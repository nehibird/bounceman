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
// whenever STRIPE_SECRET_KEY is set: the refund must exist, its
// metadata.office_refund_id must match this ledger row's id, and its amount must match.
// Without Stripe access (no STRIPE_SECRET_KEY), an explicit --no-verify is required, so a
// typo'd refund id can never be recorded as fact by accident.
//
// The status change and its audit rows (api_audit_log + activity_log) are written in the
// SAME better-sqlite3 transaction — either both happen, or neither does.

const { v4: uuid } = require('uuid');
const { getDb, initialize } = require('../db');
const stripeService = require('../services/stripe');

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

async function verifyStripeRefund(row, stripeRefundId) {
  const refund = await stripeService.retrieveRefund(stripeRefundId);
  if (!refund) throw new Error(`Stripe returned no refund for ${stripeRefundId}`);
  const metaId = refund.metadata && refund.metadata.office_refund_id;
  if (metaId !== row.id) {
    throw new Error(`refund ${stripeRefundId} metadata.office_refund_id (${metaId || 'none'}) does not match ledger id ${row.id}`);
  }
  if (refund.amount !== row.amount_cents) {
    throw new Error(`refund ${stripeRefundId} amount (${refund.amount}) does not match ledger amount_cents (${row.amount_cents})`);
  }
  return refund;
}

// R3-M1: before marking a row 'failed', confirm with Stripe that no refund actually went
// out for it — mirrors routes/office.js's own "confirm before finalizing failed" rule
// (R3-C1(b)). Returns the found refund (informational — null if genuinely not found, or
// a failed/canceled one) so the caller can record what was checked. Throws if a refund
// exists with a status OTHER than failed/canceled (i.e. it actually went through).
async function verifyNoRefundWentOut(row, payment) {
  const found = await stripeService.findRefundByOfficeId(row.id, payment);
  if (found && found.status !== 'failed' && found.status !== 'canceled') {
    throw new Error(`a Stripe refund already exists for this ledger row (${found.id}, status=${found.status}) — cannot mark failed`);
  }
  return found;
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
      try {
        verifiedRefund = await verifyStripeRefund(row, stripeRefundId);
        stripeCheck = { checked: true, outcome: 'verified', refund_id_checked: stripeRefundId };
      } catch (err) {
        console.error(`Stripe verification failed: ${err.message}`);
        if (!args['no-verify']) {
          console.error('No change made. Pass --no-verify to force this despite the failed verification (NOT recommended).');
          process.exitCode = 1;
          return;
        }
        console.error('--no-verify passed: proceeding WITHOUT Stripe verification despite the failure above.');
        stripeCheck = { checked: true, outcome: 'verification_failed_forced', refund_id_checked: stripeRefundId, error: err.message };
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
      try {
        const found = await verifyNoRefundWentOut(row, payment);
        stripeCheck = { checked: true, outcome: found ? 'found_failed_or_canceled' : 'none_found', refund_id_checked: found ? found.id : null };
      } catch (err) {
        console.error(`Stripe verification failed: ${err.message}`);
        if (!args['no-verify']) {
          console.error('No change made. Pass --no-verify to force this despite the failed verification (NOT recommended).');
          process.exitCode = 1;
          return;
        }
        console.error('--no-verify passed: proceeding WITHOUT Stripe verification despite the failure above.');
        stripeCheck = { checked: true, outcome: 'verification_failed_forced', error: err.message };
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
