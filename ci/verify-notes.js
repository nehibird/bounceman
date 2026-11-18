#!/usr/bin/env node
/**
 * P0-5 gate. The bug: two of the three sites that write the Stripe checkout-session
 * marker did `SET internal_notes = ?`, erasing whatever was in the field. The marker is
 * ALSO load-bearing -- two payment checks parse it back out with an unanchored
 * first-match regex -- so the fix has to preserve notes AND leave exactly one live
 * marker. Both halves are asserted here against the real helper, not a copy of it.
 */
const Database = require('/app/node_modules/better-sqlite3');
const { recordStripeSessionMarker } = require('/app/lib/helpers');

let fails = 0;
function check(label, ok, detail) {
  console.log((ok ? 'ok    ' : 'FAIL  ') + label + (detail ? '  [' + String(detail).slice(0, 160) + ']' : ''));
  if (!ok) fails++;
}

// A scratch database with just enough shape to exercise the helper.
const db = new Database(':memory:');
db.exec(`CREATE TABLE bookings (
  id TEXT PRIMARY KEY, booking_number TEXT, internal_notes TEXT,
  delivery_notes TEXT, updated_at TEXT
)`);
const ins = db.prepare('INSERT INTO bookings (id, booking_number, internal_notes) VALUES (?, ?, ?)');

// --- 1. The regression: a prior human note must survive the marker being written.
const BREADCRUMB = 'Auto-released: deposit unpaid at 30 min';
ins.run('b1', 'BM-T1', BREADCRUMB);
recordStripeSessionMarker(db, 'b1', 'cs_live_FIRSTSESSION', 'booking-create');
let n1 = db.prepare('SELECT internal_notes FROM bookings WHERE id = ?').get('b1').internal_notes;
check('a prior note survives the marker being written', n1.includes(BREADCRUMB), n1);
check('the marker is there too', /stripe_session:cs_live_FIRSTSESSION/.test(n1));

// --- 2. A second session must supersede the first, or the payment check reads a
//        stale session and a real deposit looks unpaid.
recordStripeSessionMarker(db, 'b1', 'cs_live_SECONDSESSION', 'pay-deposit');
n1 = db.prepare('SELECT internal_notes FROM bookings WHERE id = ?').get('b1').internal_notes;
const live = n1.match(/stripe_session:(cs_[A-Za-z0-9_]+)/g) || [];
check('exactly one live marker after a second session', live.length === 1, live.join(','));

// This is the EXACT regex routes/sarah.js and routes/booking.js use.
const seen = n1.match(/stripe_session:(cs_[a-zA-Z0-9_]+)/);
check('the readers find the NEWEST session, not the stale one',
  seen && seen[1] === 'cs_live_SECONDSESSION', seen && seen[1]);
check('the superseded one is kept as history', n1.includes('superseded_checkout_session:cs_live_FIRSTSESSION'));
check('...and is spelled so the reader regex cannot match it',
  !/stripe_session:cs_live_FIRSTSESSION/.test(n1));
check('the human breadcrumb is STILL there after both writes', n1.includes(BREADCRUMB));

// --- 3. An empty field must still work.
ins.run('b2', 'BM-T2', null);
recordStripeSessionMarker(db, 'b2', 'cs_live_ONLY', 'sarah');
const n2 = db.prepare('SELECT internal_notes FROM bookings WHERE id = ?').get('b2').internal_notes;
check('works on a booking with no notes at all', /stripe_session:cs_live_ONLY/.test(n2), n2);

// --- 4. No write path may go back to clobbering the field. The admin's own notes
//        form is the one legitimate overwrite: a human replacing the text on purpose.
const fs = require('fs');
const offenders = [];
for (const f of ['routes/booking.js', 'routes/sarah.js', 'routes/office.js', 'lib/helpers.js']) {
  const src = fs.readFileSync('/app/' + f, 'utf8');
  src.split('\n').forEach((line, i) => {
    if (/UPDATE bookings SET[^']*internal_notes\s*=\s*\?/.test(line) &&
        !/superseded|COALESCE\(internal_notes/.test(line)) {
      // The one allowed rewrite is helpers' supersede statement, whose `.run(...)` with
      // the superseded_checkout_session replacement sits on the FOLLOWING line -- so the
      // window has to look forward as well as back, not just back.
      const lines = src.split('\n');
      const ctx = lines.slice(Math.max(0, i - 3), i + 4).join(' ');
      if (!/superseded_checkout_session/.test(ctx)) offenders.push(f + ':' + (i + 1));
    }
  });
}
check('no write path clobbers internal_notes any more', offenders.length === 0, offenders.join(' '));

// --- 5. Delivery notes on the live database carry nothing the driver cannot use.
const LIVE = process.argv[2];
if (LIVE) {
  const ldb = new Database(LIVE, { readonly: true });
  const rows = ldb.prepare(
    "SELECT booking_number, delivery_notes, internal_notes FROM bookings " +
    "WHERE delivery_notes IS NOT NULL AND TRIM(delivery_notes) <> ''"
  ).all();
  const MACHINE = /auto-hold-release|webhook|pending->|cs_(live|test)_|TAX:|US Census geocoder|never re-sold/i;
  const bad = rows.filter(r => MACHINE.test(r.delivery_notes)).map(r => r.booking_number);
  check('no delivery note contains system text', bad.length === 0, bad.join(' '));
  const moved = ldb.prepare(
    "SELECT COUNT(*) n FROM bookings WHERE internal_notes LIKE '%moved from delivery notes%'"
  ).get().n;
  check('the moved text was kept, not deleted', moved > 0, moved + ' row(s) carry it');
  // The driver content must not have been lost along with it.
  const gate = ldb.prepare(
    "SELECT delivery_notes d FROM bookings WHERE booking_number = 'BM-MW5H6VEM-MA2'"
  ).get();
  check('the gate/power instructions survived the split',
    !!gate && /gate width/i.test(gate.d) && /POWER NOT CONFIRMED/i.test(gate.d),
    gate && gate.d && gate.d.slice(0, 80));
}

console.log();
console.log('NOTES_FAILED=' + fails);
process.exit(fails ? 1 : 0);
