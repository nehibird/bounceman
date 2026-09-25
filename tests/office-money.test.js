// Exercises the money endpoints in routes/office.js: manual payments, payment links,
// and refunds (including per-key max/daily refund caps, dry_run, idempotent replay, and
// a Stripe failure followed by a successful retry) plus the read-only reports endpoints.
//
// Stripe and SMS are both stubbed (services/stripe.js's _setStripeForTests, and a direct
// override of services/sms.js's exported sendSms) — no real network call. Runs against a
// throwaway temp SQLite DB.
//
// Run from the app root: node tests/office-money.test.js

process.env.DB_PATH = require('path').join(
  require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'bm-office-money-')),
  'test.db'
);
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
let forceNextRefundError = false;
const stripeCalls = { refunds: [], checkoutSessions: [] };
const fakeStripe = {
  refunds: {
    create: async (params, opts) => {
      stripeCalls.refunds.push({ params, opts });
      if (forceNextRefundError) {
        forceNextRefundError = false;
        throw new Error('simulated Stripe outage');
      }
      return { id: `re_test_${stripeCalls.refunds.length}`, status: 'succeeded' };
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
  const { rawKey: sarahLikeKey } = createApiKey(database, { name: 'sarah-office', scopes: ['*'] });

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
    idempotencyKey: 'idem-pay-1', reason: 'cash collected at delivery', amount: 100, payment_method: 'cash',
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
  t('idempotency key was passed through to Stripe', happyRefundCall.opts.idempotencyKey.includes('idem-refund-happy'), happyRefundCall.opts);
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
  // failed attempt's audit row is only cleared lazily, on the NEXT request that reuses
  // the same idempotency key — right after the 502 it's still there (that's fine; it's
  // just an audit trail entry), and the real guarantee under test is that it doesn't
  // block or get replayed as "the answer" on retry.
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
  t('exactly one audit row remains for that key, reflecting the success', rowsForRetryKey.length === 1 && rowsForRetryKey[0].status_code === 201, rowsForRetryKey);

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

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
