'use strict';

// C1/I4: sweeps office_refunds rows stuck in 'pending' — normally because the process
// was killed (or crashed) between reserving the refund and Stripe's response coming
// back, so routes/office.js never got to finalize the row. Looks the refund up on
// Stripe's side by the office_refund_id it stamped into the refund's metadata at
// creation time, and finalizes to 'succeeded'/'failed'. When Stripe's answer can't be
// determined, marks the row 'needs_review' — which still counts against the key's caps
// until a human clears it, so it can never be used to silently bypass them.
async function reconcilePendingRefunds(db, { olderThanMinutes = 15, stripeService = null } = {}) {
  const stripe = stripeService || require('../services/stripe');
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);
  const rows = db.prepare("SELECT * FROM office_refunds WHERE status = 'pending' AND created_at <= ?").all(cutoff);

  const results = [];
  for (const row of rows) {
    try {
      const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(row.payment_id);
      const found = await stripe.findRefundByOfficeId(row.id, payment);
      if (!found) {
        db.prepare("UPDATE office_refunds SET status = 'needs_review', updated_at = datetime('now') WHERE id = ?").run(row.id);
        results.push({ id: row.id, result: 'needs_review', reason: 'no matching Stripe refund found' });
        continue;
      }
      const failedLike = found.status === 'failed' || found.status === 'canceled';
      const status = failedLike ? 'failed' : 'succeeded';
      db.prepare("UPDATE office_refunds SET status = ?, stripe_refund_id = ?, stripe_status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(status, found.id, found.status, row.id);
      results.push({ id: row.id, result: status, stripe_refund_id: found.id, stripe_status: found.status });
    } catch (err) {
      db.prepare("UPDATE office_refunds SET status = 'needs_review', error = ?, updated_at = datetime('now') WHERE id = ?").run(err.message, row.id);
      results.push({ id: row.id, result: 'needs_review', reason: err.message });
    }
  }
  return results;
}

module.exports = { reconcilePendingRefunds };
