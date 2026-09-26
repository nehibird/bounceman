// R3-C1(d): exercises routes/office.js's refund endpoint against a FAKE Stripe HTTP
// server driven by the REAL stripe-node client (services/stripe.js's actual getStripe()
// config: {timeout:5000, maxNetworkRetries:1} for the client, {maxNetworkRetries:0} for
// refunds.create specifically) — not a JS stub. This is the only way to see stripe-node's
// own hidden retry after a connection reset (it retries once regardless of
// maxNetworkRetries, reusing the SAME Idempotency-Key), which is exactly the gap R3-C1
// closes: a 409 (`idempotency_key_in_use`/`idempotency_error`) or 429 landing on that
// hidden retry must NEVER be treated as a definitive "Stripe never did it".
//
// Fake Stripe server: tests/helpers/fake-stripe-server.js (127.0.0.1 only), adapted from
// Marcus Bennett's round-3 review probes.
//
// Run from the app root: node tests/office-refund-realsdk.test.js

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-office-realsdk-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
for (const k of ['STRIPE_SECRET_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'SMTP_HOST', 'SMTP_USER',
  'SMTP_PASS', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'VAPI_SERVER_SECRET', 'VAPI_API_KEY']) {
  delete process.env[k];
}

const express = require('express');
const { v4: uuid } = require('uuid');
const Stripe = require('stripe');
const db = require('../db');
db.initialize();
const database = db.getDb();

const { createApiKey } = require('../lib/api-keys');
const stripeService = require('../services/stripe');
const { createFakeStripe } = require('./helpers/fake-stripe-server');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  ${detail !== undefined ? JSON.stringify(detail) : ''}`));
}

function makeBookingAndPayment(bookingNumber, amountDollars, piId) {
  const customerId = uuid();
  database.prepare(`INSERT INTO customers (id, first_name, last_name, email, phone) VALUES (?, 'RealSdk', 'Test', 'realsdk@example.com', '5551230099')`).run(customerId);
  const bookingId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, ?, ?, 'confirmed', '2026-11-01', '11:00', '19:00', ?, ?, 50, 0, 'paid')`)
    .run(bookingId, bookingNumber, customerId, amountDollars, amountDollars);
  const paymentId = uuid();
  database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
    VALUES (?, ?, ?, ?, 'charge', 'stripe', ?, 'completed', 0)`).run(paymentId, bookingId, customerId, amountDollars, piId);
  return { bookingId, bookingNumber, paymentId };
}

async function main() {
  const fake = await createFakeStripe();
  // Matches services/stripe.js's getStripe() client config exactly — the client default
  // is maxNetworkRetries:1 (safe for idempotency-keyed writes); createRefund() itself
  // overrides refunds.create specifically to maxNetworkRetries:0 (R3-C1c). Pointed at the
  // fake server over plain HTTP with a dummy test key — this seam
  // (stripeService._setStripeForTests) is test-only; nothing in prod code can reach it.
  const realClient = Stripe('sk_test_fake', {
    timeout: 5000,
    maxNetworkRetries: 1,
    host: '127.0.0.1',
    port: fake.port,
    protocol: 'http',
  });
  stripeService._setStripeForTests(realClient);

  const officeRoutes = require('../routes/office');
  const app = express();
  app.use(express.json());
  app.use('/api/office/v1', officeRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/office/v1`;

  function write(method, urlPath, key, { idempotencyKey, ...body } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (key) headers['x-office-key'] = key;
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    return fetch(`${base}${urlPath}`, { method, headers, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  }

  let counter = 0;
  function nextPiId() { counter += 1; return `pi_realsdk_${counter}`; }

  function setupFixture(amountDollars = 200) {
    const piId = nextPiId();
    const bookingNumber = `BM-REALSDK-${counter}`;
    fake.setCharge(`ch_for_${piId}`, { amount: Math.round(amountDollars * 100), amount_refunded: 0, currency: 'usd' });
    const { bookingNumber: bn, paymentId } = makeBookingAndPayment(bookingNumber, amountDollars, piId);
    const { rawKey } = createApiKey(database, {
      name: `realsdk-key-${counter}`, scopes: ['refunds:create'], maxRefundCents: 20000, dailyRefundCapCents: 50000,
    });
    return { bookingNumber: bn, paymentId, rawKey, piId };
  }

  // ---------------------------------------------------------------------------------
  // Table 1: reset_after_processing (Stripe DID process it) then the SDK's own hidden
  // retry (same Idempotency-Key) gets FAULT2. None of these may ever double-refund, and
  // the app must never release the reservation while a refund exists.
  // ---------------------------------------------------------------------------------
  const resetThenAmbiguous = ['429', 'idempotency_key_in_use_409', 'idempotency_error_409'];
  for (const fault2 of resetThenAmbiguous) {
    const { bookingNumber, rawKey } = setupFixture();
    const idem = `idem-reset-${fault2}`;
    fake.pushRefundFault('reset_after_processing');
    fake.pushRefundFault(fault2);

    const refundsBefore = fake.getRealRefundCount();
    let r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t(`[reset->${fault2}] first attempt -> ambiguous (outcome:"unknown")`, (r.status === 502 || r.status === 504) && r.body.outcome === 'unknown', r);
    t(`[reset->${fault2}] Stripe DID actually process the refund (processed before the fault reached the client)`, fake.getRealRefundCount() === refundsBefore + 1, fake.getRealRefundCount());
    const ledgerId = r.body.ledger_id;
    let ledgerRow = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(ledgerId);
    t(`[reset->${fault2}] ledger row stays pending, never released`, ledgerRow.status === 'pending' && ledgerRow.idempotency_key === idem, ledgerRow);

    // A NEW-key retry must be refused outright (R3-M3), never a second Stripe call.
    r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: `${idem}-newkey`, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t(`[reset->${fault2}] a new-key retry is refused (unresolved_refund)`, r.status === 409 && r.body.error === 'unresolved_refund', r);
    t(`[reset->${fault2}] the new-key refusal made no additional Stripe refund`, fake.getRealRefundCount() === refundsBefore + 1, fake.getRealRefundCount());

    // R3-M2: backdate the reservation past the safe resume window — findRefundByOfficeId
    // must still resolve this correctly from the refund OBJECT (which never expires),
    // regardless of Stripe's own idempotency-KEY TTL.
    database.prepare("UPDATE office_refunds SET created_at = datetime('now', '-25 hours') WHERE id = ?").run(ledgerId);

    // A SAME-key retry resolves via findRefundByOfficeId (never calls refunds.create
    // again) -> exactly one real refund, ledger finalized succeeded.
    r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t(`[reset->${fault2}] same-key retry (even 25h later) -> 201`, r.status === 201 && !!r.body.refund_id, r);
    t(`[reset->${fault2}] EXACTLY ONE real refund exists at the end`, fake.getRealRefundCount() === refundsBefore + 1, fake.getRealRefundCount());
    ledgerRow = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(ledgerId);
    t(`[reset->${fault2}] the SAME ledger row is now succeeded`, ledgerRow.status === 'succeeded' && ledgerRow.id === ledgerId, ledgerRow);
  }

  // ---------------------------------------------------------------------------------
  // reset_after_processing then a genuinely-definitive-shaped 400: the app must confirm
  // via findRefundByOfficeId, find the refund that DID happen, and finalize from it
  // DIRECTLY in the same request — never release, never a second refund.
  // ---------------------------------------------------------------------------------
  {
    const { bookingNumber, rawKey } = setupFixture();
    const idem = 'idem-reset-400';
    fake.pushRefundFault('reset_after_processing');
    fake.pushRefundFault('400');
    const refundsBefore = fake.getRealRefundCount();

    const r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[reset->400] the app confirms via Stripe and finalizes 201 in the SAME request (never a 502)', r.status === 201 && !!r.body.refund_id, r);
    t('[reset->400] exactly one real refund exists', fake.getRealRefundCount() === refundsBefore + 1, fake.getRealRefundCount());
    const ledgerRow = database.prepare('SELECT * FROM office_refunds WHERE idempotency_key = ?').get(idem);
    t('[reset->400] ledger row succeeded, idempotency_key NEVER renamed (never released)', ledgerRow.status === 'succeeded' && ledgerRow.idempotency_key === idem, ledgerRow);
  }

  // ---------------------------------------------------------------------------------
  // reset_before_processing (Stripe touched NOTHING) then a genuine 400: confirmed
  // failed + released. A fresh same-key retry then succeeds normally, exactly 1 refund
  // total across the whole flow.
  // ---------------------------------------------------------------------------------
  {
    const { bookingNumber, rawKey } = setupFixture();
    const idem = 'idem-resetbefore-400';
    fake.pushRefundFault('reset_before_processing');
    fake.pushRefundFault('400');
    const refundsBefore = fake.getRealRefundCount();

    let r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[resetbefore->400] confirmed failed (real 502, no outcome:"unknown")', r.status === 502 && r.body.outcome === undefined, r);
    t('[resetbefore->400] zero refunds were ever created', fake.getRealRefundCount() === refundsBefore, fake.getRealRefundCount());
    const failedRow = database.prepare("SELECT * FROM office_refunds WHERE idempotency_key LIKE ?").get(`${idem}%`);
    t('[resetbefore->400] ledger row failed and RELEASED (key renamed)', failedRow.status === 'failed' && failedRow.idempotency_key !== idem, failedRow);

    r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[resetbefore->400] a fresh same-key retry now succeeds', r.status === 201 && !!r.body.refund_id, r);
    t('[resetbefore->400] exactly one real refund exists total', fake.getRealRefundCount() === refundsBefore + 1, fake.getRealRefundCount());
  }

  // ---------------------------------------------------------------------------------
  // A plain 429 on a first-and-only attempt (no earlier reset -> stripe-node's own
  // maxNetworkRetries:0 means no hidden retry happens at all) is STILL always treated as
  // ambiguous (R3-C1a) — never definitive, even though nothing was ever processed.
  // ---------------------------------------------------------------------------------
  {
    const { bookingNumber, rawKey } = setupFixture();
    const idem = 'idem-solo-429';
    fake.pushRefundFault('429');
    const refundsBefore = fake.getRealRefundCount();

    let r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[solo 429] treated as ambiguous (outcome:"unknown"), never definitive', r.status === 502 && r.body.outcome === 'unknown', r);
    t('[solo 429] nothing was ever processed', fake.getRealRefundCount() === refundsBefore, fake.getRealRefundCount());
    const pendingRow = database.prepare('SELECT * FROM office_refunds WHERE idempotency_key = ?').get(idem);
    t('[solo 429] ledger row stays pending, not released', pendingRow.status === 'pending', pendingRow);

    r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[solo 429] same-key retry now succeeds (Stripe never actually saw a fault this time)', r.status === 201, r);
    t('[solo 429] exactly one real refund exists', fake.getRealRefundCount() === refundsBefore + 1, fake.getRealRefundCount());
  }

  // ---------------------------------------------------------------------------------
  // A genuine 400 with NO earlier processing at all -> findRefundByOfficeId confirms
  // nothing exists -> failed + released, exactly as a definitive error always did.
  // ---------------------------------------------------------------------------------
  {
    const { bookingNumber, rawKey } = setupFixture();
    const idem = 'idem-solo-400';
    fake.pushRefundFault('400');
    const refundsBefore = fake.getRealRefundCount();

    let r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[solo 400] confirmed failed (no outcome:"unknown")', r.status === 502 && r.body.outcome === undefined, r);
    t('[solo 400] zero refunds were ever created', fake.getRealRefundCount() === refundsBefore, fake.getRealRefundCount());

    r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[solo 400] fresh same-key retry succeeds', r.status === 201, r);
    t('[solo 400] exactly one real refund exists', fake.getRealRefundCount() === refundsBefore + 1, fake.getRealRefundCount());
  }

  // ---------------------------------------------------------------------------------
  // R3-C1(b): if the confirmation lookup ITSELF fails (not "not found" — genuinely
  // fails), a definitive-looking error must stay pending/ambiguous, never released.
  // ---------------------------------------------------------------------------------
  {
    const { bookingNumber, rawKey } = setupFixture();
    const idem = 'idem-lookupfail-400';
    fake.pushRefundFault('400');
    fake.failNextList();
    const refundsBefore = fake.getRealRefundCount();

    let r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[lookup fails] stays ambiguous (outcome:"unknown"), not released', (r.status === 502 || r.status === 504) && r.body.outcome === 'unknown', r);
    const row = database.prepare('SELECT * FROM office_refunds WHERE idempotency_key = ?').get(idem);
    t('[lookup fails] ledger row still pending', row.status === 'pending', row);

    // The follow-up retry's OWN lookup succeeds (no fault queued this time) and
    // correctly finds nothing -> proceeds to a fresh Stripe call -> succeeds.
    r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[lookup fails] a later retry (lookup working again) succeeds', r.status === 201, r);
    t('[lookup fails] exactly one real refund exists', fake.getRealRefundCount() === refundsBefore + 1, fake.getRealRefundCount());
  }

  // ---------------------------------------------------------------------------------
  // R3-M2: a pending row with NO Stripe answer at all, backdated past the resume
  // window -> refused (needs_review, 409 refund_needs_reconcile) rather than blindly
  // calling refunds.create again.
  // ---------------------------------------------------------------------------------
  {
    const { bookingId, bookingNumber, paymentId } = makeBookingAndPayment('BM-REALSDK-AGED', 200, nextPiId());
    const { rawKey, id: keyId } = createApiKey(database, { name: 'realsdk-aged-key', scopes: ['refunds:create'], maxRefundCents: 20000, dailyRefundCapCents: 50000 });
    const idem = 'idem-aged-pending';
    const ledgerId = uuid();
    database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 5000, 'pending', 'Nehemiah', 'x', datetime('now', '-25 hours'), datetime('now', '-25 hours'))`)
      .run(ledgerId, keyId, 'realsdk-aged-key', idem, bookingId, paymentId);

    const refundsBefore = fake.getRealRefundCount();
    const r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[aged, never happened] refused with refund_needs_reconcile', r.status === 409 && r.body.error === 'refund_needs_reconcile' && r.body.ledger_id === ledgerId, r);
    t('[aged, never happened] no refunds.create call was made', fake.getRealRefundCount() === refundsBefore, fake.getRealRefundCount());
    const row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(ledgerId);
    t('[aged, never happened] row marked needs_review', row.status === 'needs_review', row);
  }

  server.close();
  database.close();
  await fake.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
