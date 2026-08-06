// A phone number typed with its country code used to be saved with the digits shifted:
// 15806281767 became "(158) 062-8176", because the formatter took the first three digits
// as the area code. It looked formatted, the booking completed, the deposit charged, and
// it surfaced sixteen days later when a delivery text bounced — two days before the event.
//
// Run from the app root: node tests/phone-format.test.js
const { formatPhoneUS, normalizePhone } = require('../lib/helpers');

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
}

console.log('formatPhoneUS — the bug:');
t('bare ten digits',        formatPhoneUS('5806281767'),        '(580) 628-1767');
t('leading 1',              formatPhoneUS('15806281767'),       '(580) 628-1767');
t('+1 with spaces',         formatPhoneUS('+1 580 628 1767'),   '(580) 628-1767');
t('1- dashed',              formatPhoneUS('1-580-628-1767'),    '(580) 628-1767');
t('already formatted',      formatPhoneUS('(580) 628-1767'),    '(580) 628-1767');
t('dotted',                 formatPhoneUS('580.628.1767'),      '(580) 628-1767');

console.log('formatPhoneUS — leaves alone what it should:');
t('empty string',           formatPhoneUS(''),                  '');
t('null',                   formatPhoneUS(null),                '');
t('undefined',              formatPhoneUS(undefined),           '');
t('too short',              formatPhoneUS('12345'),             '12345');
t('international',          formatPhoneUS('+44 20 7946 0958'),  '+44 20 7946 0958');
t('ten digits, area code 1', formatPhoneUS('1580628176'),       '1580628176');
t('ten digits, area code 0', formatPhoneUS('0580628176'),       '0580628176');

console.log('lookups were never broken — normalizePhone takes the LAST ten:');
t('bare',                   normalizePhone('5806281767'),       '5806281767');
t('leading 1',              normalizePhone('15806281767'),      '5806281767');
// The old formatter did not merely shift the digits — it TRUNCATED. substring(6,10) on
// an 11-digit string dropped the final character, so "15806281767" was stored as
// "(158) 062-8176", losing the trailing 7 for good. A mangled value is unrecoverable;
// this is why the number had to come back from the customer rather than be repaired.
t('mangled value is lossy',  normalizePhone('(158) 062-8176'),  '1580628176');
t('  ...and not the real one', normalizePhone('(158) 062-8176') === '5806281767', false);

console.log('the exact value that broke in production:');
t('Paige Legg',             formatPhoneUS('15806281767'),       '(580) 628-1767');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
