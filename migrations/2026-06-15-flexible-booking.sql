-- Migration: 2026-06-15-flexible-booking
-- Created: 2026-06-15
-- Purpose: Capture Phase 1 schema changes for flexible/multiday booking support:
--   - equipment.price_extra_day REAL column
--   - bookings.event_end_date TEXT column
--   - booking_items.rental_days INTEGER DEFAULT 1
--   - demand_dates table for demand pricing
--   - settings rows: buffer_min, wetdry_hours, extra_day_price
--
-- APPLY TO TEST DB (port 3201) FIRST before production.
-- Run with: sqlite3 /opt/bounceman/data/bounceman.db < migrations/2026-06-15-flexible-booking.sql

BEGIN IMMEDIATE;

-- Add extra-day price column to equipment (for per-unit multiday rates)
ALTER TABLE equipment ADD COLUMN price_extra_day REAL;

-- Add event_end_date to bookings for multiday rental support
ALTER TABLE bookings ADD COLUMN event_end_date TEXT;

-- Add rental_days to booking_items for multiday tracking
ALTER TABLE booking_items ADD COLUMN rental_days INTEGER DEFAULT 1;

-- Demand dates table for demand/surge pricing hooks
CREATE TABLE IF NOT EXISTS demand_dates (
  id TEXT PRIMARY KEY,
  date_start TEXT NOT NULL,
  date_end TEXT NOT NULL,
  multiplier REAL DEFAULT 1,
  surcharge REAL DEFAULT 0,
  label TEXT,
  active INTEGER DEFAULT 1
);

-- Settings rows for flexible booking defaults (INSERT OR IGNORE = no-op if already present)
INSERT OR IGNORE INTO settings (key, value) VALUES ("buffer_min", "120");
INSERT OR IGNORE INTO settings (key, value) VALUES ("wetdry_hours", "48");
INSERT OR IGNORE INTO settings (key, value) VALUES ("extra_day_price", "0");

COMMIT;
