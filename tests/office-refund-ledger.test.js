// C1: concurrency and client-disconnect guarantees for the refund reservation ledger
// (routes/office.js's reserveRefund/office_refunds), plus
// scripts/reconcile-office-refunds.js's Stripe-side reconciliation of stuck 'pending'
// rows via lib/refund-reconcile.js.
//
// Every concurrency assertion goes over REAL HTTP (Promise.all against a listening
// server on 127.0.0.1) with an artificially delayed Stripe stub, so the guarantee under
// test is the actual request-handling path, not a unit-level shortcut.
//
// Run from the app root: node tests/office-refund-ledger.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-office-refund-ledger-'));
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
let refundDelayMs = 150;
const stripeCalls = { refunds: [] };
function liveChargeAmountCentsFor(id) {
  const row = database.prepare('SELECT amount FROM payments WHERE stripe_payment_id = ? OR stripe_charge_id = ?').get(id, id);
  return row ? Math.round((row.amount || 0) * 100) : 20000;
}
const fakeStripe = {
  refunds: {
    create: (params, opts) => new Promise((resolve) => {
      setTimeout(() => {
        stripeCalls.refunds.push({ params, opts });
        resolve({ id: `re_ledger_${stripeCalls.refunds.length}`, status: 'succeeded' });
      }, refundDelayMs);
    }),
  },
  // C1.4: the refunds route also does a live amount_refunded check before reserving.
  // No test in this file needs a non-zero figure — a stable 0 keeps every concurrency/
  // disconnect assertion's math exactly as it was before that check existed. R3-L2:
  // assertUsableCharge now requires a real integer `amount` matching the payment's own
  // captured amount, so this looks it up dynamically rather than a fixed guess.
  paymentIntents: {
    retrieve: async (id) => ({ id, latest_charge: { id: `ch_fake_for_${id}`, amount: liveChargeAmountCentsFor(id), amount_refunded: 0, currency: 'usd' } }),
  },
  charges: { retrieve: async (id) => ({ id, amount: liveChargeAmountCentsFor(id), amount_refunded: 0, currency: 'usd' }) },
};
stripeService._setStripeForTests(fakeStripe);

const officeRoutes = require('../routes/office');
const { reconcilePendingRefunds } = require('../lib/refund-reconcile');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  ${detail !== undefined ? JSON.stringify(detail) : ''}`));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function makeBookingAndPayment(amountDollars) {
  const customerId = uuid();
  database.prepare(`INSERT INTO customers (id, first_name, last_name, email, phone) VALUES (?, 'Ledger', 'Test', 'ledger@example.com', '5551239999')`).run(customerId);
  const bookingId = uuid();
  const bookingNumber = 'BM-LEDGER-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, ?, ?, 'confirmed', '2026-11-01', '11:00', '19:00', ?, ?, 50, 0, 'paid')`)
    .run(bookingId, bookingNumber, customerId, amountDollars, amountDollars);
  const paymentId = uuid();
  database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
    VALUES (?, ?, ?, ?, 'charge', 'stripe', ?, 'completed', 0)`)
    .run(paymentId, bookingId, customerId, amountDollars, 'pi_ledger_' + paymentId.slice(0, 8));
  return { bookingId, bookingNumber, paymentId };
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/api/office/v1', officeRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/office/v1`;

  function write(method, urlPath, key, { idempotencyKey, ...body } = {}, opts = {}) {
    const headers = { 'content-type': 'application/json' };
    if (key) headers['x-office-key'] = key;
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    return fetch(`${base}${urlPath}`, { method, headers, body: JSON.stringify(body), signal: opts.signal });
  }

  // --- 1. Five concurrent $40 refunds against a $60 daily cap (larger per-refund max) ---
  refundDelayMs = 200;
  const { bookingNumber: capBookingNumber } = makeBookingAndPayment(500); // plenty of refundable balance — the daily cap is the binding constraint
  const { rawKey: capKey } = createApiKey(database, { name: 'ledger-cap-key', scopes: ['refunds:create'], maxRefundCents: 100000, dailyRefundCapCents: 6000 });

  const capResults = await Promise.all(
    Array.from({ length: 5 }, (_, i) => write('POST', `/bookings/${capBookingNumber}/refunds`, capKey, {
      idempotencyKey: `idem-cap-${i}`, reason: 'concurrency test', confirmed_by: 'Nehemiah', amount_cents: 4000,
    }).then((r) => r.status))
  );
  t('5 concurrent $40 refunds against a $60 cap: exactly one 201', capResults.filter((s) => s === 201).length === 1, capResults);
  t('5 concurrent $40 refunds against a $60 cap: the rest are 4xx', capResults.filter((s) => s >= 400 && s < 500).length === 4, capResults);
  t('5 concurrent $40 refunds against a $60 cap: exactly 1 Stripe call was made', stripeCalls.refunds.length === 1, stripeCalls.refunds.length);

  // --- 2. Two CONCURRENT $150 refunds on a $200 payment: exactly one passes ---
  stripeCalls.refunds.length = 0;
  const { bookingNumber: concBookingNumber } = makeBookingAndPayment(200);
  const { rawKey: concKey } = createApiKey(database, { name: 'ledger-conc-key', scopes: ['refunds:create'], maxRefundCents: 100000, dailyRefundCapCents: 100000 });

  const concResults = await Promise.all([
    write('POST', `/bookings/${concBookingNumber}/refunds`, concKey, { idempotencyKey: 'idem-conc-a', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 15000 }).then((r) => r.status),
    write('POST', `/bookings/${concBookingNumber}/refunds`, concKey, { idempotencyKey: 'idem-conc-b', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 15000 }).then((r) => r.status),
  ]);
  t('two concurrent $150 refunds on a $200 payment: exactly one succeeds', concResults.filter((s) => s === 201).length === 1, concResults);
  t('two concurrent $150 refunds on a $200 payment: exactly one Stripe call', stripeCalls.refunds.length === 1, stripeCalls.refunds.length);

  // --- 3. Two SEQUENTIAL $150 refunds on a $200 payment, pre-webhook: exactly one passes ---
  stripeCalls.refunds.length = 0;
  const { bookingNumber: seqBookingNumber } = makeBookingAndPayment(200);
  const { rawKey: seqKey } = createApiKey(database, { name: 'ledger-seq-key', scopes: ['refunds:create'], maxRefundCents: 100000, dailyRefundCapCents: 100000 });

  const seqFirst = await write('POST', `/bookings/${seqBookingNumber}/refunds`, seqKey, { idempotencyKey: 'idem-seq-a', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 15000 });
  const seqSecond = await write('POST', `/bookings/${seqBookingNumber}/refunds`, seqKey, { idempotencyKey: 'idem-seq-b', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 15000 });
  t('sequential pre-webhook: first $150 refund succeeds', seqFirst.status === 201, seqFirst.status);
  t('sequential pre-webhook: second $150 refund is rejected (refundable remainder already reserved)', seqSecond.status === 400, seqSecond.status);
  const seqBody = await seqSecond.json();
  t('sequential pre-webhook: rejection cites the refundable remainder, not a stale $200', seqBody.refundable_cents === 5000, seqBody);

  // --- 4. Client disconnect mid-refund: ledger still finalizes, audit trail still exists,
  //        and a follow-up refund (NEW Idempotency-Key) is correctly capped ---
  refundDelayMs = 300;
  stripeCalls.refunds.length = 0;
  const { bookingNumber: discBookingNumber } = makeBookingAndPayment(200);
  const { rawKey: discKey, id: discKeyId } = createApiKey(database, { name: 'ledger-disc-key', scopes: ['refunds:create'], maxRefundCents: 100000, dailyRefundCapCents: 6000 });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  try {
    await write('POST', `/bookings/${discBookingNumber}/refunds`, discKey, {
      idempotencyKey: 'idem-disc-1', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 4000,
    }, { signal: controller.signal });
  } catch (e) {
    // expected — the client aborted before the (300ms) server-side Stripe call finished
  }
  await sleep(400); // let the server finish handling the request in the background

  const discLedgerRow = database.prepare('SELECT * FROM office_refunds WHERE idempotency_key = ?').get('idem-disc-1');
  t('client disconnect: the ledger row still ends succeeded', !!discLedgerRow && discLedgerRow.status === 'succeeded', discLedgerRow);
  const discAuditRow = database.prepare('SELECT * FROM api_audit_log WHERE idempotency_key = ?').get('idem-disc-1');
  t('client disconnect: an audit row exists despite the client going away', !!discAuditRow, discAuditRow);
  const discActivityRow = database.prepare("SELECT * FROM activity_log WHERE action = 'office_api_refund' AND entity_id = ?").get(discBookingNumber);
  t('client disconnect: an activity_log row exists too', !!discActivityRow, discActivityRow);

  // R2-L2: a SAME-key retry after the disconnect must replay 201 from the ledger (the
  // authoritative record), not a stale 409/403 — even though the disconnect's own audit
  // row is stuck at 499 and was never updated in place (documented above; the retry gets
  // its OWN fresh audit row instead).
  const auditRowsBeforeRetry = database.prepare('SELECT COUNT(*) c FROM api_audit_log WHERE key_id = ?').get(discKeyId).c;
  const discRetry = await write('POST', `/bookings/${discBookingNumber}/refunds`, discKey, {
    idempotencyKey: 'idem-disc-1', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 4000,
  });
  const discRetryBody = await discRetry.json();
  t('R2-L2: a same-key retry after a client disconnect replays 201 from the ledger',
    discRetry.status === 201 && discRetryBody.refund_id === discLedgerRow.stripe_refund_id, discRetryBody);
  t('R2-L2: the retry made NO second Stripe call', stripeCalls.refunds.length === 1, stripeCalls.refunds.length);
  const auditRowsAfterRetry = database.prepare('SELECT COUNT(*) c FROM api_audit_log WHERE key_id = ?').get(discKeyId).c;
  t('R2-L2: the retry wrote its OWN new audit row (the original 499 row is kept as history, not overwritten)',
    auditRowsAfterRetry === auditRowsBeforeRetry + 1, { before: auditRowsBeforeRetry, after: auditRowsAfterRetry });
  const freshAuditRow = database.prepare("SELECT * FROM api_audit_log WHERE idempotency_key = 'idem-disc-1'").get();
  t('R2-L2: the exact idempotency-key row now reflects the 201 replay (the retry\'s own fresh row)',
    !!freshAuditRow && freshAuditRow.status_code === 201, freshAuditRow);
  const staleAuditRow = database.prepare("SELECT * FROM api_audit_log WHERE idempotency_key LIKE 'idem-disc-1:failed:%'").get();
  t('R2-L2: the original disconnect audit row is still there at 499, retired off to the side (not deleted)',
    !!staleAuditRow && staleAuditRow.status_code === 499, staleAuditRow);

  // A follow-up refund with a NEW idempotency key must be limited by a cap that already
  // includes the disconnected-but-succeeded first refund ($40 against a $60 cap).
  const followUp = await write('POST', `/bookings/${discBookingNumber}/refunds`, discKey, {
    idempotencyKey: 'idem-disc-followup', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 3000,
  });
  const followUpBody = await followUp.json();
  t('follow-up refund correctly limited by the cap the disconnected refund already used',
    followUp.status === 403 && followUpBody.already_refunded_today_cents === 4000, followUpBody);

  // --- 5. Reconcile: a stuck 'pending' row that Stripe DOES have a refund for ---
  const oldTimestamp = new Date(Date.now() - 30 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const { bookingId: recBookingId, paymentId: recPaymentId } = makeBookingAndPayment(100);
  const stuckId = uuid();
  database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
    .run(stuckId, discKeyId, 'ledger-disc-key', 'idem-stuck-found', recBookingId, recPaymentId, 2500, 'Nehemiah', 'reconcile test', oldTimestamp, oldTimestamp);

  const foundStub = {
    findRefundByOfficeId: async (officeRefundId) => (officeRefundId === stuckId ? { id: 're_reconciled_1', status: 'succeeded', metadata: { office_refund_id: officeRefundId } } : null),
  };
  let results = await reconcilePendingRefunds(database, { olderThanMinutes: 15, stripeService: foundStub });
  t('reconcile: found row finalized to succeeded', results.some((r) => r.id === stuckId && r.result === 'succeeded'), results);
  const reconciledRow = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(stuckId);
  t('reconcile: ledger row updated with the Stripe refund id', reconciledRow.stripe_refund_id === 're_reconciled_1' && reconciledRow.status === 'succeeded', reconciledRow);

  // --- 6. Reconcile: a stuck 'pending' row Stripe has NO answer for -> needs_review ---
  const { bookingId: recBookingId2, paymentId: recPaymentId2 } = makeBookingAndPayment(100);
  const lostId = uuid();
  database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
    .run(lostId, discKeyId, 'ledger-disc-key', 'idem-stuck-lost', recBookingId2, recPaymentId2, 1500, 'Nehemiah', 'reconcile test', oldTimestamp, oldTimestamp);

  const notFoundStub = { findRefundByOfficeId: async () => null };
  results = await reconcilePendingRefunds(database, { olderThanMinutes: 15, stripeService: notFoundStub });
  t('reconcile: unresolvable row marked needs_review', results.some((r) => r.id === lostId && r.result === 'needs_review'), results);
  const lostRow = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(lostId);
  t('reconcile: needs_review persisted', lostRow.status === 'needs_review', lostRow);

  // --- 7. Reconcile: a row younger than the cutoff is left alone ---
  const { bookingId: recBookingId3, paymentId: recPaymentId3 } = makeBookingAndPayment(100);
  const freshId = uuid();
  database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, datetime('now'), datetime('now'))`)
    .run(freshId, discKeyId, 'ledger-disc-key', 'idem-fresh', recBookingId3, recPaymentId3, 1000, 'Nehemiah', 'reconcile test');
  results = await reconcilePendingRefunds(database, { olderThanMinutes: 15, stripeService: notFoundStub });
  t('reconcile: a row younger than the cutoff is left pending', !results.some((r) => r.id === freshId), results);
  const freshRow = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(freshId);
  t('reconcile: fresh row status unchanged', freshRow.status === 'pending', freshRow);

  // --- LEDGER-3 (round-5 ruling, accepted as equivalent): a DIRECT unit test of
  // computeRefundLimits, exported test-only via router._test, proving the
  // pendingOrReviewLedgerCents term actually reduces refundableCents. This term is
  // provably unreachable from any of the three real call sites today (reserveRefund and
  // dry_run both refuse first via findUnresolvedRefundForPayment whenever such a row
  // exists — see routes/office.js), so it's otherwise dead in every live test. This test
  // exists so that if that blanket refusal is ever relaxed, the term protecting against a
  // double refund is already covered. ---------------------------------------------------
  {
    const { computeRefundLimits } = officeRoutes._test;
    const { paymentId: ledger3PaymentId } = makeBookingAndPayment(100);
    const payment = database.prepare('SELECT * FROM payments WHERE id = ?').get(ledger3PaymentId);
    const { id: ledger3KeyId } = createApiKey(database, { name: 'ledger3-key', scopes: ['refunds:create'] });
    const key = database.prepare('SELECT * FROM api_keys WHERE id = ?').get(ledger3KeyId);

    const baseline = computeRefundLimits(database, key, payment, null);
    t('LEDGER-3: with no pending/needs_review rows, refundableCents is the full captured amount',
      baseline.refundableCents === Math.round(payment.amount * 100), baseline);

    const pendingId = uuid();
    database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 2000, 'pending', 'Nehemiah', 'x', datetime('now'), datetime('now'))`)
      .run(pendingId, ledger3KeyId, 'ledger3-key', 'idem-ledger3-pending', payment.booking_id, ledger3PaymentId);

    const withPending = computeRefundLimits(database, key, payment, null);
    t('LEDGER-3: a seeded PENDING row reduces refundableCents by its amount_cents',
      withPending.refundableCents === baseline.refundableCents - 2000, { baseline, withPending });

    const reviewId = uuid();
    database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1500, 'needs_review', 'Nehemiah', 'x', datetime('now'), datetime('now'))`)
      .run(reviewId, ledger3KeyId, 'ledger3-key', 'idem-ledger3-review', payment.booking_id, ledger3PaymentId);

    const withBoth = computeRefundLimits(database, key, payment, null);
    t('LEDGER-3: a seeded NEEDS_REVIEW row further reduces refundableCents by its amount_cents',
      withBoth.refundableCents === baseline.refundableCents - 2000 - 1500, { baseline, withBoth });
  }

  server.close();
  database.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
