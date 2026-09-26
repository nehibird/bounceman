// R2-L4: LEDGER-1 and WEBHOOK-1 were "equivalent" mutants ONLY because no single-process
// test can construct real OS-level concurrency between two SEPARATE better-sqlite3
// connections (the read-then-write in reserveRefund/reservePaymentLink and in
// routes/webhooks.js's charge.refunded handler has no `await` inside it, so within one
// process better-sqlite3's fully-synchronous transactions already serialize everything).
// This suite proves the guarantee holds across REAL separate processes sharing one SQLite
// file (WAL mode), which is exactly the scenario `.immediate()` (BEGIN IMMEDIATE, not the
// default deferred BEGIN) was added for.
//
// Adapted from Marcus Bennett's read-only reference probes
// (~/tlc-work/marcus-bm/r2/probes/mut-ledger1-multiproc.js and -child.js) into a real,
// assertive regression test for this repo's own suite — not a mutation-testing harness.
//
// Run from the app root: node tests/office-multiproc.test.js
// Runtime: ~20-30s (4 children x 20 iterations for the refund race, 2 children x 5
// iterations for the optional webhook race).

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { fork } = require('child_process');
const { v4: uuid } = require('uuid');

const REPO = path.join(__dirname, '..');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-office-multiproc-'));
const DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.DB_PATH = DB_PATH;
for (const k of ['STRIPE_SECRET_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'SMTP_HOST', 'SMTP_USER',
  'SMTP_PASS', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'VAPI_SERVER_SECRET', 'VAPI_API_KEY']) {
  delete process.env[k];
}

const db = require('../db');
db.initialize();
const database = db.getDb();
const { createApiKey } = require('../lib/api-keys');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  ${detail !== undefined ? JSON.stringify(detail) : ''}`));
}

function forkChild(scriptPath, env) {
  return fork(scriptPath, [], {
    cwd: REPO,
    env: { ...process.env, REPO, DB_PATH, ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
}

// Runs NCHILD children of scriptPath, barriers them on a shared future timestamp via IPC,
// and resolves with their reported results once all have responded (or rejects on timeout).
function runBarrieredRace(scriptPath, perChildEnv, { nchild, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const children = [];
    let readyCount = 0;
    const results = [];
    const timeoutHandle = setTimeout(() => {
      for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
      reject(new Error('iteration timed out waiting for children'));
    }, timeoutMs);

    for (let i = 0; i < nchild; i++) {
      const child = forkChild(scriptPath, { CHILD_INDEX: String(i), ...perChildEnv(i) });
      children.push(child);
      child.on('message', (msg) => {
        if (msg.type === 'ready') {
          readyCount += 1;
          if (readyCount === nchild) {
            const goAt = Date.now() + 120; // shared future instant; children busy-wait to it
            for (const c of children) c.send({ type: 'go', goAt });
          }
        } else if (msg.type === 'result') {
          results.push(msg);
          if (results.length === nchild) {
            clearTimeout(timeoutHandle);
            for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
            resolve(results);
          }
        }
      });
      child.on('error', () => { /* surfaces as a missing result -> timeout */ });
    }
  });
}

function makeRefundFixture() {
  const keyInfo = createApiKey(database, {
    name: 'race-key-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    scopes: ['refunds:create', 'bookings:read'],
    maxRefundCents: 100000,
    dailyRefundCapCents: 25000, // $250 — less than 2x $150, so at most one $150 refund should land
  });
  const cid = uuid();
  database.prepare("INSERT INTO customers (id, first_name, last_name, email, phone) VALUES (?, 'R', 'Race', 'race@example.com', '5551234567')").run(cid);
  const bid = uuid();
  const bookingNumber = 'BM-RACE-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  database.prepare(`INSERT INTO bookings
      (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status, deposit_paid)
      VALUES (?, ?, ?, 'confirmed', '2026-11-07', '11:00', '19:00', 1000, 1000, 50, 0, 'paid', 1)`)
    .run(bid, bookingNumber, cid);
  const pid = uuid();
  database.prepare(`INSERT INTO payments
      (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
      VALUES (?, ?, ?, 1000, 'charge', 'stripe', 'pi_race_fixture', 'completed', 0)`)
    .run(pid, bid, cid);
  return { rawKey: keyInfo.rawKey, bookingNumber };
}

async function runRefundRaceSuite() {
  const NCHILD = 4;
  const ITERS = 20;
  const PER_CHILD_AMOUNT_CENTS = 15000; // $150
  const childScript = path.join(__dirname, 'office-multiproc-child.js');

  let iterationsWithMoreThanOne = 0;
  let totalSuccesses = 0;
  let busyOr500Count = 0;
  const allStatuses = [];

  for (let it = 0; it < ITERS; it++) {
    const fixture = makeRefundFixture();
    let results;
    try {
      results = await runBarrieredRace(childScript, () => ({
        RACE_KEY: fixture.rawKey, RACE_BOOKING: fixture.bookingNumber, RACE_AMOUNT_CENTS: String(PER_CHILD_AMOUNT_CENTS),
      }), { nchild: NCHILD });
    } catch (e) {
      t(`refund race iteration ${it} completed without timing out`, false, e.message);
      continue;
    }
    const successes = results.filter((r) => r.status === 201).length;
    const badResults = results.filter((r) => r.status >= 500 || (r.errMsg && /SQLITE_BUSY/i.test(r.errMsg)));
    totalSuccesses += successes;
    if (successes > 1) iterationsWithMoreThanOne += 1;
    if (badResults.length) busyOr500Count += badResults.length;
    allStatuses.push({ iteration: it, statuses: results.map((r) => r.status), successes });
  }

  t('refund race: 0 iterations had more than one success across all iterations', iterationsWithMoreThanOne === 0, allStatuses.filter((a) => a.successes > 1));
  t('refund race: at least one success happened somewhere (the race isn\'t just failing everything)', totalSuccesses > 0, totalSuccesses);
  t('refund race: zero 500s or SQLITE_BUSY errors across all iterations (busy_timeout is doing its job)', busyOr500Count === 0, busyOr500Count);
  console.log(`  (refund race detail: ${ITERS} iterations, ${totalSuccesses} total successes, statuses=${JSON.stringify(allStatuses.map((a) => a.statuses))})`);
}

async function runWebhookRaceSuite() {
  const NCHILD = 2;
  const ITERS = 5;
  const CHARGE_AMOUNT_REFUNDED_CENTS = 5000; // both children report the SAME $50 cumulative
  const childScript = path.join(__dirname, 'office-multiproc-webhook-child.js');

  let anomalies = 0;
  for (let it = 0; it < ITERS; it++) {
    const cid = uuid();
    database.prepare("INSERT INTO customers (id, first_name, last_name) VALUES (?, 'W', 'Race')").run(cid);
    const bid = uuid();
    database.prepare(`INSERT INTO bookings
        (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
        VALUES (?, ?, ?, 'confirmed', '2026-11-07', '11:00', '19:00', 100, 100, 50, 0, 'paid')`)
      .run(bid, 'BM-WRACE-' + it + '-' + Date.now(), cid);
    const pid = uuid();
    const piId = 'pi_wrace_' + it + '_' + Date.now();
    database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
        VALUES (?, ?, ?, 100, 'charge', 'stripe', ?, 'completed', 0)`)
      .run(pid, bid, cid, piId);

    let results;
    try {
      results = await runBarrieredRace(childScript, () => ({
        RACE_PI: piId, RACE_CHARGE_ID: 'ch_' + piId, CHARGE_AMOUNT_REFUNDED_CENTS: String(CHARGE_AMOUNT_REFUNDED_CENTS),
      }), { nchild: NCHILD });
    } catch (e) {
      t(`webhook race iteration ${it} completed without timing out`, false, e.message);
      continue;
    }
    const badResults = results.filter((r) => r.status >= 500 || r.errMsg);
    if (badResults.length) anomalies += 1;

    const payment = database.prepare('SELECT * FROM payments WHERE id = ?').get(pid);
    const booking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(bid);
    if (payment.refund_amount !== 50) anomalies += 1;
    if (booking.total !== 50) anomalies += 1;
  }

  t('webhook race: no anomalies across all iterations (refund_amount=$50 exactly once, total reduced exactly once, no errors)', anomalies === 0, anomalies);
}

async function main() {
  console.log('\n=== R2-L4: refund reservation multi-process race (LEDGER-1) ===');
  await runRefundRaceSuite();

  console.log('\n=== R2-L4 (optional): charge.refunded multi-process race (WEBHOOK-1) ===');
  await runWebhookRaceSuite();

  database.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
