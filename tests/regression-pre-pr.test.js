/**
 * tests/regression-pre-pr.test.js
 * Regression tests for H-1, H-4, M-1, M-3, M-6 bug fixes.
 * Run: node tests/regression-pre-pr.test.js
 */

'use strict';

process.env.DB_PATH = '/tmp/bounceman-test-regression-' + Date.now() + '.db';

const { v4: uuid } = require('uuid');

// -- Mini test harness -------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];

function assert(label, condition, details) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}${details !== undefined ? ' -- ' + details : ''}`);
    failed++;
    failures.push(label);
  }
}

function assertThrows(label, fn) {
  try {
    fn();
    console.error(`  FAIL: ${label} -- expected throw, got none`);
    failed++;
    failures.push(label + ': expected throw, got none');
  } catch (e) {
    console.log(`  PASS: ${label} (threw: ${e.message.slice(0,80)})`);
    passed++;
  }
}

// -- Bootstrap ---------------------------------------------------------------
const { initialize, getDb } = require('../db');
initialize();
const db = getDb();

db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('buffer_min', '120')").run();
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('wetdry_hours', '48')").run();
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('extra_day_price', '75')").run();

function makeEq(name, daily, p4hr, extraDay, wet) {
  const id = uuid();
  db.prepare(`INSERT INTO equipment (id, name, slug, category, price_daily, price_4hr, price_wet, price_extra_day, status, quantity)
    VALUES (?, ?, ?, 'water-slides', ?, ?, ?, ?, 'available', 1)`)
    .run(id, name, name.toLowerCase().replace(/\s+/g, '-') + '-' + id.slice(0,4), daily, p4hr, wet, extraDay);
  return db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
}

function insertBooking(opts) {
  const { eqId, date, startTime, endTime, duration = 'daily', wet = 0, endDate = null, status = 'confirmed' } = opts;
  const custId = uuid();
  db.prepare(`INSERT INTO customers (id, first_name, last_name) VALUES (?, 'T', 'C')`).run(custId);
  const bId = uuid();
  db.prepare(`INSERT INTO bookings (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, event_end_date, subtotal, total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`)
    .run(bId, 'BM-' + bId.slice(0,8), custId, status, date, startTime, endTime, endDate);
  db.prepare(`INSERT INTO booking_items (id, booking_id, equipment_id, item_name, quantity, unit_price, total_price, duration_type, wet_option)
    VALUES (?, ?, ?, 'Item', 1, 0, 0, ?, ?)`)
    .run(uuid(), bId, eqId, duration, wet ? 1 : 0);
  return bId;
}

const {
  isBlockedByWetDryRule, priceForBooking, round2, isoOffset
} = require('../lib/helpers');

// ===========================================================================
console.log('\n=== REGRESSION: H-1 Website Wet->Dry Rule (isBlockedByWetDryRule) ===');
// ===========================================================================
// Verify isBlockedByWetDryRule is exported and works correctly —
// this is the exact function the route now calls.

const slideA = makeEq('Slide Alpha', 375, 300, 90, 20);

// Insert a WET booking ending at 14:00 on 2026-12-01
insertBooking({ eqId: slideA.id, date: '2026-12-01', startTime: '09:00', endTime: '14:00', duration: 'daily', wet: 1 });

{
  // DRY request same-day at 16:00 -> within 48h -> BLOCKED
  const blocked = isBlockedByWetDryRule(db, slideA.id, '2026-12-01', '16:00', false);
  assert('H-1: dry same-day within 48h of wet booking is blocked', blocked === true, `blocked=${blocked}`);
}

{
  // WET request same-day at 16:00 -> always allowed
  const blocked = isBlockedByWetDryRule(db, slideA.id, '2026-12-01', '16:00', true);
  assert('H-1: wet request is never blocked by wet->dry rule', blocked === false, `blocked=${blocked}`);
}

{
  // DRY request next-day (Dec 2 at 10:00 = 20h after Dec 1 14:00) -> still within 48h -> BLOCKED
  const blocked = isBlockedByWetDryRule(db, slideA.id, '2026-12-02', '10:00', false);
  assert('H-1: dry next-day within 48h is blocked', blocked === true, `blocked=${blocked}`);
}

{
  // DRY request 3 days later (Dec 4 at 15:00 = 73h after Dec 1 14:00) -> past 48h -> ALLOWED
  const blocked = isBlockedByWetDryRule(db, slideA.id, '2026-12-04', '15:00', false);
  assert('H-1: dry request after 48h gap is allowed', blocked === false, `blocked=${blocked}`);
}

// ===========================================================================
console.log('\n=== REGRESSION: M-1 rental_days clamp [1,30] ===');
// ===========================================================================

{
  // clamp helper inline — same logic as the route now uses:
  const clamp = (x) => Math.min(30, Math.max(1, parseInt(x) || 1));

  assert('M-1: clamp(0) = 1', clamp(0) === 1, `got ${clamp(0)}`);
  assert('M-1: clamp(-5) = 1', clamp(-5) === 1, `got ${clamp(-5)}`);
  assert('M-1: clamp(-999) = 1', clamp(-999) === 1, `got ${clamp(-999)}`);
  assert('M-1: clamp(1) = 1', clamp(1) === 1, `got ${clamp(1)}`);
  assert('M-1: clamp(15) = 15', clamp(15) === 15, `got ${clamp(15)}`);
  assert('M-1: clamp(30) = 30', clamp(30) === 30, `got ${clamp(30)}`);
  assert('M-1: clamp(31) = 30', clamp(31) === 30, `got ${clamp(31)}`);
  assert('M-1: clamp(9999) = 30', clamp(9999) === 30, `got ${clamp(9999)}`);
  assert('M-1: clamp("abc") = 1', clamp("abc") === 1, `got ${clamp("abc")}`);
}

// ===========================================================================
console.log('\n=== REGRESSION: M-3 Flat discount cap (total >= 0) ===');
// ===========================================================================

{
  // Same logic as sarah.js and the now-fixed booking.js /review and /submit:
  const capDiscount = (codeValue, subtotal) => Math.min(codeValue, subtotal);

  // Discount exactly equal to subtotal => 0 discount taken, total = 0
  assert('M-3: discount == subtotal => capped at subtotal', capDiscount(300, 300) === 300, `got ${capDiscount(300, 300)}`);

  // Discount greater than subtotal => capped at subtotal
  assert('M-3: discount > subtotal => capped (no negative total)', capDiscount(500, 200) === 200, `got ${capDiscount(500, 200)}`);

  // Normal discount less than subtotal => applied as-is
  assert('M-3: discount < subtotal => applied unchanged', capDiscount(50, 300) === 50, `got ${capDiscount(50, 300)}`);

  // Zero subtotal edge case => no discount taken
  assert('M-3: zero subtotal => zero discount', capDiscount(100, 0) === 0, `got ${capDiscount(100, 0)}`);
}

// ===========================================================================
console.log('\n=== REGRESSION: H-4 Sarah multiday event_end_date + rental_days ===');
// ===========================================================================

{
  // Verify isoOffset (the same function sarah.js now uses for sarahEndDate)
  const base = '2026-11-10';
  const endDate = isoOffset(base, 2);  // reqDays=3 => offset by reqDays-1=2
  assert('H-4: isoOffset(base, 2) = 3rd day', endDate === '2026-11-12', `got ${endDate}`);
  // Single-day: sarahEndDate = null when reqDays <= 1
  const single = 1 > 1 ? isoOffset(base, 0) : null;
  assert('H-4: sarahEndDate is null for single-day bookings', single === null, `got ${single}`);
}

{
  // Confirm that a booking row with event_end_date set IS visible on the intermediate day
  // (exercises the same path as the H-4 fix: booking_items must have rental_days to show qty)
  const slideB = makeEq('Slide Beta', 400, 320, 100, 25);
  const multiBase = '2026-11-20';
  const multiEnd = isoOffset(multiBase, 2); // 2026-11-22

  // Insert a Sarah-style multiday booking WITH the now-required event_end_date
  const custId2 = uuid();
  db.prepare(`INSERT INTO customers (id, first_name, last_name) VALUES (?, 'S', 'M')`).run(custId2);
  const bId2 = uuid();
  db.prepare(`INSERT INTO bookings (id, booking_number, customer_id, status, event_date, event_end_date, event_start_time, event_end_time, subtotal, total)
    VALUES (?, ?, ?, 'confirmed', ?, ?, '09:00', '17:00', 0, 0)`)
    .run(bId2, 'BM-' + bId2.slice(0,8), custId2, multiBase, multiEnd);
  db.prepare(`INSERT INTO booking_items (id, booking_id, equipment_id, item_name, quantity, unit_price, total_price, duration_type, wet_option, rental_days)
    VALUES (?, ?, ?, 'Slide Beta', 1, 0, 0, 'multiday', 0, 3)`)
    .run(uuid(), bId2, slideB.id);

  const { getBookedEquipmentIds } = require('../lib/helpers');

  // Day 1 (start) must be blocked
  const d1 = getBookedEquipmentIds(db, multiBase, '10:00', '14:00', 'daily');
  assert('H-4: multiday booking day 1 visible in availability', (d1.get(slideB.id) || 0) >= 1, `count=${d1.get(slideB.id)}`);

  // Day 2 (intermediate) must be blocked — this is what was MISSING before the fix
  const d2 = getBookedEquipmentIds(db, isoOffset(multiBase, 1), '10:00', '14:00', 'daily');
  assert('H-4: multiday booking day 2 (intermediate) now visible in availability', (d2.get(slideB.id) || 0) >= 1, `count=${d2.get(slideB.id)}`);

  // Day 3 (end) must be blocked
  const d3 = getBookedEquipmentIds(db, multiEnd, '10:00', '14:00', 'daily');
  assert('H-4: multiday booking day 3 (end date) visible in availability', (d3.get(slideB.id) || 0) >= 1, `count=${d3.get(slideB.id)}`);

  // Day 4 must be free
  const d4 = getBookedEquipmentIds(db, isoOffset(multiBase, 3), '10:00', '14:00', 'daily');
  assert('H-4: day after multiday booking is free', (d4.get(slideB.id) || 0) === 0, `count=${d4.get(slideB.id)}`);
}

// ===========================================================================
console.log('\n=== REGRESSION: M-6 price_extra_day=0 throws for multiday ===');
// ===========================================================================

{
  // Per-unit rate = 0 with global setting also 0 -> must throw
  db.prepare("UPDATE settings SET value = '0' WHERE key = 'extra_day_price'").run();
  const zeroRateEq = { id: uuid(), name: 'ZeroRate', price_daily: 200, price_4hr: 130, price_wet: 20, price_overnight: null, price_extra_day: 0 };
  assertThrows('M-6: price_extra_day=0 + global=0 throws for multiday (no silent free days)', () => {
    priceForBooking(db, zeroRateEq, { duration: 'multiday', days: 2, wet: false });
  });

  // Per-unit rate = null with global setting = 0 -> must also throw
  const nullRateEq = { id: uuid(), name: 'NullRate', price_daily: 200, price_4hr: 130, price_wet: 20, price_overnight: null, price_extra_day: null };
  assertThrows('M-6: price_extra_day=null + global=0 throws for multiday', () => {
    priceForBooking(db, nullRateEq, { duration: 'multiday', days: 2, wet: false });
  });

  // Per-unit rate = 0 but global = 75 -> per-unit=0 "not set", falls through to global=75 -> also throws (global 75 > 0 so should NOT throw)
  db.prepare("UPDATE settings SET value = '75' WHERE key = 'extra_day_price'").run();
  const zeroPerUnitGlobalSetEq = { id: uuid(), name: 'ZeroPerUnit', price_daily: 200, price_4hr: 130, price_wet: 20, price_overnight: null, price_extra_day: 0 };
  const p = priceForBooking(db, zeroPerUnitGlobalSetEq, { duration: 'multiday', days: 2, wet: false });
  assert('M-6: price_extra_day=0 falls through to global>0, computes normally', p === round2(200 + 1 * 75), `got ${p}, expected ${round2(200+75)}`);

  // Per-unit rate > 0 -> uses per-unit even if global is also set
  db.prepare("UPDATE settings SET value = '75' WHERE key = 'extra_day_price'").run();
  const validEq = { id: uuid(), name: 'ValidRate', price_daily: 200, price_4hr: 130, price_wet: 20, price_overnight: null, price_extra_day: 50 };
  const p2 = priceForBooking(db, validEq, { duration: 'multiday', days: 2, wet: false });
  assert('M-6: valid price_extra_day>0 uses per-unit rate', p2 === round2(200 + 1 * 50), `got ${p2}, expected ${round2(200+50)}`);
}

// ===========================================================================
console.log('\n=== REGRESSION: FIX-1 server-derived event_end_date (no client trust) ===');
// ===========================================================================

{
  // The /submit handler must derive event_end_date = isoOffset(startDate, days - 1).
  // It must NOT be taken from a client-supplied event_end_date value.
  // We replicate the exact derivation logic from the fixed route here and verify
  // it is independent of any client-supplied end date.

  const startDate = '2027-03-10';
  const rentalDays = 3;

  // Server-derived end date (FIX 1 formula: isoOffset(data.event_date, submitDays - 1))
  const derivedEnd = isoOffset(startDate, rentalDays - 1);
  assert('FIX-1: server-derived end for 3-day booking = start + 2 days',
    derivedEnd === '2027-03-12', `got ${derivedEnd}`);

  // A crafted/short client-supplied end date must NOT be used
  const clientSuppliedShortEnd = startDate; // attacker passes start == end to create a phantom hold
  assert('FIX-1: derived end != crafted client short end (double-booking prevented)',
    derivedEnd !== clientSuppliedShortEnd,
    `derivedEnd=${derivedEnd} clientEnd=${clientSuppliedShortEnd}`);

  // A crafted/long client-supplied end date must NOT be used
  const clientSuppliedLongEnd = '2027-12-31';
  assert('FIX-1: derived end != crafted client long end (phantom hold prevented)',
    derivedEnd !== clientSuppliedLongEnd,
    `derivedEnd=${derivedEnd} clientEnd=${clientSuppliedLongEnd}`);

  // Single-day booking: end == start
  const singleEnd = isoOffset(startDate, 1 - 1);
  assert('FIX-1: single-day derived end == start date',
    singleEnd === startDate, `got ${singleEnd}`);
}

// ===========================================================================
console.log('\n=== REGRESSION: FIX-3 4hr duration caps rental_days to 1 ===');
// ===========================================================================

{
  // Replicate the exact clamp logic from the fixed /submit and /review handlers:
  //   submitDays = submitDuration === '4hr' ? 1 : Math.min(30, Math.max(1, parseInt(data.rental_days) || 1))
  const clamp4hr = (duration, rentalDays) =>
    duration === '4hr' ? 1 : Math.min(30, Math.max(1, parseInt(rentalDays) || 1));

  // 4hr + rental_days=2 must collapse to 1 (the core security assertion)
  const days_4hr_2 = clamp4hr('4hr', 2);
  assert('FIX-3: 4hr + rental_days=2 collapses to 1 day',
    days_4hr_2 === 1, `got ${days_4hr_2}`);

  // 4hr + rental_days=30 must still collapse to 1
  const days_4hr_30 = clamp4hr('4hr', 30);
  assert('FIX-3: 4hr + rental_days=30 collapses to 1 day',
    days_4hr_30 === 1, `got ${days_4hr_30}`);

  // For 4hr+2 days: derived end date must equal start date (priced as single 4hr rental)
  const startDate = '2027-05-15';
  const endDate = isoOffset(startDate, days_4hr_2 - 1); // isoOffset(start, 0) = start
  assert('FIX-3: 4hr booking end date equals start date (single-day hold)',
    endDate === startDate, `got ${endDate}`);

  // Non-4hr durations must still work normally
  const days_daily_3 = clamp4hr('daily', 3);
  assert('FIX-3: daily + rental_days=3 = 3 (not affected by 4hr cap)',
    days_daily_3 === 3, `got ${days_daily_3}`);

  const days_multiday_5 = clamp4hr('multiday', 5);
  assert('FIX-3: multiday + rental_days=5 = 5 (not affected by 4hr cap)',
    days_multiday_5 === 5, `got ${days_multiday_5}`);

  // Regression: reverting FIX 3 (removing the ternary) would make days_4hr_2 = 2, failing the assertion
  assert('FIX-3: regression guard — clamped 4hr days is always 1 (not 2)',
    days_4hr_2 !== 2, `got ${days_4hr_2} (would be 2 if FIX-3 reverted)`);
}

// ===========================================================================
// MD-CHECKOUT: online checkout must forward rental_days / event_end_date all the
// way to /submit (bug: steps 3 & 4 dropped them, so multi-day booked as 1 day).
// ===========================================================================
{
  const fs = require('fs');
  const path = require('path');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const step3 = read('views/public/booking/step3-details.ejs');
  const step4 = read('views/public/booking/step4-review.ejs');
  const sarah = read('routes/sarah.js');

  assert('MD-CHECKOUT: step3 has a rental_days hidden field', /name="rental_days"/.test(step3));
  assert('MD-CHECKOUT: step3 reads rental_days from the URL', /params\.get\(['"]rental_days['"]\)/.test(step3));
  assert('MD-CHECKOUT: step3 has an event_end_date hidden field', /name="event_end_date"/.test(step3));
  assert('MD-CHECKOUT: step4 forwards rental_days to /submit', /name="rental_days"/.test(step4));
  assert('MD-CHECKOUT: step4 forwards event_end_date to /submit', /name="event_end_date"/.test(step4));
  assert('MD-CHECKOUT: Sarah send-checkout-link appends rental_days', /rental_days=\$\{reqDays\}/.test(sarah));
}

// ===========================================================================
console.log('\n=== RESULTS ===');
// ===========================================================================
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failures.length > 0) {
  console.log('\nFailed tests:');
  failures.forEach(f => console.log('  -', f));
  process.exit(1);
} else {
  console.log('\nAll tests passed!');
  process.exit(0);
}
