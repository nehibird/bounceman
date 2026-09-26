/**
 * tests/call-routing.test.js
 * A booked customer must never reach Sarah. Sarah sells; humans support.
 * Run: node tests/call-routing.test.js
 */

'use strict';

process.env.DB_PATH = '/tmp/bounceman-test-routing-' + Date.now() + '.db';

let passed = 0, failed = 0;
const failures = [];
function assert(label, cond, details) {
  if (cond) { console.log('  PASS: ' + label); passed++; }
  else { console.error('  FAIL: ' + label + (details !== undefined ? ' -- ' + details : '')); failed++; failures.push(label); }
}

const { initialize, getDb } = require('../db');
initialize();
const db = getDb();
const { activeBookingForPhone, todayCT, isoOffset } = require('../lib/helpers');
const { v4: uuid } = require('uuid');

// I4 (fixed, round 7): activeBookingForPhone now computes its cutoff EXPLICITLY as an
// America/Chicago calendar date (todayCT, then isoOffset for the grace-day arithmetic) —
// no more SQLite `date('now','localtime')`, no more dependence on the process's own TZ.
// This fixture helper is built from the SAME todayCT/isoOffset the code under test uses,
// so "N days from today" always means N Chicago-calendar days regardless of what TZ this
// test process happens to run under (previously it read the Date object's own LOCAL
// year/month/day components, deliberately matching the OLD buggy behavior — now that the
// code is fixed, that would silently diverge from Chicago in most zones and break the
// documented "must pass under UTC/CT/Honolulu/Kolkata/Auckland/LA" requirement).
const day = (n) => isoOffset(todayCT(), n);

function seed(name, phone, eventDate, status, endDate) {
  const cid = uuid(), bid = uuid();
  db.prepare("INSERT INTO customers (id, first_name, last_name, phone) VALUES (?,?,?,?)")
    .run(cid, name, 'Test', phone);
  db.prepare(`INSERT INTO bookings (id, booking_number, customer_id, status, event_date, event_end_date,
      event_start_time, event_end_time, subtotal, total, balance_due)
    VALUES (?,?,?,?,?,?, '11:00', '19:00', 0, 0, 0)`)
    .run(bid, 'BM-' + name.toUpperCase(), cid, status, eventDate, endDate || null);
  return cid;
}

console.log('\n=== a customer with an upcoming booking goes to a human ===');
seed('Future', '(580) 555-0101', day(3), 'confirmed');
assert('upcoming booking -> forward', !!activeBookingForPhone(db, '+15805550101', 1));
assert('event today -> forward', (seed('Today', '(580) 555-0102', day(0), 'confirmed'),
  !!activeBookingForPhone(db, '+15805550102', 1)));

console.log('\n=== they go back to Sarah once it is over ===');
seed('Yesterday', '(580) 555-0103', day(-1), 'completed');
assert('event yesterday, 1-day grace -> still forward', !!activeBookingForPhone(db, '+15805550103', 1));
seed('LastWeek', '(580) 555-0104', day(-7), 'completed');
assert('event a week ago -> back to Sarah', activeBookingForPhone(db, '+15805550104', 1) === null);
assert('grace of 0 sends yesterday back to Sarah too',
  activeBookingForPhone(db, '+15805550103', 0) === null);

console.log('\n=== cancelled bookings do not earn a human ===');
seed('Cancelled', '(580) 555-0105', day(3), 'cancelled');
assert('cancelled -> Sarah', activeBookingForPhone(db, '+15805550105', 1) === null);
seed('Declined', '(580) 555-0106', day(3), 'declined');
assert('declined -> Sarah', activeBookingForPhone(db, '+15805550106', 1) === null);

console.log('\n=== phone formats all have to match ===');
seed('Paren', '(580) 555-0201', day(2), 'confirmed');
seed('Plain', '5805550202', day(2), 'confirmed');
seed('E164',  '+15805550203', day(2), 'confirmed');
seed('Dots',  '580.555.0204', day(2), 'confirmed');
assert('stored (580) 555-0201, called +1580…', !!activeBookingForPhone(db, '+15805550201', 1));
assert('stored 5805550202', !!activeBookingForPhone(db, '+15805550202', 1));
assert('stored +15805550203', !!activeBookingForPhone(db, '+15805550203', 1));
assert('stored 580.555.0204', !!activeBookingForPhone(db, '+15805550204', 1));
assert('caller sent bare 10 digits', !!activeBookingForPhone(db, '5805550201', 1));

console.log('\n=== nobody else gets forwarded ===');
assert('unknown number -> Sarah', activeBookingForPhone(db, '+19995550000', 1) === null);
assert('empty -> Sarah', activeBookingForPhone(db, '', 1) === null);
assert('null -> Sarah', activeBookingForPhone(db, null, 1) === null);
assert('short/garbage -> Sarah', activeBookingForPhone(db, '123', 1) === null);

console.log('\n=== multi-day rental uses the END date ===');
seed('MultiDay', '(580) 555-0301', day(-2), 'confirmed', day(1));
assert('started 2 days ago, ends tomorrow -> forward', !!activeBookingForPhone(db, '+15805550301', 1));

console.log('\n=== it returns the booking so the log can name it ===');
const b = activeBookingForPhone(db, '+15805550101', 1);
assert('returns booking_number', b && typeof b.booking_number === 'string', JSON.stringify(b));
assert('returns event_date', b && typeof b.event_date === 'string');
assert('returns the customer name', b && /Future/.test(b.name || ''), b && b.name);

console.log('\n=== I4: today() is computed EXPLICITLY in America/Chicago, not the process clock ===');
// 2026-09-26T01:30Z = Sep 25, 8:30 PM CDT -> the Chicago calendar day is still the 25th.
assert('todayCT: 2026-09-26T01:30Z (8:30 PM CDT the 25th) -> 2026-09-25',
  todayCT(new Date('2026-09-26T01:30:00Z')) === '2026-09-25',
  todayCT(new Date('2026-09-26T01:30:00Z')));
// 2026-09-26T06:00Z = Sep 26, 1:00 AM CDT -> the Chicago calendar day has rolled to the 26th.
assert('todayCT: 2026-09-26T06:00Z (1:00 AM CDT the 26th) -> 2026-09-26',
  todayCT(new Date('2026-09-26T06:00:00Z')) === '2026-09-26',
  todayCT(new Date('2026-09-26T06:00:00Z')));

console.log('\n=== I4: activeBookingForPhone itself uses Chicago, not UTC or the real clock ===');
// 2026-09-26T01:30Z is UTC Sep 26, but Chicago calendar Sep 25 (8:30 PM CDT). A booking
// that ended EXACTLY on the Chicago date, grace 0, must still forward when "now" is this
// instant — proving activeBookingForPhone (not just todayCT in isolation) reads the
// Chicago day. A mutant reverting to SQLite's date('now','localtime') would use the
// REAL wall clock instead of this injected instant — since the real clock is nowhere near
// October/November 2026 (these bookings are seeded far in the future relative to whenever
// this suite actually runs), that mutant would see event_date >= (real today - grace) as
// true regardless, so the "back to Sarah" assertion below is what actually catches it.
seed('UtcMismatch', '(580) 555-0501', '2026-09-25', 'completed');
assert('UTC/Chicago date mismatch: event ended Sep 25 (Chicago), grace 0, "now" 2026-09-26T01:30Z (still Sep 25 in Chicago) -> forward',
  !!activeBookingForPhone(db, '+15805550501', 0, new Date('2026-09-26T01:30:00Z')));
assert('UTC/Chicago date mismatch: same booking, "now" 2026-09-26T06:00Z (Chicago has rolled to Sep 26) -> back to Sarah',
  activeBookingForPhone(db, '+15805550501', 0, new Date('2026-09-26T06:00:00Z')) === null);

console.log('\n=== I4: grace-day behavior is unchanged across a DST boundary ===');
// 2026-11-01 is when US DST ends (clocks fall back 2 AM -> 1 AM Central). A booking that
// ended the day before, with a 1-day grace, must still forward on the 1st and stop on the
// 2nd — the CALENDAR day count must not be distorted by that day having an extra real hour.
seed('FallBack', '(580) 555-0401', '2026-10-31', 'completed');
assert('fall-back DST: event ended Oct 31, grace 1, "now" Nov 1 -> still forward',
  !!activeBookingForPhone(db, '+15805550401', 1, new Date('2026-11-01T18:00:00Z')));
assert('fall-back DST: same booking, "now" Nov 2 -> back to Sarah',
  activeBookingForPhone(db, '+15805550401', 1, new Date('2026-11-02T18:00:00Z')) === null);

// 2026-03-08 is when US DST begins (clocks spring forward 2 AM -> 3 AM Central, that day
// is an hour SHORT). Same check, the other direction.
seed('SpringForward', '(580) 555-0402', '2026-03-07', 'completed');
assert('spring-forward DST: event ended Mar 7, grace 1, "now" Mar 8 -> still forward',
  !!activeBookingForPhone(db, '+15805550402', 1, new Date('2026-03-08T18:00:00Z')));
assert('spring-forward DST: same booking, "now" Mar 9 -> back to Sarah',
  activeBookingForPhone(db, '+15805550402', 1, new Date('2026-03-09T18:00:00Z')) === null);

console.log('\n' + '='.repeat(50));
console.log('passed ' + passed + ', failed ' + failed);
if (failures.length) { failures.forEach(f => console.error('  - ' + f)); process.exit(1); }
process.exit(0);
