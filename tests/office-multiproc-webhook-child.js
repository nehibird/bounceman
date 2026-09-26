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
stripeService._setStripeForTests({
  webhooks: { constructEvent: (rawBody) => JSON.parse(rawBody.toString('utf8')) },
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
    // R4-L1 GAP: routes/webhooks.js's charge.refunded now needs a COMPLETE refunds.data
    // list to avoid its live-amount_refunded-lookup fallback (this child's minimal Stripe
    // stub has no paymentIntents/charges.retrieve at all — that fallback would otherwise
    // fail closed with 503, which is correct production behavior but not what this test is
    // exercising). Both sibling children report the SAME cumulative, so a single synthetic
    // refund entry matching it is consistent and deterministic across the whole race.
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
