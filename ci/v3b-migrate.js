#!/usr/bin/env node
/**
 * V3b data half: split the one customer row whose full name is in both name fields.
 *
 * Uses the SAME normalizeCustomerName() the write paths now use, so the migration and
 * the guard can never disagree about what counts as a duplicate.
 *
 * Idempotent: once split, the two fields differ and the row no longer matches.
 * Dry run by default; --apply to write. Nothing is deleted and no legitimate
 * multi-word name is touched.
 *
 *   node v3b-migrate.js /path/to/bounceman.db [--apply]
 */
const Database = require('/app/node_modules/better-sqlite3');
const { normalizeCustomerName } = require('/app/lib/helpers');

const DB_PATH = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!DB_PATH) { console.error('usage: v3b-migrate.js <db> [--apply]'); process.exit(2); }

const db = new Database(DB_PATH, { readonly: !APPLY });
const rows = db.prepare('SELECT id, first_name, last_name FROM customers').all();

const plan = [];
for (const r of rows) {
  const nm = normalizeCustomerName(r.first_name, r.last_name);
  if (nm.first_name !== (r.first_name || '') || nm.last_name !== (r.last_name || '')) {
    plan.push({ id: r.id, before: [r.first_name, r.last_name], after: [nm.first_name, nm.last_name] });
  }
}

console.log('customers        :', rows.length);
console.log('rows to change   :', plan.length);
console.log();
for (const p of plan) {
  console.log('  BEFORE first=' + JSON.stringify(p.before[0]) + ' last=' + JSON.stringify(p.before[1]));
  console.log('  AFTER  first=' + JSON.stringify(p.after[0]) + ' last=' + JSON.stringify(p.after[1]));
  console.log();
}

if (!APPLY) {
  console.log('DRY RUN -- nothing written. Re-run with --apply.');
  process.exit(0);
}

const tx = db.transaction((items) => {
  const upd = db.prepare(
    "UPDATE customers SET first_name = ?, last_name = ?, updated_at = datetime('now') WHERE id = ?"
  );
  for (const p of items) upd.run(p.after[0], p.after[1], p.id);
});
tx(plan);
console.log('APPLIED to ' + plan.length + ' row(s).');
