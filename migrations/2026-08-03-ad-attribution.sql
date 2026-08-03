-- Ad attribution: capture which click produced which booking.
-- Applied idempotently by db.js on boot; this file exists to match the migrations
-- convention and to document the change.
--
-- Context: ~$60/month across Google and Meta with no way to tell whether it produced
-- a single booking. `source` was empty on 29 of 31 rows and no click ID was captured
-- anywhere in the app.
--
-- All columns NULLABLE deliberately — three test suites INSERT into bookings and
-- NOT NULL here would break them.

ALTER TABLE bookings ADD COLUMN attrib_gclid TEXT;
ALTER TABLE bookings ADD COLUMN attrib_fbclid TEXT;
ALTER TABLE bookings ADD COLUMN attrib_utm_source TEXT;
ALTER TABLE bookings ADD COLUMN attrib_utm_medium TEXT;
ALTER TABLE bookings ADD COLUMN attrib_utm_campaign TEXT;
ALTER TABLE bookings ADD COLUMN attrib_utm_term TEXT;
ALTER TABLE bookings ADD COLUMN attrib_utm_content TEXT;
ALTER TABLE bookings ADD COLUMN attrib_landing_page TEXT;
ALTER TABLE bookings ADD COLUMN attrib_referrer TEXT;
ALTER TABLE bookings ADD COLUMN attrib_first_seen_at TEXT;

-- Historical rows predate tracking. Mark them honestly rather than letting them
-- masquerade as 'organic' and flatter whichever channel they're compared against.
UPDATE bookings SET source = 'unknown_pre_tracking'
WHERE (source IS NULL OR source = '') AND created_at < '2026-08-03';
