'use strict';
// Optional WEBHOOK-1 multi-process companion to office-multiproc-child.js: opens its OWN
// connection to the SAME shared DB file, mounts routes/webhooks, waits for a 'go' signal,
// then POSTs a charge.refunded event for the SAME charge as its siblings — exercising
// routes/webhooks.js's now-BEGIN-IMMEDIATE read-then-write span (R2-L4) under real
// cross-process concurrency instead of just within one Node process.

const path = require('path');
const REPO = process.env.REPO;
const express = require(path.join(REPO, 'node_modules/express'));

for (const k of Object.keys(process.env)) {
  if (/STRIPE|TWILIO|SMTP_USER|SMTP_PASS|SLACK|VAPI|META|FB_|SQUARE/.test(k)) delete process.env[k];
}
process.env.SARAH_API_KEY = process.env.SARAH_API_KEY || 'child-sarah-env-value';
process.env.STRIPE_EVENT_WEBHOOK_SECRET = process.env.STRIPE_EVENT_WEBHOOK_SECRET || 'whsec_test_dummy';

const db = require(path.join(REPO, 'db'));
db.initialize();

const stripeService = require(path.join(REPO, 'services/stripe'));
// R5-L1: routes/webhooks.js's charge.refunded now ALWAYS calls the live amount_refunded
// lookup (the refunds.data list below is sent but ignored) — this stub answers it with the
// SAME cumulative both sibling children report, so the race still exercises the intended
// BEGIN IMMEDIATE read-then-write span rather than failing closed with a 503 for lack of a
// paymentIntents/charges stub.
const liveAmountRefundedCents = parseInt(process.env.CHARGE_AMOUNT_REFUNDED_CENTS, 10);
stripeService._setStripeForTests({
  webhooks: { constructEvent: (rawBody) => JSON.parse(rawBody.toString('utf8')) },
  paymentIntents: {
    retrieve: async (id) => ({
      id, latest_charge: { id: process.env.RACE_CHARGE_ID, amount: 10000, amount_refunded: liveAmountRefundedCents, currency: 'usd' },
    }),
  },
  charges: {
    retrieve: async (id) => ({ id, amount: 10000, amount_refunded: liveAmountRefundedCents, currency: 'usd' }),
  },
});

const webhookRoutes = require(path.join(REPO, 'routes/webhooks'));

async function main() {
  const app = express();
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
  app.use('/webhooks', webhookRoutes);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  process.send({ type: 'ready', idx: process.env.CHILD_INDEX });

  process.on('message', async (msg) => {
    if (msg.type !== 'go') return;
    const waitMs = msg.goAt - Date.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

    const amountRefundedCents = parseInt(process.env.CHARGE_AMOUNT_REFUNDED_CENTS, 10);
    // R5-L1: the refunds.data list here is sent purely for payload realism — the handler
    // ignores it entirely and always uses the live lookup stubbed above (which reports the
    // SAME cumulative both sibling children expect), so the race is deterministic.
    const event = JSON.stringify({
      id: `evt_race_${process.env.CHILD_INDEX}_${Date.now()}_${Math.random()}`,
      type: 'charge.refunded',
      data: { object: {
        id: process.env.RACE_CHARGE_ID, payment_intent: process.env.RACE_PI, amount_refunded: amountRefundedCents,
        refunds: { object: 'list', data: [{ id: 're_race_synthetic', amount: amountRefundedCents, status: 'succeeded' }], has_more: false },
      } },
    });
    let status = null;
    let errMsg = null;
    try {
      const res = await fetch(`${base}/webhooks/stripe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': 'test' },
        body: event,
      });
      status = res.status;
    } catch (e) {
      errMsg = e.message;
    }
    process.send({ type: 'result', idx: process.env.CHILD_INDEX, status, errMsg });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}

main().catch((e) => {
  console.error('CHILD CRASH', e);
  process.send({ type: 'result', idx: process.env.CHILD_INDEX, status: null, errMsg: 'crash: ' + e.message });
  process.exit(1);
});
