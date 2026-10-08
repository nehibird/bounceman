-- 2026-09-25 — Office API refund reservation ledger (code-review fix C1)
--
-- Every refund reserves its amount against the key's daily cap and the payment's
-- refundable balance in ONE synchronous transaction BEFORE Stripe is ever called (see
-- routes/office.js's `reserveRefund`). The row starts 'pending' and is finalized to
-- 'succeeded' or 'failed' after the Stripe call returns (or by
-- scripts/reconcile-office-refunds.js if the process never got to finalize it — e.g.
-- the client disconnected mid-request). 'needs_review' means reconciliation could not
-- tell either way from Stripe's side; it still counts against caps until a human clears
-- it. Only 'failed' rows are excluded from cap sums.
--
-- UNIQUE(key_id, idempotency_key) is what makes concurrent duplicate requests collapse
-- to one reservation — the loser of the race gets a constraint violation inside the
-- same transaction and is turned into a 409/replay, never a second Stripe call.
--
-- Applied automatically by db.js's initialize() (CREATE TABLE IF NOT EXISTS); this file
-- exists for reference/replay outside the app process.

CREATE TABLE IF NOT EXISTS office_refunds (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  key_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT,
  booking_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | succeeded | failed | needs_review
  stripe_refund_id TEXT,
  stripe_status TEXT,
  confirmed_by TEXT,
  reason TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_office_refunds_key_idem ON office_refunds(key_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_office_refunds_payment ON office_refunds(payment_id);
CREATE INDEX IF NOT EXISTS idx_office_refunds_created ON office_refunds(created_at);
CREATE INDEX IF NOT EXISTS idx_office_refunds_status ON office_refunds(status);

-- api_audit_log gains a canonical request hash (M1) so a reused Idempotency-Key with a
-- DIFFERENT body 422s instead of replaying a stale success.
ALTER TABLE api_audit_log ADD COLUMN request_hash TEXT;
