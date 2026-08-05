// Renders the real email bodies and asserts the Sunday Monday-pickup notice appears on
// Sunday bookings and only on Sunday bookings. Run from the app root: node <this file>
const fs = require('fs');
const path = require('path');
const Module = require('module');

const src = fs.readFileSync(path.join(__dirname, "..", "services", "email.js"), 'utf8');
// Load email.js as if it lived at services/email.js so its relative requires resolve.
const m = new Module(path.join(__dirname, "..", "services", "email.js"), null);
m.filename = path.join(__dirname, "..", "services", "email.js");
m.paths = Module._nodeModulePaths(path.join(__dirname, "..", "services"));
m._compile(
  src + '\n;module.exports._t = { bookingConfirmationBody, deliveryReminderBody, sundayPickupBlock };',
  m.filename
);
const T = m.exports._t;

const base = {
  booking_number: 'BM-TEST-1', event_start_time: '09:00', event_end_time: '19:00',
  delivery_address: '1 Main St', delivery_city: 'Tonkawa', delivery_zip: '74653',
  balance_due: 100, total: 300, deposit_amount: 50, rental_duration: 'daily',
  subtotal: 250, delivery_fee: 0, tax_amount: 0, discount_amount: 0,
};
const cust = { first_name: 'Test', last_name: 'User', email: 't@e.com' };
// Shape matches a real `booking_items` row (item_name / unit_price), not a made-up one —
// a wrong fixture here renders "undefined" into the item table and hides real breakage.
const items = [{ item_name: 'Buccaneer Bay', unit_price: 250, quantity: 1, rental_days: 1 }];

const SUN = { ...base, event_date: '2026-08-09' }; // Sunday
const SAT = { ...base, event_date: '2026-08-08' }; // Saturday
const MON = { ...base, event_date: '2026-08-10' }; // Monday

// Match against whitespace-normalised text. The email bodies are hand-wrapped template
// literals, so a phrase can straddle a newline ("cannot be set\nup at a park") and render
// perfectly while a naive regex misses it.
const flat = (html) => String(html).replace(/\s+/g, ' ');
const hasNotice = (html) => /Monday morning/i.test(flat(html));
const hasDropOff = (html) => /Saturday evening/i.test(flat(html));
const hasParkRule = (html) => /cannot be set up at a park/i.test(flat(html));

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

// ---- the rules themselves -------------------------------------------------------
const h = require('../lib/helpers');

console.log('isSundayRental:');
t('Sunday',      h.isSundayRental('2026-08-09'), true);
t('Saturday',    h.isSundayRental('2026-08-08'), false);
t('Monday',      h.isSundayRental('2026-08-10'), false);
t('empty string', h.isSundayRental(''),          false);
t('null',        h.isSundayRental(null),         false);

console.log('isUnsecuredVenue:');
t('Park',        h.isUnsecuredVenue('Park'),       true);
t('park (lower)', h.isUnsecuredVenue('park'),      true);
t('City Park',   h.isUnsecuredVenue('City Park'),  true);
t('Backyard',    h.isUnsecuredVenue('Backyard'),   false);
t('Indoor',      h.isUnsecuredVenue('Indoor'),     false);
t('Commercial',  h.isUnsecuredVenue('Commercial'), false);
t('empty string', h.isUnsecuredVenue(''),          false);
t('undefined',   h.isUnsecuredVenue(undefined),    false);

console.log('combined guard (refuse only when BOTH):');
for (const [d, v, want] of [
  ['2026-08-09', 'Park', true], ['2026-08-09', 'Backyard', false],
  ['2026-08-08', 'Park', false], ['2026-08-08', 'Backyard', false],
]) t(`${d} + ${v}`, h.isSundayRental(d) && h.isUnsecuredVenue(v), want);

console.log('Sunday pickup notice — confirmation email:');
t('Sunday   -> notice present', hasNotice(T.bookingConfirmationBody(SUN, cust, items, 'c1')), true);
t('Saturday -> notice absent',  hasNotice(T.bookingConfirmationBody(SAT, cust, items, 'c1')), false);
t('Monday   -> notice absent',  hasNotice(T.bookingConfirmationBody(MON, cust, items, 'c1')), false);
t('Sunday, no contract id',     hasNotice(T.bookingConfirmationBody(SUN, cust, items, null)), true);
t('Sunday   -> park rule stated', hasParkRule(T.bookingConfirmationBody(SUN, cust, items, 'c1')), true);
t('Sunday   -> Saturday drop-off stated', hasDropOff(T.bookingConfirmationBody(SUN, cust, items, 'c1')), true);
t('Saturday -> no drop-off notice', hasDropOff(T.bookingConfirmationBody(SAT, cust, items, 'c1')), false);

console.log('Sunday pickup notice — delivery reminder email:');
t('Sunday   -> notice present', hasNotice(T.deliveryReminderBody(SUN, cust, 'c1')), true);
t('Saturday -> notice absent',  hasNotice(T.deliveryReminderBody(SAT, cust, 'c1')), false);

console.log('Output integrity:');
const html = T.bookingConfirmationBody(SUN, cust, items, 'c1');
t('no unrendered ${ } left in confirmation', /\$\{/.test(html), false);
t('no "undefined" leaked into confirmation', /undefined/.test(html), false);
t('reminder renders without contract id', typeof T.deliveryReminderBody(SUN, cust, null) === 'string', true);

console.log('\n--- rendered notice (text) ---');
console.log(T.sundayPickupBlock(SUN).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
