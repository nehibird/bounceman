'use strict';
const express = require('express');
const router = express.Router();
const { v4: uuid } = require('uuid');
const { getDb } = require('../db');
const { requireOfficeKey, requireScope, auditAndIdempotency, rateLimitByMethod } = require('../middleware/office-auth');
const { getBookedEquipmentIds, validateBookingDate } = require('../lib/helpers');

// All office API responses are JSON, all dates are Central Time (matching lib/helpers'
// todayCT/validateBookingDate, which every date-touching route below defers to).
router.use(requireOfficeKey);
router.use(rateLimitByMethod);
router.use(auditAndIdempotency);

function clampLimit(raw, def, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

function pick(obj, fields) {
  const out = {};
  for (const f of fields) out[f] = obj[f];
  return out;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Body fields that are part of the office-API request envelope, not the resource being
// patched — never rejected as an "unknown field" on a whitelist check.
const META_FIELDS = new Set(['reason', 'dry_run']);

// ---------------------------------------------------------------------------
// GET /whoami
// ---------------------------------------------------------------------------
router.get('/whoami', (req, res) => {
  let scopes = [];
  try { scopes = JSON.parse(req.apiKey.scopes || '[]'); } catch (e) { /* malformed row, report empty */ }
  res.json({
    name: req.apiKey.name,
    key_prefix: req.apiKey.key_prefix,
    scopes,
    max_refund_cents: req.apiKey.max_refund_cents,
    daily_refund_cap_cents: req.apiKey.daily_refund_cap_cents,
  });
});

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------
function summarizeBooking(b, items) {
  return {
    booking_number: b.booking_number,
    status: b.status,
    event_date: b.event_date,
    event_end_date: b.event_end_date,
    event_start_time: b.event_start_time,
    event_end_time: b.event_end_time,
    customer: { first_name: b.first_name, last_name: b.last_name, email: b.email, phone: b.customer_phone },
    items: items.map((i) => ({
      item_name: i.item_name, quantity: i.quantity, unit_price: i.unit_price,
      total_price: i.total_price, duration_type: i.duration_type, wet_option: !!i.wet_option,
    })),
    total: b.total,
    deposit_amount: b.deposit_amount,
    balance_due: b.balance_due,
    payment_status: b.payment_status,
  };
}

router.get('/bookings', requireScope('bookings:read'), (req, res) => {
  const db = getDb();
  const { date, from, to, status, q } = req.query;
  const limit = clampLimit(req.query.limit, 100, 500);

  const clauses = [];
  const params = [];
  if (date) {
    if (!ISO_DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    clauses.push('b.event_date = ?'); params.push(date);
  }
  if (from) {
    if (!ISO_DATE_RE.test(from)) return res.status(400).json({ error: 'from must be YYYY-MM-DD' });
    clauses.push('b.event_date >= ?'); params.push(from);
  }
  if (to) {
    if (!ISO_DATE_RE.test(to)) return res.status(400).json({ error: 'to must be YYYY-MM-DD' });
    clauses.push('b.event_date <= ?'); params.push(to);
  }
  if (status) { clauses.push('b.status = ?'); params.push(status); }
  if (q) {
    const like = `%${String(q).trim()}%`;
    clauses.push("(b.booking_number LIKE ? OR (c.first_name || ' ' || c.last_name) LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)");
    params.push(like, like, like, like);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT b.*, c.first_name, c.last_name, c.email, c.phone AS customer_phone
    FROM bookings b JOIN customers c ON c.id = b.customer_id
    ${where}
    ORDER BY b.event_date DESC
    LIMIT ?
  `).all(...params, limit);

  const itemsByBooking = new Map();
  if (rows.length) {
    const placeholders = rows.map(() => '?').join(',');
    const items = db.prepare(`SELECT * FROM booking_items WHERE booking_id IN (${placeholders})`).all(...rows.map((r) => r.id));
    for (const item of items) {
      if (!itemsByBooking.has(item.booking_id)) itemsByBooking.set(item.booking_id, []);
      itemsByBooking.get(item.booking_id).push(item);
    }
  }

  const bookings = rows.map((b) => summarizeBooking(b, itemsByBooking.get(b.id) || []));
  res.json({ bookings, count: bookings.length });
});

function findBookingByNumber(db, bookingNumber) {
  return db.prepare(`
    SELECT b.*, c.first_name, c.last_name, c.email, c.phone AS customer_phone
    FROM bookings b JOIN customers c ON c.id = b.customer_id
    WHERE b.booking_number = ?
  `).get(String(bookingNumber || '').toUpperCase());
}

router.get('/bookings/:booking_number', requireScope('bookings:read'), (req, res) => {
  const db = getDb();
  const b = findBookingByNumber(db, req.params.booking_number);
  if (!b) return res.status(404).json({ error: 'booking not found' });

  const items = db.prepare('SELECT * FROM booking_items WHERE booking_id = ?').all(b.id);
  const payments = db.prepare('SELECT * FROM payments WHERE booking_id = ? ORDER BY created_at').all(b.id);
  const contract = db.prepare('SELECT signed, signed_at FROM contracts WHERE booking_id = ?').get(b.id);

  res.json({
    booking_number: b.booking_number,
    status: b.status,
    event_date: b.event_date,
    event_end_date: b.event_end_date,
    event_start_time: b.event_start_time,
    event_end_time: b.event_end_time,
    delivery_address: b.delivery_address,
    delivery_city: b.delivery_city,
    delivery_state: b.delivery_state,
    delivery_zip: b.delivery_zip,
    delivery_notes: b.delivery_notes,
    surface_type: b.surface_type,
    assigned_crew: b.assigned_crew,
    internal_notes: b.internal_notes,
    subtotal: b.subtotal,
    delivery_fee: b.delivery_fee,
    tax_amount: b.tax_amount,
    discount_amount: b.discount_amount,
    damage_waiver_fee: b.damage_waiver_fee,
    total: b.total,
    deposit_amount: b.deposit_amount,
    balance_due: b.balance_due,
    payment_status: b.payment_status,
    customer: { id: b.customer_id, first_name: b.first_name, last_name: b.last_name, email: b.email, phone: b.customer_phone },
    items,
    payments,
    contract_signed: !!(contract && contract.signed),
    contract_signed_at: contract ? contract.signed_at : null,
  });
});

const BOOKING_ALLOWED_FIELDS = [
  'event_date', 'event_start_time', 'event_end_time',
  'delivery_address', 'delivery_city', 'delivery_zip', 'delivery_notes',
  'surface_type', 'assigned_crew', 'status',
];
const BOOKING_STATUS_ENUM = new Set(['pending', 'confirmed', 'completed', 'cancelled', 'declined']);

router.patch('/bookings/:booking_number', requireScope('bookings:write'), (req, res) => {
  const db = getDb();
  const booking = db.prepare('SELECT * FROM bookings WHERE booking_number = ?').get(String(req.params.booking_number || '').toUpperCase());
  if (!booking) return res.status(404).json({ error: 'booking not found' });

  const bodyKeys = Object.keys(req.body || {}).filter((k) => !META_FIELDS.has(k));
  const unknown = bodyKeys.filter((k) => !BOOKING_ALLOWED_FIELDS.includes(k));
  if (unknown.length) return res.status(400).json({ error: `unknown field(s): ${unknown.join(', ')}` });

  if (Object.prototype.hasOwnProperty.call(req.body, 'status') && !BOOKING_STATUS_ENUM.has(req.body.status)) {
    return res.status(400).json({ error: `status must be one of: ${[...BOOKING_STATUS_ENUM].join(', ')}` });
  }

  const before = pick(booking, BOOKING_ALLOWED_FIELDS);
  const after = { ...before };
  for (const field of BOOKING_ALLOWED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) after[field] = req.body[field];
  }

  const dateChanged = Object.prototype.hasOwnProperty.call(req.body, 'event_date') && req.body.event_date !== booking.event_date;
  const conflicts = [];

  if (dateChanged) {
    const newDate = req.body.event_date;
    if (!ISO_DATE_RE.test(newDate)) return res.status(400).json({ error: 'event_date must be YYYY-MM-DD' });

    const items = db.prepare(`
      SELECT bi.equipment_id, bi.duration_type, e.name, e.quantity AS total_quantity
      FROM booking_items bi LEFT JOIN equipment e ON e.id = bi.equipment_id
      WHERE bi.booking_id = ? AND bi.equipment_id IS NOT NULL
    `).all(booking.id);
    const duration = items.length ? (items[0].duration_type || 'daily') : 'daily';
    const effStart = after.event_start_time || booking.event_start_time;
    const effEnd = after.event_end_time || booking.event_end_time;

    // Global/season blocks, Sunday half-day rule, lead time — same rules the website and
    // Sarah enforce on a new booking, reused here rather than re-implemented.
    const calendarIssue = validateBookingDate(db, newDate, { duration, startTime: effStart });
    if (calendarIssue) {
      conflicts.push({ type: 'calendar_rule', message: calendarIssue.error, requires_approval: !!calendarIssue.requires_approval });
    }

    // Excludes this booking's own current reservation from the count (see
    // lib/helpers.getBookedEquipmentIds) so moving a booking doesn't collide with itself.
    const bookedCounts = getBookedEquipmentIds(db, newDate, effStart, effEnd, duration, booking.id);
    for (const item of items) {
      const totalQty = item.total_quantity || 1;
      const bookedQty = bookedCounts.get(item.equipment_id) || 0;
      if (bookedQty >= totalQty) {
        conflicts.push({ type: 'equipment_unavailable', equipment_id: item.equipment_id, name: item.name, booked: bookedQty, quantity: totalQty });
      }
    }
  }

  if (conflicts.length) {
    return res.status(409).json({ error: 'availability conflict', conflicts });
  }

  if (req.body.dry_run) {
    return res.json({ dry_run: true, booking_number: booking.booking_number, before, after });
  }

  const setClauses = [];
  const params = [];
  for (const field of BOOKING_ALLOWED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      setClauses.push(`${field} = ?`);
      params.push(req.body[field]);
    }
  }
  if (!setClauses.length) return res.status(400).json({ error: 'no updatable fields provided' });

  params.push(booking.id);
  db.prepare(`UPDATE bookings SET ${setClauses.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...params);

  const freshBooking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
  const actualAfter = pick(freshBooking, BOOKING_ALLOWED_FIELDS);

  res.locals.audit = { entity_type: 'booking', entity_id: booking.booking_number, action: 'office_api_booking_update', before, after: actualAfter };
  res.json({ booking_number: booking.booking_number, before, after: actualAfter });
});

// POST /bookings/:booking_number/notes — appends, never overwrites, so any existing
// `stripe_session:cs_...` marker (parsed by routes/sarah.js's check-payment) survives.
router.post('/bookings/:booking_number/notes', requireScope('bookings:write'), (req, res) => {
  const db = getDb();
  const booking = db.prepare('SELECT * FROM bookings WHERE booking_number = ?').get(String(req.params.booking_number || '').toUpperCase());
  if (!booking) return res.status(404).json({ error: 'booking not found' });

  const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
  if (!note) return res.status(400).json({ error: 'note is required' });

  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
  const entry = `\n[${timestamp} CT] [office:${req.apiKey.name}] ${note}`;
  const before = booking.internal_notes;

  db.prepare("UPDATE bookings SET internal_notes = COALESCE(internal_notes, '') || ?, updated_at = datetime('now') WHERE id = ?")
    .run(entry, booking.id);
  const after = db.prepare('SELECT internal_notes FROM bookings WHERE id = ?').get(booking.id).internal_notes;

  res.locals.audit = {
    entity_type: 'booking', entity_id: booking.booking_number, action: 'office_api_booking_note',
    before: { internal_notes: before }, after: { internal_notes: after },
  };
  res.json({ booking_number: booking.booking_number, internal_notes: after });
});

// ---------------------------------------------------------------------------
// Availability / blocked dates
// ---------------------------------------------------------------------------
router.get('/availability', requireScope('availability:read'), (req, res) => {
  const db = getDb();
  const { date } = req.query;
  if (!date || !ISO_DATE_RE.test(date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });

  // Same three windows + helper calls Sarah's check-availability uses, so the two never
  // disagree about what "available" means for a given date.
  const globalBlock = db.prepare('SELECT reason FROM blocked_dates WHERE date = ? AND equipment_id IS NULL').get(date);
  const equipment = db.prepare("SELECT id, name, category, quantity, full_day_only FROM equipment WHERE status = 'available' ORDER BY sort_order").all();
  const bookedMorning = getBookedEquipmentIds(db, date, '09:00:00', '13:00:00', '4hr');
  const bookedAfternoon = getBookedEquipmentIds(db, date, '15:00:00', '19:00:00', '4hr');
  const bookedFullDay = getBookedEquipmentIds(db, date, '11:00:00', '19:00:00', 'daily');
  const perUnitBlocked = new Set(
    db.prepare('SELECT equipment_id FROM blocked_dates WHERE date = ? AND equipment_id IS NOT NULL').all(date).map((r) => r.equipment_id)
  );

  const units = equipment.map((e) => {
    const qty = e.quantity || 1;
    const morningBooked = bookedMorning.get(e.id) || 0;
    const afternoonBooked = bookedAfternoon.get(e.id) || 0;
    const fullDayBooked = bookedFullDay.get(e.id) || 0;
    return {
      equipment_id: e.id,
      name: e.name,
      category: e.category,
      quantity: qty,
      full_day_only: !!e.full_day_only,
      blocked: perUnitBlocked.has(e.id),
      morning: { booked: morningBooked, available: Math.max(0, qty - morningBooked) },
      afternoon: { booked: afternoonBooked, available: Math.max(0, qty - afternoonBooked) },
      full_day: { booked: fullDayBooked, available: Math.max(0, qty - fullDayBooked) },
    };
  });

  res.json({ date, blocked: !!globalBlock, blocked_reason: globalBlock ? globalBlock.reason : null, units });
});

router.post('/blocked-dates', requireScope('availability:write'), (req, res) => {
  const db = getDb();
  const { date, equipment_id, reason } = req.body;
  if (!date || !ISO_DATE_RE.test(date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
  if (equipment_id) {
    const eq = db.prepare('SELECT id FROM equipment WHERE id = ?').get(equipment_id);
    if (!eq) return res.status(400).json({ error: 'unknown equipment_id' });
  }

  const id = uuid();
  db.prepare('INSERT INTO blocked_dates (id, date, reason, equipment_id) VALUES (?, ?, ?, ?)').run(id, date, reason || null, equipment_id || null);
  const row = db.prepare('SELECT * FROM blocked_dates WHERE id = ?').get(id);

  res.locals.audit = { entity_type: 'blocked_date', entity_id: id, action: 'office_api_block_date', after: row };
  res.status(201).json(row);
});

router.delete('/blocked-dates/:id', requireScope('availability:write'), (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM blocked_dates WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });

  db.prepare('DELETE FROM blocked_dates WHERE id = ?').run(req.params.id);

  res.locals.audit = { entity_type: 'blocked_date', entity_id: req.params.id, action: 'office_api_unblock_date', before: row };
  res.json({ success: true, deleted: row });
});

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
router.get('/customers', requireScope('customers:read'), (req, res) => {
  const db = getDb();
  const q = String(req.query.q || '').trim();
  const limit = clampLimit(req.query.limit, 100, 500);

  const rows = q
    ? db.prepare(`
        SELECT * FROM customers
        WHERE first_name LIKE ? OR last_name LIKE ? OR (first_name || ' ' || last_name) LIKE ? OR email LIKE ? OR phone LIKE ?
        ORDER BY created_at DESC LIMIT ?
      `).all(...Array(5).fill(`%${q}%`), limit)
    : db.prepare('SELECT * FROM customers ORDER BY created_at DESC LIMIT ?').all(limit);

  res.json({ customers: rows, count: rows.length });
});

router.get('/customers/:id', requireScope('customers:read'), (req, res) => {
  const db = getDb();
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'customer not found' });

  const bookings = db.prepare(`
    SELECT booking_number, status, event_date, total, deposit_amount, balance_due, payment_status
    FROM bookings WHERE customer_id = ? ORDER BY event_date DESC
  `).all(customer.id);

  res.json({ ...customer, bookings });
});

const CUSTOMER_ALLOWED_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'address', 'city', 'state', 'zip', 'notes', 'tax_exempt'];

router.patch('/customers/:id', requireScope('customers:write'), (req, res) => {
  const db = getDb();
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'customer not found' });

  const bodyKeys = Object.keys(req.body || {}).filter((k) => !META_FIELDS.has(k));
  const unknown = bodyKeys.filter((k) => !CUSTOMER_ALLOWED_FIELDS.includes(k));
  if (unknown.length) return res.status(400).json({ error: `unknown field(s): ${unknown.join(', ')}` });

  const setClauses = [];
  const params = [];
  for (const field of CUSTOMER_ALLOWED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      setClauses.push(`${field} = ?`);
      params.push(field === 'tax_exempt' ? (req.body[field] ? 1 : 0) : req.body[field]);
    }
  }
  if (!setClauses.length) return res.status(400).json({ error: 'no updatable fields provided' });

  const before = pick(customer, CUSTOMER_ALLOWED_FIELDS);
  params.push(customer.id);
  db.prepare(`UPDATE customers SET ${setClauses.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...params);
  const freshCustomer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customer.id);
  const after = pick(freshCustomer, CUSTOMER_ALLOWED_FIELDS);

  res.locals.audit = { entity_type: 'customer', entity_id: customer.id, action: 'office_api_customer_update', before, after };
  res.json(freshCustomer);
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
router.get('/audit', requireScope('audit:read'), (req, res) => {
  const db = getDb();
  const { from, to } = req.query;
  const limit = clampLimit(req.query.limit, 100, 500);

  let sql = 'SELECT * FROM api_audit_log WHERE key_id = ?';
  const params = [req.apiKey.id];
  if (from) { sql += ' AND created_at >= ?'; params.push(from); }
  if (to) { sql += ' AND created_at <= ?'; params.push(to); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  res.json({ audit: rows, count: rows.length });
});

module.exports = router;
