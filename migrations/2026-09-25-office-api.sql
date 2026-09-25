-- 2026-09-25 — Office API (server-to-server access for Sarah's office staff)
--
-- api_keys: credentials for the office API. Only the sha256 hash of the raw key is
-- stored — key_prefix is a short indexed slice used to narrow the candidate rows
-- before an exact crypto.timingSafeEqual compare of the full hash (see
-- lib/api-keys.js). Refund limits are per-key and nullable (NULL = no cap).
--
-- api_audit_log: every office API write must carry a reason and an Idempotency-Key
-- (see middleware/office-auth.js). The unique index on (key_id, idempotency_key)
-- backs idempotent replay — a retried request with the same key returns the stored
-- response_json instead of re-executing the write.
--
-- stripe_events_seen: dedup table for Stripe webhook event retries touched by the
-- office API refund flow.
--
-- Applied automatically by db.js's initialize() (CREATE TABLE IF NOT EXISTS); this
-- file exists for reference/replay outside the app process.

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  max_refund_cents INTEGER,
  daily_refund_cap_cents INTEGER,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS api_audit_log (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  key_name TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  action TEXT,
  reason TEXT,
  idempotency_key TEXT,
  request_json TEXT,
  before_json TEXT,
  after_json TEXT,
  status_code INTEGER,
  response_json TEXT,
  stripe_object_id TEXT,
  ip TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_audit_key_idem ON api_audit_log(key_id, idempotency_key);

CREATE TABLE IF NOT EXISTS stripe_events_seen (
  event_id TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now'))
);
