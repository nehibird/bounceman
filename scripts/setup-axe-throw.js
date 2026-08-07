#!/usr/bin/env node
/**
 * setup-axe-throw.js — one-shot, idempotent.
 *
 * 1. Applies migrations/2026-08-07-equipment-video.sql (guarded — SQLite has no
 *    ADD COLUMN IF NOT EXISTS, so we check PRAGMA table_info first).
 * 2. Upserts the Dual Lane Axe Throw equipment record.
 * 3. Upserts its four gallery photos.
 * 4. Blocks dates through 2026-08-16 so it can't be booked before the ODOL
 *    inspection. First bookable day is Monday 2026-08-17.
 *
 * Safe to re-run. Pass --dry to preview without writing.
 *
 *   node scripts/setup-axe-throw.js --dry
 *   node scripts/setup-axe-throw.js
 */
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DRY = process.argv.includes('--dry');
const dbPath = process.env.BM_DB || path.join(__dirname, '..', 'data', 'bounceman.db');
const db = new Database(dbPath);

const SLUG = 'dual-lane-axe-throw';
const BLOCK_THROUGH = '2026-08-16'; // first bookable day = 2026-08-17
const PHOTOS = [
  '/assets/images/equipment/axe-throw-1.jpg',
  '/assets/images/equipment/axe-throw-2.jpg',
  '/assets/images/equipment/axe-throw-3.jpg',
  '/assets/images/equipment/axe-throw-4.jpg',
];

const log = (...a) => console.log(DRY ? '[dry]' : '[run]', ...a);

// ---------------------------------------------------------------- 1. migration
function addColumn(table, column, ddl) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (has) { log(`column ${table}.${column} already present`); return; }
  if (DRY) { log(`WOULD add ${table}.${column}`); return; }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  log(`added ${table}.${column}`);
}
addColumn('equipment', 'video_path', 'video_path TEXT');
addColumn('equipment', 'video_sort_order', 'video_sort_order INTEGER DEFAULT 2');

// ---------------------------------------------------------------- 2. equipment
const SHORT = 'Two lanes, two throwers, one bullseye. Head-to-head axe throwing with soft velcro axes — safe for every age.';

const DESC = [
  '<p>Channel your inner lumberjack. The Dual Lane Axe Throw puts two players side by side, each with their own oversized target, racing for the bullseye with soft velcro axes. No sharp edges and nothing to sharpen — just the satisfying thunk of a good throw and a whole lot of friendly trash talk.</p>',
  '<p>Because it runs two lanes at once, the line moves twice as fast as a single-target game. That makes it a standout at busy events where a queue can kill the fun. Rustic log-cabin styling and big bold targets pull a crowd from across the field.</p>',
  '<p>Great for school carnivals, church festivals, corporate events and team building, grad parties, sports banquets, and backyard celebrations. Adults get into it as much as the kids do — and it sets up indoors, so it works year round.</p>',
].join('\n');

const existing = db.prepare('SELECT id, sort_order FROM equipment WHERE slug = ?').get(SLUG);
const equipmentId = existing ? existing.id : crypto.randomUUID();

// don't collide with an existing sort_order (titan and prod differ — prod has the soft play)
let sortOrder = existing ? existing.sort_order : 7;
if (!existing) {
  const taken = db.prepare("SELECT sort_order FROM equipment WHERE category NOT LIKE 'add%'").all().map((r) => r.sort_order);
  while (taken.includes(sortOrder)) sortOrder += 1;
}

const fields = {
  name: 'Dual Lane Axe Throw',
  slug: SLUG,
  category: 'interactive-games',
  description: DESC,
  short_description: SHORT,
  dimensions: "18'L x 12'W x 11'H",
  capacity_kids: 2,
  age_range: '6+',
  setup_time_min: 20,
  power_required: '1 standard outlet (20 amp)',
  price_4hr: 199,
  price_daily: 275,
  price_extra_day: 90,
  price_wet: null,          // dry only
  price_hourly: null,
  price_weekend: null,
  price_overnight: null,
  deposit_amount: 50,
  condition: 'excellent',
  status: 'available',
  featured: 1,
  quantity: 1,
  full_day_only: 0,
  sort_order: sortOrder,
  video_path: '/assets/video/axe-throw.mp4',
  video_sort_order: 2,
};

if (existing) {
  log(`equipment "${fields.name}" exists (${equipmentId}) — updating`);
  if (!DRY) {
    const cols = Object.keys(fields);
    db.prepare(
      `UPDATE equipment SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`
    ).run({ ...fields, id: equipmentId });
  }
} else {
  log(`creating equipment "${fields.name}" (${equipmentId}) at sort_order ${sortOrder}`);
  if (!DRY) {
    const cols = ['id', ...Object.keys(fields)];
    db.prepare(
      `INSERT INTO equipment (${cols.join(', ')}, created_at, updated_at)
       VALUES (${cols.map((c) => `@${c}`).join(', ')}, datetime('now'), datetime('now'))`
    ).run({ ...fields, id: equipmentId });
  }
}

// ------------------------------------------------------------------- 3. photos
PHOTOS.forEach((p, i) => {
  const row = db.prepare('SELECT id FROM equipment_images WHERE equipment_id = ? AND image_path = ?').get(equipmentId, p);
  const isPrimary = i === 0 ? 1 : 0;
  if (row) {
    log(`photo ${i + 1} already linked`);
    if (!DRY) db.prepare('UPDATE equipment_images SET is_primary = ?, sort_order = ? WHERE id = ?').run(isPrimary, i, row.id);
  } else {
    log(`linking photo ${i + 1} ${p}${isPrimary ? ' (primary)' : ''}`);
    if (!DRY) {
      db.prepare(
        `INSERT INTO equipment_images (id, equipment_id, image_path, is_primary, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`
      ).run(crypto.randomUUID(), equipmentId, p, isPrimary, i);
    }
  }
});

// ------------------------------------------------------------ 4. blocked dates
const today = new Date().toISOString().slice(0, 10);
const start = today < '2026-08-07' ? today : '2026-08-07';
const dates = [];
for (let d = new Date(start + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= BLOCK_THROUGH; d.setUTCDate(d.getUTCDate() + 1)) {
  dates.push(d.toISOString().slice(0, 10));
}
let added = 0;
dates.forEach((date) => {
  const row = db.prepare('SELECT id FROM blocked_dates WHERE date = ? AND equipment_id = ?').get(date, equipmentId);
  if (row) return;
  added += 1;
  if (!DRY) {
    db.prepare(
      `INSERT INTO blocked_dates (id, date, reason, equipment_id, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run(crypto.randomUUID(), date, 'New unit - available August 17 (pending ODOL inspection)', equipmentId);
  }
});
log(`blocked ${added} date(s) through ${BLOCK_THROUGH}; first bookable 2026-08-17`);

// ----------------------------------------------------------------- 5. verify
if (DRY) {
  console.log('\nDry run — nothing written. Re-run without --dry to apply.');
} else {
  const check = db.prepare(
    'SELECT name, slug, category, dimensions, price_4hr, price_daily, price_extra_day, price_wet, quantity, status, video_path, video_sort_order FROM equipment WHERE slug = ?'
  ).get(SLUG);
  console.log('\nResulting record:');
  console.log(check);
  console.log('photos linked:', db.prepare('SELECT COUNT(*) c FROM equipment_images WHERE equipment_id = ?').get(equipmentId).c);
  console.log('dates blocked:', db.prepare('SELECT COUNT(*) c FROM blocked_dates WHERE equipment_id = ?').get(equipmentId).c);
}
