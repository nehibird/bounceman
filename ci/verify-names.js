#!/usr/bin/env node
/**
 * V3b gate. The risk in a name normaliser is not that it fails to fix the broken row --
 * it is that it "fixes" names that were never broken. Most of these assertions are
 * about what it must NOT touch.
 */
const { normalizeCustomerName } = require('/app/lib/helpers');

let fails = 0;
function check(label, ok, detail) {
  console.log((ok ? 'ok    ' : 'FAIL  ') + label + (detail ? '  [' + String(detail).slice(0, 120) + ']' : ''));
  if (!ok) fails++;
}
function eq(a, b) { return a.first_name === b.first_name && a.last_name === b.last_name; }

// --- the bug it exists for
check('full name in both fields is split',
  eq(normalizeCustomerName('Larry hutson', 'Larry hutson'), { first_name: 'Larry', last_name: 'hutson' }),
  JSON.stringify(normalizeCustomerName('Larry hutson', 'Larry hutson')));
check('...case-insensitively, since the boxes are typed separately',
  eq(normalizeCustomerName('Larry Hutson', 'larry hutson'), { first_name: 'Larry', last_name: 'Hutson' }),
  JSON.stringify(normalizeCustomerName('Larry Hutson', 'larry hutson')));
check('a three-part name in both fields keeps the rest together',
  eq(normalizeCustomerName('Mary Jo Smith', 'Mary Jo Smith'), { first_name: 'Mary', last_name: 'Jo Smith' }),
  JSON.stringify(normalizeCustomerName('Mary Jo Smith', 'Mary Jo Smith')));

// --- everything it must leave alone. These are real rows in this database.
check('"Cara Nashae" + "Kelley" untouched',
  eq(normalizeCustomerName('Cara Nashae', 'Kelley'), { first_name: 'Cara Nashae', last_name: 'Kelley' }));
check('"Brandi" + "Kay Hannon" untouched',
  eq(normalizeCustomerName('Brandi', 'Kay Hannon'), { first_name: 'Brandi', last_name: 'Kay Hannon' }));
check('"Kelsie" + "B McKeachnie" untouched',
  eq(normalizeCustomerName('Kelsie', 'B McKeachnie'), { first_name: 'Kelsie', last_name: 'B McKeachnie' }));
check('a repeated SINGLE word is not split (real surname-as-first-name)',
  eq(normalizeCustomerName('Morgan', 'Morgan'), { first_name: 'Morgan', last_name: 'Morgan' }),
  JSON.stringify(normalizeCustomerName('Morgan', 'Morgan')));
check('capitalisation is never guessed',
  eq(normalizeCustomerName('hutson', 'mcdonald'), { first_name: 'hutson', last_name: 'mcdonald' }));
check('a missing last name stays missing',
  eq(normalizeCustomerName('Cher', ''), { first_name: 'Cher', last_name: '' }));
check('null input does not throw',
  eq(normalizeCustomerName(null, undefined), { first_name: '', last_name: '' }));

// --- incidental tidying
check('surrounding whitespace is trimmed',
  eq(normalizeCustomerName('Jim ', 'Reese'), { first_name: 'Jim', last_name: 'Reese' }));
check('inner runs of whitespace collapse',
  eq(normalizeCustomerName('Mary   Jo', 'Smith'), { first_name: 'Mary Jo', last_name: 'Smith' }));

// --- against the live database, when one is handed in
const LIVE = process.argv[2];
if (LIVE) {
  const Database = require('/app/node_modules/better-sqlite3');
  const db = new Database(LIVE, { readonly: true });
  const rows = db.prepare('SELECT id, first_name, last_name, email FROM customers').all();
  const dupes = rows.filter(r => {
    const f = String(r.first_name || '').trim();
    const l = String(r.last_name || '').trim();
    return f && f.toLowerCase() === l.toLowerCase() && /\s/.test(f);
  });
  check('no customer still has a full name in both fields', dupes.length === 0,
        dupes.map(d => d.first_name).join(', '));

  const larry = rows.find(r => r.email === 'larryhutson7@yahoo.com');
  check('the known row is split', !!larry && larry.first_name === 'Larry' && larry.last_name === 'hutson',
        larry ? larry.first_name + ' | ' + larry.last_name : 'row missing');

  const keep = [['Cara Nashae', 'Kelley'], ['Brandi', 'Kay Hannon'], ['Kelsie', 'B McKeachnie']];
  for (const [f, l] of keep) {
    check('still present unchanged: ' + f + ' ' + l,
          rows.some(r => r.first_name === f && r.last_name === l));
  }
  check('no customer name has leading or trailing whitespace',
        rows.every(r => String(r.first_name || '') === String(r.first_name || '').trim() &&
                        String(r.last_name || '') === String(r.last_name || '').trim()));
  check('customer count unchanged at 91', rows.length === 91, rows.length);
}

console.log();
console.log('NAMES_FAILED=' + fails);
process.exit(fails ? 1 : 0);
