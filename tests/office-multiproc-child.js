'use strict';
// One child process for tests/office-multiproc.test.js's LEDGER-1/R2-L4 multi-process
// race check. Opens its OWN better-sqlite3 connection to the SAME shared WAL-mode DB
// file (process.env.DB_PATH), mounts routes/office in a local Express server, waits for
// a 'go' signal from the parent (IPC barrier), then fires one refund request as close to
// its siblings' fire time as OS scheduling allows. Reports the HTTP status back to the
// parent. Adapted from Marcus Bennett's read-only reference probe
// (~/tlc-work/marcus-bm/r2/probes/mut-ledger1-multiproc-child.js) for this repo's own
// regression suite.

const path = require('path');
const REPO = process.env.REPO;
const express = require(path.join(REPO, 'node_modules/express'));

for (const k of Object.keys(process.env)) {
  if (/STRIPE|TWILIO|SMTP_USER|SMTP_PASS|SLACK|VAPI|META|FB_|SQUARE/.test(k)) delete process.env[k];
}
process.env.SARAH_API_KEY = process.env.SARAH_API_KEY || 'child-sarah-env-value';

const db = require(path.join(REPO, 'db'));
db.initialize(); // a SEPARATE connection to the SAME DB_PATH file as the parent + siblings

const stripeService = require(path.join(REPO, 'services/stripe'));
// A small artificial delay on the refund call widens the race window between the
// read-based decision (computeRefundLimits, inside the reservation transaction) and the
// eventual response — matching a real network round trip to Stripe.
stripeService._setStripeForTests({
  refunds: {
    create: async () => {
      await new Promise((r) => setTimeout(r, 40 + Math.floor(Math.random() * 30)));
      return { id: 're_race_' + process.env.CHILD_INDEX, status: 'succeeded' };
    },
  },
  paymentIntents: { retrieve: async (id) => ({ id, latest_charge: { id: `ch_race_${id}`, amount_refunded: 0 } }) },
  charges: { retrieve: async (id) => ({ id, amount_refunded: 0 }) },
});

const office = require(path.join(REPO, 'routes/office'));

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/api/office/v1', office);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/office/v1`;

  process.send({ type: 'ready', idx: process.env.CHILD_INDEX });

  process.on('message', async (msg) => {
    if (msg.type !== 'go') return;
    const waitMs = msg.goAt - Date.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

    const rawKey = process.env.RACE_KEY;
    const amountCents = parseInt(process.env.RACE_AMOUNT_CENTS, 10);
    const idk = `race-${process.env.CHILD_INDEX}-${Date.now()}-${Math.random()}`;
    let status = null;
    let body = null;
    let errMsg = null;
    try {
      const res = await fetch(`${base}/bookings/${process.env.RACE_BOOKING}/refunds`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-office-key': rawKey,
          'idempotency-key': idk,
        },
        body: JSON.stringify({ reason: 'race-probe', confirmed_by: 'race-tester', amount_cents: amountCents }),
      });
      status = res.status;
      try { body = await res.json(); } catch { body = null; }
    } catch (e) {
      errMsg = e.message;
    }
    process.send({ type: 'result', idx: process.env.CHILD_INDEX, status, body, errMsg });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}

main().catch((e) => {
  console.error('CHILD CRASH', e);
  process.send({ type: 'result', idx: process.env.CHILD_INDEX, status: null, errMsg: 'crash: ' + e.message });
  process.exit(1);
});
