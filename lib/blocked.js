'use strict';
//
// Blocking a date is the only write in the R series that changes what a CUSTOMER can
// buy: routes/booking.js and lib/helpers.js both refuse a date that appears here, so a
// row inserted by mistake is a day of lost bookings that nothing will flag.
//
// It therefore gets the same care a booking write gets -- validation, a cap, and a look
// at what is already booked inside the range BEFORE anything is written -- in one place
// that every caller shares, rather than in whichever handler happened to need it.
//
// There were already two implementations when this was written. routes/office.js has a
// good one (scope-checked, validates, writes an audit row) and routes/api.js had a bare
// one that accepted whatever it was given, including a null date. api.js now calls this;
// office.js keeps its own because its audit wiring belongs to that router, and it is
// covered by tests/office-api.test.js. Worth collapsing one day, noted rather than done.
//
const { v4: uuid } = require('uuid');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A month and a half. Long enough for a unit away at inspection -- the real case in this
// database is ten days -- and short enough that a fat-fingered year cannot take the
// calendar out for a season before anyone notices.
const MAX_DAYS = 45;

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function expand(start, end) {
  const out = [];
  let d = start;
  while (d <= end && out.length <= MAX_DAYS) { out.push(d); d = addDays(d, 1); }
  return out;
}

// Returns { ok: true, dates } or { ok: false, error } -- never throws on input, because
// every caller of this is handling a request.
function plan({ start, end, equipment_id }, db) {
  if (!start || !ISO_DATE.test(start)) return { ok: false, error: 'start date (YYYY-MM-DD) is required' };
  const last = end || start;
  if (!ISO_DATE.test(last)) return { ok: false, error: 'end date must be YYYY-MM-DD' };
  if (last < start) return { ok: false, error: 'the end date is before the start date' };

  const dates = expand(start, last);
  if (dates.length > MAX_DAYS) {
    return { ok: false, error: 'that is more than ' + MAX_DAYS + ' days -- block it in shorter runs' };
  }
  if (equipment_id) {
    const eq = db.prepare('SELECT id FROM equipment WHERE id = ?').get(equipment_id);
    if (!eq) return { ok: false, error: 'unknown equipment_id' };
  }
  return { ok: true, dates };
}

// What is already booked inside the range. The caller shows this BEFORE writing: a block
// over a live booking is not refused -- the booking still exists and is still being
// delivered -- but it must not happen without the operator seeing it, because the day
// then looks unavailable to everyone else.
function bookingsInRange(db, start, end, equipment_id) {
  const rows = db.prepare(`
    SELECT b.id, b.booking_number, b.event_date, b.status,
           c.first_name, c.last_name,
           (SELECT GROUP_CONCAT(bi.item_name, ', ') FROM booking_items bi WHERE bi.booking_id = b.id) AS items
    FROM bookings b JOIN customers c ON c.id = b.customer_id
    WHERE b.status NOT IN ('cancelled', 'declined')
      AND b.event_date >= ? AND b.event_date <= ?
    ORDER BY b.event_date
  `).all(start, end || start);
  if (!equipment_id) return rows;
  return rows.filter((r) => db.prepare(
    'SELECT 1 FROM booking_items WHERE booking_id = ? AND equipment_id = ?'
  ).get(r.id, equipment_id));
}

// Idempotent per (date, equipment_id): blocking a day twice leaves one row, so a
// double-submit or an overlapping range cannot quietly double the table the way the 63
// rows in this database were accumulated.
function block(db, { start, end, reason, equipment_id }) {
  const p = plan({ start, end, equipment_id }, db);
  if (!p.ok) return p;
  const exists = db.prepare(
    'SELECT id FROM blocked_dates WHERE date = ? AND ((equipment_id IS NULL AND ? IS NULL) OR equipment_id = ?)'
  );
  const ins = db.prepare(
    'INSERT INTO blocked_dates (id, date, reason, equipment_id) VALUES (?, ?, ?, ?)'
  );
  const created = [];
  const txn = db.transaction(() => {
    for (const date of p.dates) {
      if (exists.get(date, equipment_id || null, equipment_id || null)) continue;
      const id = uuid();
      ins.run(id, date, reason || null, equipment_id || null);
      created.push(id);
    }
  });
  txn();
  return { ok: true, created, dates: p.dates };
}

function unblock(db, { start, end, equipment_id }) {
  const p = plan({ start, end, equipment_id }, db);
  if (!p.ok) return p;
  const del = db.prepare(
    'DELETE FROM blocked_dates WHERE date = ? AND ((equipment_id IS NULL AND ? IS NULL) OR equipment_id = ?)'
  );
  let removed = 0;
  const txn = db.transaction(() => {
    for (const date of p.dates) {
      removed += del.run(date, equipment_id || null, equipment_id || null).changes;
    }
  });
  txn();
  return { ok: true, removed, dates: p.dates };
}

module.exports = { plan, block, unblock, bookingsInRange, MAX_DAYS, ISO_DATE };
