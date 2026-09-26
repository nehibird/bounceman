// R2-H1: the pre-refund live Stripe charge check must FAIL CLOSED. Round 2 fell back to
// the webhook/ledger-only view on any error and let the refund proceed — this suite
// proves that for a throw, a timeout, `latest_charge: null`, a missing `amount_refunded`,
// and an `amount_refunded` sent as a string, the refund request is refused with 503
// BEFORE any reservation and with ZERO `refunds.create` calls (both for a real attempt
// and for `dry_run`).
//
// Run from the app root: node tests/office-live-check.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-office-livecheck-'));
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

const stripeRefundCalls = [];
let retrieveBehavior = null; // set per-test: a function(id) -> Promise, or a function that never resolves for the timeout case

const fakeStripe = {
  refunds: { create: async (params, opts) => { stripeRefundCalls.push({ params, opts }); return { id: `re_live_${stripeRefundCalls.length}`, status: 'succeeded' }; } },
  paymentIntents: {
    retrieve: async (id, params, opts) => {
      // Every booking in this file is a flat $200 payment (see makeBookingAndPayment) —
      // R3-L2 requires a real integer `amount`/`currency`, so the default (no override)
      // response must match that captured amount exactly.
      if (!retrieveBehavior) return { id, latest_charge: { id: `ch_for_${id}`, amount: 20000, amount_refunded: 0, currency: 'usd' } };
      return retrieveBehavior(id, opts);
    },
  },
  charges: { retrieve: async (id) => ({ id, amount: 20000, amount_refunded: 0, currency: 'usd' }) },
};
stripeService._setStripeForTests(fakeStripe);

const officeRoutes = require('../routes/office');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  ${detail !== undefined ? JSON.stringify(detail) : ''}`));
}

function makeBookingAndPayment(bookingNumber, piId) {
  const customerId = uuid();
  database.prepare(`INSERT INTO customers (id, first_name, last_name, email, phone) VALUES (?, 'Live', 'Check', 'livecheck@example.com', '5559871234')`).run(customerId);
  const bookingId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, ?, ?, 'confirmed', '2026-11-01', '11:00', '19:00', 200, 200, 50, 0, 'paid')`)
    .run(bookingId, bookingNumber, customerId);
  const paymentId = uuid();
  database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
    VALUES (?, ?, ?, 200, 'charge', 'stripe', ?, 'completed', 0)`).run(paymentId, bookingId, customerId, piId);
  return { bookingId, paymentId };
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

  const cases = [
    {
      name: 'throws',
      setup: () => { retrieveBehavior = () => { throw new Error('simulated Stripe outage'); }; },
    },
    {
      name: 'timeout',
      setup: () => {
        retrieveBehavior = (id, opts) => new Promise((resolve, reject) => {
          // A real timeout would eventually reject via stripe-node's own {timeout} option;
          // simulate that rejection directly rather than actually waiting out a real clock.
          const err = new Error('Request timed out communicating with Stripe');
          err.code = 'ETIMEDOUT';
          setTimeout(() => reject(err), 5);
        });
      },
    },
    {
      name: 'latest_charge null',
      setup: () => { retrieveBehavior = (id) => Promise.resolve({ id, latest_charge: null }); },
    },
    {
      name: 'amount_refunded missing',
      setup: () => { retrieveBehavior = (id) => Promise.resolve({ id, latest_charge: { id: `ch_for_${id}` } }); },
    },
    {
      name: 'amount_refunded as a string',
      setup: () => { retrieveBehavior = (id) => Promise.resolve({ id, latest_charge: { id: `ch_for_${id}`, amount_refunded: '0' } }); },
    },
    // R3-L2/M17-M19: a MISSING amount or currency must fail closed exactly like a wrong
    // one — round 2 only rejected a wrong value and let a missing one silently pass.
    {
      name: 'amount missing',
      setup: () => { retrieveBehavior = (id) => Promise.resolve({ id, latest_charge: { id: `ch_for_${id}`, amount_refunded: 0, currency: 'usd' } }); },
    },
    {
      name: 'currency missing',
      setup: () => { retrieveBehavior = (id) => Promise.resolve({ id, latest_charge: { id: `ch_for_${id}`, amount_refunded: 0, amount: 20000 } }); },
    },
  ];

  for (const { name, setup } of cases) {
    const piId = `pi_live_${name.replace(/\W+/g, '_')}`;
    const { bookingId } = makeBookingAndPayment(`BM-LIVECHECK-${name.replace(/\W+/g, '-').toUpperCase()}`, piId);
    const { rawKey } = createApiKey(database, { name: `livecheck-${name.replace(/\W+/g, '-')}-key`, scopes: ['refunds:create'], maxRefundCents: 20000, dailyRefundCapCents: 50000 });

    setup();
    const refundsBefore = stripeRefundCalls.length;
    const ledgerRowsBefore = database.prepare('SELECT COUNT(*) c FROM office_refunds WHERE booking_id = ?').get(bookingId).c;

    let r = await write('POST', `/bookings/BM-LIVECHECK-${name.replace(/\W+/g, '-').toUpperCase()}/refunds`, rawKey, {
      idempotencyKey: `idem-live-${name.replace(/\W+/g, '-')}-real`, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    let body = await r.json();
    t(`[${name}] real refund attempt -> 503 live_check_unavailable`, r.status === 503 && body.error === 'live_check_unavailable', body);
    t(`[${name}] no office_refunds reservation was made`, database.prepare('SELECT COUNT(*) c FROM office_refunds WHERE booking_id = ?').get(bookingId).c === ledgerRowsBefore, bookingId);
    t(`[${name}] zero Stripe refund calls were made`, stripeRefundCalls.length === refundsBefore, stripeRefundCalls.length);

    setup(); // some behaviors are one-shot-ish via setTimeout state; re-arm for the dry_run call
    r = await write('POST', `/bookings/BM-LIVECHECK-${name.replace(/\W+/g, '-').toUpperCase()}/refunds`, rawKey, {
      idempotencyKey: `idem-live-${name.replace(/\W+/g, '-')}-dryrun`, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000, dry_run: true,
    });
    t(`[${name}] dry_run also fails closed at 503`, r.status === 503, r.status);
    retrieveBehavior = null;
  }

  // Sanity: the happy path (valid data) still works and reports live_charge_checked:true.
  {
    const piId = 'pi_live_ok';
    makeBookingAndPayment('BM-LIVECHECK-OK', piId);
    const { rawKey } = createApiKey(database, { name: 'livecheck-ok-key', scopes: ['refunds:create'], maxRefundCents: 20000, dailyRefundCapCents: 50000 });
    retrieveBehavior = null;
    const r = await write('POST', '/bookings/BM-LIVECHECK-OK/refunds', rawKey, {
      idempotencyKey: 'idem-live-ok', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    const body = await r.json();
    t('valid live data -> 201, live_charge_checked:true', r.status === 201 && body.live_charge_checked === true, body);
  }

  // Client timeout/maxNetworkRetries wiring: the live-check request options passed to
  // paymentIntents.retrieve are {timeout, maxNetworkRetries:0} — proves R2-H1's "0
  // retries + its own short timeout" choice actually reaches the Stripe call, not just
  // the client default.
  {
    let capturedOpts = null;
    retrieveBehavior = (id, opts) => { capturedOpts = opts; return Promise.resolve({ id, latest_charge: { id: `ch_for_${id}`, amount_refunded: 0 } }); };
    makeBookingAndPayment('BM-LIVECHECK-OPTS', 'pi_live_opts');
    const { rawKey } = createApiKey(database, { name: 'livecheck-opts-key', scopes: ['refunds:create'] });
    await write('POST', '/bookings/BM-LIVECHECK-OPTS/refunds', rawKey, {
      idempotencyKey: 'idem-live-opts', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 1000, dry_run: true,
    });
    t('R2-H1: the live-check retrieve call passes maxNetworkRetries:0', capturedOpts && capturedOpts.maxNetworkRetries === 0, capturedOpts);
    t('R2-H1: the live-check retrieve call passes a short timeout', capturedOpts && typeof capturedOpts.timeout === 'number' && capturedOpts.timeout <= 10000, capturedOpts);
    retrieveBehavior = null;
  }

  server.close();
  database.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
