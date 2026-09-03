/**
 * tests/addon-pricing.test.js
 * Ride-along ("add-on") pricing: price_addon, asAddon, and the cart anchor rule.
 * Run: node tests/addon-pricing.test.js
 */

'use strict';

process.env.DB_PATH = '/tmp/bounceman-test-addon-' + Date.now() + '.db';

let passed = 0, failed = 0;
const failures = [];
function assert(label, cond, details) {
  if (cond) { console.log('  PASS: ' + label); passed++; }
  else { console.error('  FAIL: ' + label + (details !== undefined ? ' -- ' + details : '')); failed++; failures.push(label); }
}

const { getDb } = require('../db');
const db = getDb();
const { priceForBooking, addonRate, addonPricedIds } = require('../lib/helpers');

// Bare fixtures -- priceForBooking reads plain objects, no inserts needed.
const slide   = { id: 'eq-slide',   name: 'Big Slide',  price_4hr: 300, price_daily: 375, price_extra_day: 90 };
const corn    = { id: 'eq-corn',    name: 'Cornhole',   price_4hr: 75,  price_daily: 100, price_extra_day: 25, price_addon: 20 };
const hoop    = { id: 'eq-hoop',    name: 'Hoop Shot',  price_4hr: 125, price_daily: 175, price_extra_day: 60, price_addon: 75 };
const speaker = { id: 'eq-speaker', name: 'Speaker',    price_4hr: 50,  price_daily: 75,  price_extra_day: 25 };

console.log('\n=== addonRate ===');
assert('reads a set rate', addonRate(corn) === 20);
assert('null when unset', addonRate(slide) === null);
assert('empty string means unset', addonRate({ price_addon: '' }) === null);
assert('zero means unset, not free', addonRate({ price_addon: 0 }) === null);
assert('negative means unset', addonRate({ price_addon: -5 }) === null);
assert('undefined eq is safe', addonRate(undefined) === null);

console.log('\n=== priceForBooking asAddon ===');
assert('asAddon uses the flat rate',
  priceForBooking(db, corn, { duration: 'daily', days: 1, asAddon: true }) === 20);
assert('flat regardless of duration',
  priceForBooking(db, corn, { duration: '4hr', days: 1, asAddon: true }) === 20);
assert('flat regardless of extra days -- no per-day multiplication',
  priceForBooking(db, corn, { duration: 'multiday', days: 3, asAddon: true }) === 20);
assert('asAddon false still charges full price',
  priceForBooking(db, corn, { duration: 'daily', days: 1, asAddon: false }) === 100);
assert('asAddon on a unit with no rate falls through to full price',
  priceForBooking(db, slide, { duration: 'daily', days: 1, asAddon: true }) === 375);

console.log('\n=== the cart anchor rule ===');
const idsAlone = addonPricedIds(db, [corn], { duration: 'daily', days: 1 });
assert('booked alone, cornhole is the anchor and pays full price', !idsAlone.has('eq-corn'));

const idsWithSlide = addonPricedIds(db, [slide, corn], { duration: 'daily', days: 1 });
assert('alongside a pricier unit, cornhole rides along', idsWithSlide.has('eq-corn'));
assert('the pricier unit never rides along', !idsWithSlide.has('eq-slide'));

const idsTwoAddons = addonPricedIds(db, [corn, hoop], { duration: 'daily', days: 1 });
assert('two ride-along items: the pricier one anchors at full price', !idsTwoAddons.has('eq-hoop'));
assert('two ride-along items: the cheaper one rides along', idsTwoAddons.has('eq-corn'));

const idsNoRate = addonPricedIds(db, [slide, speaker], { duration: 'daily', days: 1 });
assert('an item with no ride-along rate is never discounted', !idsNoRate.has('eq-speaker'));

const idsCornSpeaker = addonPricedIds(db, [corn, speaker], { duration: 'daily', days: 1 });
assert('cornhole($100) outranks speaker($75), so cornhole anchors at full price', !idsCornSpeaker.has('eq-corn'));

console.log('\n=== per-item options ===');
const perItem = addonPricedIds(db, [
  { eq: slide, opts: { duration: '4hr', days: 1 } },
  { eq: corn,  opts: { duration: 'daily', days: 1 } }
]);
assert('per-item durations resolve an anchor', perItem.has('eq-corn') && !perItem.has('eq-slide'));

console.log('\n=== money check: a real cart ===');
const cart = [slide, hoop, corn];
const ids = addonPricedIds(db, cart, { duration: 'daily', days: 1 });
const total = cart.reduce((s, eq) =>
  s + priceForBooking(db, eq, { duration: 'daily', days: 1, asAddon: ids.has(eq.id) }), 0);
assert('slide 375 + hoop 75 + cornhole 20 = 470', total === 470, 'got ' + total);

const cartNoSlide = [hoop, corn];
const ids2 = addonPricedIds(db, cartNoSlide, { duration: 'daily', days: 1 });
const total2 = cartNoSlide.reduce((s, eq) =>
  s + priceForBooking(db, eq, { duration: 'daily', days: 1, asAddon: ids2.has(eq.id) }), 0);
assert('hoop alone anchors: 175 + cornhole 20 = 195', total2 === 195, 'got ' + total2);

console.log('\n=== edge cases ===');
assert('empty cart returns an empty set', addonPricedIds(db, [], {}).size === 0);
assert('null cart is safe', addonPricedIds(db, null, {}).size === 0);
assert('a cart of nulls is safe', addonPricedIds(db, [null, undefined], {}).size === 0);
const dupIds = addonPricedIds(db, [corn, corn], { duration: 'daily', days: 1 });
assert('identical rows cannot both be discounted', dupIds.size === 0, 'size ' + dupIds.size);

console.log('\n' + '='.repeat(50));
console.log('passed ' + passed + ', failed ' + failed);
if (failures.length) { failures.forEach(f => console.error('  - ' + f)); process.exit(1); }
process.exit(0);
