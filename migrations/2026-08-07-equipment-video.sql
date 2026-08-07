-- 2026-08-07 — Equipment video support
--
-- Adds a single optional video per equipment item, positioned WITHIN the photo
-- gallery rather than as a separate block.
--
--   video_path        the .mp4 path. The .webm and the -poster.jpg are derived by
--                     convention from the same basename, matching the output of
--                     Video/<unit>-brand/render.sh:
--                       /assets/video/axe-throw.mp4
--                       /assets/video/axe-throw.webm
--                       /assets/video/axe-throw-poster.jpg
--   video_sort_order  where the video sits in the media strip, interleaved with
--                     equipment_images.sort_order. Default 2 = hero photo first,
--                     video second, remaining photos after.
--
-- Applied idempotently by scripts/setup-axe-throw.js (SQLite has no
-- ADD COLUMN IF NOT EXISTS, so that script checks PRAGMA table_info first).

ALTER TABLE equipment ADD COLUMN video_path TEXT;
ALTER TABLE equipment ADD COLUMN video_sort_order INTEGER DEFAULT 2;
