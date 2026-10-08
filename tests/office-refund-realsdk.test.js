// R3-C1(d): exercises routes/office.js's refund endpoint against a FAKE Stripe HTTP
// server driven by the REAL stripe-node client (services/stripe.js's actual getStripe()
// config: {timeout:5000, maxNetworkRetries:1} for the client, {maxNetworkRetries:0} for
// refunds.create specifically) — not a JS stub. This is the only way to see stripe-node's
// own hidden retry after a connection reset (it retries once regardless of
// maxNetworkRetries, reusing the SAME Idempotency-Key), which is exactly the gap R3-C1
// closes: a 409 (`idempotency_key_in_use`/`idempotency_error`) or 429 landing on that
// hidden retry must NEVER be treated as a definitive "Stripe never did it".
//
// Fake Stripe server: tests/helpers/fake-stripe-server.js (127.0.0.1 only), adapted from
// Marcus Bennett's round-3 review probes.
//
// Run from the app root: node tests/office-refund-realsdk.test.js

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-office-realsdk-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
for (const k of ['STRIPE_SECRET_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'SMTP_HOST', 'SMTP_USER',
  'SMTP_PASS', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'VAPI_SERVER_SECRET', 'VAPI_API_KEY']) {
  delete process.env[k];
}

const express = require('express');
const { v4: uuid } = require('uuid');
const Stripe = require('stripe');
const db = require('../db');
db.initialize();
const database = db.getDb();

const { createApiKey } = require('../lib/api-keys');
const stripeService = require('../services/stripe');
const { createFakeStripe } = require('./helpers/fake-stripe-server');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  ${detail !== undefined ? JSON.stringify(detail) : ''}`));
}

function makeBookingAndPayment(bookingNumber, amountDollars, piId) {
  const customerId = uuid();
  database.prepare(`INSERT INTO customers (id, first_name, last_name, email, phone) VALUES (?, 'RealSdk', 'Test', 'realsdk@example.com', '5551230099')`).run(customerId);
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
  const fake = await createFakeStripe();
  // Matches services/stripe.js's getStripe() client config exactly — the client default
  // is maxNetworkRetries:1 (safe for idempotency-keyed writes); createRefund() itself
  // overrides refunds.create specifically to maxNetworkRetries:0 (R3-C1c). Pointed at the
  // fake server over plain HTTP with a dummy test key — this seam
  // (stripeService._setStripeForTests) is test-only; nothing in prod code can reach it.
  const realClient = Stripe('sk_test_fake', {
    timeout: 5000,
    maxNetworkRetries: 1,
    host: '127.0.0.1',
    port: fake.port,
    protocol: 'http',
  });
  stripeService._setStripeForTests(realClient);

  const officeRoutes = require('../routes/office');
  const app = express();
  app.use(express.json());
  app.use('/api/office/v1', officeRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/office/v1`;

  function write(method, urlPath, key, { idempotencyKey, ...body } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (key) headers['x-office-key'] = key;
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    return fetch(`${base}${urlPath}`, { method, headers, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  }

  let counter = 0;
  function nextPiId() { counter += 1; return `pi_realsdk_${counter}`; }

  function setupFixture(amountDollars = 200) {
    const piId = nextPiId();
    const bookingNumber = `BM-REALSDK-${counter}`;
    fake.setCharge(`ch_for_${piId}`, { amount: Math.round(amountDollars * 100), amount_refunded: 0, currency: 'usd' });
    const { bookingNumber: bn, paymentId } = makeBookingAndPayment(bookingNumber, amountDollars, piId);
    const { rawKey } = createApiKey(database, {
      name: `realsdk-key-${counter}`, scopes: ['refunds:create'], maxRefundCents: 20000, dailyRefundCapCents: 50000,
    });
    return { bookingNumber: bn, paymentId, rawKey, piId };
  }

  // ---------------------------------------------------------------------------------
  // Table 1: reset_after_processing (Stripe DID process it) then the SDK's own hidden
  // retry (same Idempotency-Key) gets FAULT2. None of these may ever double-refund, and
  // the app must never release the reservation while a refund exists.
  // ---------------------------------------------------------------------------------
  const resetThenAmbiguous = ['429', 'idempotency_key_in_use_409', 'idempotency_error_409'];
  for (const fault2 of resetThenAmbiguous) {
    const { bookingNumber, rawKey } = setupFixture();
    const idem = `idem-reset-${fault2}`;
    fake.pushRefundFault('reset_after_processing');
    fake.pushRefundFault(fault2);

    const refundsBefore = fake.getRealRefundCount();
    let r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t(`[reset->${fault2}] first attempt -> ambiguous (outcome:"unknown")`, (r.status === 502 || r.status === 504) && r.body.outcome === 'unknown', r);
    t(`[reset->${fault2}] Stripe DID actually process the refund (processed before the fault reached the client)`, fake.getRealRefundCount() === refundsBefore + 1, fake.getRealRefundCount());
    const ledgerId = r.body.ledger_id;
    let ledgerRow = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(ledgerId);
    t(`[reset->${fault2}] ledger row stays pending, never released`, ledgerRow.status === 'pending' && ledgerRow.idempotency_key === idem, ledgerRow);

    // A NEW-key retry must be refused outright (R3-M3), never a second Stripe call.
    r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: `${idem}-newkey`, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t(`[reset->${fault2}] a new-key retry is refused (unresolved_refund)`, r.status === 409 && r.body.error === 'unresolved_refund', r);
    t(`[reset->${fault2}] the new-key refusal made no additional Stripe refund`, fake.getRealRefundCount() === refundsBefore + 1, fake.getRealRefundCount());

    // R3-M2: backdate the reservation past the safe resume window — findRefundByOfficeId
    // must still resolve this correctly from the refund OBJECT (which never expires),
    // regardless of Stripe's own idempotency-KEY TTL.
    database.prepare("UPDATE office_refunds SET created_at = datetime('now', '-25 hours') WHERE id = ?").run(ledgerId);

    // A SAME-key retry resolves via findRefundByOfficeId (never calls refunds.create
    // again) -> exactly one real refund, ledger finalized succeeded.
    r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t(`[reset->${fault2}] same-key retry (even 25h later) -> 201`, r.status === 201 && !!r.body.refund_id, r);
    t(`[reset->${fault2}] EXACTLY ONE real refund exists at the end`, fake.getRealRefundCount() === refundsBefore + 1, fake.getRealRefundCount());
    ledgerRow = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(ledgerId);
    t(`[reset->${fault2}] the SAME ledger row is now succeeded`, ledgerRow.status === 'succeeded' && ledgerRow.id === ledgerId, ledgerRow);
  }

  // ---------------------------------------------------------------------------------
  // reset_after_processing then a genuinely-definitive-shaped 400: the app must confirm
  // via findRefundByOfficeId, find the refund that DID happen, and finalize from it
  // DIRECTLY in the same request — never release, never a second refund.
  // ---------------------------------------------------------------------------------
  {
    const { bookingNumber, rawKey } = setupFixture();
    const idem = 'idem-reset-400';
    fake.pushRefundFault('reset_after_processing');
    fake.pushRefundFault('400');
    const refundsBefore = fake.getRealRefundCount();

    const r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[reset->400] the app confirms via Stripe and finalizes 201 in the SAME request (never a 502)', r.status === 201 && !!r.body.refund_id, r);
    t('[reset->400] exactly one real refund exists', fake.getRealRefundCount() === refundsBefore + 1, fake.getRealRefundCount());
    const ledgerRow = database.prepare('SELECT * FROM office_refunds WHERE idempotency_key = ?').get(idem);
    t('[reset->400] ledger row succeeded, idempotency_key NEVER renamed (never released)', ledgerRow.status === 'succeeded' && ledgerRow.idempotency_key === idem, ledgerRow);
  }

  // ---------------------------------------------------------------------------------
  // reset_before_processing (Stripe touched NOTHING) then a genuine 400: confirmed
  // failed + released. A fresh same-key retry then succeeds normally, exactly 1 refund
  // total across the whole flow.
  // ---------------------------------------------------------------------------------
  {
    const { bookingNumber, rawKey } = setupFixture();
    const idem = 'idem-resetbefore-400';
    fake.pushRefundFault('reset_before_processing');
    fake.pushRefundFault('400');
    const refundsBefore = fake.getRealRefundCount();

    let r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[resetbefore->400] confirmed failed (real 502, no outcome:"unknown")', r.status === 502 && r.body.outcome === undefined, r);
    t('[resetbefore->400] zero refunds were ever created', fake.getRealRefundCount() === refundsBefore, fake.getRealRefundCount());
    const failedRow = database.prepare("SELECT * FROM office_refunds WHERE idempotency_key LIKE ?").get(`${idem}%`);
    t('[resetbefore->400] ledger row failed and RELEASED (key renamed)', failedRow.status === 'failed' && failedRow.idempotency_key !== idem, failedRow);

    r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[resetbefore->400] a fresh same-key retry now succeeds', r.status === 201 && !!r.body.refund_id, r);
    t('[resetbefore->400] exactly one real refund exists total', fake.getRealRefundCount() === refundsBefore + 1, fake.getRealRefundCount());
  }

  // ---------------------------------------------------------------------------------
  // A plain 429 on a first-and-only attempt (no earlier reset -> stripe-node's own
  // maxNetworkRetries:0 means no hidden retry happens at all) is STILL always treated as
  // ambiguous (R3-C1a) — never definitive, even though nothing was ever processed.
  // ---------------------------------------------------------------------------------
  {
    const { bookingNumber, rawKey } = setupFixture();
    const idem = 'idem-solo-429';
    fake.pushRefundFault('429');
    const refundsBefore = fake.getRealRefundCount();

    let r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[solo 429] treated as ambiguous (outcome:"unknown"), never definitive', r.status === 502 && r.body.outcome === 'unknown', r);
    t('[solo 429] nothing was ever processed', fake.getRealRefundCount() === refundsBefore, fake.getRealRefundCount());
    const pendingRow = database.prepare('SELECT * FROM office_refunds WHERE idempotency_key = ?').get(idem);
    t('[solo 429] ledger row stays pending, not released', pendingRow.status === 'pending', pendingRow);

    r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[solo 429] same-key retry now succeeds (Stripe never actually saw a fault this time)', r.status === 201, r);
    t('[solo 429] exactly one real refund exists', fake.getRealRefundCount() === refundsBefore + 1, fake.getRealRefundCount());
  }

  // ---------------------------------------------------------------------------------
  // R3-C1(c): refunds.create must pass maxNetworkRetries:0 — a plain 500 with NOTHING
  // processed (no reset involved, so none of stripe-node's HARDCODED retry-regardless-of-
  // setting behavior applies here) is the cleanest way to observe this specific request
  // option: with the client's own default (1) instead, stripe-node retries a 500
  // automatically, and the retry lands on the fake server's now-empty fault queue (which
  // "tells the truth" and processes it) — silently turning one real ambiguous-outcome
  // attempt into a normal-looking success. maxNetworkRetries:0 means exactly one HTTP
  // attempt reaches the fake server no matter what.
  // ---------------------------------------------------------------------------------
  {
    const { bookingNumber, rawKey } = setupFixture();
    const idem = 'idem-solo-500-retries';
    fake.pushRefundFault('500_no_process');
    const refundsBefore = fake.getRealRefundCount();
    const callsBefore = fake.getLog().filter((e) => e.method === 'POST' && e.path === '/v1/refunds').length;

    const r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    const callsAfter = fake.getLog().filter((e) => e.method === 'POST' && e.path === '/v1/refunds').length;
    t('[C1-RETRIES] exactly ONE HTTP attempt reached the fake server (maxNetworkRetries:0 on refunds.create)', callsAfter === callsBefore + 1, { before: callsBefore, after: callsAfter });
    t('[C1-RETRIES] the single 500 surfaces as ambiguous (outcome:"unknown"), not a silently-retried success', r.status === 502 && r.body.outcome === 'unknown', r);
    t('[C1-RETRIES] nothing was ever processed', fake.getRealRefundCount() === refundsBefore, fake.getRealRefundCount());
  }

  // ---------------------------------------------------------------------------------
  // A genuine 400 with NO earlier processing at all -> findRefundByOfficeId confirms
  // nothing exists -> failed + released, exactly as a definitive error always did.
  // ---------------------------------------------------------------------------------
  {
    const { bookingNumber, rawKey } = setupFixture();
    const idem = 'idem-solo-400';
    fake.pushRefundFault('400');
    const refundsBefore = fake.getRealRefundCount();

    let r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[solo 400] confirmed failed (no outcome:"unknown")', r.status === 502 && r.body.outcome === undefined, r);
    t('[solo 400] zero refunds were ever created', fake.getRealRefundCount() === refundsBefore, fake.getRealRefundCount());

    r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[solo 400] fresh same-key retry succeeds', r.status === 201, r);
    t('[solo 400] exactly one real refund exists', fake.getRealRefundCount() === refundsBefore + 1, fake.getRealRefundCount());
  }

  // ---------------------------------------------------------------------------------
  // R3-C1(b): if the confirmation lookup ITSELF fails (not "not found" — genuinely
  // fails), a definitive-looking error must stay pending/ambiguous, never released.
  // ---------------------------------------------------------------------------------
  {
    const { bookingNumber, rawKey } = setupFixture();
    const idem = 'idem-lookupfail-400';
    fake.pushRefundFault('400');
    fake.failNextList();
    const refundsBefore = fake.getRealRefundCount();

    let r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[lookup fails] stays ambiguous (outcome:"unknown"), not released', (r.status === 502 || r.status === 504) && r.body.outcome === 'unknown', r);
    const row = database.prepare('SELECT * FROM office_refunds WHERE idempotency_key = ?').get(idem);
    t('[lookup fails] ledger row still pending', row.status === 'pending', row);

    // The follow-up retry's OWN lookup succeeds (no fault queued this time) and
    // correctly finds nothing -> proceeds to a fresh Stripe call -> succeeds.
    r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[lookup fails] a later retry (lookup working again) succeeds', r.status === 201, r);
    t('[lookup fails] exactly one real refund exists', fake.getRealRefundCount() === refundsBefore + 1, fake.getRealRefundCount());
  }

  // ---------------------------------------------------------------------------------
  // R3-M2: a pending row with NO Stripe answer at all, backdated past the resume
  // window -> refused (needs_review, 409 refund_needs_reconcile) rather than blindly
  // calling refunds.create again.
  // ---------------------------------------------------------------------------------
  {
    const { bookingId, bookingNumber, paymentId } = makeBookingAndPayment('BM-REALSDK-AGED', 200, nextPiId());
    const { rawKey, id: keyId } = createApiKey(database, { name: 'realsdk-aged-key', scopes: ['refunds:create'], maxRefundCents: 20000, dailyRefundCapCents: 50000 });
    const idem = 'idem-aged-pending';
    const ledgerId = uuid();
    database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 5000, 'pending', 'Nehemiah', 'x', datetime('now', '-25 hours'), datetime('now', '-25 hours'))`)
      .run(ledgerId, keyId, 'realsdk-aged-key', idem, bookingId, paymentId);

    const refundsBefore = fake.getRealRefundCount();
    const r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[aged, never happened] refused with refund_needs_reconcile', r.status === 409 && r.body.error === 'refund_needs_reconcile' && r.body.ledger_id === ledgerId, r);
    t('[aged, never happened] no refunds.create call was made', fake.getRealRefundCount() === refundsBefore, fake.getRealRefundCount());
    const row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(ledgerId);
    t('[aged, never happened] row marked needs_review', row.status === 'needs_review', row);
  }

  // ---------------------------------------------------------------------------------
  // R4-L2 (N09): pins RESUME_MAX_AGE_MS at exactly 23h. The existing fixtures only ever
  // exercise 22h (implicitly resumed before backdating) and 25h — neither one actually
  // distinguishes the real 23h constant from a mutant that widened it to 25h. A resume at
  // ~23.5h (nothing at Stripe) must still be refused needs_review/409 under the real
  // constant, and a resume at ~22.5h must still proceed normally either way.
  // ---------------------------------------------------------------------------------
  {
    const { bookingId, bookingNumber, paymentId } = makeBookingAndPayment('BM-REALSDK-N09A', 200, nextPiId());
    const { rawKey, id: keyId } = createApiKey(database, { name: 'realsdk-n09a-key', scopes: ['refunds:create'], maxRefundCents: 20000, dailyRefundCapCents: 50000 });
    const idem = 'idem-n09-235h';
    const ledgerId = uuid();
    database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 5000, 'pending', 'Nehemiah', 'x', datetime('now', '-23 hours', '-30 minutes'), datetime('now', '-23 hours', '-30 minutes'))`)
      .run(ledgerId, keyId, 'realsdk-n09a-key', idem, bookingId, paymentId);

    const refundsBefore = fake.getRealRefundCount();
    const r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[N09] a resume at ~23.5h with nothing at Stripe is refused (needs_review, 409 refund_needs_reconcile)', r.status === 409 && r.body.error === 'refund_needs_reconcile', r);
    t('[N09] no refunds.create call was made at 23.5h', fake.getRealRefundCount() === refundsBefore, fake.getRealRefundCount());
    const row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(ledgerId);
    t('[N09] row marked needs_review at 23.5h', row.status === 'needs_review', row);
  }
  {
    const { bookingId, bookingNumber, paymentId } = makeBookingAndPayment('BM-REALSDK-N09B', 200, nextPiId());
    const { rawKey, id: keyId } = createApiKey(database, { name: 'realsdk-n09b-key', scopes: ['refunds:create'], maxRefundCents: 20000, dailyRefundCapCents: 50000 });
    const idem = 'idem-n09-225h';
    const ledgerId = uuid();
    database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 5000, 'pending', 'Nehemiah', 'x', datetime('now', '-22 hours', '-30 minutes'), datetime('now', '-22 hours', '-30 minutes'))`)
      .run(ledgerId, keyId, 'realsdk-n09b-key', idem, bookingId, paymentId);

    const refundsBefore = fake.getRealRefundCount();
    const r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[N09] a resume at ~22.5h with nothing at Stripe still resumes normally -> 201', r.status === 201 && !!r.body.refund_id, r);
    t('[N09] exactly one refunds.create call was made at 22.5h', fake.getRealRefundCount() === refundsBefore + 1, fake.getRealRefundCount());
    const row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(ledgerId);
    t('[N09] row marked succeeded at 22.5h', row.status === 'succeeded', row);
  }

  // ---------------------------------------------------------------------------------
  // Confirms the exact ORDER of R3-M2's resume logic: the 23h-age refusal only ever
  // fires AFTER findRefundByOfficeId has run and come back with a definite "nothing
  // found" — never when the lookup itself fails. A resume whose lookup fails always
  // stays ambiguous (502/504, outcome:"unknown", no refunds.create), regardless of how
  // old the reservation is (even older than the 23h window).
  // ---------------------------------------------------------------------------------
  {
    // (i) A FRESH pending row (well under 23h) whose RESUME lookup fails.
    const { bookingNumber, rawKey } = setupFixture();
    const idem = 'idem-resume-lookupfail-fresh';
    fake.pushRefundFault('reset_after_processing');
    fake.pushRefundFault('429'); // first attempt: ambiguous, Stripe DID process it
    let refundsBefore = fake.getRealRefundCount();
    let r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[resume lookup fails, fresh] first attempt -> ambiguous', r.status === 502 && r.body.outcome === 'unknown', r);
    const ledgerId1 = r.body.ledger_id;

    // The RESUME's own findRefundByOfficeId call fails — must stay ambiguous, not call
    // refunds.create again, and NOT be reinterpreted as "nothing found" (which would be
    // wrong: the refund actually exists, we just couldn't confirm it this time).
    fake.failNextList();
    const callsBeforeResume = fake.getLog().filter((e) => e.path === '/v1/refunds' && e.method === 'POST').length;
    r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[resume lookup fails, fresh] stays ambiguous (502/504, outcome:"unknown"), NOT refund_needs_reconcile',
      (r.status === 502 || r.status === 504) && r.body.outcome === 'unknown' && r.body.error !== 'refund_needs_reconcile', r);
    const callsAfterResume = fake.getLog().filter((e) => e.path === '/v1/refunds' && e.method === 'POST').length;
    t('[resume lookup fails, fresh] NO refunds.create call was made on this resume', callsAfterResume === callsBeforeResume, { before: callsBeforeResume, after: callsAfterResume });
    t('[resume lookup fails, fresh] no additional real refund was created', fake.getRealRefundCount() === refundsBefore + 1, fake.getRealRefundCount());
    let row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(ledgerId1);
    t('[resume lookup fails, fresh] row still pending (never needs_review, never released)', row.status === 'pending', row);

    // A later resume (lookup working again) correctly finds the real refund and finalizes.
    r = await write('POST', `/bookings/${bookingNumber}/refunds`, rawKey, {
      idempotencyKey: idem, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[resume lookup fails, fresh] a later resume (lookup working) finalizes 201', r.status === 201, r);
    t('[resume lookup fails, fresh] still exactly one real refund total', fake.getRealRefundCount() === refundsBefore + 1, fake.getRealRefundCount());

    // (ii) The SAME scenario, but the reservation is ALSO older than the 23h window —
    // proves the age-refusal (409 refund_needs_reconcile) does NOT preempt a lookup
    // failure; a failed lookup is ALWAYS ambiguous, regardless of age.
    const { bookingNumber: bn2, rawKey: rawKey2 } = setupFixture();
    const idem2 = 'idem-resume-lookupfail-aged';
    fake.pushRefundFault('reset_after_processing');
    fake.pushRefundFault('429');
    refundsBefore = fake.getRealRefundCount();
    r = await write('POST', `/bookings/${bn2}/refunds`, rawKey2, {
      idempotencyKey: idem2, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    const ledgerId2 = r.body.ledger_id;
    database.prepare("UPDATE office_refunds SET created_at = datetime('now', '-25 hours') WHERE id = ?").run(ledgerId2);

    fake.failNextList();
    r = await write('POST', `/bookings/${bn2}/refunds`, rawKey2, {
      idempotencyKey: idem2, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[resume lookup fails, AGED >23h] STILL ambiguous, not the age-refusal (409 refund_needs_reconcile never fires on a lookup failure)',
      (r.status === 502 || r.status === 504) && r.body.outcome === 'unknown', r);
    row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(ledgerId2);
    t('[resume lookup fails, AGED >23h] row stays pending (not needs_review)', row.status === 'pending', row);

    // Once the lookup works again, findRefundByOfficeId finds the real (already-existing)
    // refund and finalizes from it — the age check is never even reached, because
    // something WAS found.
    r = await write('POST', `/bookings/${bn2}/refunds`, rawKey2, {
      idempotencyKey: idem2, reason: 'x', confirmed_by: 'Nehemiah', amount_cents: 5000,
    });
    t('[resume lookup fails, AGED >23h] once the lookup works, finds the real refund and finalizes -> 201', r.status === 201, r);
    t('[resume lookup fails, AGED >23h] exactly one real refund total (age never forced a fresh create)', fake.getRealRefundCount() === refundsBefore + 1, fake.getRealRefundCount());
  }

  // ---------------------------------------------------------------------------------
  // R6-M1: scripts/resolve-office-refund.js's error classifier, against the REAL Stripe
  // SDK error shapes (400/403/409/401/500/503/429/connection-reset) — driven through the
  // fake Stripe HTTP server exactly like the refund-create tests above, but exercising
  // stripeService.retrieveRefund (the 'succeeded' direction) and findRefundByOfficeId's
  // list call (the 'failed' direction). 400/403/409/401 must NEVER be forceable with
  // --no-verify (conflict, exit 1, row/audit untouched, in BOTH directions); 500/503/429/
  // a connection reset ARE forceable and get audited as forced.
  //
  // A separate client with maxNetworkRetries:0 avoids stripe-node's own automatic retry
  // (which would otherwise consume the queued fault on a hidden retry and land on a
  // second, unfaulted attempt) — except for a connection reset, which stripe-node retries
  // exactly once REGARDLESS of maxNetworkRetries (RequestSender._shouldRetry's hardcoded
  // ECONNRESET/EPIPE case), so 'reset' is queued twice to survive that hidden retry.
  // ---------------------------------------------------------------------------------
  {
    const resolveCli = require('../scripts/resolve-office-refund');
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_resolve_realsdk';
    const cliClient = Stripe('sk_test_fake', {
      timeout: 3000, maxNetworkRetries: 0, host: '127.0.0.1', port: fake.port, protocol: 'http',
    });
    stripeService._setStripeForTests(cliClient);

    async function callMain(argv) {
      process.exitCode = undefined;
      await resolveCli.main(argv);
      const code = process.exitCode;
      process.exitCode = undefined;
      return code;
    }

    function seedCliRow(idemKey) {
      const piId = nextPiId();
      fake.setCharge(`ch_for_${piId}`, { amount: 10000, amount_refunded: 0, currency: 'usd' });
      const { bookingId, paymentId } = makeBookingAndPayment(`BM-CLI-REALSDK-${idemKey}`, 100, piId);
      const { id: keyId } = createApiKey(database, { name: `cli-realsdk-${idemKey}`, scopes: ['refunds:create'] });
      const id = uuid();
      const oldTimestamp = new Date(Date.now() - 30 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      database.prepare(`INSERT INTO office_refunds (id, key_id, key_name, idempotency_key, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1000, 'needs_review', 'Nehemiah', 'x', ?, ?)`)
        .run(id, keyId, `cli-realsdk-${idemKey}`, idemKey, bookingId, paymentId, oldTimestamp, oldTimestamp);
      return { id, bookingId, paymentId };
    }

    // R7-M1: a 400 whose message/code ALSO looks like a network/timeout fault must still
    // refuse — proves the fix (a 4xx statusCode always wins over the timeout heuristic)
    // holds through the real SDK's actual error shape, not just the unit classifier.
    const NEVER_FORCEABLE = ['400', '403', '409', '401', '400_timeout_message'];
    for (const mode of NEVER_FORCEABLE) {
      for (const noVerify of [false, true]) {
        const label = `${mode}${noVerify ? '+nv' : ''}`;

        // succeeded direction: retrieveRefund
        {
          const seeded = seedCliRow(`idem-realsdk-succ-${mode}-${noVerify}`);
          fake.pushRetrieveRefundFault(mode);
          const auditCountBefore = database.prepare('SELECT COUNT(*) c FROM api_audit_log').get().c;
          const argv = [seeded.id, 'succeeded', '--reason', 'x', '--actor', 'Nehemiah', '--stripe-refund', 're_realsdk_fake'];
          if (noVerify) argv.push('--no-verify');
          const code = await callMain(argv);
          t(`[realsdk succeeded ${label}] refuses, never forceable`, code === 1, code);
          const row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(seeded.id);
          t(`[realsdk succeeded ${label}] row unchanged (still needs_review)`, row.status === 'needs_review', row);
          const auditCountAfter = database.prepare('SELECT COUNT(*) c FROM api_audit_log').get().c;
          t(`[realsdk succeeded ${label}] no resolved audit row`, auditCountAfter === auditCountBefore, { before: auditCountBefore, after: auditCountAfter });
        }

        // failed direction: findRefundByOfficeId (list)
        {
          const seeded = seedCliRow(`idem-realsdk-fail-${mode}-${noVerify}`);
          fake.failNextList(mode);
          const auditCountBefore = database.prepare('SELECT COUNT(*) c FROM api_audit_log').get().c;
          const argv = [seeded.id, 'failed', '--reason', 'x', '--actor', 'Nehemiah'];
          if (noVerify) argv.push('--no-verify');
          const code = await callMain(argv);
          t(`[realsdk failed ${label}] refuses, never forceable`, code === 1, code);
          const row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(seeded.id);
          t(`[realsdk failed ${label}] row unchanged (still needs_review)`, row.status === 'needs_review', row);
          const auditCountAfter = database.prepare('SELECT COUNT(*) c FROM api_audit_log').get().c;
          t(`[realsdk failed ${label}] no resolved audit row`, auditCountAfter === auditCountBefore, { before: auditCountBefore, after: auditCountAfter });
        }
      }
    }

    const FORCEABLE_WITH_NO_VERIFY = ['500', '503', '429', 'reset'];
    for (const mode of FORCEABLE_WITH_NO_VERIFY) {
      // succeeded direction, forced
      {
        const seeded = seedCliRow(`idem-realsdk-force-succ-${mode}`);
        fake.pushRetrieveRefundFault(mode);
        if (mode === 'reset') fake.pushRetrieveRefundFault(mode); // survive the hidden retry-on-reset
        const code = await callMain([seeded.id, 'succeeded', '--reason', 'x', '--actor', 'Nehemiah', '--stripe-refund', 're_realsdk_forced', '--no-verify']);
        t(`[realsdk succeeded ${mode}+nv] forced through`, code === undefined, code);
        const row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(seeded.id);
        t(`[realsdk succeeded ${mode}+nv] row recorded succeeded via the forced path`, row.status === 'succeeded' && row.stripe_refund_id === 're_realsdk_forced', row);
        const auditRow = database.prepare("SELECT * FROM api_audit_log WHERE action = 'office_refund_manual_resolve' AND entity_id = ?").get(seeded.id);
        const detail = auditRow && JSON.parse(auditRow.response_json);
        t(`[realsdk succeeded ${mode}+nv] audited as forced (verification_failed_forced)`,
          !!detail && detail.stripe_check.outcome === 'verification_failed_forced' && detail.verified_against_stripe === false, detail);
      }
      // failed direction, forced
      {
        const seeded = seedCliRow(`idem-realsdk-force-fail-${mode}`);
        fake.failNextList(mode);
        if (mode === 'reset') fake.failNextList(mode); // survive the hidden retry-on-reset
        const code = await callMain([seeded.id, 'failed', '--reason', 'x', '--actor', 'Nehemiah', '--no-verify']);
        t(`[realsdk failed ${mode}+nv] forced through`, code === undefined, code);
        const row = database.prepare('SELECT * FROM office_refunds WHERE id = ?').get(seeded.id);
        t(`[realsdk failed ${mode}+nv] row recorded failed via the forced path`, row.status === 'failed', row);
        const auditRow = database.prepare("SELECT * FROM api_audit_log WHERE action = 'office_refund_manual_resolve' AND entity_id = ?").get(seeded.id);
        const detail = auditRow && JSON.parse(auditRow.response_json);
        t(`[realsdk failed ${mode}+nv] audited as forced (verification_failed_forced)`,
          !!detail && detail.stripe_check.outcome === 'verification_failed_forced' && detail.verified_against_stripe === false, detail);
      }
    }

    delete process.env.STRIPE_SECRET_KEY;
  }

  server.close();
  database.close();
  await fake.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
