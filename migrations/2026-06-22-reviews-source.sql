-- 2026-06-22: review source tracking for Google Business Profile reviews sync.
-- Also auto-applied by db.js on startup (idempotent ALTERs). Safe to re-run.
ALTER TABLE reviews ADD COLUMN source TEXT DEFAULT 'internal';
ALTER TABLE reviews ADD COLUMN external_id TEXT;
