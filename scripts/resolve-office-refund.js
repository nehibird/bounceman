#!/usr/bin/env node
'use strict';

// R2-C1/R2-M2a: the ONLY supported way to manually resolve a stuck office_refunds row
// (one lib/refund-reconcile.js's automated sweep couldn't settle) short of hand-editing
// prod SQLite. Never calls stripe.refunds.create — like reconcile, this can only RECORD
// what a human has already confirmed happened (or didn't) on Stripe's side.
//
//   node scripts/resolve-office-refund.js <ledger_id> succeeded|failed --reason "<text>"
//     [--stripe-refund re_...] [--actor <name>] [--no-verify] [--older-than-minutes 15]
//
// Only acts on a row that is 'needs_review', or 'pending' and older than
// --older-than-minutes (default 15) — a fresh/genuinely-in-progress row is refused, so
// this can never be used to jump ahead of a refund attempt that's still legitimately
// running.
//
// --reason is REQUIRED (non-empty after trim) — without it, exits non-zero with NO change.
//
// Marking 'succeeded' REQUIRES --stripe-refund re_..., and is verified against Stripe
// whenever STRIPE_SECRET_KEY is set: the retrieved refund's own status must be
// 'succeeded' (a live 'failed'/'canceled'/'pending'/'requires_action' refund is refused),
// its metadata.office_refund_id must match this ledger row's id, its amount must match,
// and its currency must be usd. Without Stripe access (no STRIPE_SECRET_KEY), an explicit
// --no-verify is required, so a typo'd refund id can never be recorded as fact by accident.
//
// R5/R6-M1: any live Stripe ANSWER — a status other than 'succeeded', a 404 (the id
// doesn't exist), a metadata/amount/currency mismatch, or any other 4xx (including a bad
// API key, 401) — can NEVER be overridden by --no-verify. --no-verify only covers
// network/connection errors, timeouts, 5xx, 429, a missing key, or no Stripe id; any other
// Stripe response (any 4xx incl. 401/403/404/409) refuses. See lib/stripe-errors.js's
// classifyStripeLookupError for the shared allow-list this is built on.
//
// The status change and its audit rows (api_audit_log + activity_log) are written in the
// SAME better-sqlite3 transaction — either both happen, or neither does.

const { v4: uuid } = require('uuid');
const { getDb, initialize } = require('../db');
const stripeService = require('../services/stripe');
const { classifyStripeLookupError } = require('../lib/stripe-errors');

const RESOLVABLE_TARGET_STATUSES = new Set(['succeeded', 'failed']);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i += 1; } else { args[key] = true; }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function printUsage() {
  console.error([
    'Usage:',
    '  resolve-office-refund.js <ledger_id> succeeded|failed --reason "<text>"',
    '      [--stripe-refund re_...] [--actor <name>] [--no-verify] [--older-than-minutes 15]',
  ].join('\n'));
}

// R4-M1: both verify* helpers below RETURN a structured {outcome, ...} result instead of
// throwing on a conflict — a POSITIVE Stripe finding (a live refund exists; a metadata or
// amount mismatch) must ALWAYS win and can NEVER be overridden by --no-verify, which is
// meant only for "Stripe couldn't be asked at all" (a failed/timed-out call, no
// STRIPE_SECRET_KEY, or — R4-L4 — no pi_/ch_ id to even ask about). Throwing made both
// cases look identical to the caller's catch block, which is exactly the R4-M1 hole:
// --no-verify silently forced through a CONFIRMED live refund the same way it forced
// through a network timeout. Outcomes: 'verified'/'none_found' (good — proceed),
// 'conflict' (Stripe positively disagrees — never overridable), 'unavailable' (the Stripe
// call itself failed — the only thing --no-verify may excuse), 'no_stripe_target' (R4-L4:
// there was nothing to even ask Stripe about — NOT the same fact as a completed check).
//
// R5-M1: 'succeeded' requires the RETRIEVED refund's own status to be 'succeeded' — a
// live refund that Stripe says is 'failed'/'canceled' means the money never went out
// (resolve the row as 'failed' instead); 'pending'/'requires_action' (or anything else
// non-succeeded) isn't final yet and belongs to reconcile's sweep, not this CLI. Both are
// 'conflict' (a live Stripe status is a positive finding — never overridable by
// --no-verify), never 'unavailable' (that's reserved for the CALL failing, not Stripe
// answering). Optional hardening: also require currency 'usd', so a refund that happens
// to share this ledger row's id/metadata/amount in a different currency can't slip through.
//
// R5-M2/R6-M1: the catch block below classifies retrieveRefund's own failure with the
// SHARED allow-list classifier (lib/stripe-errors.js's classifyStripeLookupError) — only a
// connection error, a 5xx, a 429, or a network/timeout code counts as the CALL failing
// (the one thing --no-verify may excuse). A 404/resource_missing ("No such refund") is
// Stripe POSITIVELY saying this id does not exist, so it keeps its own specific message
// ahead of the shared classifier, but is still a conflict either way. A bad API key
// (StripeAuthenticationError/401) is ALSO a conflict now, not an excusable outage — see
// classifyStripeLookupError's comment for the reasoning (a key problem is the operator's
// to fix, never to force through).
async function verifyStripeRefund(row, stripeRefundId) {
  let refund;
  try {
    refund = await stripeService.retrieveRefund(stripeRefundId);
  } catch (err) {
    if (err && (err.statusCode === 404 || err.code === 'resource_missing')) {
      return { outcome: 'conflict', error: `Stripe says this refund id does not exist: ${err.message}` };
    }
    const classified = classifyStripeLookupError(err);
    return { outcome: classified.outcome, error: classified.message };
  }
  if (!refund) return { outcome: 'unavailable', error: `Stripe returned no refund for ${stripeRefundId}` };
  // R6-I1: computed before the status check (and named in ITS message too) so a `failed`
  // refund that actually belongs to a DIFFERENT ledger row reports the metadata mismatch
  // as well, rather than only ever hinting "resolve this row as failed" — the failed path
  // re-verifies with findRefundByOfficeId(row) regardless, so this is a hint, not a gate.
  const metaId = refund.metadata && refund.metadata.office_refund_id;
  const metaMismatchNote = metaId !== row.id
    ? ` (also: its metadata.office_refund_id is '${metaId || 'none'}', not this row's '${row.id}' — it may belong to a different ledger row entirely)`
    : '';
  if (refund.status !== 'succeeded') {
    const message = (refund.status === 'failed' || refund.status === 'canceled')
      ? `refund ${stripeRefundId} status is '${refund.status}' — resolve this row as 'failed' instead of 'succeeded'${metaMismatchNote}`
      : `refund ${stripeRefundId} status is '${refund.status}', not final yet — leave it to reconcile${metaMismatchNote}`;
    return { outcome: 'conflict', refund, error: message };
  }
  if (metaId !== row.id) {
    return { outcome: 'conflict', refund, error: `refund ${stripeRefundId} metadata.office_refund_id (${metaId || 'none'}) does not match ledger id ${row.id}` };
  }
  if (refund.amount !== row.amount_cents) {
    return { outcome: 'conflict', refund, error: `refund ${stripeRefundId} amount (${refund.amount}) does not match ledger amount_cents (${row.amount_cents})` };
  }
  if (refund.currency !== 'usd') {
    return { outcome: 'conflict', refund, error: `refund ${stripeRefundId} currency (${refund.currency || 'missing'}) is not usd` };
  }
  return { outcome: 'verified', refund };
}

// R3-M1: before marking a row 'failed', confirm with Stripe that no refund actually went
// out for it — mirrors routes/office.js's own "confirm before finalizing failed" rule
// (R3-C1(b)). R4-L4: a payment with no pi_/ch_ id to check is refused BEFORE ever calling
// stripeService — this is not "checked, none found", it's "there was nothing to check".
async function verifyNoRefundWentOut(row, payment) {
  const hasStripeTarget = !!payment && (
    (typeof payment.stripe_payment_id === 'string' && payment.stripe_payment_id.startsWith('pi_')) ||
    (typeof payment.stripe_charge_id === 'string' && payment.stripe_charge_id.startsWith('ch_'))
  );
  if (!hasStripeTarget) return { outcome: 'no_stripe_target' };

  let found;
  try {
    found = await stripeService.findRefundByOfficeId(row.id, payment);
  } catch (err) {
    // R6-M1: same shared allow-list classifier as verifyStripeRefund — a 400/403/409/401
    // (or any other definitive Stripe answer) from this LOOKUP CALL ITSELF is never
    // forceable, exactly like the succeeded direction. Returned as its own
    // 'lookup_conflict' outcome (not plain 'conflict') so the caller in main() never
    // confuses this with the "a live refund was actually found" conflict below, which
    // carries a `refund` object the lookup-error case has none of.
    const classified = classifyStripeLookupError(err);
    return { outcome: classified.outcome === 'conflict' ? 'lookup_conflict' : classified.outcome, error: classified.message };
  }
  if (found && found.status !== 'failed' && found.status !== 'canceled') {
    return { outcome: 'conflict', refund: found };
  }
  return { outcome: 'none_found', refund: found || null };
}

async function main(argv = process.argv.slice(2)) {
  const [ledgerId, targetStatus, ...rest] = argv;
  const args = parseArgs(rest);

  if (!ledgerId || !RESOLVABLE_TARGET_STATUSES.has(targetStatus)) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  if (!reason) {
    console.error('--reason is required (non-empty) — no change made.');
    process.exitCode = 1;
    return;
  }
  // R3-M1: --actor is now REQUIRED — a default of 'unknown-operator' defeated the point
  // of the audit trail naming who confirmed the outcome.
  const actor = typeof args.actor === 'string' ? args.actor.trim() : '';
  if (!actor) {
    console.error('--actor is required (non-empty) — no change made.');
    process.exitCode = 1;
    return;
  }

  const olderThanMinutes = args['older-than-minutes'] !== undefined ? parseInt(args['older-than-minutes'], 10) : 15;
  if (!Number.isFinite(olderThanMinutes) || olderThanMinutes < 0) {
    console.error('--older-than-minutes must be a non-negative number — no change made.');
    process.exitCode = 1;
    return;
  }

  initialize();
  const db = getDb();
  const row = db.prepare('SELECT * FROM office_refunds WHERE id = ?').get(ledgerId);
  if (!row) {
    console.error(`No office_refunds row with id ${ledgerId} — no change made.`);
    process.exitCode = 1;
    return;
  }

  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const eligible = row.status === 'needs_review' || (row.status === 'pending' && row.created_at <= cutoff);
  if (!eligible) {
    console.error(`office_refunds ${ledgerId} is '${row.status}' (created_at=${row.created_at}) — not eligible ` +
      `(must be needs_review, or pending and older than ${olderThanMinutes} min). No change made.`);
    process.exitCode = 1;
    return;
  }

  let verifiedRefund = null;
  let stripeRefundId = null;
  // R3-M1: --stripe-refund must look like a real refund id EVEN with --no-verify — a
  // typo'd id must never be recorded as fact just because verification was skipped.
  if (typeof args['stripe-refund'] === 'string' && args['stripe-refund'].trim() && !/^re_/.test(args['stripe-refund'].trim())) {
    console.error(`--stripe-refund must look like a Stripe refund id (re_...), got: ${args['stripe-refund'].trim()} — no change made.`);
    process.exitCode = 1;
    return;
  }

  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(row.payment_id);
  let stripeCheck = { checked: false, outcome: null, refund_id_checked: null };

  if (targetStatus === 'succeeded') {
    stripeRefundId = typeof args['stripe-refund'] === 'string' ? args['stripe-refund'].trim() : '';
    if (!stripeRefundId) {
      console.error('--stripe-refund re_... is required to mark a refund succeeded — no change made.');
      process.exitCode = 1;
      return;
    }
    if (process.env.STRIPE_SECRET_KEY) {
      const result = await verifyStripeRefund(row, stripeRefundId);
      if (result.outcome === 'verified') {
        verifiedRefund = result.refund;
        stripeCheck = { checked: true, outcome: 'verified', refund_id_checked: stripeRefundId };
      } else if (result.outcome === 'conflict') {
        // R4-M1: Stripe POSITIVELY disagrees (metadata or amount mismatch) — this is a
        // confirmed finding, never overridable by --no-verify.
        console.error(`Stripe verification found a conflict: ${result.error}`);
        console.error('No change made. This cannot be overridden with --no-verify — a positive Stripe finding always wins.');
        process.exitCode = 1;
        return;
      } else {
        // 'unavailable' — the Stripe call itself failed; this is the only thing
        // --no-verify may excuse.
        console.error(`Stripe verification failed: ${result.error}`);
        if (!args['no-verify']) {
          console.error('No change made. Pass --no-verify to force this despite the failed verification (NOT recommended).');
          process.exitCode = 1;
          return;
        }
        console.error('--no-verify passed: proceeding WITHOUT Stripe verification despite the failure above.');
        stripeCheck = { checked: true, outcome: 'verification_failed_forced', refund_id_checked: stripeRefundId, error: result.error };
      }
    } else if (!args['no-verify']) {
      console.error('STRIPE_SECRET_KEY is not set, so this refund id cannot be verified against Stripe.');
      console.error('Pass --no-verify to proceed anyway. No change made.');
      process.exitCode = 1;
      return;
    } else {
      stripeCheck = { checked: false, outcome: 'no_verify_no_stripe_access', refund_id_checked: stripeRefundId };
    }
  } else {
    // R3-M1: marking 'failed' needs the SAME kind of confirmation as routes/office.js's
    // R3-C1(b) fix — a row can only retire the reservation once Stripe has actually
    // confirmed nothing went out. Refuse if a non-failed/non-canceled refund exists for
    // it, or if the lookup itself fails; require --no-verify without Stripe access.
    if (process.env.STRIPE_SECRET_KEY) {
      const result = await verifyNoRefundWentOut(row, payment);
      if (result.outcome === 'no_stripe_target') {
        // R4-L4: nothing to even ask Stripe about — never record this as a completed
        // check ('checked:true, none_found' would be a false claim of confirmation).
        if (!args['no-verify']) {
          console.error('This payment has no Stripe pi_/ch_ id to verify against — nothing was checked.');
          console.error('Pass --no-verify to proceed anyway. No change made.');
          process.exitCode = 1;
          return;
        }
        console.error('--no-verify passed: this payment has no Stripe pi_/ch_ id, so nothing could be checked at all.');
        stripeCheck = { checked: false, outcome: 'no_stripe_target' };
      } else if (result.outcome === 'conflict') {
        // R4-M1: Stripe POSITIVELY confirms a live refund exists — this always wins and
        // is never overridable by --no-verify (that flag is for an UNAVAILABLE check, not
        // a check that came back and disagreed with you).
        console.error(`A Stripe refund already exists for this ledger row (${result.refund.id}, status=${result.refund.status}) — cannot mark failed.`);
        console.error(`If that refund is correct, run instead: resolve-office-refund.js ${ledgerId} succeeded --stripe-refund ${result.refund.id} --actor <name> --reason "<text>"`);
        console.error('No change made. This cannot be overridden with --no-verify.');
        process.exitCode = 1;
        return;
      } else if (result.outcome === 'lookup_conflict') {
        // R6-M1: the LOOKUP CALL ITSELF got a definitive Stripe answer (400/403/409/401/
        // etc) rather than failing to reach Stripe at all — never forceable, same as the
        // 'succeeded' direction.
        console.error(`Stripe verification found a conflict: ${result.error}`);
        console.error('No change made. This cannot be overridden with --no-verify — a positive Stripe finding always wins.');
        process.exitCode = 1;
        return;
      } else if (result.outcome === 'unavailable') {
        console.error(`Stripe verification failed: ${result.error}`);
        if (!args['no-verify']) {
          console.error('No change made. Pass --no-verify to force this despite the failed verification (NOT recommended).');
          process.exitCode = 1;
          return;
        }
        console.error('--no-verify passed: proceeding WITHOUT Stripe verification despite the failure above.');
        stripeCheck = { checked: true, outcome: 'verification_failed_forced', error: result.error };
      } else {
        // 'none_found' — Stripe was actually asked and genuinely has nothing (or only a
        // failed/canceled refund) for this row.
        stripeCheck = { checked: true, outcome: 'none_found', refund_id_checked: result.refund ? result.refund.id : null };
      }
    } else if (!args['no-verify']) {
      console.error('STRIPE_SECRET_KEY is not set, so this cannot be verified against Stripe.');
      console.error('Pass --no-verify to proceed anyway. No change made.');
      process.exitCode = 1;
      return;
    } else {
      stripeCheck = { checked: false, outcome: 'no_verify_no_stripe_access' };
    }
  }

  const oldStatus = row.status;
  const newStripeRefundId = verifiedRefund ? verifiedRefund.id : (stripeRefundId || row.stripe_refund_id);
  const newStripeStatus = verifiedRefund ? verifiedRefund.status : row.stripe_status;

  try {
    const txn = db.transaction(() => {
      // R3-M1: `failed` retires the idempotency key exactly like
      // routes/office.js's finalizeRefundLedger — Stripe has now been confirmed to have
      // nothing on record for it, so the same key can start fresh. `AND status = ?`
      // (the status this CLI validated eligibility against) plus checking `changes`
      // closes the TOCTOU window against a same-key resume or reconcile run finishing
      // concurrently with this command.
      const info = db.prepare(`UPDATE office_refunds SET status = ?, stripe_refund_id = ?, stripe_status = ?,
        error = NULL, error_classification = NULL,
        idempotency_key = CASE WHEN ? = 'failed' THEN idempotency_key || ':failed:' || id ELSE idempotency_key END,
        updated_at = datetime('now') WHERE id = ? AND status = ?`)
        .run(targetStatus, newStripeRefundId, newStripeStatus, targetStatus, ledgerId, oldStatus);

      if (info.changes === 0) {
        throw new Error(`office_refunds ${ledgerId} status changed concurrently (expected '${oldStatus}') — no change made`);
      }

      const detail = {
        ledger_id: ledgerId, old_status: oldStatus, new_status: targetStatus, actor, reason,
        stripe_refund_id: newStripeRefundId, verified_against_stripe: !!verifiedRefund, stripe_check: stripeCheck,
      };
      db.prepare(`INSERT INTO api_audit_log
        (id, key_id, key_name, method, path, entity_type, entity_id, action, reason, status_code, response_json, ip, created_at)
        VALUES (?, ?, ?, 'CLI', ?, 'office_refund', ?, 'office_refund_manual_resolve', ?, 200, ?, 'cli', datetime('now'))`).run(
        uuid(), row.key_id, row.key_name, `/cli/resolve-office-refund/${ledgerId}`, ledgerId,
        `${reason} (actor: ${actor})`, JSON.stringify(detail));

      db.prepare(`INSERT INTO activity_log (id, action, entity_type, entity_id, details, ip_address)
        VALUES (?, 'office_refund_manual_resolve', 'office_refund', ?, ?, 'cli')`).run(
        uuid(), ledgerId, JSON.stringify({ via: 'resolve-office-refund-cli', ...detail }));
    });
    txn();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Resolved office_refunds ${ledgerId}: ${oldStatus} -> ${targetStatus} (actor=${actor}, reason="${reason}").`);
}

// Testable entry point: tests/office-refund-ambiguous.test.js requires this module
// in-process (to stub services/stripe.js's findRefundByOfficeId without real network) and
// calls main(argv) directly; the CLI itself still auto-runs exactly as before.
if (require.main === module) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
