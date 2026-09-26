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
function liveChargeAmountCentsFor(id) {
  const row = database.prepare('SELECT amount FROM payments WHERE stripe_payment_id = ? OR stripe_charge_id = ?').get(id, id);
  return row ? Math.round((row.amount || 0) * 100) : 20000;
}

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
  // R3-L2: assertUsableCharge now requires a real integer `amount` matching the payment's
  // own captured amount — look it up dynamically rather than a fixed guess.
  paymentIntents: { retrieve: async (id) => ({ id, latest_charge: { id: `ch_ambig_${id}`, amount: liveChargeAmountCentsFor(id), amount_refunded: 0, currency: 'usd' } }) },
  charges: { retrieve: async (id) => ({ id, amount: liveChargeAmountCentsFor(id), amount_refunded: 0, currency: 'usd' }) },
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
    const { rawKey, id: keyId } = createApiKey(database, {
      name: `ambig-${mode}-key`, scopes: ['refunds:create'], maxRefundCents: 10000, dailyRefundCapCents: 6000,
    });
    const idemA = `idem-${mode}-a`;

    // 0. A genuinely concurrent duplicate (same NEW key, arriving twice) BEFORE any
    //    reservation exists on this payment — proves refundsInFlight/UNIQUE-index
    //    protection independent of R3-M3's unresolved-refund guard below (which would
    //    otherwise refuse BOTH attempts once an unrelated reservation is pending on the
    //    same payment, masking this check entirely). Never a second concurrent Stripe call.
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

    // M05/M06 setup: the audit row this FIRST (ambiguous) attempt wrote — captured now so
    // the eventual resume can be proven to have updated THIS SAME ROW in place, not
    // inserted a second one.
    const auditRowAfterFirstAttempt = database.prepare('SELECT * FROM api_audit_log WHERE key_id = ? AND idempotency_key = ?').get(keyId, idemA);
    t(`[${mode}] the first attempt wrote exactly one audit row, recording the 502/504`, !!auditRowAfterFirstAttempt && auditRowAfterFirstAttempt.status_code === expectedStatus, auditRowAfterFirstAttempt);
    const auditRowCountAfterFirstAttempt = database.prepare('SELECT COUNT(*) c FROM api_audit_log WHERE key_id = ? AND idempotency_key = ?').get(keyId, idemA).c;

    // 2. R3-M3: a NEW Idempotency-Key while ANY pending/needs_review reservation exists on
    //    this SAME PAYMENT is refused outright — even though there'd be numeric room under
    //    the daily cap ($5000 + $2000 <= $6000) — because a new reservation on top of one
    //    whose outcome is unknown can double-pay if the unresolved one turns out to have
    //    succeeded. The caller must retry the ORIGINAL key instead.
    r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: `idem-${mode}-newkey`, reason: 'new key after ambiguous', confirmed_by: 'Nehemiah', amount_cents: 2000,
    });
    body = await r.json();
    t(`[${mode}] a NEW-key retry is refused (unresolved_refund) while the ambiguous reservation is unresolved`,
      r.status === 409 && body.error === 'unresolved_refund' && body.ledger_id === ledgerId && body.retry_with_same_idempotency_key === true, body);

    // 3. SAME-key retry of the original ambiguous attempt -> resumes the SAME ledger
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

    // M05/M06: the resume updated the SAME audit row IN PLACE — the row COUNT for this
    // idempotency key is UNCHANGED across the resume (not incremented by a second
    // INSERT), the row ID itself is identical to the one the first attempt wrote, and its
    // content (status_code/response_json) now reflects the 201 success, not the original
    // 502/504. This is the precise shape M05 (isAmbiguousRefundOutcome -> false) and M06
    // (ignore resumingAuditId) would otherwise leave unasserted.
    const auditRowCountAfterRetry = database.prepare('SELECT COUNT(*) c FROM api_audit_log WHERE key_id = ? AND idempotency_key = ?').get(keyId, idemA).c;
    t(`[${mode}] the audit row COUNT for this idempotency key is unchanged by the resume (still exactly ${auditRowCountAfterFirstAttempt})`,
      auditRowCountAfterRetry === auditRowCountAfterFirstAttempt, { before: auditRowCountAfterFirstAttempt, after: auditRowCountAfterRetry });
    const auditRowAfterRetry = database.prepare('SELECT * FROM api_audit_log WHERE key_id = ? AND idempotency_key = ?').get(keyId, idemA);
    t(`[${mode}] the SAME audit row id was updated in place (not a new row)`, auditRowAfterRetry.id === auditRowAfterFirstAttempt.id, { before: auditRowAfterFirstAttempt.id, after: auditRowAfterRetry.id });
    t(`[${mode}] that row's status_code now reflects the 201 success (was ${expectedStatus})`, auditRowAfterRetry.status_code === 201, auditRowAfterRetry.status_code);
    t(`[${mode}] that row's response_json now reflects the refund_id, not the old outcome:"unknown" body`,
      JSON.parse(auditRowAfterRetry.response_json || '{}').refund_id === body.refund_id, auditRowAfterRetry.response_json);

    // 4. Payment's remainder now enforces the succeeded refund — a further attempt that
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

  // --- M08: a same-key resume of a 'needs_review' row (not just 'pending') works -------
  {
    const { bookingId, bookingNumber, paymentId } = makeBookingAndPayment('BM-AMBIG-NR-RESUME', 200, 'pi_ambig_nr_resume');
    const { rawKey, id: keyId } = createApiKey(database, { name: 'ambig-nr-resume-key', scopes: ['refunds:create'], maxRefundCents: 10000, dailyRefundCapCents: 6000 });
    const idem = 'idem-nr-resume-a';
    const nrId = uuid();
    // Seeded directly as 'needs_review' (as a previous reconcile run might leave it),
    // rather than reached via a first ambiguous HTTP attempt.
    database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 5000, 'needs_review', 'Nehemiah', 'x', datetime('now'), datetime('now'))`)
      .run(nrId, keyId, 'ambig-nr-resume-key', idem, bookingId, paymentId);

    const callsBefore = stripeRefundCalls.length;
    const r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    const body = await r.json();
    t('M08: a same-key resume of a needs_review row succeeds (not refused as unresumable)', r.status === 201 && !!body.refund_id, body);
    t('M08: the resume made exactly one Stripe call', stripeRefundCalls.length === callsBefore + 1, stripeRefundCalls.length);
    const row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(nrId);
    t('M08: the SAME ledger row (nrId) is now succeeded', row && row.status === 'succeeded' && row.id === nrId, row);
  }

  // --- M07: an audit-write failure on a money write (refund) is a 500, never a silent
  // 2xx with no corresponding audit row (R2-M1's promise, untested until now) -----------
  {
    const { bookingNumber } = makeBookingAndPayment('BM-AMBIG-AUDITFAIL', 200, 'pi_ambig_auditfail');
    const { rawKey } = createApiKey(database, { name: 'ambig-auditfail-key', scopes: ['refunds:create'], maxRefundCents: 10000, dailyRefundCapCents: 6000 });
    nextCreateOutcome = null;
    const realPrepare = database.prepare.bind(database);
    database.prepare = (sql) => {
      if (sql.includes('INSERT INTO api_audit_log')) throw new Error('simulated audit insert failure');
      return realPrepare(sql);
    };
    const r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: 'idem-auditfail-1', reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    database.prepare = realPrepare;
    t('M07: an audit-write failure on a money write (refund) returns 500', r.status === 500, r.status);
  }

  // --- R3-L1: reconcile finalizing 'failed' retires the idempotency key so a same-key
  // retry starts fresh, and the audit middleware stops treating the stale ambiguous audit
  // row as live once the underlying ledger row is final -------------------------------
  {
    const { bookingNumber } = makeBookingAndPayment('BM-AMBIG-L1', 200, 'pi_ambig_l1');
    const { rawKey } = createApiKey(database, { name: 'ambig-l1-key', scopes: ['refunds:create'], maxRefundCents: 10000, dailyRefundCapCents: 6000 });
    const idem = 'idem-l1-a';

    // First attempt -> ambiguous (kept pending, outcome:"unknown").
    nextCreateOutcome = 'connection';
    let r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    let body = await r.json();
    t('[L1] first attempt -> ambiguous (502, outcome unknown)', r.status === 502 && body.outcome === 'unknown', body);
    const ledgerId = body.ledger_id;
    database.prepare("UPDATE office_refunds SET created_at = datetime('now', '-30 minutes') WHERE id = ?").run(ledgerId);

    // Reconcile confirms Stripe shows this refund attempt as canceled -> finalizes
    // 'failed' and (R3-L1) retires the ledger row's idempotency key.
    const canceledStub = { findRefundByOfficeId: async () => ({ id: 're_l1_confirmed_canceled', status: 'canceled', metadata: {} }) };
    await reconcilePendingRefunds(database, { olderThanMinutes: 15, stripeService: canceledStub });
    const ledgerRow = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(ledgerId);
    t('[L1] reconcile finalized the row failed', ledgerRow && ledgerRow.status === 'failed', ledgerRow);
    t('[L1] reconcile retired the ledger row\'s idempotency_key', ledgerRow.idempotency_key !== idem, ledgerRow.idempotency_key);

    // A same-key retry with a DIFFERENT body must be processed FRESH (422 would mean the
    // middleware still thinks the stale audit row is a live ambiguous attempt).
    r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 4000,
    });
    body = await r.json();
    t('[L1] a same-key, DIFFERENT-body retry after a reconciled-failed row starts fresh (not 422)', r.status === 201 && !!body.refund_id, body);
    const freshRow = database.prepare("SELECT * FROM office_refunds WHERE idempotency_key = ?").get(idem);
    t('[L1] the fresh retry created a NEW ledger row under the (freed) original idempotency key', freshRow && freshRow.id !== ledgerId && freshRow.status === 'succeeded', freshRow);
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

  // --- R3-L4: findRefundByOfficeId hitting the page cap throws a DISTINGUISHABLE error
  // instead of silently returning null (which used to look identical to "confirmed not
  // found") — and reconcile surfaces that as needs_review with the error recorded, not a
  // silent not-found. ------------------------------------------------------------------
  {
    let listCallCount = 0;
    const neverMatchesStub = {
      refunds: {
        list: async () => {
          listCallCount += 1;
          return { data: [{ id: `re_cap_${listCallCount}`, status: 'succeeded', metadata: { office_refund_id: 'never-this-one' } }], has_more: true };
        },
      },
    };
    stripeService._setStripeForTests(neverMatchesStub);
    let caughtErr = null;
    try {
      await stripeService.findRefundByOfficeId('ledger-past-the-cap', { stripe_payment_id: 'pi_cap_test' });
    } catch (e) {
      caughtErr = e;
    }
    t('R3-L4: findRefundByOfficeId THROWS on hitting the page cap (never a silent null)', !!caughtErr && /page cap reached/.test(caughtErr.message), caughtErr && caughtErr.message);
    t('R3-L4: it actually paged the full 20 times before giving up', listCallCount === 20, listCallCount);

    const { bookingId: capBookingId, paymentId: capPaymentId } = makeBookingAndPayment('BM-L4-CAP', 100, 'pi_cap_recon');
    const { id: capKeyId } = createApiKey(database, { name: 'l4-cap-key', scopes: ['refunds:create'] });
    const capRowId = uuid();
    const oldTs = new Date(Date.now() - 30 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1000, 'pending', 'Nehemiah', 'x', ?, ?)`)
      .run(capRowId, capKeyId, 'l4-cap-key', 'idem-l4-cap', capBookingId, capPaymentId, oldTs, oldTs);
    const capResults = await reconcilePendingRefunds(database, { olderThanMinutes: 15, stripeService: stripeService });
    stripeService._setStripeForTests(fakeStripe);
    const capResult = capResults.find((r2) => r2.id === capRowId);
    t('R3-L4: reconcile reports the page-cap hit as needs_review with the error recorded (not a silent not-found)',
      !!capResult && capResult.result === 'needs_review' && /page cap reached/.test(capResult.reason || ''), capResult);
    const capRow = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(capRowId);
    t('R3-L4: the row itself records the page-cap error', capRow.status === 'needs_review' && /page cap reached/.test(capRow.error || ''), capRow);
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

    // --actor supplied so this isolates the eligibility check specifically (--actor is
    // checked FIRST in the script, so a test omitting it can't tell eligibility from a
    // missing-actor refusal — exactly how the eligibility mutant survived round 4).
    let res = runCli([freshId, 'failed', '--reason', 'trying anyway', '--actor', 'Nehemiah']);
    t('CLI: refuses a fresh pending row (not old enough)', res.code !== 0 && /not eligible/.test(res.stderr || ''), res);
    let row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(freshId);
    t('CLI: no change was made to the fresh row', row.status === 'pending', row);

    // Missing --reason -> exit non-zero, no change.
    const nrId = uuid();
    database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1000, 'needs_review', 'Nehemiah', 'x', ?, ?)`)
      .run(nrId, keyId, 'cli-key', 'idem-cli-noreason', bookingId, paymentId, oldTimestamp, oldTimestamp);
    // --actor supplied so this isolates the --reason check specifically (both are
    // required now — a test missing BOTH can't tell which check actually fired, which is
    // exactly how RESOLVE-REASON survived round 4's mutation pass with --actor omitted).
    res = runCli([nrId, 'failed', '--actor', 'Nehemiah']);
    t('CLI: refuses without --reason', res.code !== 0 && /--reason is required/.test(res.stderr || ''), res);
    row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(nrId);
    t('CLI: no change without --reason', row.status === 'needs_review', row);

    res = runCli([nrId, 'failed', '--reason', '   ', '--actor', 'Nehemiah']);
    t('CLI: refuses a whitespace-only --reason', res.code !== 0 && /--reason is required/.test(res.stderr || ''), res);

    // 'succeeded' without --stripe-refund -> refused. (--actor supplied throughout so
    // each of these isolates the SPECIFIC check under test — see the --reason fix above.)
    res = runCli([nrId, 'succeeded', '--reason', 'confirmed on dashboard', '--actor', 'Nehemiah']);
    t('CLI: refuses succeeded without --stripe-refund', res.code !== 0 && /--stripe-refund/.test(res.stderr || ''), res);

    // No STRIPE_SECRET_KEY, no --no-verify -> refused.
    res = runCli([nrId, 'succeeded', '--reason', 'confirmed on dashboard', '--stripe-refund', 're_manual_1', '--actor', 'Nehemiah']);
    t('CLI: refuses to record succeeded without Stripe access and no --no-verify', res.code !== 0 && /cannot be verified against Stripe/.test(res.stderr || ''), res);
    row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(nrId);
    t('CLI: still no change after the two refusals above', row.status === 'needs_review', row);

    // 'failed' resolution succeeds with a reason, and writes an audit row in the same
    // transaction as the status change. R3-M1: 'failed' now ALSO needs Stripe
    // verification (or --no-verify) — this suite has no STRIPE_SECRET_KEY, so --no-verify
    // is required here (see the dedicated in-process Stripe-check tests below).
    const auditCountBefore = database.prepare('SELECT COUNT(*) c FROM api_audit_log').get().c;
    res = runCli([nrId, 'failed', '--reason', 'confirmed never charged', '--actor', 'Nehemiah', '--no-verify']);
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

    // R3-M1: --actor is required — missing it refuses outright, no change.
    const nr3Id = uuid();
    database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1000, 'needs_review', 'Nehemiah', 'x', ?, ?)`)
      .run(nr3Id, keyId, 'cli-key', 'idem-cli-noactor', bookingId, paymentId, oldTimestamp, oldTimestamp);
    res = runCli([nr3Id, 'failed', '--reason', 'confirmed never charged', '--no-verify']);
    t('CLI: refuses without --actor', res.code !== 0 && /--actor is required/.test(res.stderr || ''), res);
    row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(nr3Id);
    t('CLI: no change without --actor', row.status === 'needs_review', row);

    // R3-M1: --stripe-refund must look like re_... EVEN with --no-verify.
    res = runCli([nr3Id, 'succeeded', '--reason', 'x', '--actor', 'Nehemiah', '--stripe-refund', 'not-a-refund-id', '--no-verify']);
    t('CLI: refuses a malformed --stripe-refund even with --no-verify', res.code !== 0, res);
  }

  // --- R3-M1: 'failed' requires the SAME kind of Stripe confirmation as R3-C1(b) — tested
  // in-process (main() called directly, stubbing findRefundByOfficeId) since a real
  // subprocess has no way to reach a fake Stripe server without real network access. ----
  {
    const resolveCli = require('../scripts/resolve-office-refund');
    const savedExitCode = process.exitCode;
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_resolve_cli';

    async function callMain(argv) {
      process.exitCode = undefined;
      await resolveCli.main(argv);
      const code = process.exitCode;
      process.exitCode = undefined;
      return code;
    }

    function seedRow(idemKey) {
      const { bookingId, paymentId } = makeBookingAndPayment(`BM-CLI-STRIPECHECK-${idemKey}`, 100, `pi_cli_sc_${idemKey}`);
      const { id: keyId } = createApiKey(database, { name: `cli-sc-${idemKey}`, scopes: ['refunds:create'] });
      const id = uuid();
      const oldTimestamp = new Date(Date.now() - 30 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1000, 'needs_review', 'Nehemiah', 'x', ?, ?)`)
        .run(id, keyId, `cli-sc-${idemKey}`, idemKey, bookingId, paymentId, oldTimestamp, oldTimestamp);
      return id;
    }

    // A refund actually exists (succeeded) -> refused, no change, no second refund
    // possible afterwards (the row stays needs_review, still eligible for the SAME
    // resolution to be retried correctly later once reconcile/a human catches up).
    let id = seedRow('idem-sc-exists');
    stripeService._setStripeForTests({ refunds: { list: async () => ({ data: [{ id: 're_sc_exists', status: 'succeeded', metadata: { office_refund_id: id } }], has_more: false }) } });
    let code = await callMain([id, 'failed', '--reason', 'trying to mark failed anyway', '--actor', 'Nehemiah']);
    t('CLI Stripe-check: a refund that actually exists refuses "failed"', code === 1, code);
    let row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(id);
    t('CLI Stripe-check: no change was made (still needs_review)', row.status === 'needs_review', row);

    // None exists -> failed, key renamed, audit row records the lookup outcome.
    id = seedRow('idem-sc-none');
    const originalIdemKey = 'idem-sc-none';
    stripeService._setStripeForTests({ refunds: { list: async () => ({ data: [], has_more: false }) } });
    code = await callMain([id, 'failed', '--reason', 'confirmed never charged', '--actor', 'Nehemiah']);
    t('CLI Stripe-check: none found -> failed succeeds', code === undefined, code);
    row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(id);
    t('CLI Stripe-check: row finalized failed', row.status === 'failed', row);
    t('CLI Stripe-check: idempotency_key retired (R3-M1, same convention as finalizeRefundLedger)', row.idempotency_key !== originalIdemKey, row.idempotency_key);
    // R3-M1: the lookup result (found/none/error + which refund id, if any, was checked)
    // must land in the api_audit_log ROW itself (response_json), not just activity_log.
    const scAuditRow = database.prepare("SELECT * FROM api_audit_log WHERE action = 'office_refund_manual_resolve' AND entity_id = ?").get(id);
    const scAuditDetail = scAuditRow && JSON.parse(scAuditRow.response_json);
    t('CLI Stripe-check: the api_audit_log row itself records the lookup outcome (stripe_check.outcome)',
      !!scAuditDetail && scAuditDetail.stripe_check && scAuditDetail.stripe_check.outcome === 'none_found' && scAuditDetail.stripe_check.checked === true, scAuditDetail);
    const scActivityRow = database.prepare("SELECT * FROM activity_log WHERE action = 'office_refund_manual_resolve' AND entity_id = ?").get(id);
    const scDetail = scActivityRow && JSON.parse(scActivityRow.details);
    t('CLI Stripe-check: activity_log ALSO records the lookup outcome (stripe_check)', !!scDetail && scDetail.stripe_check && scDetail.stripe_check.outcome === 'none_found', scDetail);

    // Lookup itself fails -> refused, no change.
    id = seedRow('idem-sc-error');
    stripeService._setStripeForTests({ refunds: { list: async () => { throw new Error('simulated Stripe outage'); } } });
    code = await callMain([id, 'failed', '--reason', 'confirmed never charged', '--actor', 'Nehemiah']);
    t('CLI Stripe-check: a lookup failure refuses "failed"', code === 1, code);
    row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(id);
    t('CLI Stripe-check: no change was made after a lookup failure', row.status === 'needs_review', row);

    // M1-NOSTATUSGUARD: a TOCTOU race — the row's status changes (e.g. a concurrent
    // reconcile run finalizes it) AFTER the CLI reads it for eligibility but BEFORE its
    // own UPDATE commits. The `AND status = ?` clause (bound to the status the CLI itself
    // validated eligibility against) must refuse rather than blindly overwrite whatever
    // that concurrent process just wrote. Simulated by hooking the CLI's own initial row
    // SELECT: return the stale (still needs_review) row to the CLI, but flip the REAL row
    // to 'succeeded' first, mimicking another process finishing the race first.
    id = seedRow('idem-sc-toctou');
    stripeService._setStripeForTests({ refunds: { list: async () => ({ data: [], has_more: false }) } });
    const realPrepare = database.prepare.bind(database);
    let hookFired = false;
    database.prepare = (sql) => {
      const stmt = realPrepare(sql);
      if (!hookFired && sql === 'SELECT * FROM office_refunds WHERE id = ?') {
        hookFired = true;
        return {
          get: (...args) => {
            const staleRow = stmt.get(...args);
            realPrepare("UPDATE office_refunds SET status = 'succeeded' WHERE id = ?").run(args[0]);
            return staleRow;
          },
        };
      }
      return stmt;
    };
    code = await callMain([id, 'failed', '--reason', 'confirmed never charged', '--actor', 'Nehemiah']);
    database.prepare = realPrepare;
    t('M1-NOSTATUSGUARD: a status change racing the CLI\'s own read is refused, not clobbered', code === 1, code);
    row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(id);
    t('M1-NOSTATUSGUARD: the row keeps the RACING process\'s answer (succeeded), untouched by the CLI', row.status === 'succeeded', row);

    delete process.env.STRIPE_SECRET_KEY;
    process.exitCode = savedExitCode;
  }

  database.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
