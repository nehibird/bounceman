// Recurring money that leaves the account on a schedule: storage rent, the loan
// repayment to Reagan, personal rent. Every one of them reduces what is safe to
// spend, but they are NOT all expenses:
//
//   expense    real business cost, books to the expenses table   (storage)
//   liability  repays a debt whose asset was already expensed    (Reagan's $200)
//   draw       owner's personal money leaving the business       (rent)
//
// Booking a liability repayment as an expense would expense the same $3,500 of
// inflatables twice over 18 months. Booking a draw as an expense would deduct a
// personal cost on a business return. Both are wrong, and both would still be
// wrong if they made safe-to-spend look better.
'use strict';

const crypto = require('crypto');

const KINDS = ['expense', 'liability', 'draw'];

function monthOf(date) {
  return String(date).slice(0, 7);
}

function addMonths(period, n) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function listActive(db) {
  return db.prepare('SELECT * FROM recurring_obligations WHERE active = 1 ORDER BY day_of_month, name').all();
}

function isPaid(db, obligationId, period) {
  return !!db.prepare('SELECT 1 FROM recurring_payments WHERE obligation_id = ? AND period = ?')
    .get(obligationId, period);
}

function inWindow(o, period) {
  if (o.start_month && period < o.start_month) return false;
  if (o.end_month && period > o.end_month) return false;
  return true;
}

// The earliest period this obligation still owes. Looks back two months so a
// genuinely missed payment keeps being reserved instead of silently vanishing,
// and forward one so paying this month's storage does not make safe-to-spend
// jump up right before next month's is due.
function nextUnpaidPeriod(db, o, today) {
  const cur = monthOf(today);
  for (let i = -2; i <= 1; i++) {
    const p = addMonths(cur, i);
    if (!inWindow(o, p)) continue;
    if (!isPaid(db, o.id, p)) return p;
  }
  return null;
}

// What every active obligation still owes, with enough detail for the dashboard
// to explain the number instead of just showing a smaller one.
function reserved(db, today) {
  const now = today || new Date().toISOString().slice(0, 10);
  const cur = monthOf(now);
  const day = Number(String(now).slice(8, 10));
  const items = [];
  let total = 0;

  for (const o of listActive(db)) {
    const period = nextUnpaidPeriod(db, o, now);
    if (!period) continue;
    const amount = Math.round((parseFloat(o.amount) || 0) * 100) / 100;
    const overdue = period < cur || (period === cur && day > o.day_of_month);
    items.push({
      id: o.id, name: o.name, kind: o.kind, amount, period,
      day_of_month: o.day_of_month, overdue,
      payment_method: o.payment_method || null
    });
    total += amount;
  }
  return { total: Math.round(total * 100) / 100, items };
}

// Record a payment. Only kind='expense' writes to the expenses table — see the
// note at the top of this file for why the other two must not.
function markPaid(db, obligationId, period, opts) {
  const o = db.prepare('SELECT * FROM recurring_obligations WHERE id = ?').get(obligationId);
  if (!o) throw new Error('No such obligation: ' + obligationId);
  if (isPaid(db, obligationId, period)) throw new Error(o.name + ' is already marked paid for ' + period);

  const options = opts || {};
  const paidDate = options.paid_date || new Date().toISOString().slice(0, 10);
  const amount = options.amount != null ? parseFloat(options.amount) : parseFloat(o.amount);
  let expenseId = null;

  const run = db.transaction(() => {
    if (o.kind === 'expense') {
      expenseId = crypto.randomUUID();
      db.prepare(`INSERT INTO expenses (id, date, category, vendor, description, amount, payment_method, notes)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(expenseId, paidDate, o.category || 'other', o.name,
          o.name + ' — ' + period, amount, options.payment_method || o.payment_method || null,
          'Recurring obligation ' + o.id + ' for ' + period);
    }
    db.prepare(`INSERT INTO recurring_payments (id, obligation_id, period, amount, paid_date, expense_id)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), obligationId, period, amount, paidDate, expenseId);
  });
  run();
  return { expenseId, amount, period };
}

// Remaining balance on a liability-kind obligation (the loan from Reagan).
function liabilityBalance(db, obligationId) {
  const o = db.prepare('SELECT * FROM recurring_obligations WHERE id = ?').get(obligationId);
  if (!o || o.kind !== 'liability') return null;
  const principal = parseFloat(o.principal) || 0;
  const paid = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM recurring_payments WHERE obligation_id = ?')
    .get(obligationId).s;
  return Math.round((principal - paid) * 100) / 100;
}

module.exports = { KINDS, reserved, markPaid, listActive, isPaid, nextUnpaidPeriod, liabilityBalance, addMonths, monthOf };
