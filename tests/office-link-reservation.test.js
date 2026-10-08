// R2-M1: a payment-link's (key_id, Idempotency-Key) pair must be reserved SYNCHRONOUSLY,
// before any Stripe call — this suite proves that two concurrent requests with the same
// key against a Checkout-session stub that does NOT itself dedupe make exactly ONE real
// Checkout Session, the winner gets 201 with an audit row, and the loser gets 409 (never
// a silent, audit-less 201). It also proves a retry after an error reuses the SAME
// `expires_at` (fixed at reservation time) rather than drifting to a fresh `now + 24h`
// that would make Stripe treat the retry as a brand-new request.
//
// Run from the app root: node tests/office-link-reservation.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-office-link-res-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
for (const k of ['STRIPE_SECRET_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'SMTP_HOST', 'SMTP_USER',
  'SMTP_PASS', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'VAPI_SERVER_SECRET', 'VAPI_API_KEY']) {
  delete process.env[k];
}

const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
db.initialize();
const database = db.getDb();

const { createApiKey } = require('../lib/api-keys');
const stripeService = require('../services/stripe');

let sessionCreateDelayMs = 0;
let forceNextSessionError = false;
const sessionCreateCalls = [];
const fakeStripe = {
  checkout: {
    sessions: {
      // Deliberately does NOT dedupe on idempotencyKey — models a stub/edge case where
      // Stripe-side dedup can't be relied on, so the app's OWN pre-reservation is what
      // has to prevent two real sessions.
      create: (params, opts) => new Promise((resolve, reject) => {
        const run = () => {
          sessionCreateCalls.push({ params, opts });
          if (forceNextSessionError) {
            forceNextSessionError = false;
            return reject(new Error('simulated Checkout Session outage'));
          }
          resolve({ id: `cs_res_${sessionCreateCalls.length}`, url: `https://checkout.stripe.com/test/${sessionCreateCalls.length}` });
        };
        if (sessionCreateDelayMs > 0) setTimeout(run, sessionCreateDelayMs); else run();
      }),
    },
  },
};
stripeService._setStripeForTests(fakeStripe);

const officeRoutes = require('../routes/office');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  ${detail !== undefined ? JSON.stringify(detail) : ''}`));
}

function makeBooking(bookingNumber, balanceDue) {
  const customerId = uuid();
  database.prepare(`INSERT INTO customers (id, first_name, last_name, email, phone) VALUES (?, 'Link', 'Res', 'linkres@example.com', '5553339999')`).run(customerId);
  const bookingId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, ?, ?, 'confirmed', '2026-11-01', '11:00', '19:00', ?, ?, 0, ?, 'partial')`)
    .run(bookingId, bookingNumber, customerId, balanceDue, balanceDue, balanceDue);
  return bookingId;
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/api/office/v1', officeRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/office/v1`;

  function write(method, urlPath, key, { idempotencyKey, ...body } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (key) headers['x-office-key'] = key;
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    return fetch(`${base}${urlPath}`, { method, headers, body: JSON.stringify(body) });
  }

  // --- 1. Two concurrent identical requests, non-deduping stub: exactly one 201 with
  //        an audit row, exactly one real Checkout Session, the loser gets 409. ---------
  makeBooking('BM-LINKRES-CONC', 100);
  const { rawKey: concKey, id: concKeyId } = createApiKey(database, { name: 'link-conc-key', scopes: ['payments:link'] });
  sessionCreateDelayMs = 100;
  const idemConc = 'idem-link-conc-1';

  const concResults = await Promise.all([
    write('POST', '/bookings/BM-LINKRES-CONC/payment-link', concKey, { idempotencyKey: idemConc, reason: 'x', amount_cents: 5000 }).then((r) => r.status),
    write('POST', '/bookings/BM-LINKRES-CONC/payment-link', concKey, { idempotencyKey: idemConc, reason: 'x', amount_cents: 5000 }).then((r) => r.status),
  ]);
  sessionCreateDelayMs = 0;
  t('two concurrent identical link requests: exactly one 201', concResults.filter((s) => s === 201).length === 1, concResults);
  t('two concurrent identical link requests: exactly one 409 (never a silent second 201)', concResults.filter((s) => s === 409).length === 1, concResults);
  t('two concurrent identical link requests: exactly ONE real Checkout Session was created', sessionCreateCalls.length === 1, sessionCreateCalls.length);

  const linkAuditRows = database.prepare("SELECT * FROM api_audit_log WHERE key_id = ? AND idempotency_key = ?").all(concKeyId, idemConc);
  t('the winner has exactly one audit row (never zero, never two)', linkAuditRows.length === 1, linkAuditRows);
  t('the audit row reflects the 201 success, not the 409 loser', linkAuditRows[0].status_code === 201, linkAuditRows[0]);

  const reservationRow = database.prepare('SELECT * FROM office_payment_link_reservations WHERE key_id = ? AND idempotency_key = ?').get(concKeyId, idemConc);
  t('exactly one office_payment_link_reservations row exists, finalized succeeded', !!reservationRow && reservationRow.status === 'succeeded', reservationRow);

  // --- 2. A retry after a Stripe error reuses the SAME reservation and the SAME
  //        expires_at — never a fresh "now + 24h" that would drift on Stripe's side. ----
  makeBooking('BM-LINKRES-RETRY', 100);
  const { rawKey: retryKey, id: retryKeyId } = createApiKey(database, { name: 'link-retry-key', scopes: ['payments:link'] });
  const idemRetry = 'idem-link-retry-1';
  const stripeIdemKeyForRetry = `office-link-${retryKeyId}-${idemRetry}`;

  forceNextSessionError = true;
  let r = await write('POST', '/bookings/BM-LINKRES-RETRY/payment-link', retryKey, { idempotencyKey: idemRetry, reason: 'x', amount_cents: 5000 });
  t('first attempt fails (simulated Stripe outage) -> 502', r.status === 502, r.status);

  const reservationAfterFailure = database.prepare('SELECT * FROM office_payment_link_reservations WHERE idempotency_key = ?').get(idemRetry);
  t('a reservation row exists even after the failed attempt', !!reservationAfterFailure && reservationAfterFailure.status === 'failed', reservationAfterFailure);
  const expiresAtAfterFailure = reservationAfterFailure.expires_at;

  // Simulate real elapsed time between attempts — old (pre-fix) code recomputed
  // `now + 24h` per attempt, so a few seconds of drift alone reproduced the bug.
  await new Promise((resolve) => setTimeout(resolve, 1100));

  r = await write('POST', '/bookings/BM-LINKRES-RETRY/payment-link', retryKey, { idempotencyKey: idemRetry, reason: 'x', amount_cents: 5000 });
  const body = await r.json();
  t('retry with the same key succeeds', r.status === 201 && !!body.session_id, body);
  const sentExpiresAt = sessionCreateCalls[sessionCreateCalls.length - 1].params.expires_at;
  t('R2-M1: the retry sent the EXACT SAME expires_at as the original reservation, not a recomputed one', sentExpiresAt === expiresAtAfterFailure, { sent: sentExpiresAt, reserved: expiresAtAfterFailure });

  const reservationAfterRetry = database.prepare('SELECT * FROM office_payment_link_reservations WHERE idempotency_key = ?').get(idemRetry);
  t('R2-M1: the SAME reservation row was reused (not a second row)', reservationAfterRetry.id === reservationAfterFailure.id && reservationAfterRetry.status === 'succeeded', reservationAfterRetry);
  // Both the failed attempt and the retry used the IDENTICAL Stripe idempotency key AND
  // the identical expires_at — against a real (deduping) Stripe backend that guarantees
  // exactly one real Checkout Session, even though this stub itself doesn't dedupe.
  const callsForThisReservation = sessionCreateCalls.filter((c) => c.opts && c.opts.idempotencyKey === stripeIdemKeyForRetry);
  t('R2-M1: both attempts for this reservation sent the SAME Stripe idempotency key', callsForThisReservation.length === 2, callsForThisReservation);
  t('R2-M1: both attempts sent the SAME expires_at (never recomputed on retry)', callsForThisReservation.every((c) => c.params.expires_at === expiresAtAfterFailure), callsForThisReservation.map((c) => c.params.expires_at));

  // --- 3. A different request body under the same Idempotency-Key -> 422, no reservation
  //        mutation, no Stripe call. ------------------------------------------------------
  makeBooking('BM-LINKRES-DIFFBODY', 200);
  const { rawKey: diffKey } = createApiKey(database, { name: 'link-diffbody-key', scopes: ['payments:link'] });
  const idemDiff = 'idem-link-diffbody-1';
  r = await write('POST', '/bookings/BM-LINKRES-DIFFBODY/payment-link', diffKey, { idempotencyKey: idemDiff, reason: 'x', amount_cents: 5000 });
  t('first request with idemDiff succeeds', r.status === 201, r.status);
  const callsBeforeDiff = sessionCreateCalls.length;
  r = await write('POST', '/bookings/BM-LINKRES-DIFFBODY/payment-link', diffKey, { idempotencyKey: idemDiff, reason: 'x', amount_cents: 9000 });
  t('same key, different amount_cents -> 422 (idempotency-key body-hash mismatch, generic middleware)', r.status === 422, r.status);
  t('no new Stripe call for the mismatched-body retry', sessionCreateCalls.length === callsBeforeDiff, sessionCreateCalls.length);

  server.close();
  database.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
