#!/usr/bin/env node
'use strict';

// Sweeps stuck 'pending' rows in office_refunds (see lib/refund-reconcile.js) and
// finalizes them against Stripe's own record of the refund. Safe to run repeatedly
// (e.g. on a cron every few minutes) — rows that are already succeeded/failed/
// needs_review are never touched.
//
//   node scripts/reconcile-office-refunds.js [--older-than-minutes N]
//
// Exits non-zero if any row ended up 'needs_review', so a cron wrapper can alert on it.

const { getDb, initialize } = require('../db');
const { reconcilePendingRefunds } = require('../lib/refund-reconcile');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i += 1; } else { args[key] = true; }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const olderThanMinutes = args['older-than-minutes'] ? parseInt(args['older-than-minutes'], 10) : 15;
  if (!Number.isFinite(olderThanMinutes) || olderThanMinutes < 0) {
    console.error('--older-than-minutes must be a non-negative number');
    process.exitCode = 1;
    return;
  }

  initialize();
  const db = getDb();
  const results = await reconcilePendingRefunds(db, { olderThanMinutes });

  if (!results.length) {
    console.log(`No pending office refunds older than ${olderThanMinutes} minutes.`);
    return;
  }
  for (const r of results) {
    console.log(`${r.id}: ${r.result}` + (r.stripe_refund_id ? ` (${r.stripe_refund_id}, stripe_status=${r.stripe_status})` : '') + (r.reason ? ` - ${r.reason}` : ''));
  }
  const needsReview = results.filter((r) => r.result === 'needs_review').length;
  if (needsReview) {
    console.warn(`${needsReview} row(s) need manual review.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exitCode = 1;
});
