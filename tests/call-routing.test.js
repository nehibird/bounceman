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
const { activeBookingForPhone } = require('../lib/helpers');
const { v4: uuid } = require('uuid');

const day = (n) => {
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

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

console.log('\n' + '='.repeat(50));
console.log('passed ' + passed + ', failed ' + failed);
if (failures.length) { failures.forEach(f => console.error('  - ' + f)); process.exit(1); }
process.exit(0);
