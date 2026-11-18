#!/usr/bin/env node
/**
 * P0-5 data half: Delivery Notes must contain only what the driver needs.
 *
 * Nothing is deleted. The non-driver half of a delivery note is MOVED into
 * internal_notes with a dated marker, so the postmortem is still on the booking --
 * just not on the sheet the driver reads at the door.
 *
 * Idempotent: a note that has already been split carries the marker and is skipped.
 * Default is a dry run; pass --apply to write.
 *
 *   node p05-migrate.js /path/to/bounceman.db [--apply]
 */
const Database = require('/app/node_modules/better-sqlite3');

const DB_PATH = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!DB_PATH) { console.error('usage: p05-migrate.js <db> [--apply]'); process.exit(2); }

const MARKER = '[moved from delivery notes 2026-11-17]';

// A delivery note is split at the first sentence that is plainly about the SYSTEM
// rather than about getting a bounce house onto a lawn. These are matched as whole
// sentences so a customer writing "the gate code is 4821" is never touched.
const MACHINE = [
  /\bauto-hold-release\b/i,
  /\bwebhook\b/i,
  /\bpending->\w+/i,
  /\bReinstated \d{4}-\d{2}-\d{2}\b/i,
  /\bStripe\b/i,
  /\bcs_(live|test)_[A-Za-z0-9]+/,
  /\bpi_[A-Za-z0-9]{6,}/,
  /\bTAX:/,
  /\bUS Census geocoder\b/i,
  /\bunincorporated .* County per\b/i,
  /\bdo not let a reprice push this\b/i,
  /\bBooked by text \d{4}-\d{2}-\d{2}\b/i,
  /\bshe started online and stopped at the address field\b/i,
  /\bstarted online and stopped\b/i,
  // Inventory/booking history, not delivery instructions. "Unit was never re-sold" is
  // the tail of a cancellation postmortem -- the driver has no use for it.
  /\bnever re-sold\b/i,
  /\bunit was never\b/i
];

function splitSentences(text) {
  // Split on sentence ends and on the " | " separator this field uses, keeping both.
  return String(text)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])|\s*\|\s*/)
    .map(s => s.trim())
    .filter(Boolean);
}

const db = new Database(DB_PATH, { readonly: !APPLY });
const rows = db.prepare(
  "SELECT id, booking_number, delivery_notes, internal_notes FROM bookings " +
  "WHERE delivery_notes IS NOT NULL AND TRIM(delivery_notes) <> ''"
).all();

let changed = 0, skipped = 0;
const plan = [];

for (const r of rows) {
  if (String(r.internal_notes || '').includes(MARKER)) { skipped++; continue; }
  const parts = splitSentences(r.delivery_notes);
  const keep = [], move = [];
  for (const p of parts) (MACHINE.some(re => re.test(p)) ? move : keep).push(p);
  if (!move.length) continue;

  const newDelivery = keep.join(' ').trim();
  const moved = move.join(' ').trim();
  plan.push({ id: r.id, bno: r.booking_number, before: r.delivery_notes, keep: newDelivery, moved });
  changed++;
}

console.log('rows with delivery notes :', rows.length);
console.log('already split (skipped)  :', skipped);
console.log('rows this would change   :', changed);
console.log();

for (const p of plan) {
  console.log('--- ' + p.bno + ' ---');
  console.log('  BEFORE  : ' + p.before.replace(/\s+/g, ' '));
  console.log('  DRIVER  : ' + (p.keep || '(empty -- the whole note was system text)'));
  console.log('  MOVED   : ' + p.moved.replace(/\s+/g, ' '));
  console.log();
}

if (!APPLY) {
  console.log('DRY RUN -- nothing written. Re-run with --apply.');
  process.exit(0);
}

const tx = db.transaction((items) => {
  const upd = db.prepare(
    "UPDATE bookings SET delivery_notes = ?, " +
    "internal_notes = COALESCE(internal_notes, '') || ?, " +
    "updated_at = datetime('now') WHERE id = ?"
  );
  for (const p of items) {
    upd.run(p.keep, '\n' + MARKER + ' ' + p.moved, p.id);
  }
});
tx(plan);
console.log('APPLIED to ' + plan.length + ' row(s).');
