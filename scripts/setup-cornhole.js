#!/usr/bin/env node
/**
 * setup-cornhole.js — one-shot, idempotent.
 *
 * Creates the branded cornhole set as TWO equipment rows, because it sells at two
 * different prices depending on context:
 *
 *   cornhole-set           interactive-games   $75 half day / $100 full day   (standalone rental)
 *   cornhole-set-add-on    add_ons             $20 flat                       (rides along with another unit)
 *
 * The schema carries one price per equipment row, so a single row cannot express
 * both. Two rows is how the existing add_ons items already work.
 *
 * KNOWN LIMITATION: availability conflicts are detected by equipment_id, so the
 * two rows do not know they are the same physical set. Both could be booked for
 * the same date. With one set on the truck that is visible on the delivery route,
 * but see the note in the session docs for the proper fix.
 *
 * Blocks both rows through the worst-case delivery date (2026-09-10). Order #60539
 * went into production 2026-08-24 with no tracking assigned; shorten the block the
 * moment FedEx confirms.
 *
 *   node scripts/setup-cornhole.js --dry
 *   node scripts/setup-cornhole.js
 */
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DRY = process.argv.includes('--dry');
const dbPath = process.env.BM_DB || path.join(__dirname, '..', 'data', 'bounceman.db');
const db = new Database(dbPath);

const BLOCK_THROUGH = '2026-09-10'; // worst case from the All American Tailgate email
const log = (...a) => console.log(DRY ? '[dry]' : '[run]', ...a);

const SHORT = 'Regulation tournament boards with custom Bounce Man graphics. No power, no setup, works anywhere — add it to any rental for $20.';

const DESC = [
  '<p>Regulation 2′× 4′ tournament boards and eight all-weather bags, finished with custom Bounce Man graphics. Set it up on grass, gravel, a driveway or a gym floor in about five minutes flat, and it plays all day without a blower, an outlet or a single stake.</p>',
  '<p>That makes it the one rental that goes anywhere. Tailgates, fall festivals, church harvest parties, graduations, corporate picnics, wedding receptions, banquets — anywhere people are standing around with a drink in their hand waiting for something to do.</p>',
  '<p>Renting a bounce house already? <strong>Add cornhole for $20.</strong> It rides along on the same delivery and gives the parents and older kids something to do while the little ones bounce.</p>',
].join('\n');

const ROWS = [
  {
    slug: 'cornhole-set',
    name: 'Cornhole Set',
    category: 'interactive-games',
    price_4hr: 75.0,
    price_daily: 100.0,
    sortHint: 8,
    status: 'available',
  },
  {
    slug: 'cornhole-set-add-on',
    name: 'Cornhole Set (add to any rental)',
    category: 'add_ons',
    price_4hr: 20.0,
    price_daily: 20.0,
    sortHint: 10,
    status: 'available',
  },
];

const COMMON = {
  description: DESC,
  short_description: SHORT,
  dimensions: "Two 2' x 4' regulation boards + 8 bags",
  weight_lbs: 50,
  capacity_kids: 4,
  age_range: 'All ages',
  setup_time_min: 5,
  power_required: 'None',
  quantity: 1,
  replacement_cost: 334.99,
  manufacturer: 'All American Tailgate',
  purchase_date: '2026-08-20',
  condition: 'new',
  featured: 0,
  full_day_only: 0,
};

const ids = [];
for (const row of ROWS) {
  const existing = db.prepare('SELECT id, sort_order FROM equipment WHERE slug = ?').get(row.slug);
  const id = existing ? existing.id : crypto.randomUUID();
  ids.push(id);

  let sortOrder = existing ? existing.sort_order : row.sortHint;
  if (!existing && row.category !== 'add_ons') {
    const taken = db.prepare("SELECT sort_order FROM equipment WHERE category NOT LIKE 'add%'").all().map((r) => r.sort_order);
    while (taken.includes(sortOrder)) sortOrder += 1;
  }

  const fields = { ...COMMON, name: row.name, slug: row.slug, category: row.category,
    price_4hr: row.price_4hr, price_daily: row.price_daily, price_hourly: null,
    price_weekend: row.price_daily, price_overnight: null, price_extra_day: row.price_4hr,
    status: row.status, sort_order: sortOrder };

  const cols = Object.keys(fields);
  if (DRY) {
    log(`${existing ? 'WOULD update' : 'WOULD insert'} ${row.slug}  $${row.price_4hr}/$${row.price_daily}  [${row.category}]  sort=${sortOrder}`);
  } else if (existing) {
    db.prepare(`UPDATE equipment SET ${cols.map((c) => `${c}=@${c}`).join(', ')}, updated_at=datetime('now') WHERE id=@id`)
      .run({ ...fields, id });
    log(`updated ${row.slug}`);
  } else {
    db.prepare(`INSERT INTO equipment (id, ${cols.join(', ')}, created_at, updated_at)
      VALUES (@id, ${cols.map((c) => '@' + c).join(', ')}, datetime('now'), datetime('now'))`)
      .run({ ...fields, id });
    log(`inserted ${row.slug}`);
  }
}

// Block both rows until the set is physically here.
const insBlock = db.prepare(`INSERT INTO blocked_dates (id, date, reason, equipment_id)
  SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM blocked_dates WHERE date=? AND equipment_id=?)`);
const today = new Date('2026-08-25T00:00:00Z');
const until = new Date(BLOCK_THROUGH + 'T00:00:00Z');
let blocked = 0;
for (const id of ids) {
  for (let d = new Date(today); d <= until; d.setUTCDate(d.getUTCDate() + 1)) {
    const ds = d.toISOString().slice(0, 10);
    if (DRY) { blocked++; continue; }
    const r = insBlock.run(crypto.randomUUID(), ds, 'Ordered 2026-08-20, in production, not yet delivered', id, ds, id);
    blocked += r.changes;
  }
}
log(`${DRY ? 'would block' : 'blocked'} ${blocked} equipment-days through ${BLOCK_THROUGH}`);
log('done. Shorten the block with: DELETE FROM blocked_dates WHERE equipment_id IN (...) AND date >= <arrival>;');
