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
// R3-L3: charge.refund.updated's reversal correction now looks up the LIVE
// amount_refunded on the charge before deciding how to correct the books — controllable
// per-test via liveAmountRefundedCentsOverride (only reached when the event carries a
// `payment_intent`/`charge` field; the existing R2-L5 fixtures don't, so they keep
// exercising the old best-effort-subtraction fallback unchanged).
let liveAmountRefundedCentsOverride = null;
stripeService._setStripeForTests({
  webhooks: {
    // Stub out real signature verification entirely — the webhook ROUTE is under test
    // here, not Stripe's HMAC scheme, and this needs no network call or real secret.
    constructEvent: (rawBody) => JSON.parse(rawBody.toString('utf8')),
  },
  paymentIntents: {
    retrieve: async (id) => ({
      id,
      latest_charge: { id: `ch_for_${id}`, amount: 10000, amount_refunded: liveAmountRefundedCentsOverride !== null ? liveAmountRefundedCentsOverride : 0, currency: 'usd' },
    }),
  },
  charges: {
    retrieve: async (id) => ({ id, amount: 10000, amount_refunded: liveAmountRefundedCentsOverride !== null ? liveAmountRefundedCentsOverride : 0, currency: 'usd' }),
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

  function chargeRefundedEvent(id, amountRefundedCents, paymentIntent = 'pi_test_1') {
    return JSON.stringify({
      id,
      type: 'charge.refunded',
      data: { object: { id: 'ch_test_1', payment_intent: paymentIntent, amount_refunded: amountRefundedCents } },
    });
  }

  function chargeRefundUpdatedEvent(id, { refundId, status, amountCents, officeRefundId, paymentIntent }) {
    return JSON.stringify({
      id,
      type: 'charge.refund.updated',
      data: { object: { id: refundId, status, amount: amountCents, payment_intent: paymentIntent || null, metadata: { office_refund_id: officeRefundId } } },
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

  // 5.5 H1-DELTA: a genuinely STALE event (a LOWER cumulative than what's already
  // recorded, e.g. an out-of-order redelivery) must be a complete no-op — not just
  // refund_amount held steady by MAX() (which a guard moved to AFTER the write would
  // still satisfy), but ALSO zero writes to bookings.total/updated_at/internal_notes. A
  // spy on database.prepare proves no such UPDATE statement is even attempted, which a
  // purely numeric assertion could miss if the guard were moved rather than removed.
  const bookingBeforeStale = database.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  const bookingUpdateCalls = [];
  const realPrepareForSpy = database.prepare.bind(database);
  database.prepare = (sql) => {
    if (sql.includes('UPDATE bookings SET total')) bookingUpdateCalls.push(sql);
    return realPrepareForSpy(sql);
  };
  r = await post(chargeRefundedEvent('evt_test_stale', 4000)); // $40 < the $70 already recorded
  database.prepare = realPrepareForSpy;
  body = await r.json();
  t('H1-DELTA: a stale event (lower cumulative than recorded) -> 200, treated as a no-op', r.status === 200 && body.received === true, JSON.stringify(body));
  t('H1-DELTA: no UPDATE bookings SET total statement was ever prepared for a stale event', bookingUpdateCalls.length === 0, bookingUpdateCalls);
  payment = database.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  booking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  t('H1-DELTA: refund_amount still 70 (MAX-protected either way)', payment.refund_amount === 70, payment.refund_amount);
  t('H1-DELTA: booking.total still 30, NOT incorrectly increased to 60', booking.total === 30, booking.total);
  t('H1-DELTA: booking.updated_at untouched', booking.updated_at === bookingBeforeStale.updated_at, { before: bookingBeforeStale.updated_at, after: booking.updated_at });
  t('H1-DELTA: internal_notes untouched (no extra note appended)', booking.internal_notes === bookingBeforeStale.internal_notes, { before: bookingBeforeStale.internal_notes, after: booking.internal_notes });

  // 6. L8: stripe_events_seen rows older than 30 days are pruned on boot (db.js's
  // initialize(), called again here — idempotent by design); newer rows are kept.
  const { v4: uuidL8 } = require('uuid');
  const oldEventId = uuidL8();
  const freshEventId = uuidL8();
  database.prepare("INSERT INTO stripe_events_seen (event_id, created_at) VALUES (?, datetime('now', '-40 days'))").run(oldEventId);
  database.prepare("INSERT INTO stripe_events_seen (event_id, created_at) VALUES (?, datetime('now', '-1 days'))").run(freshEventId);
  db.initialize();
  const oldRow = database.prepare('SELECT * FROM stripe_events_seen WHERE event_id = ?').get(oldEventId);
  const freshRow = database.prepare('SELECT * FROM stripe_events_seen WHERE event_id = ?').get(freshEventId);
  t('L8: a stripe_events_seen row older than 30 days is pruned', !oldRow, oldRow);
  t('L8: a stripe_events_seen row within 30 days is kept', !!freshRow, freshRow);

  // 7. R2-L5: charge.refund.updated with a REVERSAL (failed/canceled) must correct
  // payments.refund_amount and bookings.total by the difference — the MAX() guard in the
  // charge.refunded handler exists to reject exactly this kind of downward move as
  // "stale", so it would otherwise swallow Stripe's own legitimate correction.
  const revCustomerId = uuid();
  database.prepare("INSERT INTO customers (id, first_name, last_name) VALUES (?, 'Reversal', 'Test')").run(revCustomerId);
  const revBookingId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, 'BM-REV-1', ?, 'confirmed', '2026-10-01', '11:00', '19:00', 100, 70, 50, 0, 'paid')`).run(revBookingId, revCustomerId);
  const revPaymentId = uuid();
  // Simulates: a $100 charge, a $30 office refund already recorded (via an earlier
  // charge.refunded webhook) — payment.refund_amount=30, booking.total reduced 100->70.
  database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
    VALUES (?, ?, ?, 100, 'charge', 'stripe', 'pi_rev_1', 'completed', 30)`).run(revPaymentId, revBookingId, revCustomerId);
  const revOfficeRefundId = uuid();
  database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, stripe_refund_id, stripe_status, created_at, updated_at)
    VALUES (?, 'test-key-id', 'test-key', 'idem-rev-1', ?, ?, 3000, 'succeeded', 'Nehemiah', 'x', 're_reversal_test', 'succeeded', datetime('now'), datetime('now'))`)
    .run(revOfficeRefundId, revBookingId, revPaymentId);

  r = await post(chargeRefundUpdatedEvent('evt_rev_1', { refundId: 're_reversal_test', status: 'canceled', amountCents: 3000, officeRefundId: revOfficeRefundId }));
  body = await r.json();
  t('R2-L5: charge.refund.updated (reversal) -> 200', r.status === 200 && body.received === true, JSON.stringify(body));

  let revOfficeRow = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(revOfficeRefundId);
  let revPayment = database.prepare('SELECT * FROM payments WHERE id = ?').get(revPaymentId);
  let revBooking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(revBookingId);
  t('R2-L5: the office_refunds row is marked failed (the reversal itself, unchanged behavior)', revOfficeRow.status === 'failed', revOfficeRow);
  t('R2-L5: payments.refund_amount corrected DOWN by the reversed $30 (30 -> 0)', revPayment.refund_amount === 0, revPayment.refund_amount);
  t('R2-L5: bookings.total corrected back UP by $30 (70 -> 100)', revBooking.total === 100, revBooking.total);
  t('R2-L5: bookings.balance_due recomputed consistently (0, nothing else paid)', revBooking.balance_due === 0, revBooking.balance_due);
  t('R2-L5: an internal note records the reversal', /refund reversed/.test(revBooking.internal_notes || ''), revBooking.internal_notes);

  // Idempotent: a SECOND charge.refund.updated for the SAME refund (different event id,
  // so it isn't blocked by the outer event-id dedup) must not re-apply the correction —
  // the office_refunds row is already 'failed', so `info.changes` is 0 and the whole
  // correction block is skipped.
  r = await post(chargeRefundUpdatedEvent('evt_rev_2', { refundId: 're_reversal_test', status: 'canceled', amountCents: 3000, officeRefundId: revOfficeRefundId }));
  t('R2-L5: a second (different event id) delivery for the same refund -> 200', r.status === 200, r.status);
  revPayment = database.prepare('SELECT * FROM payments WHERE id = ?').get(revPaymentId);
  revBooking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(revBookingId);
  t('R2-L5: idempotent — refund_amount is NOT corrected a second time (stays 0, not negative)', revPayment.refund_amount === 0, revPayment.refund_amount);
  t('R2-L5: idempotent — booking.total is NOT increased a second time (stays 100)', revBooking.total === 100, revBooking.total);

  // --- R3-L3: reversal out-of-order — the refund's OWN charge.refunded hasn't arrived
  // yet when its charge.refund.updated (canceled) lands. payments.refund_amount must not
  // be blindly decremented from a base that never included this refund in the first
  // place (that would drive it wrong, and a later charge.refunded would then re-apply the
  // delta on top of an already-wrong number).
  const ooCustomerId = uuid();
  database.prepare("INSERT INTO customers (id, first_name, last_name) VALUES (?, 'OutOfOrder', 'Test')").run(ooCustomerId);
  const ooBookingId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, 'BM-OOO-1', ?, 'confirmed', '2026-10-01', '11:00', '19:00', 100, 100, 50, 0, 'paid')`).run(ooBookingId, ooCustomerId);
  const ooPaymentId = uuid();
  // $100 charge, NO refund recorded yet (its own charge.refunded hasn't arrived) —
  // refund_amount starts at 0.
  database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
    VALUES (?, ?, ?, 100, 'charge', 'stripe', 'pi_ooo_1', 'completed', 0)`).run(ooPaymentId, ooBookingId, ooCustomerId);
  const ooOfficeRefundId = uuid();
  // Our ledger already marked this refund 'succeeded' (Stripe's create call returned
  // before it actually got canceled) — this is the ambiguous window R3-L3 is about.
  database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, stripe_refund_id, stripe_status, created_at, updated_at)
    VALUES (?, 'test-key-id', 'test-key', 'idem-ooo-1', ?, ?, 4000, 'succeeded', 'Nehemiah', 'x', 're_ooo_test', 'pending', datetime('now'), datetime('now'))`)
    .run(ooOfficeRefundId, ooBookingId, ooPaymentId);

  liveAmountRefundedCentsOverride = 0; // Stripe confirms: nothing was actually kept refunded
  r = await post(chargeRefundUpdatedEvent('evt_ooo_1', { refundId: 're_ooo_test', status: 'canceled', amountCents: 4000, officeRefundId: ooOfficeRefundId, paymentIntent: 'pi_ooo_1' }));
  t('R3-L3: out-of-order reversal -> 200', r.status === 200, r.status);
  let ooPayment = database.prepare('SELECT * FROM payments WHERE id = ?').get(ooPaymentId);
  let ooBooking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(ooBookingId);
  t('R3-L3: refund_amount stays 0 (never blindly subtracted into negative)', ooPayment.refund_amount === 0, ooPayment.refund_amount);
  t('R3-L3: booking.total untouched (still 100) since nothing was ever actually deducted', ooBooking.total === 100, ooBooking.total);

  // Now the (late) charge.refunded event for this SAME charge arrives, with
  // amount_refunded=0 (the refund never actually completed) — must be a no-op.
  r = await post(chargeRefundedEvent('evt_ooo_2', 0, 'pi_ooo_1'));
  t('R3-L3: the late charge.refunded (0 cumulative) -> 200', r.status === 200, r.status);
  ooPayment = database.prepare('SELECT * FROM payments WHERE id = ?').get(ooPaymentId);
  ooBooking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(ooBookingId);
  t('R3-L3: after the late charge.refunded, refund_amount still 0', ooPayment.refund_amount === 0, ooPayment.refund_amount);
  t('R3-L3: after the late charge.refunded, booking.total still 100', ooBooking.total === 100, ooBooking.total);
  liveAmountRefundedCentsOverride = null;

  server.close();
  database.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
