-- Migration: 2026-06-16-extra-day-rates
-- Purpose: Seed per-unit price_extra_day (L-4 gap). Required or multiday bookings throw.
-- Mains = locked rates; add-ons = $25/day token rate (owner decision 2026-06-16).
-- Idempotent: plain UPDATEs by name/category. Apply AFTER 2026-06-15-flexible-booking.sql.
BEGIN IMMEDIATE;
UPDATE equipment SET price_extra_day=150 WHERE name='The Gauntlet';
UPDATE equipment SET price_extra_day=150 WHERE name='Buccaneer Bay';
UPDATE equipment SET price_extra_day=90  WHERE name='Blue Crush Slide';
UPDATE equipment SET price_extra_day=75  WHERE name='Tropical Combo Bounce & Slide';
UPDATE equipment SET price_extra_day=50  WHERE name='Monkey Jumper';
UPDATE equipment SET price_extra_day=50  WHERE name='Mini Castle Bounce House & Slide';
UPDATE equipment SET price_extra_day=25  WHERE category='add_ons';
COMMIT;
