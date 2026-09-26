'use strict';

// C1/I4/R2-C1/R2-M2: sweeps office_refunds rows this app is NOT yet certain about, and
// finalizes them against Stripe's own record — NEVER by calling refunds.create, only by
// looking one up (via metadata.office_refund_id, stamped on every refund this app
// creates). Three kinds of row qualify:
//   - 'pending' — normally because the process was killed (or crashed) between reserving
//     the refund and Stripe's response coming back, so routes/office.js never got to
//     finalize the row. Also covers R2-C1's ambiguous-outcome rows that were never
//     retried by the caller.
//   - 'needs_review' — a previous reconcile run (or the CLI) couldn't determine the
//     answer; re-checked every run in case Stripe's side has since settled.
//   - 'failed' rows whose error was never classified 'definitive' (R2-C1) AND that do
//     have a stored error at all — i.e. rows the OLD (pre-R2-C1) code finalized 'failed'
//     for ANY thrown error, including ambiguous ones that may have actually succeeded on
//     Stripe's side. A genuine Stripe refund.status of 'failed'/'canceled' never has an
//     `error` set (see routes/office.js's finalizeRefundLedger), so those rows are never
//     re-swept here — they're a real, already-final Stripe answer.
// When Stripe's answer can't be determined, the row is marked/kept 'needs_review' —
// which still counts against the key's caps until a human clears it (scripts/
// resolve-office-refund.js), so it can never be used to silently bypass them.
async function reconcilePendingRefunds(db, { olderThanMinutes = 15, stripeService = null } = {}) {
  const stripe = stripeService || require('../services/stripe');
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);
  const rows = db.prepare(`
    SELECT * FROM office_refunds
    WHERE created_at <= ?
      AND (
        status IN ('pending', 'needs_review')
        OR (status = 'failed' AND error IS NOT NULL AND error_classification IS NULL)
      )
  `).all(cutoff);

  const results = [];
  for (const row of rows) {
    try {
      const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(row.payment_id);
      const found = await stripe.findRefundByOfficeId(row.id, payment);
      if (!found) {
        // Definitively not found (yet, or ever) and old enough — never guess. A row that
        // was already 'needs_review' simply stays that way; a legacy ambiguous-'failed'
        // row is PROMOTED to 'needs_review' rather than left masquerading as resolved.
        db.prepare("UPDATE office_refunds SET status = 'needs_review', updated_at = datetime('now') WHERE id = ?").run(row.id);
        results.push({ id: row.id, result: 'needs_review', reason: 'no matching Stripe refund found' });
        continue;
      }
      const failedLike = found.status === 'failed' || found.status === 'canceled';
      const status = failedLike ? 'failed' : 'succeeded';
      // R3-L1: finalizing 'failed' here retires the idempotency key exactly like
      // routes/office.js's finalizeRefundLedger does — otherwise a same-key retry hits
      // the office_refunds UNIQUE(key_id, idempotency_key) index forever (409), with no
      // way for reconcile's own answer to ever be actioned by a fresh attempt.
      if (failedLike) {
        db.prepare(`UPDATE office_refunds SET status = ?, stripe_refund_id = ?, stripe_status = ?, error = NULL, error_classification = NULL,
          idempotency_key = idempotency_key || ':failed:' || id, updated_at = datetime('now') WHERE id = ?`)
          .run(status, found.id, found.status, row.id);
      } else {
        db.prepare('UPDATE office_refunds SET status = ?, stripe_refund_id = ?, stripe_status = ?, error = NULL, error_classification = NULL, updated_at = datetime(\'now\') WHERE id = ?')
          .run(status, found.id, found.status, row.id);
      }
      results.push({ id: row.id, result: status, stripe_refund_id: found.id, stripe_status: found.status });
    } catch (err) {
      db.prepare("UPDATE office_refunds SET status = 'needs_review', error = ?, updated_at = datetime('now') WHERE id = ?").run(err.message, row.id);
      results.push({ id: row.id, result: 'needs_review', reason: err.message });
    }
  }
  return results;
}

module.exports = { reconcilePendingRefunds };
