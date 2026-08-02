/**
 * tests/pricing-availability.test.js
 * Phase 1 tests: priceForBooking, buffer, wet->dry, multiday, maxExtraDaysAvailable
 * Run: node tests/pricing-availability.test.js
 */

'use strict';

process.env.DB_PATH = '/tmp/bounceman-test-phase1-' + Date.now() + '.db';

const path = require('path');
const fs = require('fs');
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

// Ensure settings
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('buffer_min', '120')").run();
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('wetdry_hours', '48')").run();
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('extra_day_price', '0')").run();

// Insert test equipment fixtures
function makeEq(name, daily, p4hr, extraDay, wet) {
  const id = uuid();
  db.prepare(`INSERT INTO equipment (id, name, slug, category, price_daily, price_4hr, price_wet, price_extra_day, status)
    VALUES (?, ?, ?, 'bounce_house', ?, ?, ?, ?, 'available')`)
    .run(id, name, name.toLowerCase().replace(/\s+/g, '-') + '-' + id.slice(0,4), daily, p4hr, wet, extraDay);
  return db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
}

const gauntlet   = makeEq('The Gauntlet',            450, 375, 150, null);
const buccaneer  = makeEq('Buccaneer Bay',            450, 350, 150, null);
const blueCrush  = makeEq('Blue Crush Slide',         375, 300,  90, null);
const tropical   = makeEq('Tropical Combo',           299, 250,  75, null);
const monkey     = makeEq('Monkey Jumper',            200, 150,  50,   25);
const miniCastle = makeEq('Mini Castle Bounce House', 175, 125,  50, null);

// Helper: insert booking with items
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
  priceForBooking, demandMultiplierFor, getBookedEquipmentIds,
  isBlockedByWetDryRule, maxExtraDaysAvailable, round2
} = require('../lib/helpers');

// ===========================================================================
console.log('\n=== SECTION 1: priceForBooking ===');
// ===========================================================================

// 1a. Half-day (4hr)
{
  const p = priceForBooking(db, gauntlet, { duration: '4hr', days: 1, wet: false });
  assert('4hr price correct', p === 375, `got ${p}`);
}

// 1b. All-day (daily)
{
  const p = priceForBooking(db, gauntlet, { duration: 'daily', days: 1, wet: false });
  assert('daily price correct', p === 450, `got ${p}`);
}

// 1c. Multiday 2 days: daily + 1 extra @ 150
{
  const expected = round2(450 + 1 * 150); // 600
  const p = priceForBooking(db, gauntlet, { duration: 'multiday', days: 2, wet: false });
  assert('multiday 2-day Gauntlet = daily + 1*extraDay', p === expected, `got ${p}, expected ${expected}`);
}

// 1d. Multiday 3 days: daily + 2 extra @ 150
{
  const expected = round2(450 + 2 * 150); // 750
  const p = priceForBooking(db, gauntlet, { duration: 'multiday', days: 3, wet: false });
  assert('multiday 3-day Gauntlet = daily + 2*extraDay', p === expected, `got ${p}, expected ${expected}`);
}

// 1e. Demand multiplier: insert window multiplier=2.0 for Aug 2026
db.prepare("INSERT INTO demand_dates (id, date_start, date_end, multiplier, active, label) VALUES (?, '2026-08-01', '2026-08-31', 2.0, 1, 'SummerPeak')").run(uuid());

// 1f. Wet costs the same as dry (conference decision 2026-07: upcharge removed).
// This used to assert a $25 flat-add; getWetUpcharge() has returned 0 since 1f14565,
// so the assertion was left failing. Wet/dry is now a selectable option with no price delta.
{
  const demandDate = '2026-08-15';
  const priceWithWet    = priceForBooking(db, monkey, { duration: 'daily', days: 1, wet: true,  date: demandDate });
  const priceWithoutWet = priceForBooking(db, monkey, { duration: 'daily', days: 1, wet: false, date: demandDate });
  const wetDelta = round2(priceWithWet - priceWithoutWet);
  assert('wet costs the same as dry (upcharge removed)', wetDelta === 0, `wetDelta=${wetDelta}`);
}

// 1g. Demand multiplier applied to rentalBase
{
  const demandDate = '2026-08-15';
  const nodemand = priceForBooking(db, monkey, { duration: 'daily', days: 1, wet: false, date: '2026-07-01' });
  const withdemand = priceForBooking(db, monkey, { duration: 'daily', days: 1, wet: false, date: demandDate });
  assert('demand 2x applied to base', withdemand === round2(nodemand * 2), `no-demand=${nodemand}, with-demand=${withdemand}`);
}

// 1h. Multiday + demand: (daily + extraDays*rate)*mult. No wet fee is added — the
// upcharge was removed in 1f14565, so price_wet on the row must NOT reach the total.
// (price_wet survives in the DB purely as a wet-capable flag; see isWetCapable.)
{
  const demandDate = '2026-08-15';
  const rentalBase = 450 + 1 * 150; // 600
  const expected = round2(rentalBase * 2); // 1200 — wet adds nothing
  const eqWithWet = { ...gauntlet, price_wet: 30 };
  const p = priceForBooking(db, eqWithWet, { duration: 'multiday', days: 2, wet: true, date: demandDate });
  assert('multiday+demand, wet adds nothing: (base+extra)*mult', p === expected, `got ${p}, expected ${expected}`);
}

// 1i. NaN-guard: no price_extra_day + settings empty => throw
{
  const noRateEq = { id: uuid(), name: 'NoRate', price_daily: 100, price_4hr: 65, price_wet: 20, price_overnight: null, price_extra_day: null };
  db.prepare("UPDATE settings SET value = '' WHERE key = 'extra_day_price'").run();
  assertThrows('NaN-guard throws when no extra rate available', () => {
    priceForBooking(db, noRateEq, { duration: 'multiday', days: 2, wet: false, date: null });
  });
  db.prepare("UPDATE settings SET value = '0' WHERE key = 'extra_day_price'").run();
}

// ===========================================================================
console.log('\n=== SECTION 2: Buffer (2-hour) ===');
// ===========================================================================

const bufDate = '2026-09-05'; // Friday (no Sunday special case)

// Existing booking: 09:00-13:00
insertBooking({ eqId: gauntlet.id, date: bufDate, startTime: '09:00', endTime: '13:00', duration: 'daily' });
// Buffered window of existing: 07:00–15:00

// 2a. Requested 14:00 start: within buffer (14:00 < 15:00) → BLOCKED
{
  const counts = getBookedEquipmentIds(db, bufDate, '14:00', '18:00', 'daily');
  assert('buffer: 14:00 start blocked (within 2h of 13:00 end)', (counts.get(gauntlet.id) || 0) >= 1, `count=${counts.get(gauntlet.id)}`);
}

// 2b. Requested 15:00 start: at buffered end boundary → ALLOWED
{
  const counts = getBookedEquipmentIds(db, bufDate, '15:00', '19:00', 'daily');
  assert('buffer: 15:00 start allowed (at buffered end)', (counts.get(gauntlet.id) || 0) === 0, `count=${counts.get(gauntlet.id)}`);
}

// 2c. 14:30 start: still within buffer → BLOCKED
{
  const counts = getBookedEquipmentIds(db, bufDate, '14:30', '18:30', 'daily');
  assert('buffer: 14:30 start blocked (<2h gap)', (counts.get(gauntlet.id) || 0) >= 1, `count=${counts.get(gauntlet.id)}`);
}

// ===========================================================================
console.log('\n=== SECTION 3: Wet->Dry Rule ===');
// ===========================================================================

const wetDryDate = '2026-09-10';
// Insert WET booking ending at 14:00
insertBooking({ eqId: buccaneer.id, date: wetDryDate, startTime: '09:00', endTime: '14:00', duration: 'daily', wet: 1 });

// 3a. DRY same-day at 15:00 → within 48h of wet end → BLOCKED
{
  const blocked = isBlockedByWetDryRule(db, buccaneer.id, wetDryDate, '15:00', 0);
  assert('wet->dry: dry blocked same-day', blocked === true, `blocked=${blocked}`);
}

// 3b. WET same-day at 15:00 → wet-after-wet is fine
{
  const blocked = isBlockedByWetDryRule(db, buccaneer.id, wetDryDate, '15:00', 1);
  assert('wet->dry: wet-after-wet allowed', blocked === false, `blocked=${blocked}`);
}

// 3c. DRY next day within 48h (Sep 11 10:00) → BLOCKED
{
  const blocked = isBlockedByWetDryRule(db, buccaneer.id, '2026-09-11', '10:00', 0);
  assert('wet->dry: dry within 48h blocked (next day)', blocked === true, `blocked=${blocked}`);
}

// 3d. DRY after 48h (Sep 12 15:00: wet ended Sep 10 14:00, gap = 49h) → ALLOWED
{
  const blocked = isBlockedByWetDryRule(db, buccaneer.id, '2026-09-12', '15:00', 0);
  assert('wet->dry: dry after 48h allowed', blocked === false, `blocked=${blocked}`);
}

// ===========================================================================
console.log('\n=== SECTION 4: Multiday Blocking ===');
// ===========================================================================

// 3-day booking: Oct 1-3 on tropical
insertBooking({ eqId: tropical.id, date: '2026-10-01', startTime: '09:00', endTime: '17:00',
  duration: 'multiday', endDate: '2026-10-03' });

// 4a. Day 1 (Oct 1) blocked
{
  const counts = getBookedEquipmentIds(db, '2026-10-01', '10:00', '14:00', 'daily');
  assert('multiday: day 1 blocked', (counts.get(tropical.id) || 0) >= 1, `count=${counts.get(tropical.id)}`);
}

// 4b. Day 2 (Oct 2) intermediate — fully blocked
{
  const counts = getBookedEquipmentIds(db, '2026-10-02', '10:00', '14:00', 'daily');
  assert('multiday: day 2 (intermediate) blocked', (counts.get(tropical.id) || 0) >= 1, `count=${counts.get(tropical.id)}`);
}

// 4c. Day 3 (Oct 3) end date — blocked
{
  const counts = getBookedEquipmentIds(db, '2026-10-03', '10:00', '14:00', 'daily');
  assert('multiday: day 3 (end date) blocked', (counts.get(tropical.id) || 0) >= 1, `count=${counts.get(tropical.id)}`);
}

// 4d. Day 4 (Oct 4) — free
{
  const counts = getBookedEquipmentIds(db, '2026-10-04', '10:00', '14:00', 'daily');
  assert('multiday: day 4 free', (counts.get(tropical.id) || 0) === 0, `count=${counts.get(tropical.id)}`);
}

// 4e. A booking on day 2 is rejected (sees the block)
{
  const counts = getBookedEquipmentIds(db, '2026-10-02', '11:00', '15:00', 'daily');
  assert('multiday: request on day 2 rejected', (counts.get(tropical.id) || 0) >= 1);
}

// ===========================================================================
console.log('\n=== SECTION 5: maxExtraDaysAvailable ===');
// ===========================================================================

// 5a. Fresh unit with nothing booked after base date → multiple free days
{
  const extra = maxExtraDaysAvailable(db, miniCastle.id, '2026-11-03', 1);
  assert('maxExtraDays: >0 when nothing after base', extra > 0, `got ${extra}`);
}

// 5b. Block Nov 4 → extra days from Nov 3 should be 0
{
  insertBooking({ eqId: miniCastle.id, date: '2026-11-04', startTime: '00:00', endTime: '23:59:59', duration: 'daily' });
  const extra = maxExtraDaysAvailable(db, miniCastle.id, '2026-11-03', 1);
  assert('maxExtraDays: 0 when day+1 is blocked', extra === 0, `got ${extra}`);
}

// 5c. Two free days then blocked: base=Nov 10, block Nov 13
{
  insertBooking({ eqId: miniCastle.id, date: '2026-11-13', startTime: '09:00', endTime: '17:00', duration: 'daily' });
  const extra = maxExtraDaysAvailable(db, miniCastle.id, '2026-11-10', 1);
  // Nov 11, Nov 12 free; Nov 13 blocked → 2 extra days
  assert('maxExtraDays: 2 free days then blocked on day 3', extra === 2, `got ${extra}`);
}

// ===========================================================================
console.log('\n=== SECTION 6: demandMultiplierFor ===');
// ===========================================================================

{
  const mult = demandMultiplierFor(db, '2026-08-15');
  assert('demandMultiplierFor: 2.0 for date in demand window', mult === 2.0, `got ${mult}`);
}

{
  const mult = demandMultiplierFor(db, '2026-12-01');
  assert('demandMultiplierFor: 1.0 for date outside all windows', mult === 1.0, `got ${mult}`);
}

// ===========================================================================
console.log('\n=== SECTION 7: weekday special (full day at half-day price) ===');
// ===========================================================================
{
  const { weekdaySpecialApplies } = require('../lib/helpers');
  // Clear any demand windows from earlier sections so these assertions isolate the special.
  db.prepare('DELETE FROM demand_dates').run();
  const setS = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v);
  setS('weekday_special_active', '1');
  setS('weekday_special_start', '2026-08-01');
  setS('weekday_special_end', '2026-08-31');
  setS('weekday_special_days', '1,2,3,4,5');

  const monday = '2026-08-03';    // Monday in window
  const saturday = '2026-08-01';  // Saturday (weekend)
  const julyMon = '2026-07-06';   // Monday but outside window

  assert('special applies on Aug weekday', weekdaySpecialApplies(db, monday) === true);
  assert('special NOT on Aug weekend', weekdaySpecialApplies(db, saturday) === false);
  assert('special NOT outside window', weekdaySpecialApplies(db, julyMon) === false);

  const wk = priceForBooking(db, gauntlet, { duration: 'daily', days: 1, wet: false, date: monday });
  assert('weekday full-day = half-day price', wk === 375, `got ${wk}`);

  const weekend = priceForBooking(db, gauntlet, { duration: 'daily', days: 1, wet: false, date: saturday });
  assert('weekend full-day = normal daily', weekend === 450, `got ${weekend}`);

  const multi = priceForBooking(db, gauntlet, { duration: 'multiday', days: 2, wet: false, date: monday });
  assert('multi-day weekday NOT discounted', multi === 600, `got ${multi}`);

  const reg = priceForBooking(db, gauntlet, { duration: 'daily', days: 1, wet: false, date: monday, ignoreSpecial: true });
  assert('ignoreSpecial returns regular daily', reg === 450, `got ${reg}`);

  setS('weekday_special_active', '0');
  const off = priceForBooking(db, gauntlet, { duration: 'daily', days: 1, wet: false, date: monday });
  assert('inactive special = no discount', off === 450, `got ${off}`);
  setS('weekday_special_active', '1');
}

// ===========================================================================
console.log('\n=== SECTION 8: sales-tax jurisdiction resolution ===');
// ===========================================================================
{
  const { getTaxRate, calcPricing } = require('../lib/helpers');
  const near = (a, b) => a != null && Math.abs(a - b) < 0.00001;

  assert('Tonkawa = 10.25%',    near(getTaxRate('Tonkawa'), 0.1025), getTaxRate('Tonkawa'));
  assert('Blackwell = 10.75%',  near(getTaxRate('Blackwell'), 0.1075), getTaxRate('Blackwell'));
  assert('Ponca City = 9.583%', near(getTaxRate('Ponca City'), 0.09583), getTaxRate('Ponca City'));
  assert('ponca city (lowercase) same', near(getTaxRate('ponca city'), 0.09583), getTaxRate('ponca city'));
  assert('Newkirk = 9.75%',     near(getTaxRate('Newkirk'), 0.0975), getTaxRate('Newkirk'));
  // B4: city with no city tax = state + county only
  assert('Nardin = 5.75% (no city tax)', near(getTaxRate('Nardin'), 0.0575), getTaxRate('Nardin'));
  // B3: Cherokee is in Alfalfa county (2%), not Kay
  assert('Cherokee = 9.75% (Alfalfa county)', near(getTaxRate('Cherokee'), 0.0975), getTaxRate('Cherokee'));
  // B2: unknown / empty city => null (no Tonkawa guess)
  assert('unknown city => null', getTaxRate('Nowheresville') === null);
  assert('empty city => null', getTaxRate('') === null);
  assert('null city => null', getTaxRate(null) === null);

  // calcPricing uses per-city rate; unresolved => state+Kay fallback (5.75%), never the old flat setting
  const s = { damage_waiver_fee: '0', deposit_percent: '50', tax_rate: '0.085' };
  const pNardin = calcPricing(s, 100, 0, 'Nardin', false);
  assert('calcPricing Nardin taxAmount = 5.75', near(pNardin.taxAmount, 5.75), pNardin.taxAmount);
  const pUnknown = calcPricing(s, 100, 0, 'Nowheresville', false);
  assert('calcPricing unknown -> 5.75% fallback (not 8.5)', near(pUnknown.taxAmount, 5.75), pUnknown.taxAmount);
  const pExempt = calcPricing(s, 100, 0, 'Tonkawa', true);
  assert('calcPricing exempt = 0 tax', pExempt.taxAmount === 0);
}

// ===========================================================================
console.log('\n=== SECTION 9: discount codes (comp, single-use, whitespace) ===');
// ===========================================================================
{
  const { lookupDiscount, isCompCode, discountAmountFor, redeemDiscount, normalizeCode,
          getSettings, calcPricing } = require('../lib/helpers');
  const s = getSettings();

  const mk = (code, type, value, maxUses) => {
    db.prepare('DELETE FROM discount_codes WHERE code = ?').run(code);
    db.prepare(`INSERT INTO discount_codes (id, code, type, value, min_order, max_uses, uses_count, active)
                VALUES (?, ?, ?, ?, 0, ?, 0, 1)`).run(uuid(), code, type, value, maxUses);
  };

  // Mirrors the pricing that routes/booking.js does for a code.
  const quote = (raw, { subtotal, deliveryFee = 0, surfaceFee = 0, city = 'Tonkawa' }) => {
    const row = lookupDiscount(db, raw);
    const comp = isCompCode(row);
    let disc = comp ? subtotal : discountAmountFor(row, subtotal);
    const p = calcPricing(s, subtotal, deliveryFee, city, false, surfaceFee, disc);
    let total = round2(Math.max(0, p.total - disc));
    if (comp) { disc = p.total; total = 0; }
    return { matched: !!row, comp, total, tax: p.taxAmount,
             deposit: Math.min(parseFloat(s.deposit_flat || '50'), total) };
  };

  mk('TESTCOMP', 'free', 100, 1);
  mk('TESTPCT', 'percent', 10, null);

  // A comp must zero EVERYTHING — the bug was that delivery and the hard-surface
  // surcharge survived a subtotal-only discount, so "100% off" still charged money.
  const worst = { subtotal: 450, deliveryFee: 100, surfaceFee: 45, city: 'Enid' };
  const plain = quote(null, worst);
  assert('no code: worst case still costs money', plain.total > 600, `total=${plain.total}`);
  const comped = quote('TESTCOMP', worst);
  assert('comp zeroes the total incl. delivery + surcharge', comped.total === 0, `total=${comped.total}`);
  assert('comp owes no sales tax', comped.tax === 0, `tax=${comped.tax}`);
  assert('comp leaves a $0 deposit (skips Stripe)', comped.deposit === 0, `deposit=${comped.deposit}`);

  // Whitespace-insensitive matching — "FOSTER CARE" is typed with a space.
  db.prepare("UPDATE discount_codes SET uses_count = 0 WHERE code = 'TESTCOMP'").run();
  assert('normalizeCode strips spaces', normalizeCode(' Test Comp ') === 'TESTCOMP');
  for (const v of ['TESTCOMP', 'test comp', ' Test Comp ', 'TEST  COMP']) {
    assert(`code matches variant ${JSON.stringify(v)}`, !!lookupDiscount(db, v), 'no match');
  }

  // Single use must actually hold — max_uses was previously never enforced or incremented.
  assert('first redemption succeeds', redeemDiscount(db, lookupDiscount(db, 'TESTCOMP').id) === true);
  assert('used-up code no longer resolves', lookupDiscount(db, 'TESTCOMP') === null);
  const after = quote('TESTCOMP', worst);
  assert('used-up code charges full price', after.matched === false && after.total > 600, `total=${after.total}`);
  const rowId = db.prepare("SELECT id FROM discount_codes WHERE code = 'TESTCOMP'").get().id;
  assert('second redemption refused (atomic guard)', redeemDiscount(db, rowId) === false);

  // Ordinary codes must be untouched by all of the above.
  const pct = quote('TESTPCT', { subtotal: 350 });
  assert('percent code still discounts subtotal only', pct.comp === false && pct.total > 0, `total=${pct.total}`);
  assert('unlimited code has no use cap', redeemDiscount(db, lookupDiscount(db, 'TESTPCT').id) === true);
  assert('unlimited code still resolves after use', !!lookupDiscount(db, 'TESTPCT'));

  db.prepare("DELETE FROM discount_codes WHERE code IN ('TESTCOMP','TESTPCT')").run();
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
