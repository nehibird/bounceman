// Verifies routes/webhooks.js's charge.refunded delta fix (subtracts only the amount
// newly refunded since the last webhook, not the cumulative total every time) and the
// stripe_events_seen dedup table — including that a thrown processing error un-dedups
// the event so Stripe's automatic retry can reach the handler again.
//
// Stripe is stubbed via services/stripe.js's _setStripeForTests — no real network call,
// no real webhook signature verification (that's Stripe's own crypto, not what's under
// test here). Runs against a throwaway temp SQLite DB.
//
// Run from the app root: node tests/refund-webhook.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-refund-webhook-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.STRIPE_EVENT_WEBHOOK_SECRET = 'whsec_test_dummy';
process.env.SARAH_API_KEY = 'test-sarah-key'; // routes/webhooks.js requires this to even load
for (const k of ['STRIPE_SECRET_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'SMTP_HOST', 'SMTP_USER',
  'SMTP_PASS', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'VAPI_SERVER_SECRET', 'VAPI_API_KEY']) {
  delete process.env[k];
}

const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
db.initialize();
const database = db.getDb();

const stripeService = require('../services/stripe');
stripeService._setStripeForTests({
  webhooks: {
    // Stub out real signature verification entirely — the webhook ROUTE is under test
    // here, not Stripe's HMAC scheme, and this needs no network call or real secret.
    constructEvent: (rawBody) => JSON.parse(rawBody.toString('utf8')),
  },
});

const webhookRoutes = require('../routes/webhooks');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  ${detail !== undefined ? detail : ''}`));
}

async function main() {
  const customerId = uuid();
  database.prepare("INSERT INTO customers (id, first_name, last_name) VALUES (?, 'Test', 'Customer')").run(customerId);
  const bookingId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, 'BM-TEST-1', ?, 'confirmed', '2026-10-01', '11:00', '19:00', 100, 100, 50, 0, 'paid')`).run(bookingId, customerId);
  const paymentId = uuid();
  database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
    VALUES (?, ?, ?, 100, 'charge', 'stripe', 'pi_test_1', 'completed', 0)`).run(paymentId, bookingId, customerId);

  const app = express();
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
  app.use('/webhooks', webhookRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  function chargeRefundedEvent(id, amountRefundedCents) {
    return JSON.stringify({
      id,
      type: 'charge.refunded',
      data: { object: { id: 'ch_test_1', payment_intent: 'pi_test_1', amount_refunded: amountRefundedCents } },
    });
  }

  function post(body) {
    return fetch(`${base}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'test' },
      body,
    });
  }

  // 1. First partial refund: $30 of a $100 booking
  let r = await post(chargeRefundedEvent('evt_test_1', 3000));
  let body = await r.json();
  t('first refund event -> 200', r.status === 200 && body.received === true, JSON.stringify(body));
  let payment = database.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  let booking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  t('payment.refund_amount = 30 after first refund', payment.refund_amount === 30, payment.refund_amount);
  t('booking.total = 70 after first refund', booking.total === 70, booking.total);

  // 2. Second event: cumulative refund now $50 — delta from the first is $20, NOT $50
  r = await post(chargeRefundedEvent('evt_test_2', 5000));
  body = await r.json();
  t('second refund event -> 200', r.status === 200 && body.received === true);
  payment = database.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  booking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  t('payment.refund_amount = 50 (cumulative) after second refund', payment.refund_amount === 50, payment.refund_amount);
  t('booking.total = 50 after second refund (delta of 20 subtracted, not cumulative 50)', booking.total === 50, booking.total);

  // 3. Duplicate delivery of the SAME event id must be ignored entirely
  r = await post(chargeRefundedEvent('evt_test_2', 5000));
  body = await r.json();
  t('duplicate event id -> duplicate:true', r.status === 200 && body.duplicate === true, JSON.stringify(body));
  booking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  t('duplicate event does not change booking.total again', booking.total === 50, booking.total);

  // 4. A processing exception must not permanently swallow the retry. Force a DB failure
  //    on the write that follows the dedup insert, confirm the request 400s AND the
  //    stripe_events_seen row was removed, then confirm resending the SAME event id
  //    afterwards succeeds (as Stripe's automatic retry would trigger).
  const realPrepare = database.prepare.bind(database);
  let throwOnce = true;
  database.prepare = (sql) => {
    if (throwOnce && sql.includes('UPDATE payments SET refund_amount')) {
      throwOnce = false;
      throw new Error('simulated DB failure for retry test');
    }
    return realPrepare(sql);
  };

  r = await post(chargeRefundedEvent('evt_test_3', 7000));
  t('processing failure -> 400', r.status === 400, r.status);
  database.prepare = realPrepare; // restore before querying directly below

  const seenRow = database.prepare('SELECT * FROM stripe_events_seen WHERE event_id = ?').get('evt_test_3');
  t('failed event was NOT left marked as seen', !seenRow, seenRow);
  booking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  t('booking.total unchanged after the failed attempt', booking.total === 50, booking.total);

  // 5. Retry (what Stripe's automatic redelivery would send) — should now process cleanly
  r = await post(chargeRefundedEvent('evt_test_3', 7000));
  body = await r.json();
  t('retry after failure succeeds', r.status === 200 && body.received === true, JSON.stringify(body));
  payment = database.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  booking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  t('payment.refund_amount = 70 after retry', payment.refund_amount === 70, payment.refund_amount);
  t('booking.total = 30 after retry (delta of 20 from the prior 50)', booking.total === 30, booking.total);

  server.close();
  database.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
