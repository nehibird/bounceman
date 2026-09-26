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
const { execFileSync } = require('child_process');
// R6-L1: routes/webhooks.js only attaches its test-only `_test.stillOwnsEventAttempt`
// export under NODE_ENV==='test' (same precedent as routes/office.js's R6-I3 gate).
process.env.NODE_ENV = 'test';
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
// R4-L1 GAP: forces the live amount_refunded lookup itself to fail (network outage etc.),
// independent of liveAmountRefundedCentsOverride, to exercise charge.refunded's
// live-fetch-failed path (must refuse 503 + un-dedup, never fall back to the frozen total).
let forceLiveLookupError = false;
// R5-L2: an artificial delay on the live lookup, so a test can fire a SECOND delivery of
// the same event id while the FIRST is still "processing" (awaiting Stripe) — the same
// technique tests/office-refund-ledger.test.js already uses for its own concurrency races.
let liveLookupDelayMs = 0;
// R5-L3: counts every live-lookup call this stub actually received, so a test can assert
// Stripe was never even called for a charge with no matching payment.
let liveLookupCallCount = 0;
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
stripeService._setStripeForTests({
  webhooks: {
    // Stub out real signature verification entirely — the webhook ROUTE is under test
    // here, not Stripe's HMAC scheme, and this needs no network call or real secret.
    constructEvent: (rawBody) => JSON.parse(rawBody.toString('utf8')),
  },
  paymentIntents: {
    retrieve: async (id) => {
      liveLookupCallCount += 1;
      if (liveLookupDelayMs) await sleep(liveLookupDelayMs);
      if (forceLiveLookupError) throw new Error('simulated Stripe outage (live amount_refunded lookup)');
      return {
        id,
        latest_charge: { id: `ch_for_${id}`, amount: 10000, amount_refunded: liveAmountRefundedCentsOverride !== null ? liveAmountRefundedCentsOverride : 0, currency: 'usd' },
      };
    },
  },
  charges: {
    retrieve: async (id) => {
      liveLookupCallCount += 1;
      if (liveLookupDelayMs) await sleep(liveLookupDelayMs);
      if (forceLiveLookupError) throw new Error('simulated Stripe outage (live amount_refunded lookup)');
      return { id, amount: 10000, amount_refunded: liveAmountRefundedCentsOverride !== null ? liveAmountRefundedCentsOverride : 0, currency: 'usd' };
    },
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

  // R4-L1: refundsData models the REAL Stripe payload shape (charge.refunds.data) the
  // handler now reads from. Three modes:
  //   - omitted (undefined): defaults to a single synthetic refund matching the cumulative
  //     total, so every pre-existing call site below behaves exactly as before.
  //   - an array: an explicit (complete) refunds.data list, for a specific/stale set of
  //     underlying refunds.
  //   - null (R4-L1 GAP): omits the `refunds` key from the payload entirely — the
  //     REALISTIC MODERN Stripe shape (Charge.refunds is not guaranteed present; see the
  //     R4-L1-gap commit), which forces the handler onto its live-lookup fallback path.
  function chargeRefundedEvent(id, amountRefundedCents, paymentIntent = 'pi_test_1', refundsData) {
    const chargeObj = { id: 'ch_test_1', payment_intent: paymentIntent, amount_refunded: amountRefundedCents };
    if (refundsData !== null) {
      const data = refundsData || [{ id: `re_synth_${id}`, amount: amountRefundedCents, status: 'succeeded' }];
      chargeObj.refunds = { object: 'list', data, has_more: false };
    }
    return JSON.stringify({ id, type: 'charge.refunded', data: { object: chargeObj } });
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
  // R5-L1: the handler now ALWAYS asks Stripe for the live amount_refunded rather than
  // trusting the payload (whether via amount_refunded or a refunds.data list) — every
  // charge.refunded call site below sets liveAmountRefundedCentsOverride to the cumulative
  // figure it intends Stripe to report, matching the amountRefundedCents argument.
  liveAmountRefundedCentsOverride = 3000;
  let r = await post(chargeRefundedEvent('evt_test_1', 3000));
  let body = await r.json();
  t('first refund event -> 200', r.status === 200 && body.received === true, JSON.stringify(body));
  let payment = database.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  let booking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  t('payment.refund_amount = 30 after first refund', payment.refund_amount === 30, payment.refund_amount);
  t('booking.total = 70 after first refund', booking.total === 70, booking.total);

  // 2. Second event: cumulative refund now $50 — delta from the first is $20, NOT $50
  liveAmountRefundedCentsOverride = 5000;
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

  liveAmountRefundedCentsOverride = 7000;
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
  liveAmountRefundedCentsOverride = 4000; // $40 < the $70 already recorded
  r = await post(chargeRefundedEvent('evt_test_stale', 4000));
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
  liveAmountRefundedCentsOverride = null; // restore the ambient default the sections below assume

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

  // --- R3-L3: reversal out-of-order — a SECOND refund (B, $20) whose OWN charge.refunded
  // hasn't arrived yet gets reversed while a FIRST refund (A, $30) is already webhooked
  // and reflected in refund_amount. A naive subtraction of B's own amount from the
  // CURRENT refund_amount ($30 - $20 = $10) is WRONG — B's $20 was never actually folded
  // into that $30 in the first place, so subtracting it drives the figure below what A
  // alone already accounts for. The live charge's true amount_refunded (A only, $30,
  // since B never completed) is the only correct answer — and it must come out UNCHANGED
  // (delta 0), not $10. This is the exact case a plain subtraction cannot get right,
  // which is why L3-ABSOLUTE (reverting to subtraction) must be caught by this test and
  // not just by a case that happens to floor at 0 either way.
  const ooCustomerId = uuid();
  database.prepare("INSERT INTO customers (id, first_name, last_name) VALUES (?, 'OutOfOrder', 'Test')").run(ooCustomerId);
  const ooBookingId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, 'BM-OOO-1', ?, 'confirmed', '2026-10-01', '11:00', '19:00', 100, 70, 50, 0, 'paid')`).run(ooBookingId, ooCustomerId);
  const ooPaymentId = uuid();
  // $100 charge. Refund A ($30) already webhooked: refund_amount=30, booking.total
  // already reduced 100->70. Refund B ($20) is NOT reflected yet (its own charge.refunded
  // hasn't arrived) — refund_amount stays exactly 30, not 50.
  database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
    VALUES (?, ?, ?, 100, 'charge', 'stripe', 'pi_ooo_1', 'completed', 30)`).run(ooPaymentId, ooBookingId, ooCustomerId);
  const ooOfficeRefundId = uuid();
  // Our ledger already marked refund B 'succeeded' (Stripe's create call returned before
  // it actually got canceled) — this is the ambiguous window R3-L3 is about.
  database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, stripe_refund_id, stripe_status, created_at, updated_at)
    VALUES (?, 'test-key-id', 'test-key', 'idem-ooo-1', ?, ?, 2000, 'succeeded', 'Nehemiah', 'x', 're_ooo_test', 'pending', datetime('now'), datetime('now'))`)
    .run(ooOfficeRefundId, ooBookingId, ooPaymentId);

  liveAmountRefundedCentsOverride = 3000; // Stripe confirms: only A ($30) ever actually completed
  r = await post(chargeRefundUpdatedEvent('evt_ooo_1', { refundId: 're_ooo_test', status: 'canceled', amountCents: 2000, officeRefundId: ooOfficeRefundId, paymentIntent: 'pi_ooo_1' }));
  t('R3-L3: out-of-order reversal -> 200', r.status === 200, r.status);
  let ooPayment = database.prepare('SELECT * FROM payments WHERE id = ?').get(ooPaymentId);
  let ooBooking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(ooBookingId);
  t('R3-L3: refund_amount stays 30 (the live truth), NOT naively subtracted to 10', ooPayment.refund_amount === 30, ooPayment.refund_amount);
  t('R3-L3: booking.total untouched (still 70) since B was never actually deducted from it', ooBooking.total === 70, ooBooking.total);

  // R5-L1: the late/retried delivery of B's ORIGINAL charge.refunded event carries the
  // REALISTIC STALE payload Stripe actually generates — a webhook body is frozen at
  // generation time and never rewritten after a later cancellation. Its `refunds.data`
  // list still lists B with the status it had AT SEND TIME (succeeded — before it was
  // later canceled), and its own frozen `amount_refunded` is $50 (A $30 + B $20). Under
  // R5-L1 this payload content is IGNORED ENTIRELY — the live lookup below (still
  // returning $30, the true current state) is the only thing consulted, so this is simply
  // a no-op (delta 0 against the already-current 30). Passing an explicit stale list here
  // (rather than omitting it) proves the list's presence makes no difference at all.
  r = await post(chargeRefundedEvent('evt_ooo_2', 5000, 'pi_ooo_1', [
    { id: 're_ooo_a_test', amount: 3000, status: 'succeeded' },
    { id: 're_ooo_test', amount: 2000, status: 'succeeded' }, // B's stale, pre-cancellation status — irrelevant under R5-L1
  ]));
  t('R5-L1: the late/retried STALE charge.refunded (list ignored, live truth used) -> 200', r.status === 200, r.status);
  ooPayment = database.prepare('SELECT * FROM payments WHERE id = ?').get(ooPaymentId);
  ooBooking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(ooBookingId);
  t('R5-L1 VERDICT: refund_amount stays 30 (the live figure, never the stale $50 list total)', ooPayment.refund_amount === 30, ooPayment.refund_amount);
  t('R5-L1 VERDICT: booking.total stays 70 (never re-reduced for a refund that never went out)', ooBooking.total === 70, ooBooking.total);

  // Claude's variant: a DIFFERENT event id carrying the exact same stale payload (another
  // redelivery/reorder) must be equally harmless — the fix depends only on the live
  // lookup, never on payload content or event id.
  r = await post(chargeRefundedEvent('evt_ooo_3', 5000, 'pi_ooo_1', [
    { id: 're_ooo_a_test', amount: 3000, status: 'succeeded' },
    { id: 're_ooo_test', amount: 2000, status: 'succeeded' },
  ]));
  t('R5-L1: a second, different-event-id redelivery of the same stale payload -> 200', r.status === 200, r.status);
  ooPayment = database.prepare('SELECT * FROM payments WHERE id = ?').get(ooPaymentId);
  ooBooking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(ooBookingId);
  t('R5-L1: still 30/70 after a second stale redelivery under a different event id', ooPayment.refund_amount === 30 && ooBooking.total === 70, { refund_amount: ooPayment.refund_amount, total: ooBooking.total });
  liveAmountRefundedCentsOverride = null;

  // --- R5-L1: Claude's probe — a Dashboard refund frozen 'pending' in a COMPLETE
  // (has_more:false) list, with NO office_refunds row at all (never created via this
  // app's API, so the old ledger cross-check could never have excluded it either), that
  // Stripe later actually canceled. The pre-R5-L1 code trusted a complete list at face
  // value and re-inflated the books to 80/20; R5-L1 ignores the list outright and asks
  // Stripe directly, so this must stay exactly 30/70. -------------------------------------
  const dashCustomerId = uuid();
  database.prepare("INSERT INTO customers (id, first_name, last_name) VALUES (?, 'Dashboard', 'Test')").run(dashCustomerId);
  const dashBookingId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, 'BM-DASHBOARD-1', ?, 'confirmed', '2026-10-01', '11:00', '19:00', 100, 70, 50, 0, 'paid')`).run(dashBookingId, dashCustomerId);
  const dashPaymentId = uuid();
  // $100 charge, refund A ($30, via this app) already reflected (refund_amount=30, total 70).
  database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
    VALUES (?, ?, ?, 100, 'charge', 'stripe', 'pi_dashboard_1', 'completed', 30)`).run(dashPaymentId, dashBookingId, dashCustomerId);

  // The payload's own (complete) list would sum to $80 if trusted: A ($30, succeeded) +
  // Dashboard refund B ($50, still 'pending' at the moment this webhook body was frozen).
  // Stripe's LIVE truth (mocked below) is that B never actually completed — only A ever
  // went out — so the live amount_refunded is $30.
  liveAmountRefundedCentsOverride = 3000;
  r = await post(chargeRefundedEvent('evt_dashboard_1', 8000, 'pi_dashboard_1', [
    { id: 're_dashboard_a', amount: 3000, status: 'succeeded' },
    { id: 're_dashboard_b', amount: 5000, status: 'pending' }, // frozen mid-flight; later canceled at Stripe
  ]));
  t('R5-L1 (Claude 80/20 case): a stale COMPLETE list with a pending-then-canceled Dashboard refund -> 200', r.status === 200, r.status);
  const dashPayment = database.prepare('SELECT * FROM payments WHERE id = ?').get(dashPaymentId);
  const dashBooking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(dashBookingId);
  t('R5-L1 (Claude 80/20 case) VERDICT: refund_amount stays 30, NOT the list-implied 80', dashPayment.refund_amount === 30, dashPayment.refund_amount);
  t('R5-L1 (Claude 80/20 case) VERDICT: booking.total stays 70, NOT re-inflated to 20', dashBooking.total === 70, dashBooking.total);
  liveAmountRefundedCentsOverride = null;

  // --- R5-L4 (remaining part): a payload where refunds.has_more is TRUE (an INCOMPLETE
  // list) must be handled identically — the live figure is used regardless of has_more,
  // since the list is never inspected at all any more. -----------------------------------
  const hmCustomerId = uuid();
  database.prepare("INSERT INTO customers (id, first_name, last_name) VALUES (?, 'HasMore', 'Test')").run(hmCustomerId);
  const hmBookingId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, 'BM-HASMORE-1', ?, 'confirmed', '2026-10-01', '11:00', '19:00', 100, 100, 50, 0, 'paid')`).run(hmBookingId, hmCustomerId);
  const hmPaymentId = uuid();
  database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
    VALUES (?, ?, ?, 100, 'charge', 'stripe', 'pi_hasmore_1', 'completed', 0)`).run(hmPaymentId, hmBookingId, hmCustomerId);
  liveAmountRefundedCentsOverride = 4000; // the live truth — the has_more:true list below must be ignored
  const hmChargeObj = { id: 'ch_test_1', payment_intent: 'pi_hasmore_1', amount_refunded: 9999 };
  hmChargeObj.refunds = { object: 'list', data: [{ id: 're_hasmore_1', amount: 9999, status: 'succeeded' }], has_more: true };
  r = await post(JSON.stringify({ id: 'evt_hasmore_1', type: 'charge.refunded', data: { object: hmChargeObj } }));
  t('R5-L4: a has_more:true payload -> 200', r.status === 200, r.status);
  const hmPayment = database.prepare('SELECT * FROM payments WHERE id = ?').get(hmPaymentId);
  const hmBooking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(hmBookingId);
  t('R5-L4 VERDICT: refund_amount uses the LIVE figure (40), never the incomplete list\'s own frozen total (99.99)', hmPayment.refund_amount === 40, hmPayment.refund_amount);
  t('R5-L4 VERDICT: booking.total reduced by the live delta (100 -> 60)', hmBooking.total === 60, hmBooking.total);
  liveAmountRefundedCentsOverride = null;

  // --- R4-L1 GAP: the REALISTIC MODERN Stripe payload shape — charge.refunds is NOT
  // guaranteed present at all (stripe-node's own CHANGELOG documents Charge.refunds as
  // "not guaranteed to be returned by the Stripe API"). This is the COMMON case, not an
  // edge case: the handler must fetch the LIVE amount_refunded rather than trust the
  // frozen payload total. ------------------------------------------------------------------
  const gapCustomerId = uuid();
  database.prepare("INSERT INTO customers (id, first_name, last_name) VALUES (?, 'L1Gap', 'Test')").run(gapCustomerId);
  const gapBookingId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, 'BM-L1GAP-1', ?, 'confirmed', '2026-10-01', '11:00', '19:00', 100, 70, 50, 0, 'paid')`).run(gapBookingId, gapCustomerId);
  const gapPaymentId = uuid();
  // $100 charge, refund A ($30) already reflected (refund_amount=30, total already 70) —
  // exactly like the ooo fixture, but this payment's charge.refunded events will carry NO
  // refunds field at all (the modern shape).
  database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
    VALUES (?, ?, ?, 100, 'charge', 'stripe', 'pi_l1gap_1', 'completed', 30)`).run(gapPaymentId, gapBookingId, gapCustomerId);

  // (1) A stale/retried charge.refunded arrives with the modern shape: amount_refunded is
  // the STALE frozen cumulative ($50, as if B's since-canceled $20 were still counted), and
  // there is no refunds.data at all to cross-check against our ledger. The live lookup (the
  // authoritative current truth) reports $30 — must be trusted over the frozen $50, so this
  // is a no-op (delta 0 against the already-current 30).
  liveAmountRefundedCentsOverride = 3000;
  r = await post(chargeRefundedEvent('evt_l1gap_1', 5000, 'pi_l1gap_1', null));
  t('R4-L1 GAP (1): modern-shape stale charge.refunded (live lookup available) -> 200', r.status === 200, r.status);
  let gapPayment = database.prepare('SELECT * FROM payments WHERE id = ?').get(gapPaymentId);
  let gapBooking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(gapBookingId);
  t('R4-L1 GAP (1) VERDICT: refund_amount stays 30 (the LIVE truth), not the stale frozen $50', gapPayment.refund_amount === 30, gapPayment.refund_amount);
  t('R4-L1 GAP (1) VERDICT: booking.total stays 70, never re-reduced by the stale frozen total', gapBooking.total === 70, gapBooking.total);
  liveAmountRefundedCentsOverride = null;

  // (2) Same modern-shape stale event, but the live lookup ITSELF fails (Stripe outage).
  // Must NOT fall back to the frozen $50 — refuse with a non-2xx (503) so Stripe redelivers,
  // AND the event must not be recorded as processed (a later redelivery of the SAME event id
  // must still be handled, not swallowed as a duplicate).
  forceLiveLookupError = true;
  r = await post(chargeRefundedEvent('evt_l1gap_2', 5000, 'pi_l1gap_1', null));
  t('R4-L1 GAP (2): modern-shape stale charge.refunded with live lookup DOWN -> non-2xx (503)', r.status === 503, r.status);
  body = await r.json();
  t('R4-L1 GAP (2): the error body identifies the live check as unavailable', body.error === 'live_refund_check_unavailable', body);
  gapPayment = database.prepare('SELECT * FROM payments WHERE id = ?').get(gapPaymentId);
  gapBooking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(gapBookingId);
  t('R4-L1 GAP (2): refund_amount is UNCHANGED (still 30) — never guessed from the frozen total', gapPayment.refund_amount === 30, gapPayment.refund_amount);
  t('R4-L1 GAP (2): booking.total is UNCHANGED (still 70)', gapBooking.total === 70, gapBooking.total);
  const gapSeenRow = database.prepare('SELECT * FROM stripe_events_seen WHERE event_id = ?').get('evt_l1gap_2');
  t('R4-L1 GAP (2): the event is NOT recorded as processed (un-deduped), so Stripe\'s redelivery will be handled', !gapSeenRow, gapSeenRow);

  // Confirm the redelivery (SAME event id) actually gets processed once Stripe is reachable
  // again — proving (2)'s un-dedup is real, not just a missing row by coincidence.
  forceLiveLookupError = false;
  liveAmountRefundedCentsOverride = 3000;
  r = await post(chargeRefundedEvent('evt_l1gap_2', 5000, 'pi_l1gap_1', null));
  t('R4-L1 GAP (2): the SAME event id, redelivered once Stripe is reachable, is processed (not "duplicate") -> 200', r.status === 200, r.status);
  body = await r.json();
  t('R4-L1 GAP (2): the redelivery is NOT reported as a duplicate', body.duplicate !== true, body);
  gapPayment = database.prepare('SELECT * FROM payments WHERE id = ?').get(gapPaymentId);
  t('R4-L1 GAP (2): after the successful redelivery, refund_amount still correctly stays 30 (live truth)', gapPayment.refund_amount === 30, gapPayment.refund_amount);
  liveAmountRefundedCentsOverride = null;

  // (4) Normal IN-ORDER charge.refunded still works on the MODERN shape (no refunds field):
  // a fresh charge whose live amount_refunded genuinely matches the event's own cumulative
  // total must still record the refund and reduce the booking normally via the fallback path.
  const gap2CustomerId = uuid();
  database.prepare("INSERT INTO customers (id, first_name, last_name) VALUES (?, 'L1Gap2', 'Test')").run(gap2CustomerId);
  const gap2BookingId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, 'BM-L1GAP-2', ?, 'confirmed', '2026-10-01', '11:00', '19:00', 100, 100, 50, 0, 'paid')`).run(gap2BookingId, gap2CustomerId);
  const gap2PaymentId = uuid();
  database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
    VALUES (?, ?, ?, 100, 'charge', 'stripe', 'pi_l1gap_2', 'completed', 0)`).run(gap2PaymentId, gap2BookingId, gap2CustomerId);
  liveAmountRefundedCentsOverride = 4000; // matches the event's own cumulative below — a genuine, in-order $40 refund
  r = await post(chargeRefundedEvent('evt_l1gap_3', 4000, 'pi_l1gap_2', null));
  t('R4-L1 GAP (4): normal in-order modern-shape charge.refunded -> 200', r.status === 200, r.status);
  const gap2Payment = database.prepare('SELECT * FROM payments WHERE id = ?').get(gap2PaymentId);
  const gap2Booking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(gap2BookingId);
  t('R4-L1 GAP (4): refund_amount correctly becomes 40 via the live-lookup fallback', gap2Payment.refund_amount === 40, gap2Payment.refund_amount);
  t('R4-L1 GAP (4): booking.total correctly reduced to 60', gap2Booking.total === 60, gap2Booking.total);
  liveAmountRefundedCentsOverride = null;

  // --- R5-L3: a cheap payment match BEFORE ever calling Stripe. An event for a charge
  // this app has no payment for must return 200 WITHOUT calling Stripe at all — even when
  // Stripe is completely down (forceLiveLookupError=true would otherwise turn this into an
  // avoidable 503 that Stripe would then retry for up to 3 days). --------------------------
  {
    forceLiveLookupError = true;
    const callsBefore = liveLookupCallCount;
    const r2 = await post(chargeRefundedEvent('evt_unknown_charge_1', 9999, 'pi_does_not_exist_at_all', null));
    const body2 = await r2.json();
    t('R5-L3: an unknown charge with Stripe DOWN -> 200 (not 503)', r2.status === 200 && body2.received === true, { status: r2.status, body: body2 });
    t('R5-L3: Stripe was never actually called for the unknown charge', liveLookupCallCount === callsBefore, { before: callsBefore, after: liveLookupCallCount });
    forceLiveLookupError = false;
  }

  // --- R5-L2: stripe_events_seen gets a processing -> done lifecycle ---------------------
  {
    // (a) A concurrent duplicate arriving while the FIRST delivery is still 'processing'
    // (waiting on the live lookup below) must NOT get 200 duplicate:true — Stripe would
    // then have no reason to ever redeliver an event this app hasn't actually finished. It
    // gets 409 instead, so Stripe retries on its own schedule.
    const procCustomerId = uuid();
    database.prepare("INSERT INTO customers (id, first_name, last_name) VALUES (?, 'Proc', 'Test')").run(procCustomerId);
    const procBookingId = uuid();
    database.prepare(`INSERT INTO bookings
      (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
      VALUES (?, 'BM-PROC-1', ?, 'confirmed', '2026-10-01', '11:00', '19:00', 100, 100, 50, 0, 'paid')`).run(procBookingId, procCustomerId);
    const procPaymentId = uuid();
    database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
      VALUES (?, ?, ?, 100, 'charge', 'stripe', 'pi_proc_1', 'completed', 0)`).run(procPaymentId, procBookingId, procCustomerId);

    liveAmountRefundedCentsOverride = 3000;
    liveLookupDelayMs = 200;
    const evtProcBody = chargeRefundedEvent('evt_proc_1', 3000, 'pi_proc_1', null);
    const [firstRes, secondRes] = await Promise.all([
      post(evtProcBody),
      sleep(50).then(() => post(evtProcBody)),
    ]);
    liveLookupDelayMs = 0;
    t('R5-L2: the first (slow) delivery eventually succeeds -> 200', firstRes.status === 200, firstRes.status);
    t('R5-L2: a concurrent duplicate while still processing -> 409, NOT 200 duplicate:true', secondRes.status === 409, secondRes.status);
    const secondBody = await secondRes.json();
    t('R5-L2: the 409 tells Stripe to retry, never reports duplicate:true', secondBody.duplicate !== true, secondBody);
    const procPayment = database.prepare('SELECT * FROM payments WHERE id = ?').get(procPaymentId);
    t('R5-L2: the event was still only actually processed once (refund_amount = 30, not doubled)', procPayment.refund_amount === 30, procPayment.refund_amount);
    const procSeenRow = database.prepare('SELECT * FROM stripe_events_seen WHERE event_id = ?').get('evt_proc_1');
    t('R5-L2: the row ends up done after the slow delivery finishes', procSeenRow && procSeenRow.status === 'done', procSeenRow);

    // (b) A THIRD delivery of the same event, now that it's genuinely done, is a normal
    // safe duplicate — proving 409 above was about timing, not a permanent block.
    const thirdRes = await post(evtProcBody);
    const thirdBody = await thirdRes.json();
    t('R5-L2: a THIRD delivery once done -> 200 duplicate:true', thirdRes.status === 200 && thirdBody.duplicate === true, thirdBody);
    liveAmountRefundedCentsOverride = null;
  }

  // (c) A stale 'processing' row (simulating an earlier crash mid-handler, which never
  // reached the UPDATE-to-done or the DELETE-on-failure) is reclaimed and processed fresh,
  // not 409'd forever.
  {
    const staleEventId = 'evt_stale_processing_1';
    database.prepare("INSERT INTO stripe_events_seen (event_id, status, created_at) VALUES (?, 'processing', datetime('now', '-10 minutes'))").run(staleEventId);
    const staleCustomerId = uuid();
    database.prepare("INSERT INTO customers (id, first_name, last_name) VALUES (?, 'Stale', 'Test')").run(staleCustomerId);
    const staleBookingId = uuid();
    database.prepare(`INSERT INTO bookings
      (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
      VALUES (?, 'BM-STALEPROC-1', ?, 'confirmed', '2026-10-01', '11:00', '19:00', 100, 100, 50, 0, 'paid')`).run(staleBookingId, staleCustomerId);
    const stalePaymentId = uuid();
    database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
      VALUES (?, ?, ?, 100, 'charge', 'stripe', 'pi_stale_1', 'completed', 0)`).run(stalePaymentId, staleBookingId, staleCustomerId);
    liveAmountRefundedCentsOverride = 2000;
    const r3 = await post(chargeRefundedEvent(staleEventId, 2000, 'pi_stale_1', null));
    const body3 = await r3.json();
    t('R5-L2: a stale (>5min) processing row is reclaimed and actually processed, not 409\'d', r3.status === 200 && body3.duplicate !== true, { status: r3.status, body: body3 });
    const stalePayment = database.prepare('SELECT * FROM payments WHERE id = ?').get(stalePaymentId);
    t('R5-L2: the reclaimed event was actually applied (refund_amount = 20)', stalePayment.refund_amount === 20, stalePayment.refund_amount);
    const staleSeenRow = database.prepare('SELECT * FROM stripe_events_seen WHERE event_id = ?').get(staleEventId);
    t('R5-L2: the reclaimed row ends up done', staleSeenRow && staleSeenRow.status === 'done', staleSeenRow);
    liveAmountRefundedCentsOverride = null;
  }

  // (c2) Hardening: the reclaim's WHERE clause (status='processing' AND created_at <=
  // cutoff), not a preceding SELECT, is what gates it — a direct proof that only ONE of
  // two identical reclaim attempts against the SAME stale row can ever succeed, exactly
  // the compare-and-swap the fix relies on for real cross-process safety (two real OS
  // processes can't both interleave a SELECT and an unconditional UPDATE the way a single
  // process's synchronous dedup block never could in the first place).
  {
    const atomicEventId = 'evt_atomic_reclaim_1';
    const oldCutoff = new Date(Date.now() - 6 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    database.prepare("INSERT INTO stripe_events_seen (event_id, status, created_at) VALUES (?, 'processing', datetime('now', '-10 minutes'))").run(atomicEventId);
    const reclaimSql = "UPDATE stripe_events_seen SET created_at = datetime('now') WHERE event_id = ? AND status = 'processing' AND created_at <= ?";
    const first = database.prepare(reclaimSql).run(atomicEventId, oldCutoff);
    const second = database.prepare(reclaimSql).run(atomicEventId, oldCutoff);
    t('R5-L2 (atomic reclaim): the FIRST reclaim attempt against a stale row succeeds (changes=1)', first.changes === 1, first);
    t('R5-L2 (atomic reclaim): the SECOND attempt against the SAME row fails (changes=0) — the first already moved created_at past the cutoff', second.changes === 0, second);
  }

  // (c3) Hardening at the HTTP layer: a stale processing row whose reclaimer is still mid-
  // flight (a slow live lookup) must make a CONCURRENT duplicate delivery of the SAME event
  // get 409, never a second successful process — exactly "a stale processing row + two
  // reclaim attempts -> exactly one processes, the other gets 409".
  {
    const raceEventId = 'evt_stale_race_1';
    database.prepare("INSERT INTO stripe_events_seen (event_id, status, created_at) VALUES (?, 'processing', datetime('now', '-10 minutes'))").run(raceEventId);
    const raceCustomerId = uuid();
    database.prepare("INSERT INTO customers (id, first_name, last_name) VALUES (?, 'StaleRace', 'Test')").run(raceCustomerId);
    const raceBookingId = uuid();
    database.prepare(`INSERT INTO bookings
      (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
      VALUES (?, 'BM-STALERACE-1', ?, 'confirmed', '2026-10-01', '11:00', '19:00', 100, 100, 50, 0, 'paid')`).run(raceBookingId, raceCustomerId);
    const racePaymentId = uuid();
    database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
      VALUES (?, ?, ?, 100, 'charge', 'stripe', 'pi_stale_race_1', 'completed', 0)`).run(racePaymentId, raceBookingId, raceCustomerId);

    liveAmountRefundedCentsOverride = 1500;
    liveLookupDelayMs = 200;
    const raceEventBody = chargeRefundedEvent(raceEventId, 1500, 'pi_stale_race_1', null);
    const [raceFirst, raceSecond] = await Promise.all([
      post(raceEventBody),
      sleep(50).then(() => post(raceEventBody)),
    ]);
    liveLookupDelayMs = 0;
    t('R5-L2 (atomic reclaim): the reclaiming delivery eventually succeeds -> 200', raceFirst.status === 200, raceFirst.status);
    t('R5-L2 (atomic reclaim): a concurrent duplicate of the SAME stale event gets 409, never a second success', raceSecond.status === 409, raceSecond.status);
    const raceSecondBody = await raceSecond.json();
    t('R5-L2 (atomic reclaim): the 409 asks Stripe to retry, never reports duplicate:true', raceSecondBody.duplicate !== true, raceSecondBody);
    const racePayment = database.prepare('SELECT * FROM payments WHERE id = ?').get(racePaymentId);
    t('R5-L2 (atomic reclaim): the event was applied exactly once (refund_amount = 15, not doubled)', racePayment.refund_amount === 15, racePayment.refund_amount);
    const raceSeenRow = database.prepare('SELECT * FROM stripe_events_seen WHERE event_id = ?').get(raceEventId);
    t('R5-L2 (atomic reclaim): the row ends up done', raceSeenRow && raceSeenRow.status === 'done', raceSeenRow);
    liveAmountRefundedCentsOverride = null;
  }

  // (d) 30-day prune still works with the new status column — age is what matters, not
  // status; a 'done' and a 'processing' row are both pruned once old enough.
  {
    const { v4: uuidL8b } = require('uuid');
    const doneOldId = uuidL8b();
    const procOldId = uuidL8b();
    database.prepare("INSERT INTO stripe_events_seen (event_id, status, created_at) VALUES (?, 'done', datetime('now', '-40 days'))").run(doneOldId);
    database.prepare("INSERT INTO stripe_events_seen (event_id, status, created_at) VALUES (?, 'processing', datetime('now', '-40 days'))").run(procOldId);
    db.initialize();
    const doneOldRow = database.prepare('SELECT * FROM stripe_events_seen WHERE event_id = ?').get(doneOldId);
    const procOldRow = database.prepare('SELECT * FROM stripe_events_seen WHERE event_id = ?').get(procOldId);
    t('R5-L2: 30-day prune still removes an old row regardless of status (done)', !doneOldRow, doneOldRow);
    t('R5-L2: 30-day prune still removes an old row regardless of status (processing)', !procOldRow, procOldRow);
  }

  // (e) R6-L1: attempt_id ownership scoping — a stale row reclaimed by attempt B while
  // attempt A is still (slowly) mid-handler. A's late 'done' UPDATE and error DELETE must
  // NOT touch B's row (both scoped `AND attempt_id = ?`); B's own 'done' UPDATE succeeds.
  // Calls the REAL production functions (webhookRoutes._test.reclaimStaleEvent/
  // markEventDone/deleteEventAttempt) — not a hand-copied SQL duplicate — so a regression
  // in the actual scoping fails this test, not just a divergent copy of it (round-7
  // mutation pass: an earlier draft of this suite used its own copy of the CAS and missed
  // exactly this kind of regression).
  {
    const { reclaimStaleEvent, markEventDone, deleteEventAttempt } = webhookRoutes._test;
    const ownershipEventId = 'evt_ownership_1';
    const attemptA = 'attempt-A-slow-original';
    const attemptB = 'attempt-B-reclaimer';
    database.prepare("INSERT INTO stripe_events_seen (event_id, status, attempt_id, created_at) VALUES (?, 'processing', ?, datetime('now', '-10 minutes'))").run(ownershipEventId, attemptA);

    const reclaim = reclaimStaleEvent(database, ownershipEventId, attemptB);
    t('R6-L1: attempt B successfully reclaims the stale row', reclaim.changes === 1, reclaim);
    let row = database.prepare('SELECT * FROM stripe_events_seen WHERE event_id = ?').get(ownershipEventId);
    t('R6-L1: the row now carries B\'s attempt_id', row.attempt_id === attemptB, row);

    // A, unaware it was reclaimed, finally finishes (or fails) — both must be no-ops.
    const aDone = markEventDone(database, ownershipEventId, attemptA);
    t('R6-L1: A\'s late done-UPDATE touches ZERO rows (no longer owns it)', aDone.changes === 0, aDone);
    row = database.prepare('SELECT * FROM stripe_events_seen WHERE event_id = ?').get(ownershipEventId);
    t('R6-L1: the row is UNCHANGED by A\'s done-UPDATE (still processing, still B\'s attempt_id)', row.status === 'processing' && row.attempt_id === attemptB, row);
    const aDelete = deleteEventAttempt(database, ownershipEventId, attemptA);
    t('R6-L1: A\'s late error-DELETE touches ZERO rows (no longer owns it)', aDelete.changes === 0, aDelete);
    row = database.prepare('SELECT * FROM stripe_events_seen WHERE event_id = ?').get(ownershipEventId);
    t('R6-L1: the row STILL EXISTS after A\'s delete attempt (B\'s row survives)', !!row, row);

    // B finishes normally.
    const bDone = markEventDone(database, ownershipEventId, attemptB);
    t('R6-L1: B\'s own done-UPDATE succeeds (B still owns the row)', bDone.changes === 1, bDone);
    row = database.prepare('SELECT * FROM stripe_events_seen WHERE event_id = ?').get(ownershipEventId);
    t('R6-L1: the row ends up done, owned by B', row.status === 'done' && row.attempt_id === attemptB, row);
  }

  // (f) R6-L1: stillOwnsEventAttempt — the exact gate a queued notification checks before
  // firing. True while this attempt's own attempt_id still matches the row; false once a
  // redelivery has reclaimed it (the "notification skip" mechanism itself).
  {
    const { stillOwnsEventAttempt } = webhookRoutes._test;
    const ownEventId = 'evt_ownership_check_1';
    const myAttempt = 'attempt-mine';
    const otherAttempt = 'attempt-reclaimed-by-someone-else';
    database.prepare("INSERT INTO stripe_events_seen (event_id, status, attempt_id, created_at) VALUES (?, 'processing', ?, datetime('now'))").run(ownEventId, myAttempt);
    t('R6-L1: stillOwnsEventAttempt is true while this attempt still owns the row', stillOwnsEventAttempt(database, ownEventId, myAttempt) === true, null);
    database.prepare('UPDATE stripe_events_seen SET attempt_id = ? WHERE event_id = ?').run(otherAttempt, ownEventId);
    t('R6-L1: stillOwnsEventAttempt is false once reclaimed by a different attempt_id — this is what gates the notification skip', stillOwnsEventAttempt(database, ownEventId, myAttempt) === false, null);
    t('R6-L1: stillOwnsEventAttempt is false for an event this attempt never owned at all', stillOwnsEventAttempt(database, 'evt_never_existed_at_all', myAttempt) === false, null);
  }

  // (f2) R6-I3 (following routes/office.js's own precedent): router._test must be ABSENT
  // under NODE_ENV==='production' — spawned as a real child process (a fresh `require`
  // cache), since this process already has routes/webhooks.js cached with _test attached.
  {
    const probeScript = `
      process.env.NODE_ENV = 'production';
      process.env.DB_PATH = ${JSON.stringify(path.join(TMP_DIR, 'prod-probe-webhooks.db'))};
      process.env.STRIPE_EVENT_WEBHOOK_SECRET = 'whsec_test_dummy';
      process.env.SARAH_API_KEY = 'test-sarah-key';
      const routes = require(${JSON.stringify(path.join(__dirname, '..', 'routes', 'webhooks.js'))});
      console.log(JSON.stringify({ hasTest: typeof routes._test !== 'undefined' }));
    `;
    const out = execFileSync('node', ['-e', probeScript], { encoding: 'utf8' });
    const parsed = JSON.parse(out.trim());
    t('R6-I3: under NODE_ENV=production, routes/webhooks.js\'s router._test is absent', parsed.hasTest === false, parsed);
  }

  // (g) R6-L1: static/unit check — the Slack fetch calls reachable from this webhook's
  // non-money side effects carry an AbortSignal, and the nodemailer transport carries
  // explicit timeouts. No real network: global.fetch and nodemailer.createTransport are
  // stubbed.
  {
    const capturedFetchCalls = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => {
      capturedFetchCalls.push({ url, opts });
      return { ok: true, json: async () => ({ ok: true, ts: '123.456' }) };
    };
    const notifications = require('../services/notifications');
    await notifications.notifyNewBooking(
      { id: 'fake-booking-timeout-check', booking_number: 'BM-TIMEOUT-TEST', total: 100 },
      { first_name: 'Timeout', last_name: 'Test' },
      []
    );
    global.fetch = realFetch;
    t('R6-L1: notifyNewBooking\'s Slack post carries an AbortSignal (10s timeout)',
      capturedFetchCalls.length > 0 && capturedFetchCalls[0].opts && capturedFetchCalls[0].opts.signal instanceof AbortSignal,
      capturedFetchCalls);

    const nodemailerModule = require('nodemailer');
    const realCreateTransport = nodemailerModule.createTransport;
    let capturedTransportOpts = null;
    nodemailerModule.createTransport = (opts) => {
      capturedTransportOpts = opts;
      return { sendMail: async () => ({ messageId: 'fake' }) };
    };
    const emailService = require('../services/email');
    await emailService.sendTestEmail('r6l1-timeout-check@example.com');
    nodemailerModule.createTransport = realCreateTransport;
    t('R6-L1: the nodemailer transport carries connectionTimeout/greetingTimeout/socketTimeout ~30s',
      !!capturedTransportOpts && capturedTransportOpts.connectionTimeout === 30000 &&
      capturedTransportOpts.greetingTimeout === 30000 && capturedTransportOpts.socketTimeout === 30000,
      capturedTransportOpts);
  }

  // (h) R6-L2: the INSERT OR IGNORE conflicts (changes=0) but the row VANISHES before the
  // follow-up SELECT can read it — only possible across processes (another process's own
  // first delivery just failed and DELETEd it); simulated here by hooking db.prepare to
  // delete the row between the two statements. Must be 409 (let Stripe retry), never a
  // silent 200 duplicate:true that ACKs an event nothing ever actually processed.
  {
    const vanishEventId = 'evt_vanish_1';
    database.prepare("INSERT INTO stripe_events_seen (event_id, status, created_at) VALUES (?, 'processing', datetime('now'))").run(vanishEventId);
    const realPrepare = database.prepare.bind(database);
    let hookFired = false;
    database.prepare = (sql) => {
      const stmt = realPrepare(sql);
      if (!hookFired && sql === 'SELECT status, created_at FROM stripe_events_seen WHERE event_id = ?') {
        hookFired = true;
        return {
          get: (...args) => {
            realPrepare('DELETE FROM stripe_events_seen WHERE event_id = ?').run(args[0]);
            return stmt.get(...args);
          },
        };
      }
      return stmt;
    };
    const r = await post(chargeRefundedEvent(vanishEventId, 1000, 'pi_vanish_1', null));
    database.prepare = realPrepare;
    const body = await r.json();
    t('R6-L2: a dedup row vanishing between INSERT and SELECT -> 409, never 200 duplicate:true', r.status === 409 && body.duplicate !== true, { status: r.status, body });
    const rowAfter = database.prepare('SELECT * FROM stripe_events_seen WHERE event_id = ?').get(vanishEventId);
    t('R6-L2: no row was left behind falsely claiming this event was processed', !rowAfter, rowAfter);
  }

  // (i) R6-L3 mutant #1 (survived: CAS without `status = 'processing'`): a DONE row with an
  // OLD created_at must NOT be reclaimed/reprocessed — a redelivery gets 200 duplicate via
  // the normal 'done' short-circuit (never even reaching the CAS), AND the CAS statement
  // run alone against that same row (bypassing the short-circuit) must return changes=0.
  // Calls the REAL webhookRoutes._test.reclaimStaleEvent (not a hand-copied SQL string) —
  // confirmed by temporarily dropping `status = 'processing'` from the PRODUCTION query
  // (routes/webhooks.js) and re-running this suite: the CAS assertion below FAILED
  // (changes became 1), then reverted.
  {
    const { reclaimStaleEvent } = webhookRoutes._test;
    const doneOldEventId = 'evt_done_old_1';
    database.prepare("INSERT INTO stripe_events_seen (event_id, status, attempt_id, created_at) VALUES (?, 'done', 'attempt-old-done', datetime('now', '-10 minutes'))").run(doneOldEventId);

    const result = reclaimStaleEvent(database, doneOldEventId, 'attempt-should-never-win');
    t('R6-L3: the CAS ALONE against a DONE row (even with an old created_at) returns changes=0', result.changes === 0, result);

    const doneOldCustomerId = uuid();
    database.prepare("INSERT INTO customers (id, first_name, last_name) VALUES (?, 'DoneOld', 'Test')").run(doneOldCustomerId);
    const doneOldBookingId = uuid();
    database.prepare(`INSERT INTO bookings
      (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
      VALUES (?, 'BM-DONEOLD-1', ?, 'confirmed', '2026-10-01', '11:00', '19:00', 100, 100, 50, 0, 'paid')`).run(doneOldBookingId, doneOldCustomerId);
    const doneOldPaymentId = uuid();
    database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
      VALUES (?, ?, ?, 100, 'charge', 'stripe', 'pi_done_old_1', 'completed', 0)`).run(doneOldPaymentId, doneOldBookingId, doneOldCustomerId);
    const r = await post(chargeRefundedEvent(doneOldEventId, 9999, 'pi_done_old_1', null));
    const body = await r.json();
    t('R6-L3: a redelivery of a DONE (old) row -> 200 duplicate:true, never reprocessed', r.status === 200 && body.duplicate === true, body);
    const doneOldPayment = database.prepare('SELECT * FROM payments WHERE id = ?').get(doneOldPaymentId);
    t('R6-L3: the payment was never touched by the redelivery (refund_amount stays 0)', doneOldPayment.refund_amount === 0, doneOldPayment);
  }

  // (j) R6-I2: clock skew — a 'processing' row whose created_at is more than 1 minute in
  // the FUTURE (a container clock briefly ahead) is treated as stale and reclaimed, inside
  // the same atomic CAS WHERE clause (not a separate check).
  {
    const { reclaimStaleEvent } = webhookRoutes._test;
    const skewedEventId = 'evt_clock_skew_1';
    database.prepare("INSERT INTO stripe_events_seen (event_id, status, attempt_id, created_at) VALUES (?, 'processing', 'attempt-skewed-original', datetime('now', '+10 minutes'))").run(skewedEventId);
    const reclaim = reclaimStaleEvent(database, skewedEventId, 'attempt-skew-reclaimer');
    t('R6-I2: a row 10 minutes in the FUTURE is reclaimed (clock skew treated as stale)', reclaim.changes === 1, reclaim);

    // Within the 1-minute tolerance: NOT reclaimed (ordinary clock jitter, not skew).
    const jitterEventId = 'evt_clock_jitter_1';
    database.prepare("INSERT INTO stripe_events_seen (event_id, status, attempt_id, created_at) VALUES (?, 'processing', 'attempt-jitter-original', datetime('now', '+30 seconds'))").run(jitterEventId);
    const jitterReclaim = reclaimStaleEvent(database, jitterEventId, 'attempt-should-not-reclaim-jitter');
    t('R6-I2: a row only 30s ahead (within tolerance) is NOT reclaimed', jitterReclaim.changes === 0, jitterReclaim);

    // HTTP-level: a genuinely skewed row gets processed (200, not 409), not stuck forever.
    const skewedHttpEventId = 'evt_clock_skew_http_1';
    database.prepare("INSERT INTO stripe_events_seen (event_id, status, created_at) VALUES (?, 'processing', datetime('now', '+10 minutes'))").run(skewedHttpEventId);
    const skewCustomerId = uuid();
    database.prepare("INSERT INTO customers (id, first_name, last_name) VALUES (?, 'Skew', 'Test')").run(skewCustomerId);
    const skewBookingId = uuid();
    database.prepare(`INSERT INTO bookings
      (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
      VALUES (?, 'BM-CLOCKSKEW-1', ?, 'confirmed', '2026-10-01', '11:00', '19:00', 100, 100, 50, 0, 'paid')`).run(skewBookingId, skewCustomerId);
    const skewPaymentId = uuid();
    database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
      VALUES (?, ?, ?, 100, 'charge', 'stripe', 'pi_clock_skew_1', 'completed', 0)`).run(skewPaymentId, skewBookingId, skewCustomerId);
    liveAmountRefundedCentsOverride = 2500;
    const skewR = await post(chargeRefundedEvent(skewedHttpEventId, 2500, 'pi_clock_skew_1', null));
    const skewBody = await skewR.json();
    t('R6-I2: an HTTP redelivery of a future-skewed processing row is reclaimed and processed (200, not 409)', skewR.status === 200 && skewBody.duplicate !== true, { status: skewR.status, body: skewBody });
    const skewPayment = database.prepare('SELECT * FROM payments WHERE id = ?').get(skewPaymentId);
    t('R6-I2: the skewed-clock event was actually applied (refund_amount = 25)', skewPayment.refund_amount === 25, skewPayment.refund_amount);
    liveAmountRefundedCentsOverride = null;
  }

  // (k) R6-L3 mutant #2 (survived: migration `DEFAULT 'done'` -> `'processing'`): create an
  // OLD-schema stripe_events_seen (no status/attempt_id columns) with one pre-existing row
  // in a throwaway DB, run initialize() in a FRESH child process (a fresh require cache —
  // this process's db.js module is already initialized against the main TMP_DIR db), and
  // assert the row comes out status='done' with the attempt_id column present (NULL), and
  // that a redelivery of that same event id is recognized as an already-done duplicate.
  // Confirmed by temporarily changing the migration's `DEFAULT 'done'` to
  // `DEFAULT 'processing'` and re-running this suite: the assertions below FAILED
  // (migratedStatus became 'processing', redeliveryWouldBeDuplicate became false), then
  // reverted.
  {
    const MIGRATION_TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-refund-webhook-migration-'));
    const migrationDbPath = path.join(MIGRATION_TMP_DIR, 'old-schema.db');
    const Database = require('better-sqlite3');
    const oldSchemaDb = new Database(migrationDbPath);
    oldSchemaDb.exec("CREATE TABLE stripe_events_seen (event_id TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now')))");
    oldSchemaDb.prepare("INSERT INTO stripe_events_seen (event_id, created_at) VALUES ('evt_pre_migration_1', datetime('now', '-1 hour'))").run();
    oldSchemaDb.close();

    const probeScript = `
      process.env.NODE_ENV = 'test';
      process.env.DB_PATH = ${JSON.stringify(migrationDbPath)};
      const { getDb, initialize } = require(${JSON.stringify(path.join(__dirname, '..', 'db.js'))});
      initialize();
      const db = getDb();
      const row = db.prepare('SELECT status, attempt_id FROM stripe_events_seen WHERE event_id = ?').get('evt_pre_migration_1');
      const dedupInfo = db.prepare("INSERT OR IGNORE INTO stripe_events_seen (event_id, status, attempt_id) VALUES (?, 'processing', ?)").run('evt_pre_migration_1', 'child-redelivery-attempt');
      const existing = db.prepare('SELECT status FROM stripe_events_seen WHERE event_id = ?').get('evt_pre_migration_1');
      console.log(JSON.stringify({
        migratedStatus: row.status,
        migratedAttemptIdColumnPresent: Object.prototype.hasOwnProperty.call(row, 'attempt_id'),
        migratedAttemptIdValue: row.attempt_id,
        dedupInsertChanges: dedupInfo.changes,
        redeliveryWouldBeDuplicate: existing.status === 'done',
      }));
    `;
    const out = execFileSync('node', ['-e', probeScript], { encoding: 'utf8' });
    // db.js's own initialize() logs several lines of its own (e.g. default-admin-user
    // creation) — our JSON is always the LAST line printed.
    const lastLine = out.trim().split('\n').pop();
    const parsed = JSON.parse(lastLine);
    t('R6-L3 (migration): a pre-existing row (created before the status column existed) migrates to status=\'done\'', parsed.migratedStatus === 'done', parsed);
    t('R6-L3 (migration): the attempt_id column exists on the migrated row (NULL for a pre-existing row)', parsed.migratedAttemptIdColumnPresent === true && parsed.migratedAttemptIdValue === null, parsed);
    t('R6-L3 (migration): a redelivery of that same event id is recognized as an already-done duplicate', parsed.dedupInsertChanges === 0 && parsed.redeliveryWouldBeDuplicate === true, parsed);
    fs.rmSync(MIGRATION_TMP_DIR, { recursive: true, force: true });
  }

  server.close();
  database.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
