-- Migration: delivery-zones-v2
-- Created: 2026-06-15
-- Purpose: Replace all delivery zones with 3 canonical zones:
--   Kay County + Local (free), Zone 2 ($60), Zone 3 ($95)
-- Per-mile/distance ZIPs are intentionally removed — handled by resolveDeliveryFee() in lib/helpers.js
--
-- APPLY TO TEST DB (port 3201) FIRST before production.
-- Run with: sqlite3 /opt/bounceman/data/bounceman.db < migrations/2026-06-15-delivery-zones-v2.sql

BEGIN IMMEDIATE;

DELETE FROM delivery_zones;

INSERT INTO delivery_zones (id, name, zip_codes, delivery_fee, active) VALUES
  (lower(hex(randomblob(16))), 'Kay County + Local', '74653,74631,74601,74602,74604,74632,74644,74646,74647,74641,74643,74630', 0, 1),
  (lower(hex(randomblob(16))), 'Zone 2 ($60)',       '74636,74633,74651,73077,67140,73766,73757,74640,73738', 60, 1),
  (lower(hex(randomblob(16))), 'Zone 3 ($95)',       '73730,73759,73073,73061,73736,67022,74637,74652,73753,67005,73761,73733,74650,73701,73703,67051,74075', 95, 1);

COMMIT;
