-- 2026-06-19: per-unit extra-day rates for add-ons so multi-day rentals price correctly
-- Speaker: +$10 per extra day · Generator: +$25 per extra day (customer provides gas on multi-day)
-- Idempotent: safe to re-run.
UPDATE equipment SET price_extra_day = 10 WHERE category = 'add_ons' AND name LIKE '%Speaker%';
UPDATE equipment SET price_extra_day = 25 WHERE category = 'add_ons' AND name LIKE '%Generator%';
