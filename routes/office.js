'use strict';
const express = require('express');
const router = express.Router();
const { v4: uuid } = require('uuid');
const { getDb } = require('../db');
const {
  requireOfficeKey, requireScope, auditAndIdempotency, rateLimitByMethod, refundLimiter,
} = require('../middleware/office-auth');
const {
  getBookedEquipmentIds, validateBookingDate, todayCT, isoOffset, appendInternalNote,
} = require('../lib/helpers');
const { recordManualPayment } = require('../lib/payments');
const { parseCents, isValidEmail, isValidPhone, isValidTimeString, sanitizeDescription } = require('../lib/validation');
const { effectiveMaxRefundCents, effectiveDailyRefundCapCents, HARD_MAX_REFUND_CENTS } = require('../lib/refund-caps');
const stripeService = require('../services/stripe');
const smsService = require('../services/sms');

// All office API responses are JSON, all dates are Central Time (matching lib/helpers'
// todayCT/validateBookingDate, which every date-touching route below defers to).
router.use(requireOfficeKey);
router.use(rateLimitByMethod);
router.use(auditAndIdempotency);

// L4: every async route is wrapped so a rejected promise (a thrown error after an await —
// e.g. the notes UPDATE failing after a Stripe call succeeded) becomes a 500 JSON
// response instead of an unhandled rejection that can hang the request or crash the
// process on modern Node.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

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
const META_FIELDS = new Set(['reason', 'dry_run', 'override_unpaid']);

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
    max_refund_cents: effectiveMaxRefundCents(req.apiKey.max_refund_cents),
    daily_refund_cap_cents: effectiveDailyRefundCapCents(req.apiKey.daily_refund_cap_cents),
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
    payments: payments.map(serializePayment),
    contract_signed: !!(contract && contract.signed),
    contract_signed_at: contract ? contract.signed_at : null,
  });
});

const BOOKING_ALLOWED_FIELDS = [
  'event_date', 'event_end_date', 'event_start_time', 'event_end_time',
  'delivery_address', 'delivery_city', 'delivery_zip', 'delivery_notes',
  'surface_type', 'assigned_crew', 'status',
];
const BOOKING_STATUS_ENUM = new Set(['pending', 'confirmed', 'completed', 'cancelled', 'declined']);
const BOOKING_DATE_FIELDS = new Set(['event_date', 'event_end_date']);
const BOOKING_TIME_FIELDS = new Set(['event_start_time', 'event_end_time']);
const BOOKING_PLAIN_STRING_FIELDS = new Set(['delivery_address', 'delivery_city', 'delivery_zip', 'delivery_notes', 'surface_type', 'assigned_crew']);

// M5: a booking status transition table — the office API can move a booking forward
// through its normal lifecycle, but completed/cancelled/declined are terminal here (a
// human uses the admin UI for anything more exotic; those are edge cases with side
// effects like refunds and hold releases this API doesn't perform).
const STATUS_TRANSITIONS = {
  pending: new Set(['confirmed', 'cancelled', 'declined']),
  confirmed: new Set(['cancelled', 'completed']),
  completed: new Set(),
  cancelled: new Set(),
  declined: new Set(),
};

function normalizeTimeForCompare(t) {
  if (!t) return null;
  return t.length === 5 ? `${t}:00` : t;
}

// Enumerates YYYY-MM-DD dates from start to end, inclusive. Guarded against a runaway
// loop (e.g. a caller-supplied end date centuries out) — 400 days covers any legitimate
// rental range with room to spare.
function enumerateDates(startDate, endDate) {
  const dates = [];
  let d = startDate;
  let guard = 0;
  while (d <= endDate && guard < 400) {
    dates.push(d);
    if (d === endDate) break;
    d = isoOffset(d, 1);
    guard++;
  }
  return dates;
}

router.patch('/bookings/:booking_number', requireScope('bookings:write'), (req, res) => {
  const db = getDb();
  const booking = db.prepare('SELECT * FROM bookings WHERE booking_number = ?').get(String(req.params.booking_number || '').toUpperCase());
  if (!booking) return res.status(404).json({ error: 'booking not found' });

  const bodyKeys = Object.keys(req.body || {}).filter((k) => !META_FIELDS.has(k));
  const unknown = bodyKeys.filter((k) => !BOOKING_ALLOWED_FIELDS.includes(k));
  if (unknown.length) return res.status(400).json({ error: `unknown field(s): ${unknown.join(', ')}` });

  // L3: type-check every field before it ever reaches SQL.
  for (const field of bodyKeys) {
    const val = req.body[field];
    if (field === 'status') {
      if (!BOOKING_STATUS_ENUM.has(val)) return res.status(400).json({ error: `status must be one of: ${[...BOOKING_STATUS_ENUM].join(', ')}` });
      continue;
    }
    if (field === 'event_end_date' && val === null) continue; // explicit clear of a multi-day range
    if (BOOKING_DATE_FIELDS.has(field)) {
      if (typeof val !== 'string' || !ISO_DATE_RE.test(val)) return res.status(400).json({ error: `${field} must be YYYY-MM-DD` });
      continue;
    }
    if (BOOKING_TIME_FIELDS.has(field)) {
      if (!isValidTimeString(val)) return res.status(400).json({ error: `${field} must be HH:MM or HH:MM:SS` });
      continue;
    }
    if (BOOKING_PLAIN_STRING_FIELDS.has(field) && typeof val !== 'string') {
      return res.status(400).json({ error: `${field} must be a string` });
    }
  }

  // M5: status transitions
  let statusOverrideNote = null;
  if (Object.prototype.hasOwnProperty.call(req.body, 'status') && req.body.status !== booking.status) {
    const allowed = STATUS_TRANSITIONS[booking.status] || new Set();
    if (!allowed.has(req.body.status)) {
      return res.status(409).json({ error: `cannot transition booking from ${booking.status} to ${req.body.status}` });
    }
    if (req.body.status === 'confirmed' && booking.status === 'pending' && !booking.deposit_paid) {
      if (!req.body.override_unpaid) {
        return res.status(409).json({
          error: 'cannot confirm a booking with no deposit paid — pass override_unpaid:true to override',
          deposit_paid: false,
        });
      }
      statusOverrideNote = 'confirmed with override_unpaid:true (no deposit on file)';
    }
  }

  const before = pick(booking, BOOKING_ALLOWED_FIELDS);
  const after = { ...before };
  for (const field of BOOKING_ALLOWED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) after[field] = req.body[field];
  }

  const dateChanged = Object.prototype.hasOwnProperty.call(req.body, 'event_date') && req.body.event_date !== booking.event_date;
  const endDateProvided = Object.prototype.hasOwnProperty.call(req.body, 'event_end_date');

  // H5: moving a multi-day booking's start date must shift its end date by the same
  // offset when the caller didn't also supply a new end — otherwise the end can be left
  // BEFORE the new start, which makes getBookedEquipmentIds treat the moved booking as
  // not occupying its own new dates at all (opening the door to a double booking).
  if (dateChanged && !endDateProvided && booking.event_end_date && booking.event_end_date !== booking.event_date) {
    const oldStart = new Date(`${booking.event_date}T12:00:00`);
    const oldEnd = new Date(`${booking.event_end_date}T12:00:00`);
    const offsetDays = Math.round((oldEnd - oldStart) / 86400000);
    after.event_end_date = isoOffset(after.event_date, offsetDays);
  }

  const newStart = after.event_date;
  const newEnd = after.event_end_date || newStart;
  if (newEnd < newStart) {
    return res.status(400).json({ error: 'event_end_date cannot be before event_date' });
  }
  if (newEnd === newStart && after.event_start_time && after.event_end_time) {
    if (normalizeTimeForCompare(after.event_end_time) <= normalizeTimeForCompare(after.event_start_time)) {
      return res.status(400).json({ error: 'event_end_time must be after event_start_time' });
    }
  }

  const relevantFieldsChanged = ['event_date', 'event_end_date', 'event_start_time', 'event_end_time']
    .some((f) => Object.prototype.hasOwnProperty.call(req.body, f)) || (dateChanged && !endDateProvided);

  const conflicts = [];
  if (relevantFieldsChanged) {
    if (dateChanged) {
      const items0 = db.prepare(`
        SELECT bi.duration_type FROM booking_items bi WHERE bi.booking_id = ? AND bi.equipment_id IS NOT NULL LIMIT 1
      `).get(booking.id);
      const calendarIssue = validateBookingDate(db, newStart, { duration: items0 ? items0.duration_type : 'daily', startTime: after.event_start_time });
      if (calendarIssue) {
        conflicts.push({ type: 'calendar_rule', message: calendarIssue.error, requires_approval: !!calendarIssue.requires_approval });
      }
    }

    const items = db.prepare(`
      SELECT bi.equipment_id, bi.duration_type, e.name, e.quantity AS total_quantity
      FROM booking_items bi LEFT JOIN equipment e ON e.id = bi.equipment_id
      WHERE bi.booking_id = ? AND bi.equipment_id IS NOT NULL
    `).all(booking.id);
    const duration = items.length ? (items[0].duration_type || 'daily') : 'daily';

    // H5: check EVERY day in the (possibly multi-day) new range, not just the new start
    // date — a time-only change or an end-date move must be conflict-checked too.
    const dateList = enumerateDates(newStart, newEnd);
    const worstBookedByEquipment = new Map();
    for (const day of dateList) {
      let winStart = after.event_start_time;
      let winEnd = after.event_end_time;
      if (dateList.length > 1) {
        if (day === newStart) winEnd = '23:59:59';
        else if (day === newEnd) winStart = '00:00';
        else { winStart = '00:00'; winEnd = '23:59:59'; }
      }
      const bookedCounts = getBookedEquipmentIds(db, day, winStart, winEnd, duration, booking.id);
      for (const item of items) {
        const bookedQty = bookedCounts.get(item.equipment_id) || 0;
        const worst = worstBookedByEquipment.get(item.equipment_id) || 0;
        if (bookedQty > worst) worstBookedByEquipment.set(item.equipment_id, bookedQty);
      }
    }
    for (const item of items) {
      const totalQty = item.total_quantity || 1;
      const bookedQty = worstBookedByEquipment.get(item.equipment_id) || 0;
      if (bookedQty >= totalQty) {
        conflicts.push({ type: 'equipment_unavailable', equipment_id: item.equipment_id, name: item.name, booked: bookedQty, quantity: totalQty });
      }
    }
  }

  if (conflicts.length) {
    return res.status(409).json({ error: 'availability conflict', conflicts });
  }

  // H5: dates moving are price-affecting (Sunday rules, extra-day rates, delivery fee) —
  // this endpoint never silently re-prices. It flags the response so the caller knows a
  // human/re-quote step is needed, and leaves a note on the booking either way.
  const datesChanged = dateChanged || (endDateProvided && after.event_end_date !== booking.event_end_date);

  if (req.body.dry_run) {
    return res.json({ dry_run: true, booking_number: booking.booking_number, before, after, reprice_needed: datesChanged || undefined });
  }

  const setClauses = [];
  const params = [];
  for (const field of BOOKING_ALLOWED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(req.body, field) || (field === 'event_end_date' && after.event_end_date !== before.event_end_date)) {
      setClauses.push(`${field} = ?`);
      params.push(after[field]);
    }
  }
  if (!setClauses.length) return res.status(400).json({ error: 'no updatable fields provided' });

  params.push(booking.id);
  db.prepare(`UPDATE bookings SET ${setClauses.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...params);

  if (datesChanged) {
    appendInternalNote(db, booking.id, `office:${req.apiKey.name}`,
      `moved dates ${before.event_date}${before.event_end_date ? '–' + before.event_end_date : ''} -> ${after.event_date}${after.event_end_date ? '–' + after.event_end_date : ''} (reprice needed)`);
  }
  if (statusOverrideNote) {
    appendInternalNote(db, booking.id, `office:${req.apiKey.name}`, statusOverrideNote);
  }

  const freshBooking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
  const actualAfter = pick(freshBooking, BOOKING_ALLOWED_FIELDS);

  res.locals.audit = { entity_type: 'booking', entity_id: booking.booking_number, action: 'office_api_booking_update', before, after: actualAfter };
  res.json({ booking_number: booking.booking_number, before, after: actualAfter, reprice_needed: datesChanged || undefined });
});

// POST /bookings/:booking_number/notes — appends, never overwrites, so any existing
// `stripe_session:cs_...` marker (parsed by routes/sarah.js's check-payment) survives.
router.post('/bookings/:booking_number/notes', requireScope('bookings:write'), (req, res) => {
  const db = getDb();
  const booking = db.prepare('SELECT * FROM bookings WHERE booking_number = ?').get(String(req.params.booking_number || '').toUpperCase());
  if (!booking) return res.status(404).json({ error: 'booking not found' });

  const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
  if (!note) return res.status(400).json({ error: 'note is required' });

  const before = booking.internal_notes;
  const after = appendInternalNote(db, booking.id, `office:${req.apiKey.name}`, note);

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
// M6: an office assistant needs enough to identify and contact a customer and know their
// tax-exempt status — never ad-attribution/UTM/click-id fields, the tax-exempt cert
// itself, lifetime revenue, or free-text notes.
const CUSTOMER_RESPONSE_FIELDS = [
  'id', 'first_name', 'last_name', 'email', 'phone',
  'address', 'city', 'state', 'zip', 'tax_exempt',
  'total_bookings', 'created_at', 'updated_at',
];

router.get('/customers', requireScope('customers:read'), (req, res) => {
  const db = getDb();
  const q = String(req.query.q || '').trim();
  // M6: unfiltered listing is capped hard at 25 (browsing everyone is not a legitimate
  // office-assistant use case); a search query may return up to 100.
  const limit = q ? clampLimit(req.query.limit, 25, 100) : clampLimit(req.query.limit, 25, 25);

  const rows = q
    ? db.prepare(`
        SELECT * FROM customers
        WHERE first_name LIKE ? OR last_name LIKE ? OR (first_name || ' ' || last_name) LIKE ? OR email LIKE ? OR phone LIKE ?
        ORDER BY created_at DESC LIMIT ?
      `).all(...Array(5).fill(`%${q}%`), limit)
    : db.prepare('SELECT * FROM customers ORDER BY created_at DESC LIMIT ?').all(limit);

  res.json({ customers: rows.map((c) => pick(c, CUSTOMER_RESPONSE_FIELDS)), count: rows.length });
});

router.get('/customers/:id', requireScope('customers:read'), (req, res) => {
  const db = getDb();
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'customer not found' });

  const bookings = db.prepare(`
    SELECT booking_number, status, event_date, total, deposit_amount, balance_due, payment_status
    FROM bookings WHERE customer_id = ? ORDER BY event_date DESC
  `).all(customer.id);

  res.json({ ...pick(customer, CUSTOMER_RESPONSE_FIELDS), bookings });
});

const CUSTOMER_ALLOWED_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'address', 'city', 'state', 'zip', 'notes', 'tax_exempt'];

router.patch('/customers/:id', requireScope('customers:write'), (req, res) => {
  const db = getDb();
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'customer not found' });

  const bodyKeys = Object.keys(req.body || {}).filter((k) => !META_FIELDS.has(k));
  const unknown = bodyKeys.filter((k) => !CUSTOMER_ALLOWED_FIELDS.includes(k));
  if (unknown.length) return res.status(400).json({ error: `unknown field(s): ${unknown.join(', ')}` });

  // L3
  if (Object.prototype.hasOwnProperty.call(req.body, 'email') && req.body.email && !isValidEmail(req.body.email)) {
    return res.status(400).json({ error: 'email is not a valid address' });
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'phone') && req.body.phone && !isValidPhone(req.body.phone)) {
    return res.status(400).json({ error: 'phone must be a 10-digit US number' });
  }
  for (const field of ['first_name', 'last_name', 'address', 'city', 'state', 'zip', 'notes']) {
    if (Object.prototype.hasOwnProperty.call(req.body, field) && typeof req.body[field] !== 'string') {
      return res.status(400).json({ error: `${field} must be a string` });
    }
  }

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
  res.json(pick(freshCustomer, CUSTOMER_RESPONSE_FIELDS));
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

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
// M6: never expose card_last4/card_brand or raw Stripe object ids — the refund endpoint
// takes the internal `id` (payment_id), never a Stripe id, so there's nothing here Sarah
// legitimately needs beyond what a refund decision requires.
const PAYMENT_RESPONSE_FIELDS = ['id', 'amount', 'payment_type', 'payment_method', 'status', 'refund_amount', 'notes', 'created_at'];

function serializePayment(p) {
  const isStripe = !!(p.stripe_payment_id || p.stripe_charge_id);
  const refundableCents = isStripe ? Math.max(0, Math.round(((p.amount || 0) - (p.refund_amount || 0)) * 100)) : null;
  return { ...pick(p, PAYMENT_RESPONSE_FIELDS), is_stripe_payment: isStripe, refundable_cents: refundableCents };
}

router.get('/bookings/:booking_number/payments', requireScope('payments:read'), (req, res) => {
  const db = getDb();
  const booking = findBookingByNumber(db, req.params.booking_number);
  if (!booking) return res.status(404).json({ error: 'booking not found' });

  const payments = db.prepare('SELECT * FROM payments WHERE booking_id = ? ORDER BY created_at').all(booking.id);
  res.json({ booking_number: booking.booking_number, payments: payments.map(serializePayment) });
});

const MANUAL_PAYMENT_METHODS = new Set(['cash', 'check', 'cashapp', 'venmo', 'zelle', 'card_offline']);
const MAX_MANUAL_PAYMENT_CENTS = HARD_MAX_REFUND_CENTS * 20; // $10,000 sanity ceiling — a bigger figure belongs in accounting, not a phone-collected cash/check record

// Records money that already changed hands OFFLINE (cash in an envelope, a Venmo
// transfer, etc) — this endpoint never touches Stripe or a card. notify defaults to
// false so a backfilled/historical payment doesn't retroactively text or email the
// customer; pass notify:true for a payment recorded live, at drop-off.
//
// H4: takes amount_cents (integer cents), matching refunds/payment-links — a legacy
// `amount` (dollars) field is rejected outright rather than silently accepted, so an
// LLM caller can never confuse the two units and be off by 100x.
router.post('/bookings/:booking_number/payments', requireScope('payments:record'), (req, res) => {
  const db = getDb();
  const booking = findBookingByNumber(db, req.params.booking_number);
  if (!booking) return res.status(404).json({ error: 'booking not found' });

  if (Object.prototype.hasOwnProperty.call(req.body, 'amount')) {
    return res.status(400).json({ error: 'this endpoint takes amount_cents (integer cents), not amount — convert dollars to cents' });
  }

  const { payment_method, notes, notify } = req.body;
  if (!MANUAL_PAYMENT_METHODS.has(payment_method)) {
    return res.status(400).json({ error: `payment_method must be one of: ${[...MANUAL_PAYMENT_METHODS].join(', ')}` });
  }

  const amountCents = parseCents(req.body.amount_cents, { max: MAX_MANUAL_PAYMENT_CENTS });
  if (amountCents === null) {
    return res.status(400).json({ error: `amount_cents must be a positive integer number of cents, no more than ${MAX_MANUAL_PAYMENT_CENTS}` });
  }
  const amountDollarsStr = (amountCents / 100).toFixed(2);

  let result;
  try {
    result = recordManualPayment(db, {
      bookingId: booking.id, amount: amountDollarsStr, paymentMethod: payment_method, notes,
      actor: req.apiKey.name, notifySlack: !!notify, sendConfirmationEmail: !!notify,
    });
  } catch (err) {
    if (err.code === 'INVALID_AMOUNT') return res.status(400).json({ error: 'amount_cents must be > 0' });
    throw err;
  }

  res.locals.audit = {
    entity_type: 'booking', entity_id: booking.booking_number, action: 'office_api_payment_record',
    after: { payment_id: result.paymentId, amount_cents: amountCents, payment_method, new_balance: result.newBalance, new_status: result.newStatus },
    amount_cents: amountCents,
  };
  res.status(201).json({
    payment_id: result.paymentId,
    booking_number: booking.booking_number,
    amount_cents: amountCents,
    payment_method,
    new_balance: result.newBalance,
    new_status: result.newStatus,
    card_charged: false, // this is a manual/offline record — no card was ever charged
  });
});

// Creates a Stripe Checkout link for an amount (balance due by default) and optionally
// texts it to the customer. Doesn't touch internal_notes' stripe_session:cs_... marker
// (that's the DEPOSIT session routes/sarah.js's check-payment parses) — it appends a
// separate, differently-worded note line so the two can never be confused.
const MAX_PAYMENT_LINK_CENTS = 1000000; // $10,000.00 hard ceiling, independent of balance_due
router.post('/bookings/:booking_number/payment-link', requireScope('payments:link'), asyncHandler(async (req, res) => {
  const db = getDb();
  const booking = findBookingByNumber(db, req.params.booking_number);
  if (!booking) return res.status(404).json({ error: 'booking not found' });
  // M3: refuse links on a booking that's already done, cancelled, or declined.
  if (booking.status === 'cancelled' || booking.status === 'declined' || booking.status === 'completed') {
    return res.status(400).json({ error: `cannot create a payment link for a ${booking.status} booking` });
  }

  const balanceDueCents = Math.max(0, Math.round((parseFloat(booking.balance_due) || 0) * 100));
  const allowOverpay = req.body.allow_overpay === true;

  let amountCents;
  if (req.body.amount_cents !== undefined) {
    amountCents = parseCents(req.body.amount_cents, { max: MAX_PAYMENT_LINK_CENTS });
    if (amountCents === null) {
      return res.status(400).json({ error: `amount_cents must be a positive integer number of cents, no more than ${MAX_PAYMENT_LINK_CENTS}` });
    }
  } else {
    amountCents = balanceDueCents;
    if (amountCents <= 0) {
      return res.status(400).json({ error: 'amount_cents must be a positive integer (this booking has no balance due — pass amount_cents for a custom amount)' });
    }
  }

  // M2: a link can never collect more than the balance due unless the caller explicitly
  // opts in and records why (a tip, a deposit top-up ahead of adding equipment, etc).
  let overpayReason = null;
  if (amountCents > balanceDueCents) {
    if (!allowOverpay) {
      return res.status(400).json({
        error: 'amount_cents exceeds the balance due — pass allow_overpay:true and overpay_reason to override',
        balance_due_cents: balanceDueCents,
      });
    }
    overpayReason = typeof req.body.overpay_reason === 'string' ? req.body.overpay_reason.trim() : '';
    if (!overpayReason) return res.status(400).json({ error: 'overpay_reason is required when allow_overpay is true' });
  }

  const sendSms = !!req.body.send_sms;
  const description = sanitizeDescription(req.body.description);
  if (req.body.dry_run) {
    return res.json({
      dry_run: true, booking_number: booking.booking_number, amount_cents: amountCents,
      balance_due_cents: balanceDueCents, overpay_reason: overpayReason, description: description || null, send_sms: sendSms,
    });
  }

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(booking.customer_id);
  // Same base as routes/booking.js's own pay routes — not EVENT_BASE_URL (that's for the
  // walk-up event flow and has nothing to do with a booking's pay pages).
  const baseUrl = process.env.BASE_URL || 'https://bouncemanrentals.com';
  const expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // M2: 24h expiry

  let session;
  try {
    session = await stripeService.createPaymentLink({
      bookingId: booking.id,
      bookingNumber: booking.booking_number,
      amountCents,
      customerEmail: (customer && customer.email) || undefined,
      description,
      metadata: { api_key: req.apiKey.name },
      idempotencyKey: `office-link-${req.apiKey.id}-${req.idempotencyKey}`,
      expiresAt,
      // /pay/:num/success self-records whatever session.amount_total actually was
      // (dedup on the payment intent, same key the checkout.session.completed webhook
      // uses) — unlike GET /booking/lookup, which ignores its own query string and
      // shows an empty "check your booking" form with no recording at all. A payment
      // link's amount is arbitrary (not necessarily the deposit or the full balance),
      // so it needs a success page that records exactly what was paid, not one that
      // assumes a fixed amount or does nothing.
      successUrl: `${baseUrl}/booking/pay/${booking.booking_number}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${baseUrl}/booking/pay/${booking.booking_number}/cancel`,
    });
  } catch (err) {
    console.error('[OFFICE API] createPaymentLink failed:', err.message);
    return res.status(502).json({ error: `Stripe error: ${err.message}` });
  }

  const noteText = `payment link created for $${(amountCents / 100).toFixed(2)} (checkout session ${session.id})`
    + (overpayReason ? ` [overpay: ${overpayReason}]` : '');
  appendInternalNote(db, booking.id, `office:${req.apiKey.name}`, noteText);

  let smsSent = false;
  if (sendSms && customer && customer.phone) {
    try {
      await smsService.sendSms(customer.phone, `Bounce Man payment link for booking #${booking.booking_number}: ${session.url}`);
      smsSent = true;
    } catch (err) {
      console.error('[OFFICE API] payment-link SMS failed:', err.message);
    }
  }

  res.locals.audit = {
    entity_type: 'booking', entity_id: booking.booking_number, action: 'office_api_payment_link',
    after: { session_id: session.id, amount_cents: amountCents, sms_sent: smsSent },
    amount_cents: amountCents,
    stripe_object_id: session.id,
  };
  res.status(201).json({ url: session.url, session_id: session.id, amount_cents: amountCents, sms_sent: smsSent });
}));

// ---------------------------------------------------------------------------
// Refunds (C1) — see docs/office-api.md for the full reservation-ledger design.
//
// The refundable-balance rule (across ALL keys — the ledger sums below are scoped only
// by payment_id, never by key_id, because a payment can only be refunded once no matter
// which key initiates it):
//
//   confirmed_cents = MAX(webhook-recorded refund_amount,
//                         live Stripe amount_refunded (C1.4, best-effort),
//                         sum of SUCCEEDED office_refunds rows for this payment)
//   reserved_cents  = confirmed_cents + sum of PENDING/NEEDS_REVIEW office_refunds rows
//   refundable_cents = captured_cents - reserved_cents
//
// Confirmed sources (webhook / live Stripe / succeeded ledger rows) are combined with
// MAX, not summed — they describe the same already-happened money from different
// vantage points, and summing them would double-count a refund this ledger itself made
// once Stripe's webhook (or a live lookup) independently confirms it. PENDING and
// NEEDS_REVIEW rows are added on top unconditionally: this is deliberately conservative
// (a crashed-but-actually-refunded pending row can be double-counted against the
// remainder) so that an unresolved reservation fails safe — never granting more
// headroom — until scripts/reconcile-office-refunds.js resolves it one way or the other.
// ---------------------------------------------------------------------------

// L8: bounded scan (last 2 days is more than enough to cover any UTC/CT boundary) plus
// exact Central-time day comparison in JS, matching lib/helpers.todayCT's own clock.
function sumTodaysReservedCentsCT(db, keyId) {
  const today = todayCT();
  const rows = db.prepare(`
    SELECT amount_cents, created_at FROM office_refunds
    WHERE key_id = ? AND status IN ('pending', 'succeeded', 'needs_review')
      AND created_at >= datetime('now', '-2 days')
  `).all(keyId);
  let sum = 0;
  for (const row of rows) {
    const ctDate = new Date(`${row.created_at}Z`).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    if (ctDate === today) sum += row.amount_cents;
  }
  return sum;
}

// Scoped by payment_id only (never key_id) — every key's succeeded refunds on this
// payment are money that's actually gone out the door, regardless of which key sent it.
function sumSucceededCentsForPayment(db, paymentId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) s FROM office_refunds
    WHERE payment_id = ? AND status = 'succeeded'
  `).get(paymentId);
  return row.s || 0;
}

// Also scoped by payment_id only, across all keys — an in-flight reservation from ANY
// key reserves against the same payment's shared balance.
function sumPendingOrNeedsReviewCentsForPayment(db, paymentId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) s FROM office_refunds
    WHERE payment_id = ? AND status IN ('pending', 'needs_review')
  `).get(paymentId);
  return row.s || 0;
}

// liveRefundedCents: the amount_refunded fetched live from Stripe just before this call
// (services/stripe.js's getLiveRefundedCents), or null/undefined if that lookup wasn't
// made or failed — never awaited inside here, so this stays synchronous and safe to call
// inside reserveRefund's transaction.
function computeRefundLimits(db, key, payment, liveRefundedCents) {
  const maxRefundCents = effectiveMaxRefundCents(key.max_refund_cents);
  const dailyCapCents = effectiveDailyRefundCapCents(key.daily_refund_cap_cents);
  const alreadyTodayCents = sumTodaysReservedCentsCT(db, key.id);

  const webhookRefundedCents = Math.round((payment.refund_amount || 0) * 100);
  const succeededLedgerCents = sumSucceededCentsForPayment(db, payment.id);
  const pendingOrReviewLedgerCents = sumPendingOrNeedsReviewCentsForPayment(db, payment.id);

  const confirmedCandidates = [webhookRefundedCents, succeededLedgerCents];
  if (typeof liveRefundedCents === 'number' && Number.isFinite(liveRefundedCents)) {
    confirmedCandidates.push(liveRefundedCents);
  }
  const confirmedCents = Math.max(...confirmedCandidates);

  const reservedCents = confirmedCents + pendingOrReviewLedgerCents;
  const capturedCents = Math.round((payment.amount || 0) * 100);
  const refundableCents = capturedCents - reservedCents;
  return { maxRefundCents, dailyCapCents, alreadyTodayCents, refundableCents };
}

// C1: everything that decides whether a refund is ALLOWED, plus the ledger INSERT that
// reserves it, happens inside one synchronous better-sqlite3 transaction — better-sqlite3
// runs transactions fully synchronously, so no other request's reservation can interleave
// mid-check even though the rest of this route handler is async and awaits Stripe. This is
// what makes the per-key caps and the refundable-remainder check hold under real
// concurrency, not just when calls happen to be serialized.
function reserveRefund(db, { key, booking, payment, amountCents, idempotencyKey, requestHash, reason, confirmedBy, liveRefundedCents }) {
  const attempt = db.transaction(() => {
    const limits = computeRefundLimits(db, key, payment, liveRefundedCents);

    // Data-integrity check first (can this payment even cover the amount), then
    // per-key policy caps — mirrors dry_run's own preview ordering.
    if (amountCents > limits.refundableCents) {
      return { ok: false, status: 400, body: { error: 'amount_cents exceeds the refundable remainder', refundable_cents: limits.refundableCents } };
    }
    if (amountCents > limits.maxRefundCents) {
      return { ok: false, status: 403, body: { error: "amount exceeds this key's max_refund_cents limit", max_refund_cents: limits.maxRefundCents } };
    }
    if (limits.alreadyTodayCents + amountCents > limits.dailyCapCents) {
      return {
        ok: false, status: 403,
        body: {
          error: "this refund would exceed the key's daily_refund_cap_cents",
          daily_refund_cap_cents: limits.dailyCapCents,
          already_refunded_today_cents: limits.alreadyTodayCents,
        },
      };
    }

    const id = uuid();
    db.prepare(`INSERT INTO office_refunds
      (id, key_id, key_name, idempotency_key, request_hash, booking_id, payment_id, amount_cents, status, confirmed_by, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, datetime('now'), datetime('now'))`).run(
      id, key.id, key.name, idempotencyKey, requestHash, booking.id, payment.id, amountCents, confirmedBy, reason);

    return { ok: true, ledgerId: id, limits };
  });

  try {
    return attempt();
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE constraint failed')) {
      return { ok: false, status: 409, body: { error: 'a refund reservation already exists for this idempotency key' } };
    }
    throw err;
  }
}

// Finalizing to 'failed' also frees the reservation's idempotency_key (renamed off to
// the side, same convention as middleware/office-auth.js's audit-log handling) so a
// retry with the SAME Idempotency-Key can reserve fresh instead of hitting the
// UNIQUE(key_id, idempotency_key) index of the now-dead attempt.
function finalizeRefundLedger(db, ledgerId, { status, stripeRefundId = null, stripeStatus = null, error = null }) {
  if (status === 'failed') {
    db.prepare(`UPDATE office_refunds SET status = ?, stripe_refund_id = ?, stripe_status = ?, error = ?,
      idempotency_key = idempotency_key || ':failed:' || id, updated_at = datetime('now')
      WHERE id = ? AND status = 'pending'`).run(status, stripeRefundId, stripeStatus, error, ledgerId);
    return;
  }
  db.prepare("UPDATE office_refunds SET status = ?, stripe_refund_id = ?, stripe_status = ?, error = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, stripeRefundId, stripeStatus, error, ledgerId);
}

router.post('/bookings/:booking_number/refunds', requireScope('refunds:create'), refundLimiter, asyncHandler(async (req, res) => {
  const db = getDb();
  const booking = findBookingByNumber(db, req.params.booking_number);
  if (!booking) return res.status(404).json({ error: 'booking not found' });

  const confirmedBy = typeof req.body.confirmed_by === 'string' ? req.body.confirmed_by.trim() : '';
  if (!confirmedBy) return res.status(400).json({ error: 'confirmed_by is required' });
  // H3: refunds:create being on a key at all already means an LLM can move money —
  // "confirmed by the key itself" would defeat the point of asking who approved it.
  if (confirmedBy.toLowerCase() === String(req.apiKey.name || '').toLowerCase()) {
    return res.status(400).json({ error: 'confirmed_by must name the human who approved this refund, not the API key itself' });
  }

  const amountCents = parseCents(req.body.amount_cents, { max: HARD_MAX_REFUND_CENTS });
  if (amountCents === null) {
    return res.status(400).json({ error: 'amount_cents must be a positive integer number of cents' });
  }

  let payment;
  if (req.body.payment_id) {
    // L1: an explicit payment_id must still be a completed payment belonging to this booking.
    payment = db.prepare("SELECT * FROM payments WHERE id = ? AND booking_id = ? AND status = 'completed'").get(req.body.payment_id, booking.id);
    if (!payment) return res.status(400).json({ error: 'payment_id does not belong to this booking, or is not a completed payment' });
  } else {
    payment = db.prepare(`
      SELECT * FROM payments
      WHERE booking_id = ? AND status = 'completed'
        AND (stripe_payment_id IS NOT NULL OR stripe_charge_id IS NOT NULL)
        AND (amount - COALESCE(refund_amount, 0)) > 0
      ORDER BY created_at DESC LIMIT 1
    `).get(booking.id);
    if (!payment) return res.status(400).json({ error: 'no refundable Stripe payment found for this booking' });
  }

  const paymentIntentId = payment.stripe_payment_id && payment.stripe_payment_id.startsWith('pi_') ? payment.stripe_payment_id : null;
  const chargeId = !paymentIntentId && payment.stripe_charge_id && payment.stripe_charge_id.startsWith('ch_') ? payment.stripe_charge_id : null;
  if (!paymentIntentId && !chargeId) {
    return res.status(400).json({ error: 'payment has no Stripe pi_/ch_ id and cannot be refunded via this endpoint' });
  }

  // C1.4: best-effort live check against Stripe's own record of the charge, so a refund
  // issued from the Stripe Dashboard (or anywhere outside this app) that the
  // `charge.refunded` webhook hasn't caught up on yet still shrinks the refundable
  // remainder. Fetched OUTSIDE reserveRefund's synchronous transaction (it's a network
  // call), then passed in as a plain number — the reservation's atomicity guarantee
  // doesn't depend on this call, only on the ledger checks already inside it.
  let liveRefundedCents = null;
  let liveChargeChecked = true;
  try {
    liveRefundedCents = await stripeService.getLiveRefundedCents({ paymentIntentId, chargeId });
  } catch (err) {
    liveChargeChecked = false;
    console.warn('[OFFICE API] live charge lookup failed, falling back to webhook/ledger values for the refundable-remainder check:', err.message);
  }

  if (req.body.dry_run) {
    const limits = computeRefundLimits(db, req.apiKey, payment, liveRefundedCents);
    return res.json({
      dry_run: true,
      booking_number: booking.booking_number,
      payment_id: payment.id,
      amount_cents: amountCents,
      refundable_cents: limits.refundableCents,
      max_refund_cents: limits.maxRefundCents,
      daily_refund_cap_cents: limits.dailyCapCents,
      already_refunded_today_cents: limits.alreadyTodayCents,
      live_charge_checked: liveChargeChecked,
    });
  }

  const reservation = reserveRefund(db, {
    key: req.apiKey, booking, payment, amountCents,
    idempotencyKey: req.idempotencyKey, requestHash: req.requestHash,
    reason: String(req.body.reason || '').slice(0, 450), confirmedBy, liveRefundedCents,
  });
  if (!reservation.ok) return res.status(reservation.status).json({ ...reservation.body, live_charge_checked: liveChargeChecked });

  // Written explicitly, at reservation time, BEFORE the Stripe call — never dependent on
  // res 'finish' alone, so a client disconnect mid-refund (see middleware/office-auth.js's
  // registerWriteAudit, which also fires on 'close') still leaves a record.
  res.locals.audit = {
    entity_type: 'booking', entity_id: booking.booking_number, action: 'office_api_refund',
    after: { ledger_id: reservation.ledgerId, payment_id: payment.id, amount_cents: amountCents, status: 'pending' },
    amount_cents: amountCents,
  };

  let refund;
  try {
    refund = await stripeService.createRefund({
      paymentIntentId,
      chargeId,
      amountCents,
      // C1: derived from the ledger row, not the caller's Idempotency-Key header —
      // guarantees exactly one Stripe call per reservation even if the same header is
      // somehow reused, and metadata.office_refund_id is what lets both
      // routes/webhooks.js's charge.refund.updated handler and
      // scripts/reconcile-office-refunds.js find this row again from Stripe's side.
      idempotencyKey: `office-refund-${reservation.ledgerId}`,
      metadata: {
        office_refund_id: reservation.ledgerId,
        booking_number: booking.booking_number,
        payment_id: payment.id,
        api_key: req.apiKey.name,
        reason: String(req.body.reason || '').slice(0, 450),
        confirmed_by: confirmedBy,
      },
    });
  } catch (err) {
    finalizeRefundLedger(db, reservation.ledgerId, { status: 'failed', error: err.message });
    res.locals.audit = {
      ...res.locals.audit,
      after: { ...res.locals.audit.after, status: 'failed', error: err.message },
    };
    console.error('[OFFICE API] Stripe refund failed:', err.message);
    if (res.writableEnded || res.destroyed) return undefined;
    return res.status(502).json({ error: `Stripe error: ${err.message}`, live_charge_checked: liveChargeChecked });
  }

  // L2: Stripe's own 'failed'/'canceled' refund statuses must not count toward the cap —
  // they release the reservation just like a thrown Stripe error would.
  const failedLikeStatuses = new Set(['failed', 'canceled']);
  const ledgerStatus = failedLikeStatuses.has(refund.status) ? 'failed' : 'succeeded';
  finalizeRefundLedger(db, reservation.ledgerId, { status: ledgerStatus, stripeRefundId: refund.id, stripeStatus: refund.status });

  res.locals.audit = {
    entity_type: 'booking', entity_id: booking.booking_number, action: 'office_api_refund',
    after: { ledger_id: reservation.ledgerId, refund_id: refund.id, payment_id: payment.id, amount_cents: amountCents, status: ledgerStatus, stripe_status: refund.status },
    amount_cents: amountCents,
    stripe_object_id: refund.id,
  };

  // Bookkeeping (payments.refund_amount, bookings.total/balance_due) is intentionally
  // NOT done here — routes/webhooks.js's charge.refunded handler is the single place
  // that reduces the booking's books, so a webhook retry or delay can never be
  // double-counted against a write this endpoint also made.
  if (res.writableEnded || res.destroyed) return undefined; // client already gone (C1) — ledger + audit are already correct
  return res.status(201).json({
    refund_id: refund.id,
    booking_number: booking.booking_number,
    payment_id: payment.id,
    amount_cents: amountCents,
    status: refund.status,
    ledger_status: ledgerStatus,
    bookkeeping_via: 'stripe_webhook',
    live_charge_checked: liveChargeChecked,
  });
}));

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
router.get('/reports/summary', requireScope('reports:read'), (req, res) => {
  const db = getDb();
  const { from, to } = req.query;
  if (from && !ISO_DATE_RE.test(from)) return res.status(400).json({ error: 'from must be YYYY-MM-DD' });
  if (to && !ISO_DATE_RE.test(to)) return res.status(400).json({ error: 'to must be YYYY-MM-DD' });

  // Gross/count/avg scoped by created_at (when the booking was MADE) and top units
  // scoped by event_date (when the rental HAPPENS) — the same split admin.js's GET
  // /reports uses. Cash collected/refunds follow the admin dashboard's payments-net-
  // of-refunds logic, scoped by when the money actually moved (payments.created_at).
  const bookingClauses = ["status != 'cancelled'"];
  const bookingParams = [];
  if (from) { bookingClauses.push('created_at >= ?'); bookingParams.push(from); }
  if (to) { bookingClauses.push('created_at <= ?'); bookingParams.push(`${to} 23:59:59`); }
  const bookingWhere = bookingClauses.join(' AND ');

  const grossTotal = db.prepare(`SELECT COALESCE(SUM(total), 0) r FROM bookings WHERE ${bookingWhere}`).get(...bookingParams).r;
  const bookingsCount = db.prepare(`SELECT COUNT(*) c FROM bookings WHERE ${bookingWhere}`).get(...bookingParams).c;
  const avgTicket = db.prepare(`SELECT COALESCE(AVG(total), 0) a FROM bookings WHERE ${bookingWhere}`).get(...bookingParams).a;

  const itemClauses = ["b.status NOT IN ('cancelled', 'declined')"];
  const itemParams = [];
  if (from) { itemClauses.push('b.event_date >= ?'); itemParams.push(from); }
  if (to) { itemClauses.push('b.event_date <= ?'); itemParams.push(to); }
  const topUnits = db.prepare(`
    SELECT e.name AS item_name, COUNT(*) AS rentals, COALESCE(SUM(bi.total_price), 0) AS revenue
    FROM booking_items bi JOIN bookings b ON b.id = bi.booking_id JOIN equipment e ON e.id = bi.equipment_id
    WHERE ${itemClauses.join(' AND ')}
    GROUP BY e.id ORDER BY rentals DESC LIMIT 10
  `).all(...itemParams);

  const paymentClauses = ["p.status = 'completed'", "b.status NOT IN ('cancelled', 'declined')"];
  const paymentParams = [];
  if (from) { paymentClauses.push('p.created_at >= ?'); paymentParams.push(from); }
  if (to) { paymentClauses.push('p.created_at <= ?'); paymentParams.push(`${to} 23:59:59`); }
  const paymentWhere = paymentClauses.join(' AND ');
  const cashCollected = db.prepare(`
    SELECT COALESCE(SUM(p.amount - COALESCE(p.refund_amount, 0)), 0) r
    FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE ${paymentWhere}
  `).get(...paymentParams).r;
  const refunds = db.prepare(`
    SELECT COALESCE(SUM(p.refund_amount), 0) r
    FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE ${paymentWhere}
  `).get(...paymentParams).r;

  res.json({
    from: from || null,
    to: to || null,
    bookings_count: bookingsCount,
    gross_total: Math.round(grossTotal * 100) / 100,
    refunds: Math.round(refunds * 100) / 100,
    net_revenue: Math.round((grossTotal - refunds) * 100) / 100,
    cash_collected: Math.round(cashCollected * 100) / 100,
    avg_ticket: Math.round(avgTicket * 100) / 100,
    top_units: topUnits,
  });
});

router.get('/reports/outstanding', requireScope('reports:read'), (req, res) => {
  const db = getDb();
  // "Upcoming" is anchored to todayCT(), not SQLite's date('now','localtime') (the
  // server's OS timezone, not necessarily Central) — same clock every other date
  // comparison in this file uses.
  const rows = db.prepare(`
    SELECT b.booking_number, b.event_date, b.status, b.total, b.deposit_amount, b.balance_due, b.payment_status,
           c.first_name, c.last_name, c.phone, c.email
    FROM bookings b JOIN customers c ON c.id = b.customer_id
    WHERE b.status NOT IN ('cancelled', 'declined')
      AND date(b.event_date) >= date(?)
      AND (b.deposit_paid = 0 OR b.balance_due > 0)
    ORDER BY b.event_date
  `).all(todayCT());
  res.json({ outstanding: rows, count: rows.length });
});

router.get('/reports/payouts', requireScope('reports:read'), asyncHandler(async (req, res) => {
  const data = await stripeService.getPayoutSummary();
  res.json({ payouts: data || null });
}));

// L4: any error that reached here (thrown synchronously, or via asyncHandler's .catch)
// becomes a clean JSON 500 instead of Express's default HTML error page or an unhandled
// rejection. Express identifies this as an error handler by its 4-arg signature, so
// `next` must stay in the parameter list even though it's never called.
router.use((err, req, res, next) => {
  console.error('[OFFICE API] unhandled route error:', err && err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal error' });
});

module.exports = router;
