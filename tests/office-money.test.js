// Exercises the money endpoints in routes/office.js: manual payments, payment links,
// and refunds (including per-key max/daily refund caps, dry_run, idempotent replay, and
// a Stripe failure followed by a successful retry) plus the read-only reports endpoints.
//
// Stripe and SMS are both stubbed (services/stripe.js's _setStripeForTests, and a direct
// override of services/sms.js's exported sendSms) — no real network call. Runs against a
// throwaway temp SQLite DB.
//
// Run from the app root: node tests/office-money.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-office-money-'));
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
const { recordManualPayment } = require('../lib/payments');

const stripeService = require('../services/stripe');
let forceNextRefundError = false;
let forceNextRefundStatus = null; // L2: let a test make the NEXT refund come back 'failed'/'pending'
// C1.4: configurable live-charge stub — liveRefundedByPI simulates a Dashboard refund
// (or any refund made outside this app) that the webhook hasn't recorded yet.
// forceLiveFetchError simulates the live lookup itself being unreachable.
let forceLiveFetchError = false;
const liveRefundedByPI = {}; // pi_xxx -> cents already refunded, per Stripe's own record
const stripeCalls = { refunds: [], checkoutSessions: [] };
const fakeStripe = {
  refunds: {
    create: async (params, opts) => {
      stripeCalls.refunds.push({ params, opts });
      if (forceNextRefundError) {
        forceNextRefundError = false;
        throw new Error('simulated Stripe outage');
      }
      const status = forceNextRefundStatus || 'succeeded';
      forceNextRefundStatus = null;
      return { id: `re_test_${stripeCalls.refunds.length}`, status };
    },
  },
  checkout: {
    sessions: {
      create: async (params) => {
        stripeCalls.checkoutSessions.push(params);
        return { id: `cs_test_${stripeCalls.checkoutSessions.length}`, url: `https://checkout.stripe.com/test/${stripeCalls.checkoutSessions.length}` };
      },
    },
  },
  paymentIntents: {
    retrieve: async (id) => {
      if (forceLiveFetchError) throw new Error('simulated Stripe outage (live charge lookup)');
      return { id, latest_charge: { id: `ch_fake_for_${id}`, amount_refunded: liveRefundedByPI[id] || 0 } };
    },
  },
  charges: {
    retrieve: async (id) => {
      if (forceLiveFetchError) throw new Error('simulated Stripe outage (live charge lookup)');
      return { id, amount_refunded: 0 };
    },
  },
  balance: { retrieve: async () => ({ pending: [{ amount: 1000 }], available: [{ amount: 2000 }] }) },
  payouts: { list: async () => ({ data: [] }) },
  accounts: { retrieve: async () => null },
};
stripeService._setStripeForTests(fakeStripe);

const smsService = require('../services/sms');
const smsCalls = [];
smsService.sendSms = async (phone, body) => { smsCalls.push({ phone, body }); return { sid: 'SM_test' }; };

const officeRoutes = require('../routes/office');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  ${detail !== undefined ? JSON.stringify(detail) : ''}`));
}

// L4: a DB write that throws after a successful Stripe call must become a clean JSON 500
// (asyncHandler -> the router's error middleware), never an unhandled promise rejection.
const unhandledRejections = [];
process.on('unhandledRejection', (reason) => { unhandledRejections.push(reason); });

async function main() {
  // --- Fixtures ---------------------------------------------------------
  const customerId = uuid();
  database.prepare(`INSERT INTO customers (id, first_name, last_name, email, phone)
    VALUES (?, 'Money', 'Test', 'money@example.com', '5552223333')`).run(customerId);

  const bookingId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time,
     subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, 'BM-MONEY-1', ?, 'confirmed', '2026-11-01', '11:00', '19:00', 200, 200, 50, 100, 'deposit_paid')`)
    .run(bookingId, customerId);
  const paymentId = uuid();
  database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
    VALUES (?, ?, ?, 200, 'charge', 'stripe', 'pi_test_money_1', 'completed', 0)`).run(paymentId, bookingId, customerId);

  const { rawKey: moneyKey } = createApiKey(database, {
    name: 'test-money',
    scopes: ['payments:read', 'payments:record', 'payments:link', 'refunds:create', 'reports:read'],
    maxRefundCents: 5000,
    dailyRefundCapCents: 6000,
  });
  const sarahLikeKeyRow = createApiKey(database, { name: 'sarah-office', scopes: ['*'] });
  const sarahLikeKey = sarahLikeKeyRow.rawKey;

  // --- App ----------------------------------------------------------------
  const app = express();
  app.use(express.json());
  app.use('/api/office/v1', officeRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/office/v1`;

  function get(path, key) {
    return fetch(`${base}${path}`, { headers: key ? { 'x-office-key': key } : {} });
  }
  function write(method, path, key, { idempotencyKey, ...body } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (key) headers['x-office-key'] = key;
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    return fetch(`${base}${path}`, { method, headers, body: JSON.stringify(body) });
  }

  // 1. Manual payment recording updates the balance and never touches Stripe/notify by default
  let r = await write('POST', '/bookings/BM-MONEY-1/payments', moneyKey, {
    idempotencyKey: 'idem-pay-1', reason: 'cash collected at delivery', amount_cents: 10000, payment_method: 'cash',
  });
  let body = await r.json();
  t('manual payment -> 201', r.status === 201, r.status);
  t('manual payment marks card_charged:false', body.card_charged === false, body);
  t('manual payment updates balance to 0 / status paid', body.new_balance === 0 && body.new_status === 'paid', body);
  const afterManualPay = database.prepare('SELECT balance_due, payment_status FROM bookings WHERE id = ?').get(bookingId);
  t('manual payment persisted to bookings row', afterManualPay.balance_due === 0 && afterManualPay.payment_status === 'paid', afterManualPay);

  // 2. Payment link defaults to balance_due (now 0 after the manual payment — top up first)
  database.prepare("UPDATE bookings SET balance_due = 75, payment_status = 'partial' WHERE id = ?").run(bookingId);
  r = await write('POST', '/bookings/BM-MONEY-1/payment-link', moneyKey, { idempotencyKey: 'idem-link-1', reason: 'send balance link' });
  body = await r.json();
  t('payment-link -> 201', r.status === 201, r.status);
  t('payment-link defaults amount_cents to balance_due', body.amount_cents === 7500, body);
  t('payment-link did not send SMS by default', body.sms_sent === false && smsCalls.length === 0, { body, smsCalls: smsCalls.length });

  // 3. Payment link with send_sms uses the stubbed SMS service
  r = await write('POST', '/bookings/BM-MONEY-1/payment-link', moneyKey, {
    idempotencyKey: 'idem-link-2', reason: 'text the link', amount_cents: 2500, send_sms: true,
  });
  body = await r.json();
  t('payment-link send_sms -> 201, sms_sent true', r.status === 201 && body.sms_sent === true, body);
  t('sms service was actually called', smsCalls.length === 1 && smsCalls[0].phone === '5552223333', smsCalls);
  t('payment-link session in Stripe fake', stripeCalls.checkoutSessions.length === 2, stripeCalls.checkoutSessions.length);

  // 3b. A payment-link session, once completed, must be recorded by the EXISTING
  // checkout.session.completed webhook for exactly the CUSTOM amount that was paid —
  // not a hardcoded deposit assumption. Uses a dedicated booking + a separate app/server
  // (the webhook route needs its own express.raw() body parser ahead of any express.json(),
  // which the main `app` above already has mounted globally for the office routes).
  const webhookCustomerId = uuid();
  database.prepare(`INSERT INTO customers (id, first_name, last_name, email, phone)
    VALUES (?, 'Weblink', 'Payer', 'weblink@example.com', '5554447777')`).run(webhookCustomerId);
  const webhookBookingId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time,
     subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, 'BM-MONEY-WEBHOOK', ?, 'pending', '2026-11-15', '11:00', '19:00', 150, 150, 50, 150, 'unpaid')`)
    .run(webhookBookingId, webhookCustomerId);

  r = await write('POST', '/bookings/BM-MONEY-WEBHOOK/payment-link', moneyKey, {
    idempotencyKey: 'idem-link-webhook', reason: 'custom amount link', amount_cents: 6789,
  });
  body = await r.json();
  t('payment-link for the webhook fixture -> 201', r.status === 201 && body.amount_cents === 6789, body);
  const webhookSessionId = body.session_id;

  process.env.SARAH_API_KEY = process.env.SARAH_API_KEY || 'test-sarah-key';
  process.env.STRIPE_EVENT_WEBHOOK_SECRET = process.env.STRIPE_EVENT_WEBHOOK_SECRET || 'whsec_test_dummy';
  // Stub signature verification the same way tests/refund-webhook.test.js does — no real
  // network call, no real HMAC needed to test the office-created-session -> webhook path.
  fakeStripe.webhooks = { constructEvent: (rawBody) => JSON.parse(rawBody.toString('utf8')) };
  const webhookRoutes = require('../routes/webhooks');
  const webhookApp = express();
  webhookApp.use('/stripe', express.raw({ type: 'application/json' }));
  webhookApp.use('/', webhookRoutes);
  const webhookServer = webhookApp.listen(0);
  const webhookBase = `http://127.0.0.1:${webhookServer.address().port}`;

  const completedEvent = JSON.stringify({
    id: 'evt_office_paymentlink_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: webhookSessionId,
        payment_intent: 'pi_office_paymentlink_1',
        amount_total: 6789, // the CUSTOM amount, not the $50 deposit or the $150 balance
        payment_status: 'paid',
        metadata: { booking_id: webhookBookingId, booking_number: 'BM-MONEY-WEBHOOK' },
      },
    },
  });
  r = await fetch(`${webhookBase}/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'test' },
    body: completedEvent,
  });
  body = await r.json();
  t('webhook accepts the completed payment-link session', r.status === 200 && body.received === true, body);

  const webhookPayment = database.prepare('SELECT * FROM payments WHERE stripe_payment_id = ?').get('pi_office_paymentlink_1');
  t('webhook recorded a payment for the CUSTOM amount ($67.89), not the deposit or full balance', webhookPayment && webhookPayment.amount === 67.89, webhookPayment);
  const webhookBookingAfter = database.prepare('SELECT * FROM bookings WHERE id = ?').get(webhookBookingId);
  t('balance_due reduced by exactly the custom amount paid (150 - 67.89 = 82.11)', Math.abs(webhookBookingAfter.balance_due - 82.11) < 0.001, webhookBookingAfter.balance_due);
  t('booking flipped to confirmed/deposit_paid (custom amount exceeded the deposit)', webhookBookingAfter.status === 'confirmed' && webhookBookingAfter.payment_status === 'deposit_paid', webhookBookingAfter);

  // M3: a payment-link paid AFTER a booking is already completed must never demote it
  // back to 'confirmed'.
  const completedCustomerId = uuid();
  database.prepare(`INSERT INTO customers (id, first_name, last_name, email, phone) VALUES (?, 'Already', 'Done', 'done@example.com', '5559990000')`).run(completedCustomerId);
  const completedBookingId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, 'BM-MONEY-COMPLETED', ?, 'completed', '2026-09-01', '11:00', '19:00', 150, 150, 50, 0, 'paid')`)
    .run(completedBookingId, completedCustomerId);
  const demotionEvent = JSON.stringify({
    id: 'evt_office_demotion_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_demotion',
        payment_intent: 'pi_office_demotion_1',
        amount_total: 6000, // > deposit_amount(50), so depositPaid becomes true — this is the case the M3 fix must not demote on
        payment_status: 'paid',
        metadata: { booking_id: completedBookingId, booking_number: 'BM-MONEY-COMPLETED' },
      },
    },
  });
  r = await fetch(`${webhookBase}/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'test' },
    body: demotionEvent,
  });
  t('a later payment-link payment on a completed booking is still recorded (webhook 200)', r.status === 200, r.status);
  const completedBookingAfter = database.prepare('SELECT * FROM bookings WHERE id = ?').get(completedBookingId);
  t('M3: a completed booking is NEVER demoted back to confirmed by a later payment', completedBookingAfter.status === 'completed', completedBookingAfter.status);

  webhookServer.close();

  // --- Refunds --------------------------------------------------------------
  // 4. Missing confirmed_by -> 400
  r = await write('POST', '/bookings/BM-MONEY-1/refunds', moneyKey, {
    idempotencyKey: 'idem-refund-noconfirm', reason: 'test', amount_cents: 1000,
  });
  t('refund missing confirmed_by -> 400', r.status === 400, r.status);

  // 5. dry_run makes NO Stripe call
  const refundCallsBeforeDryRun = stripeCalls.refunds.length;
  r = await write('POST', '/bookings/BM-MONEY-1/refunds', moneyKey, {
    idempotencyKey: 'idem-refund-dryrun', reason: 'preview', confirmed_by: 'Nehemiah', amount_cents: 3000, dry_run: true,
  });
  body = await r.json();
  t('refund dry_run -> 200 with plan', r.status === 200 && body.dry_run === true && body.amount_cents === 3000, body);
  t('refund dry_run made no Stripe call', stripeCalls.refunds.length === refundCallsBeforeDryRun, stripeCalls.refunds.length);

  // 6. Over-refundable amount -> 400 (payment amount is $200 = 20000 cents, none refunded yet)
  r = await write('POST', '/bookings/BM-MONEY-1/refunds', moneyKey, {
    idempotencyKey: 'idem-refund-over', reason: 'too much', confirmed_by: 'Nehemiah', amount_cents: 25000,
  });
  body = await r.json();
  t('over-refundable amount -> 400', r.status === 400 && body.refundable_cents === 20000, body);

  // 7. Per-key max_refund_cents cap (5000) -> 403, before touching the daily cap
  r = await write('POST', '/bookings/BM-MONEY-1/refunds', moneyKey, {
    idempotencyKey: 'idem-refund-overcap', reason: 'too big for this key', confirmed_by: 'Nehemiah', amount_cents: 6000,
  });
  body = await r.json();
  t('amount over max_refund_cents -> 403', r.status === 403 && /max_refund_cents/.test(body.error || ''), body);

  // 8. Happy path refund: $30 (3000 cents), well within max (5000) and daily (6000) caps
  r = await write('POST', '/bookings/BM-MONEY-1/refunds', moneyKey, {
    idempotencyKey: 'idem-refund-happy', reason: 'partial refund', confirmed_by: 'Nehemiah', amount_cents: 3000,
  });
  body = await r.json();
  t('happy-path refund -> 201', r.status === 201, r.status);
  t('refund response does not touch bookkeeping directly', body.bookkeeping_via === 'stripe_webhook', body);
  const happyRefundCall = stripeCalls.refunds[stripeCalls.refunds.length - 1];
  const happyLedgerRow = database.prepare("SELECT * FROM office_refunds WHERE idempotency_key = 'idem-refund-happy'").get();
  t('C1: a ledger row exists for the reservation, and finalized to succeeded', !!happyLedgerRow && happyLedgerRow.status === 'succeeded', happyLedgerRow);
  t('C1: Stripe idempotency key is derived from the ledger row id, not the caller header', happyRefundCall.opts.idempotencyKey === `office-refund-${happyLedgerRow.id}`, happyRefundCall.opts);
  t('C1: Stripe refund metadata carries office_refund_id', happyRefundCall.params.metadata.office_refund_id === happyLedgerRow.id, happyRefundCall.params.metadata);
  t('Stripe refund used the pi_ payment intent', happyRefundCall.params.payment_intent === 'pi_test_money_1', happyRefundCall.params);

  // 9. Replay with the SAME Idempotency-Key returns the stored response and does NOT call Stripe again
  const refundCallCountAfterHappy = stripeCalls.refunds.length;
  r = await write('POST', '/bookings/BM-MONEY-1/refunds', moneyKey, {
    idempotencyKey: 'idem-refund-happy', reason: 'partial refund', confirmed_by: 'Nehemiah', amount_cents: 3000,
  });
  const replayBody = await r.json();
  t('replay returns the same refund_id', replayBody.refund_id === body.refund_id, replayBody);
  t('replay did NOT call Stripe again', stripeCalls.refunds.length === refundCallCountAfterHappy, stripeCalls.refunds.length);

  // 10. Daily cap (6000): already refunded 3000 today via this key; another 4000 would total 7000 > 6000
  r = await write('POST', '/bookings/BM-MONEY-1/refunds', moneyKey, {
    idempotencyKey: 'idem-refund-dailycap', reason: 'push past the daily cap', confirmed_by: 'Nehemiah', amount_cents: 4000,
  });
  body = await r.json();
  t('refund pushing past daily_refund_cap_cents -> 403', r.status === 403 && /daily_refund_cap_cents/.test(body.error || ''), body);

  // 11. Stripe error -> 502, then retrying with the SAME Idempotency-Key succeeds. The
  // failed attempt's audit row is renamed off to the side (idempotency_key gets a
  // ":failed:<id>" suffix) rather than deleted — a failed refund attempt is exactly the
  // kind of thing that belongs in the audit trail — and the real guarantee under test is
  // that the renamed row doesn't block or get replayed as "the answer" on retry.
  const auditCountBeforeRetry = database.prepare('SELECT COUNT(*) c FROM api_audit_log').get().c;
  forceNextRefundError = true;
  r = await write('POST', '/bookings/BM-MONEY-1/refunds', moneyKey, {
    idempotencyKey: 'idem-refund-retry', reason: 'stripe is down', confirmed_by: 'Nehemiah', amount_cents: 1000,
  });
  t('Stripe error surfaces as 502', r.status === 502, r.status);

  r = await write('POST', '/bookings/BM-MONEY-1/refunds', moneyKey, {
    idempotencyKey: 'idem-refund-retry', reason: 'stripe is down', confirmed_by: 'Nehemiah', amount_cents: 1000,
  });
  body = await r.json();
  t('retry after a Stripe failure succeeds', r.status === 201 && !!body.refund_id, body);
  const rowsForRetryKey = database.prepare("SELECT status_code FROM api_audit_log WHERE idempotency_key = 'idem-refund-retry'").all();
  t('exactly one row now matches that exact idempotency key, reflecting the success', rowsForRetryKey.length === 1 && rowsForRetryKey[0].status_code === 201, rowsForRetryKey);
  const renamedFailedRow = database.prepare("SELECT * FROM api_audit_log WHERE idempotency_key LIKE 'idem-refund-retry:failed:%'").get();
  t('the failed attempt is still in the audit trail, just renamed off to the side', !!renamedFailedRow && renamedFailedRow.status_code === 502, renamedFailedRow);
  const auditCountAfterRetry = database.prepare('SELECT COUNT(*) c FROM api_audit_log').get().c;
  t('both the failed attempt AND the successful retry are present (nothing deleted)', auditCountAfterRetry === auditCountBeforeRetry + 2, { before: auditCountBeforeRetry, after: auditCountAfterRetry });

  // --- Reports (sarah-like full-scope key) -----------------------------------
  r = await get('/reports/summary', sarahLikeKey);
  t('GET /reports/summary works with a wildcard-scope key', r.status === 200, r.status);

  r = await get('/reports/outstanding', sarahLikeKey);
  t('GET /reports/outstanding -> 200', r.status === 200, r.status);

  r = await get('/reports/payouts', sarahLikeKey);
  body = await r.json();
  t('GET /reports/payouts -> 200, null-safe shape', r.status === 200 && 'payouts' in body, body);

  r = await get('/bookings/BM-MONEY-1/payments', sarahLikeKey);
  body = await r.json();
  t('GET /bookings/:num/payments -> 200 with refundable_cents', r.status === 200 && body.payments.some((p) => typeof p.refundable_cents === 'number'), body);

  // 12. GET requests write a lightweight, attributable read-audit row — and SQLite's
  // unique index on (key_id, idempotency_key) allows any number of NULL idempotency_key
  // rows for the same key (NULLs are never equal to each other), so the 4 reads above for
  // sarahLikeKey must all have landed without a single unique-constraint failure.
  const readRows = database.prepare(
    "SELECT * FROM api_audit_log WHERE key_id = ? AND action = 'office_api_read'"
  ).all(sarahLikeKeyRow.id);
  t('4 GET requests each wrote their own read-audit row', readRows.length === 4, readRows.length);
  t('read-audit rows carry no idempotency_key (NULL, not deduped against each other)', readRows.every((r2) => r2.idempotency_key === null), readRows.map((r2) => r2.idempotency_key));
  t('read-audit rows record method/path/status/ip, attributable to the key', readRows.every((r2) =>
    r2.method === 'GET' && typeof r2.path === 'string' && r2.path.length > 0 && r2.status_code === 200 && !!r2.ip), readRows);
  t('read-audit rows store no response_json, no reason', readRows.every((r2) => r2.response_json === null && r2.reason === null), readRows);
  const readActivityRows = database.prepare(
    "SELECT COUNT(*) c FROM activity_log WHERE details LIKE '%\"actor\":\"sarah-office\"%'"
  ).get().c;
  t('reads do NOT create activity_log rows (writes do; sarah-office made none here)', readActivityRows === 0, readActivityRows);

  // --- H7 gap coverage -------------------------------------------------------
  // Fresh keys per group below: POST /refunds carries its own 10/hour-per-key limiter
  // (M7), and moneyKey already spent most of its budget on the tests above.
  const { rawKey: edgeKey } = createApiKey(database, {
    name: 'test-money-edge', scopes: ['payments:read', 'payments:record', 'payments:link', 'refunds:create'],
    maxRefundCents: 5000, dailyRefundCapCents: 6000,
  });

  // Zero/negative/non-integer refund amounts -> 400
  r = await write('POST', '/bookings/BM-MONEY-1/refunds', edgeKey, { idempotencyKey: 'idem-h7-zero', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 0 });
  t('zero refund -> 400', r.status === 400, r.status);
  r = await write('POST', '/bookings/BM-MONEY-1/refunds', edgeKey, { idempotencyKey: 'idem-h7-neg', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: -500 });
  t('negative refund -> 400', r.status === 400, r.status);
  r = await write('POST', '/bookings/BM-MONEY-1/refunds', edgeKey, { idempotencyKey: 'idem-h7-str', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: '2500' });
  t('string amount_cents -> 400 (H4)', r.status === 400, r.status);
  r = await write('POST', '/bookings/BM-MONEY-1/refunds', edgeKey, { idempotencyKey: 'idem-h7-bool', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: true });
  t('boolean amount_cents -> 400 (H4)', r.status === 400, r.status);
  r = await write('POST', '/bookings/BM-MONEY-1/refunds', edgeKey, { idempotencyKey: 'idem-h7-arr', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: [1500] });
  t('array amount_cents -> 400 (H4)', r.status === 400, r.status);
  r = await write('POST', '/bookings/BM-MONEY-1/refunds', edgeKey, { idempotencyKey: 'idem-h7-dec', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 99.5 });
  t('decimal amount_cents -> 400 (H4)', r.status === 400, r.status);
  r = await write('POST', '/bookings/BM-MONEY-1/refunds', edgeKey, { idempotencyKey: 'idem-h7-self', reason: 'x', confirmed_by: 'test-money-edge', amount_cents: 100 });
  t('confirmed_by equal to the key name -> 400 (H3)', r.status === 400, r.status);

  const { rawKey: scopeKey } = createApiKey(database, {
    name: 'test-money-scope', scopes: ['payments:read', 'refunds:create'], maxRefundCents: 5000, dailyRefundCapCents: 6000,
  });

  // A second booking with its own separate Stripe payment, to prove refund scoping
  const otherCustomerId = uuid();
  database.prepare(`INSERT INTO customers (id, first_name, last_name, email, phone) VALUES (?, 'Other', 'Booking', 'other@example.com', '5551110000')`).run(otherCustomerId);
  const otherBookingId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, 'BM-MONEY-OTHER', ?, 'confirmed', '2026-11-05', '11:00', '19:00', 90, 90, 50, 40, 'deposit_paid')`).run(otherBookingId, otherCustomerId);
  const otherPaymentId = uuid();
  database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
    VALUES (?, ?, ?, 90, 'charge', 'stripe', 'pi_test_other_1', 'completed', 0)`).run(otherPaymentId, otherBookingId, otherCustomerId);

  r = await write('POST', '/bookings/BM-MONEY-1/refunds', scopeKey, {
    idempotencyKey: 'idem-h7-crossbooking', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 1000, payment_id: otherPaymentId,
  });
  body = await r.json();
  t('payment_id from a DIFFERENT booking -> 400, never refunds another customer\'s charge (H7)', r.status === 400, body);
  const otherPaymentUnchanged = database.prepare('SELECT refund_amount FROM payments WHERE id = ?').get(otherPaymentId);
  t('the other booking\'s payment was never touched', otherPaymentUnchanged.refund_amount === 0, otherPaymentUnchanged);

  // The FALLBACK (no payment_id) lookup must also stay scoped to the URL's booking —
  // refund BM-MONEY-OTHER's own balance without payment_id and confirm it only ever
  // touches that booking's own payment, never bleeding into another booking's charge.
  r = await write('POST', '/bookings/BM-MONEY-OTHER/refunds', scopeKey, {
    idempotencyKey: 'idem-h7-fallback-scope', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 1000,
  });
  body = await r.json();
  t('fallback (no payment_id) refund on a fresh booking -> 201, scoped to its own payment', r.status === 201 && body.payment_id === otherPaymentId, body);

  // Payment-link $10k hard cap
  r = await write('POST', '/bookings/BM-MONEY-1/payment-link', moneyKey, {
    idempotencyKey: 'idem-h7-linkcap', reason: 'too big', amount_cents: 1000001, allow_overpay: true, overpay_reason: 'test',
  });
  t('payment-link amount over the $10k hard cap -> 400', r.status === 400, r.status);

  // Payment link amount above balance_due requires allow_overpay + overpay_reason (M2)
  database.prepare("UPDATE bookings SET balance_due = 50 WHERE id = ?").run(bookingId);
  r = await write('POST', '/bookings/BM-MONEY-1/payment-link', moneyKey, { idempotencyKey: 'idem-m2-overpay-noconsent', reason: 'x', amount_cents: 7500 });
  body = await r.json();
  t('amount_cents over balance_due without allow_overpay -> 400 (M2)', r.status === 400 && body.balance_due_cents === 5000, body);
  r = await write('POST', '/bookings/BM-MONEY-1/payment-link', moneyKey, { idempotencyKey: 'idem-m2-overpay-noreason', reason: 'x', amount_cents: 7500, allow_overpay: true });
  t('allow_overpay without overpay_reason -> 400 (M2)', r.status === 400, r.status);
  r = await write('POST', '/bookings/BM-MONEY-1/payment-link', moneyKey, {
    idempotencyKey: 'idem-m2-overpay-ok', reason: 'x', amount_cents: 7500, allow_overpay: true, overpay_reason: 'customer wants to prepay next season',
  });
  body = await r.json();
  t('allow_overpay + overpay_reason succeeds over balance_due (M2)', r.status === 201 && body.amount_cents === 7500, body);
  const overpayCall = stripeCalls.checkoutSessions[stripeCalls.checkoutSessions.length - 1];
  t('M2: payment-link session has a short expires_at set', typeof overpayCall.expires_at === 'number' && overpayCall.expires_at > Math.floor(Date.now() / 1000), overpayCall.expires_at);

  // Payment link refused on a cancelled/completed booking
  const cancelledBookingId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, 'BM-MONEY-CANCELLED', ?, 'cancelled', '2026-11-06', '11:00', '19:00', 90, 90, 50, 40, 'deposit_paid')`).run(cancelledBookingId, customerId);
  r = await write('POST', `/bookings/BM-MONEY-CANCELLED/payment-link`, moneyKey, { idempotencyKey: 'idem-h7-cancelledlink', reason: 'x' });
  t('payment link on a cancelled booking -> 400', r.status === 400, r.status);

  // Manual payment <= 0 -> 400
  r = await write('POST', '/bookings/BM-MONEY-1/payments', moneyKey, { idempotencyKey: 'idem-h7-manual-neg', reason: 'x', amount_cents: 0, payment_method: 'cash' });
  t('manual payment amount_cents <= 0 -> 400', r.status === 400, r.status);
  r = await write('POST', '/bookings/BM-MONEY-1/payments', moneyKey, { idempotencyKey: 'idem-h7-manual-legacy', reason: 'x', amount: 50, payment_method: 'cash' });
  body = await r.json();
  t('legacy `amount` field on manual payment -> 400, clear message (H4)', r.status === 400 && /amount_cents/.test(body.error || ''), body);

  // lib/payments.recordManualPayment's OWN guard, called directly — the office API's
  // amount_cents validation (parseCents) already rejects <= 0 before this is ever
  // reached from HTTP, but the admin UI calls this function directly with a dollar
  // string, so its own defense must independently reject <= 0 amounts too.
  let threw = null;
  try {
    recordManualPayment(database, { bookingId, amount: '0', paymentMethod: 'cash', notifySlack: false, sendConfirmationEmail: false });
  } catch (e) { threw = e; }
  t('recordManualPayment rejects amount "0" directly (not just via the HTTP layer)', threw && threw.code === 'INVALID_AMOUNT', threw && threw.code);
  threw = null;
  try {
    recordManualPayment(database, { bookingId, amount: '-5', paymentMethod: 'cash', notifySlack: false, sendConfirmationEmail: false });
  } catch (e) { threw = e; }
  t('recordManualPayment rejects a negative amount directly', threw && threw.code === 'INVALID_AMOUNT', threw && threw.code);

  // --- C1.4: live Stripe charge check folded into the refundable remainder ------------
  const { rawKey: liveKey } = createApiKey(database, {
    name: 'test-money-live', scopes: ['refunds:create'], maxRefundCents: 20000, dailyRefundCapCents: 50000,
  });

  function makeLivePayment(bookingNumber, piId) {
    const custId = uuid();
    database.prepare(`INSERT INTO customers (id, first_name, last_name, email, phone) VALUES (?, 'Live', 'Charge', 'live@example.com', '5556667777')`).run(custId);
    const bkId = uuid();
    database.prepare(`INSERT INTO bookings
      (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
      VALUES (?, ?, ?, 'confirmed', '2026-11-08', '11:00', '19:00', 200, 200, 50, 0, 'paid')`).run(bkId, bookingNumber, custId);
    const payId = uuid();
    database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
      VALUES (?, ?, ?, 200, 'charge', 'stripe', ?, 'completed', 0)`).run(payId, bkId, custId, piId);
    return { bkId, payId };
  }

  // (a) Stripe Dashboard already refunded $100 (webhook hasn't recorded it yet) — an
  // office refund of $150 on the remaining $100 must be rejected using the LIVE figure.
  makeLivePayment('BM-LIVE-A', 'pi_live_a');
  liveRefundedByPI['pi_live_a'] = 10000;
  r = await write('POST', '/bookings/BM-LIVE-A/refunds', liveKey, {
    idempotencyKey: 'idem-live-a', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 15000,
  });
  body = await r.json();
  t('(a) Dashboard $100 refunded, not yet webhooked: office $150 -> 400 using the live figure', r.status === 400 && body.refundable_cents === 10000, body);
  t('(a) response reports the live charge WAS checked', body.live_charge_checked === true, body);

  // (b) Same Dashboard $100, PLUS a pending office reservation of $50 on the same
  // payment (from any key) — a further $100 must be rejected, but exactly $50 succeeds.
  const { bkId: bId, payId: pId } = makeLivePayment('BM-LIVE-B', 'pi_live_b');
  liveRefundedByPI['pi_live_b'] = 10000;
  const liveKeyId = database.prepare('SELECT id FROM api_keys WHERE name = ?').get('test-money-live').id;
  database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 5000, 'pending', 'Nehemiah', 'other in-flight refund', datetime('now'), datetime('now'))`)
    .run(uuid(), liveKeyId, 'test-money-live', 'idem-live-b-other', bId, pId);

  r = await write('POST', '/bookings/BM-LIVE-B/refunds', liveKey, {
    idempotencyKey: 'idem-live-b-1', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 10000,
  });
  body = await r.json();
  t('(b) Dashboard $100 + pending office $50: a further $100 -> 400 (only $50 left)', r.status === 400 && body.refundable_cents === 5000, body);

  r = await write('POST', '/bookings/BM-LIVE-B/refunds', liveKey, {
    idempotencyKey: 'idem-live-b-2', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
  });
  t('(b) exactly the remaining $50 succeeds', r.status === 201, r.status);

  // (c) The live lookup itself fails (Stripe unreachable) — must fall back to the
  // webhook/ledger view and STILL correctly enforce it, with live_charge_checked:false.
  const { payId: cPayId } = makeLivePayment('BM-LIVE-C', 'pi_live_c');
  database.prepare('UPDATE payments SET refund_amount = 100 WHERE id = ?').run(cPayId); // simulates the webhook having already recorded a $100 refund
  forceLiveFetchError = true;
  r = await write('POST', '/bookings/BM-LIVE-C/refunds', liveKey, {
    idempotencyKey: 'idem-live-c', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 15000,
  });
  body = await r.json();
  forceLiveFetchError = false;
  t('(c) live lookup throws: falls back to the webhook-recorded $100, still rejects $150 on $100 remaining', r.status === 400 && body.refundable_cents === 10000, body);
  t('(c) response reports the live charge was NOT checked', body.live_charge_checked === false, body);

  // --- L1: an explicit payment_id whose payments.status is NOT 'completed' -----------
  const { rawKey: l1Key } = createApiKey(database, { name: 'test-l1', scopes: ['refunds:create'], maxRefundCents: 20000, dailyRefundCapCents: 50000 });
  const { bkId: l1BkId } = makeLivePayment('BM-L1', 'pi_l1');
  const l1PendingPaymentId = uuid();
  database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
    VALUES (?, ?, (SELECT customer_id FROM bookings WHERE id = ?), 75, 'charge', 'stripe', 'pi_l1_pending', 'pending', 0)`)
    .run(l1PendingPaymentId, l1BkId, l1BkId);
  const l1RefundsBefore = stripeCalls.refunds.length;
  r = await write('POST', '/bookings/BM-L1/refunds', l1Key, {
    idempotencyKey: 'idem-l1-pending', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000, payment_id: l1PendingPaymentId,
  });
  t('L1: explicit payment_id on a PENDING (not completed) payment -> 4xx', r.status >= 400 && r.status < 500, r.status);
  t('L1: no Stripe refund call was made', stripeCalls.refunds.length === l1RefundsBefore, stripeCalls.refunds.length);

  // --- L2: Stripe refund.status 'failed'/'pending' surfaced, and only 'failed' is
  // excluded from the daily cap ('pending' still counts) -------------------------------
  const { rawKey: l2aKey } = createApiKey(database, { name: 'test-l2a', scopes: ['refunds:create'], maxRefundCents: 20000, dailyRefundCapCents: 6000 });
  makeLivePayment('BM-L2A', 'pi_l2a');
  forceNextRefundStatus = 'failed';
  r = await write('POST', '/bookings/BM-L2A/refunds', l2aKey, {
    idempotencyKey: 'idem-l2a-1', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
  });
  body = await r.json();
  t('L2: a Stripe refund.status of "failed" is surfaced on the response', r.status === 201 && body.status === 'failed' && body.ledger_status === 'failed', body);
  // A 'failed' finalize renames idempotency_key off to the side (frees it for retry —
  // see finalizeRefundLedger), so match with LIKE rather than an exact key.
  const l2aLedgerRow = database.prepare("SELECT status FROM office_refunds WHERE idempotency_key LIKE 'idem-l2a-1%'").get();
  t('L2: the ledger row itself is finalized to failed', l2aLedgerRow && l2aLedgerRow.status === 'failed', l2aLedgerRow);
  // A further $60 against the same $60 daily cap must succeed — it only fits if the
  // $50 "failed" refund above was correctly excluded from today's total.
  r = await write('POST', '/bookings/BM-L2A/refunds', l2aKey, {
    idempotencyKey: 'idem-l2a-2', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 6000,
  });
  t('L2: a failed refund does NOT count toward the daily cap', r.status === 201, r.status);

  const { rawKey: l2bKey } = createApiKey(database, { name: 'test-l2b', scopes: ['refunds:create'], maxRefundCents: 20000, dailyRefundCapCents: 6000 });
  makeLivePayment('BM-L2B', 'pi_l2b');
  forceNextRefundStatus = 'pending';
  r = await write('POST', '/bookings/BM-L2B/refunds', l2bKey, {
    idempotencyKey: 'idem-l2b-1', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
  });
  body = await r.json();
  t('L2: a Stripe refund.status of "pending" is surfaced on the response too', r.status === 201 && body.status === 'pending', body);
  // A further $20 against the same $60 cap (only $10 headroom left) must be rejected —
  // it only fails if the $50 "pending" refund correctly DID count toward today's total.
  r = await write('POST', '/bookings/BM-L2B/refunds', l2bKey, {
    idempotencyKey: 'idem-l2b-2', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 2000,
  });
  t('L2: a pending (non-failed) refund DOES count toward the daily cap', r.status === 403, r.status);

  // --- L8: the daily-cap sum ignores ledger rows from a PREVIOUS Central-time day -----
  const { rawKey: l8Key, id: l8KeyId } = createApiKey(database, { name: 'test-l8', scopes: ['refunds:create'], maxRefundCents: 20000, dailyRefundCapCents: 6000 });
  const { bkId: l8BkId, payId: l8PayId } = makeLivePayment('BM-L8', 'pi_l8');
  const { todayCT, isoOffset } = require('../lib/helpers');
  const yesterdayCT = isoOffset(todayCT(), -1);
  database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 5000, 'succeeded', 'Nehemiah', 'yesterday refund', ?, ?)`)
    .run(uuid(), l8KeyId, 'test-l8', 'idem-l8-yesterday', l8BkId, l8PayId, `${yesterdayCT} 18:00:00`, `${yesterdayCT} 18:00:00`);
  // If that $50 "yesterday" row counted toward TODAY's $60 cap, a further $40 would
  // push to $90 and be rejected; since it must be excluded, $40 alone fits easily.
  r = await write('POST', '/bookings/BM-L8/refunds', l8Key, {
    idempotencyKey: 'idem-l8-today', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 4000,
  });
  t('L8: a ledger row from a previous CT day is excluded from today\'s daily-cap sum', r.status === 201, r.status);

  // --- L9: payment-link description is truncated to 200 chars and control-char-stripped
  const { rawKey: l9Key } = createApiKey(database, { name: 'test-l9', scopes: ['payments:link'] });
  makeLivePayment('BM-L9', 'pi_l9');
  database.prepare("UPDATE bookings SET balance_due = 500 WHERE booking_number = 'BM-L9'").run();
  const rawDescription = '\x01\x02control-then-' + 'x'.repeat(250);
  r = await write('POST', '/bookings/BM-L9/payment-link', l9Key, {
    idempotencyKey: 'idem-l9-desc', reason: 'x', amount_cents: 5000, description: rawDescription,
  });
  t('L9: payment-link with an oversized/control-char description -> 201', r.status === 201, r.status);
  const l9StripeCall = stripeCalls.checkoutSessions[stripeCalls.checkoutSessions.length - 1];
  const l9SentDescription = l9StripeCall.line_items[0].price_data.product_data.description;
  t('L9: the description Stripe actually received is capped at 200 chars', l9SentDescription.length <= 200, l9SentDescription.length);
  // eslint-disable-next-line no-control-regex
  t('L9: control characters never reached the Stripe stub', !/[\x00-\x1F\x7F]/.test(l9SentDescription), JSON.stringify(l9SentDescription));

  // --- L4: a DB write that throws AFTER a successful Stripe call -> clean JSON 500,
  // never an unhandled promise rejection -----------------------------------------------
  const { rawKey: l4Key } = createApiKey(database, { name: 'test-l4', scopes: ['payments:link'] });
  makeLivePayment('BM-L4', 'pi_l4');
  database.prepare("UPDATE bookings SET balance_due = 500 WHERE booking_number = 'BM-L4'").run();
  const realPrepare = database.prepare.bind(database);
  database.prepare = (sql) => {
    if (sql.includes('UPDATE bookings SET internal_notes')) {
      throw new Error('simulated DB failure after the Stripe call succeeded');
    }
    return realPrepare(sql);
  };
  const unhandledBefore = unhandledRejections.length;
  r = await write('POST', '/bookings/BM-L4/payment-link', l4Key, {
    idempotencyKey: 'idem-l4-throw', reason: 'x', amount_cents: 5000,
  });
  database.prepare = realPrepare;
  body = await r.json().catch(() => null);
  t('L4: a DB write throwing after Stripe succeeds -> 500', r.status === 500, r.status);
  t('L4: the 500 body is JSON, not an HTML stack trace', body && typeof body === 'object', body);
  // Give any stray microtask a tick to surface before checking.
  await new Promise((resolve) => setTimeout(resolve, 20));
  t('L4: no unhandled promise rejection was raised', unhandledRejections.length === unhandledBefore, unhandledRejections.slice(unhandledBefore));

  server.close();
  database.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
