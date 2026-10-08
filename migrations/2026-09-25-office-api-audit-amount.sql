-- 2026-09-25 — Office API money endpoints: track amount_cents on the audit trail
--
-- Refunds, manual payments, and payment links all touch a dollar amount. Recording it
-- on api_audit_log (in cents, integer) lets a key's daily_refund_cap_cents be enforced
-- by summing today's successful refund rows straight off the audit trail, with no
-- second ledger to keep in sync.
--
-- Applied automatically by db.js's initialize() (ALTER TABLE, tolerant of already
-- existing); this file exists for reference/replay outside the app process.

ALTER TABLE api_audit_log ADD COLUMN amount_cents INTEGER;
