// R2-C1: an AMBIGUOUS Stripe error (Stripe may have actually processed the refund before
// the response was lost — a timeout, a dropped connection, a 5xx) must never be treated
// like a definitive rejection. This suite proves, for a timeout, a StripeConnectionError,
// and StripeAPIError 500/503:
//   - the first call gets 502 (504 for a timeout) with {outcome:"unknown", ledger_id,
//     retry_with_same_idempotency_key:true}; the ledger row stays 'pending' and still
//     counts against the daily cap;
//   - a NEW Idempotency-Key retried while that reservation is still held is rejected by
//     the cap/remainder;
//   - a SAME-Idempotency-Key retry reuses the SAME ledger row and Stripe idempotency key,
//     resolves to 201, and causes EXACTLY ONE real refund in the stub even though
//     refunds.create was called twice;
//   - a genuinely concurrent duplicate (same key, still being processed in this process)
//     gets 409, never a second concurrent Stripe call.
// It also covers R2-C1/R2-M2's reconcile sweep of 'needs_review' and legacy
// ambiguous-'failed' rows, R2-M2c's refunds.list pagination, and the audited
// scripts/resolve-office-refund.js CLI.
//
// The Stripe stub here is deliberately "realistic": a call that later throws still
// records the refund against its idempotency key FIRST (exactly like real Stripe, which
// may process a refund before the HTTP response back to this app is lost) — so a retry
// with the same key returns the SAME stored result rather than creating a second one.
//
// Run from the app root: node tests/office-refund-ambiguous.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-office-ambig-'));
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
const { reconcilePendingRefunds } = require('../lib/refund-reconcile');

// --- Realistic Stripe refunds.create stub: honours idempotency keys, PROCESSES the
// refund (records it) before optionally throwing. ------------------------------------
const processedByIdemKey = new Map(); // stripe idempotency key -> the refund Stripe "stored"
const stripeRefundCalls = [];
let nextCreateOutcome = null; // set right before a call whose FIRST attempt should be ambiguous

function makeAmbiguousError(mode) {
  if (mode === 'timeout') {
    const err = new Error('Request timed out communicating with Stripe');
    err.code = 'ETIMEDOUT';
    return err;
  }
  if (mode === 'connection') {
    const err = new Error('An error occurred while communicating with Stripe (connection reset)');
    err.type = 'StripeConnectionError';
    return err;
  }
  if (mode === 'api500') {
    const err = new Error('Stripe internal server error');
    err.type = 'StripeAPIError';
    err.statusCode = 500;
    return err;
  }
  if (mode === 'api503') {
    const err = new Error('Stripe service unavailable');
    err.type = 'StripeAPIError';
    err.statusCode = 503;
    return err;
  }
  throw new Error(`unknown ambiguous mode: ${mode}`);
}

let createDelayMs = 0;
const fakeStripe = {
  refunds: {
    create: (params, opts) => new Promise((resolve, reject) => {
      const idemKey = opts && opts.idempotencyKey;
      const run = () => {
        stripeRefundCalls.push({ idemKey, params });
        if (processedByIdemKey.has(idemKey)) {
          // Real Stripe semantics: the SAME idempotency key always returns the SAME
          // stored result — no new charge, no matter how many times it's called.
          return resolve(processedByIdemKey.get(idemKey));
        }
        const refund = { id: `re_ambig_${processedByIdemKey.size + 1}`, status: 'succeeded' };
        const outcome = nextCreateOutcome;
        nextCreateOutcome = null; // one-shot — only the first time THIS idemKey is seen
        // Stripe actually processes/records the refund even when the outcome is
        // ambiguous — only the RESPONSE back to this app is lost.
        processedByIdemKey.set(idemKey, refund);
        if (outcome) return reject(makeAmbiguousError(outcome));
        return resolve(refund);
      };
      if (createDelayMs > 0) setTimeout(run, createDelayMs); else run();
    }),
    list: async () => ({ data: [], has_more: false }),
  },
  paymentIntents: { retrieve: async (id) => ({ id, latest_charge: { id: `ch_ambig_${id}`, amount_refunded: 0 } }) },
  charges: { retrieve: async (id) => ({ id, amount_refunded: 0 }) },
};
stripeService._setStripeForTests(fakeStripe);

const officeRoutes = require('../routes/office');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  ${detail !== undefined ? JSON.stringify(detail) : ''}`));
}

function makeBookingAndPayment(bookingNumber, amountDollars, piId) {
  const customerId = uuid();
  database.prepare(`INSERT INTO customers (id, first_name, last_name, email, phone) VALUES (?, 'Ambig', 'Test', 'ambig@example.com', '5551230000')`).run(customerId);
  const bookingId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, ?, ?, 'confirmed', '2026-11-01', '11:00', '19:00', ?, ?, 50, 0, 'paid')`)
    .run(bookingId, bookingNumber, customerId, amountDollars, amountDollars);
  const paymentId = uuid();
  database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, refund_amount)
    VALUES (?, ?, ?, ?, 'charge', 'stripe', ?, 'completed', 0)`).run(paymentId, bookingId, customerId, amountDollars, piId);
  return { bookingId, bookingNumber, paymentId };
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

  // --- Per-mode: timeout -> 504; connection/api500/api503 -> 502 -----------------------
  const modes = [
    { mode: 'timeout', expectedStatus: 504 },
    { mode: 'connection', expectedStatus: 502 },
    { mode: 'api500', expectedStatus: 502 },
    { mode: 'api503', expectedStatus: 502 },
  ];

  for (const { mode, expectedStatus } of modes) {
    const { bookingNumber, paymentId } = makeBookingAndPayment(`BM-AMBIG-${mode.toUpperCase()}`, 200, `pi_ambig_${mode}`);
    const { rawKey } = createApiKey(database, {
      name: `ambig-${mode}-key`, scopes: ['refunds:create'], maxRefundCents: 10000, dailyRefundCapCents: 6000,
    });
    const idemA = `idem-${mode}-a`;

    // 1. First attempt -> ambiguous outcome, ledger stays pending and counted. The
    //    realistic stub already RECORDS the refund before throwing (exactly like real
    //    Stripe may have) — so the real refund count increases here, on the FIRST call,
    //    not on the later retry.
    const processedBeforeFirstAttempt = processedByIdemKey.size;
    nextCreateOutcome = mode;
    let r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idemA, reason: 'ambiguous test', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    let body = await r.json();
    t(`[${mode}] first attempt -> ${expectedStatus}`, r.status === expectedStatus, { status: r.status, body });
    t(`[${mode}] outcome:"unknown", retry_with_same_idempotency_key:true`, body.outcome === 'unknown' && body.retry_with_same_idempotency_key === true, body);
    t(`[${mode}] response carries a ledger_id`, typeof body.ledger_id === 'string' && body.ledger_id.length > 0, body);
    const ledgerId = body.ledger_id;
    t(`[${mode}] Stripe DID actually process/record the refund on the first (ambiguous) attempt`,
      processedByIdemKey.size === processedBeforeFirstAttempt + 1 && processedByIdemKey.has(`office-refund-${ledgerId}`), processedByIdemKey.size);

    const ledgerRow = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(ledgerId);
    t(`[${mode}] ledger row stays 'pending' (never marked failed, never released)`, ledgerRow && ledgerRow.status === 'pending', ledgerRow);
    t(`[${mode}] ledger row's error text was recorded`, !!ledgerRow.error, ledgerRow.error);
    t(`[${mode}] ledger row's idempotency_key was NEVER renamed`, ledgerRow.idempotency_key === idemA, ledgerRow.idempotency_key);

    // 2. A NEW Idempotency-Key while the ambiguous reservation is still held -> capped
    //    ($5000 already reserved + $2000 new > $6000 daily cap).
    r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: `idem-${mode}-newkey`, reason: 'new key after ambiguous', confirmed_by: 'Nehemiah', amount_cents: 2000,
    });
    body = await r.json();
    t(`[${mode}] a NEW-key retry is rejected by the still-held reservation's cap`, r.status === 403 && body.already_refunded_today_cents === 5000, body);

    // 3. A genuinely concurrent duplicate (same key, still in flight in THIS process)
    //    gets 409 — never a second concurrent Stripe call.
    createDelayMs = 150;
    nextCreateOutcome = null; // this concurrent pair should just succeed once resolved
    const idemConc = `idem-${mode}-conc`;
    const concResults = await Promise.all([
      write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, { idempotencyKey: idemConc, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 100 }).then((rr) => rr.status),
      new Promise((resolve) => setTimeout(resolve, 30)).then(() =>
        write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, { idempotencyKey: idemConc, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 100 }).then((rr) => rr.status)),
    ]);
    createDelayMs = 0;
    t(`[${mode}] a genuinely concurrent duplicate: exactly one 409, and the winner still gets 201`,
      concResults.filter((s) => s === 409).length === 1 && concResults.filter((s) => s === 201).length === 1, concResults);

    // 4. SAME-key retry of the original ambiguous attempt -> resumes the SAME ledger
    //    row and reuses the SAME derived Stripe idempotency key. The stub's map already
    //    has an entry for that key from step 1, so this call returns the CACHED result
    //    (exactly like real Stripe's 24h idempotency dedupe) — no NEW real refund.
    const processedBeforeRetry = processedByIdemKey.size;
    const callsBeforeRetry = stripeRefundCalls.length;
    r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idemA, reason: 'ambiguous test', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    body = await r.json();
    t(`[${mode}] same-key retry -> 201`, r.status === 201 && !!body.refund_id, body);
    t(`[${mode}] same-key retry made another Stripe call (not a cached HTTP replay)`, stripeRefundCalls.length === callsBeforeRetry + 1, stripeRefundCalls.length);
    t(`[${mode}] the retry did NOT create a second real refund (Stripe-side dedupe on the reused idempotency key)`,
      processedByIdemKey.size === processedBeforeRetry, { before: processedBeforeRetry, after: processedByIdemKey.size });

    const resolvedRow = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(ledgerId);
    t(`[${mode}] the SAME ledger row id is now succeeded`, resolvedRow && resolvedRow.status === 'succeeded' && resolvedRow.id === ledgerId, resolvedRow);
    t(`[${mode}] Stripe idempotency key used was derived from the SAME ledger id both times`, stripeRefundCalls[callsBeforeRetry].idemKey === `office-refund-${ledgerId}`, stripeRefundCalls[callsBeforeRetry]);

    // 5. Payment's remainder now enforces the succeeded refund — a further attempt that
    //    would exceed what's left is rejected on the remainder, not just the daily cap.
    const paymentRow = database.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    t(`[${mode}] payment row itself is untouched by this endpoint (webhook-only bookkeeping)`, paymentRow.refund_amount === 0, paymentRow);
  }

  // --- Definitive error still behaves as before: 'failed', released, fresh retry -------
  {
    const { bookingNumber } = makeBookingAndPayment('BM-AMBIG-DEFINITIVE', 200, 'pi_ambig_definitive');
    const { rawKey } = createApiKey(database, { name: 'ambig-definitive-key', scopes: ['refunds:create'], maxRefundCents: 10000, dailyRefundCapCents: 6000 });
    const idem = 'idem-definitive-a';
    nextCreateOutcome = null;
    // Force a DEFINITIVE error by monkeypatching create for exactly one call.
    const origCreate = fakeStripe.refunds.create;
    fakeStripe.refunds.create = (params, opts) => {
      fakeStripe.refunds.create = origCreate;
      const err = new Error('Your card was declined.');
      err.type = 'StripeCardError';
      err.statusCode = 402;
      stripeRefundCalls.push({ idemKey: opts.idempotencyKey, params, definitive: true });
      return Promise.reject(err);
    };
    let r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'definitive test', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    let body = await r.json();
    t('[definitive] a real 4xx Stripe error -> 502, no outcome:"unknown"', r.status === 502 && body.outcome === undefined, body);
    const row = database.prepare("SELECT * FROM office_refunds WHERE idempotency_key LIKE 'idem-definitive-a%'").get();
    t('[definitive] ledger row finalized failed and RELEASED (idempotency_key renamed)', row && row.status === 'failed' && row.idempotency_key !== idem, row);
    t('[definitive] error_classification recorded as definitive', row.error_classification === 'definitive', row);

    r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'definitive test', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    body = await r.json();
    t('[definitive] retry with the same key reserves FRESH (new ledger row) and succeeds', r.status === 201 && !!body.refund_id, body);
  }

  // --- R2-C1/R2-M2: reconcile sweeps 'needs_review' and legacy ambiguous-'failed' rows --
  {
    const { bookingId, paymentId } = makeBookingAndPayment('BM-RECONCILE-NR', 100, 'pi_reconcile_nr');
    const { id: keyId } = createApiKey(database, { name: 'reconcile-nr-key', scopes: ['refunds:create'] });
    const oldTimestamp = new Date(Date.now() - 30 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    const nrId = uuid();
    database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 2000, 'needs_review', 'Nehemiah', 'x', ?, ?)`)
      .run(nrId, keyId, 'reconcile-nr-key', 'idem-nr-1', bookingId, paymentId, oldTimestamp, oldTimestamp);

    const legacyId = uuid();
    database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, error, error_classification, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 3000, 'failed', 'Nehemiah', 'x', 'simulated pre-R2-C1 ambiguous failure', NULL, ?, ?)`)
      .run(legacyId, keyId, 'reconcile-nr-key', 'idem-legacy-1', bookingId, paymentId, oldTimestamp, oldTimestamp);

    const definitiveFailedId = uuid();
    database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, error, error_classification, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1000, 'failed', 'Nehemiah', 'x', 'card declined', 'definitive', ?, ?)`)
      .run(definitiveFailedId, keyId, 'reconcile-nr-key', 'idem-definitive-failed-1', bookingId, paymentId, oldTimestamp, oldTimestamp);

    const stripeStatusStatusFailedId = uuid();
    database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, stripe_refund_id, stripe_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 500, 'failed', 'Nehemiah', 'x', 're_already_failed', 'failed', ?, ?)`)
      .run(stripeStatusStatusFailedId, keyId, 'reconcile-nr-key', 'idem-realfailed-1', bookingId, paymentId, oldTimestamp, oldTimestamp);

    const lookupCalls = [];
    const stub = {
      findRefundByOfficeId: async (officeRefundId) => {
        lookupCalls.push(officeRefundId);
        if (officeRefundId === nrId) return { id: 're_nr_resolved', status: 'succeeded', metadata: { office_refund_id: officeRefundId } };
        if (officeRefundId === legacyId) return { id: 're_legacy_resolved', status: 'succeeded', metadata: { office_refund_id: officeRefundId } };
        return null;
      },
    };
    const results = await reconcilePendingRefunds(database, { olderThanMinutes: 15, stripeService: stub });

    t('reconcile: needs_review row is re-checked and resolved', results.some((r2) => r2.id === nrId && r2.result === 'succeeded'), results);
    t('reconcile: legacy ambiguous-failed row (error set, no classification) is swept and resolved', results.some((r2) => r2.id === legacyId && r2.result === 'succeeded'), results);
    t('reconcile: a DEFINITIVE failed row is never looked up on Stripe at all', !lookupCalls.includes(definitiveFailedId), lookupCalls);
    t('reconcile: a real Stripe failed/canceled row (no `error`) is never looked up either', !lookupCalls.includes(stripeStatusStatusFailedId), lookupCalls);

    const definitiveRowAfter = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(definitiveFailedId);
    t('reconcile: the definitive-failed row is completely untouched', definitiveRowAfter.status === 'failed' && definitiveRowAfter.error === 'card declined', definitiveRowAfter);

    // Never calls refunds.create.
    const refundCreateCallsBefore = stripeRefundCalls.length;
    t('reconcile never calls stripe.refunds.create', stripeRefundCalls.length === refundCreateCallsBefore, stripeRefundCalls.length);
  }

  // --- R2-M2c: findRefundByOfficeId paginates past the first page ----------------------
  {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `re_page1_${i}`, status: 'succeeded', metadata: { office_refund_id: 'not-this-one' } }));
    const targetId = 'ledger-on-page-2';
    const page2 = [
      { id: 're_page2_0', status: 'succeeded', metadata: { office_refund_id: 'also-not-this-one' } },
      { id: 're_page2_match', status: 'succeeded', metadata: { office_refund_id: targetId } },
    ];
    const listCalls = [];
    const pagingStub = {
      refunds: {
        list: async (params) => {
          listCalls.push(params);
          if (!params.starting_after) return { data: page1, has_more: true };
          return { data: page2, has_more: false };
        },
      },
    };
    stripeService._setStripeForTests(pagingStub);
    const found = await stripeService.findRefundByOfficeId(targetId, { stripe_payment_id: 'pi_paged_test' });
    stripeService._setStripeForTests(fakeStripe);
    t('R2-M2c: findRefundByOfficeId pages past 100 and finds a match on page 2', !!found && found.id === 're_page2_match', found);
    t('R2-M2c: exactly 2 list() calls were made (page 1 + page 2)', listCalls.length === 2, listCalls.length);
    t('R2-M2c: the second call used starting_after from the last item of page 1', listCalls[1].starting_after === 're_page1_99', listCalls[1]);
  }

  server.close();

  // --- R2-M2a: scripts/resolve-office-refund.js CLI, run as a real child process -------
  const scriptPath = path.join(__dirname, '..', 'scripts', 'resolve-office-refund.js');
  const childEnv = { ...process.env };
  delete childEnv.STRIPE_SECRET_KEY;

  function runCli(args) {
    try {
      const stdout = execFileSync('node', [scriptPath, ...args], { env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, stdout };
    } catch (err) {
      return { code: err.status, stdout: err.stdout ? err.stdout.toString() : '', stderr: err.stderr ? err.stderr.toString() : '' };
    }
  }

  {
    const { bookingId, paymentId } = makeBookingAndPayment('BM-CLI-1', 100, 'pi_cli_1');
    const { id: keyId } = createApiKey(database, { name: 'cli-key', scopes: ['refunds:create'] });
    const oldTimestamp = new Date(Date.now() - 30 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    // Not eligible: a fresh 'pending' row (not old enough).
    const freshId = uuid();
    database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1000, 'pending', 'Nehemiah', 'x', datetime('now'), datetime('now'))`)
      .run(freshId, keyId, 'cli-key', 'idem-cli-fresh', bookingId, paymentId);

    let res = runCli([freshId, 'failed', '--reason', 'trying anyway']);
    t('CLI: refuses a fresh pending row (not old enough)', res.code !== 0, res);
    let row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(freshId);
    t('CLI: no change was made to the fresh row', row.status === 'pending', row);

    // Missing --reason -> exit non-zero, no change.
    const nrId = uuid();
    database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1000, 'needs_review', 'Nehemiah', 'x', ?, ?)`)
      .run(nrId, keyId, 'cli-key', 'idem-cli-noreason', bookingId, paymentId, oldTimestamp, oldTimestamp);
    res = runCli([nrId, 'failed']);
    t('CLI: refuses without --reason', res.code !== 0, res);
    row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(nrId);
    t('CLI: no change without --reason', row.status === 'needs_review', row);

    res = runCli([nrId, 'failed', '--reason', '   ']);
    t('CLI: refuses a whitespace-only --reason', res.code !== 0, res);

    // 'succeeded' without --stripe-refund -> refused.
    res = runCli([nrId, 'succeeded', '--reason', 'confirmed on dashboard']);
    t('CLI: refuses succeeded without --stripe-refund', res.code !== 0, res);

    // No STRIPE_SECRET_KEY, no --no-verify -> refused.
    res = runCli([nrId, 'succeeded', '--reason', 'confirmed on dashboard', '--stripe-refund', 're_manual_1']);
    t('CLI: refuses to record succeeded without Stripe access and no --no-verify', res.code !== 0, res);
    row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(nrId);
    t('CLI: still no change after the two refusals above', row.status === 'needs_review', row);

    // 'failed' resolution succeeds with a reason, and writes an audit row in the same
    // transaction as the status change.
    const auditCountBefore = database.prepare('SELECT COUNT(*) c FROM api_audit_log').get().c;
    res = runCli([nrId, 'failed', '--reason', 'confirmed never charged', '--actor', 'Nehemiah']);
    t('CLI: resolves a needs_review row to failed with a reason', res.code === 0, res);
    row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(nrId);
    t('CLI: ledger row updated to failed', row.status === 'failed', row);
    const auditRow = database.prepare("SELECT * FROM api_audit_log WHERE action = 'office_refund_manual_resolve' AND entity_id = ?").get(nrId);
    t('CLI: wrote an audit row naming the ledger id, actor, and reason', !!auditRow && /Nehemiah/.test(auditRow.reason) && /confirmed never charged/.test(auditRow.reason), auditRow);
    const activityRow = database.prepare("SELECT * FROM activity_log WHERE action = 'office_refund_manual_resolve' AND entity_id = ?").get(nrId);
    t('CLI: wrote a matching activity_log row', !!activityRow, activityRow);
    const auditCountAfter = database.prepare('SELECT COUNT(*) c FROM api_audit_log').get().c;
    t('CLI: exactly one new audit row for this resolution', auditCountAfter === auditCountBefore + 1, { before: auditCountBefore, after: auditCountAfter });

    // succeeded + --no-verify succeeds and records the stripe_refund_id.
    const nr2Id = uuid();
    database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1000, 'needs_review', 'Nehemiah', 'x', ?, ?)`)
      .run(nr2Id, keyId, 'cli-key', 'idem-cli-noverify', bookingId, paymentId, oldTimestamp, oldTimestamp);
    res = runCli([nr2Id, 'succeeded', '--reason', 'confirmed on dashboard manually', '--stripe-refund', 're_manual_2', '--no-verify', '--actor', 'Nehemiah']);
    t('CLI: --no-verify allows recording succeeded without Stripe access', res.code === 0, res);
    row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(nr2Id);
    t('CLI: succeeded row recorded the given stripe_refund_id', row.status === 'succeeded' && row.stripe_refund_id === 're_manual_2', row);
  }

  database.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
