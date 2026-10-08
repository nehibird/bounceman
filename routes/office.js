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
const { effectiveMaxRefundCents, effectiveDailyRefundCapCents, HARD_MAX_REFUND_CENTS, MANUAL_PAYMENT_HARD_MAX_CENTS } = require('../lib/refund-caps');
const { isDefinitiveStripeError, isTimeoutError } = require('../lib/stripe-errors');
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

// R2-M1: money-moving endpoints (refund / payment-link / manual-payment) must never ship
// a success response whose audit row failed to write — a caller seeing 201 with no
// corresponding api_audit_log entry has no way to know the write even happened. Persists
// the audit row SYNCHRONOUSLY before the response is sent (via req.auditControl, set up
// by middleware/office-auth.js's auditAndIdempotency) and turns a write failure into a
// 500 instead of a silent console.error next to a 2xx.
function respondToMoneyWrite(req, res, statusCode, body) {
  if (res.writableEnded || res.destroyed) {
    // Client already gone — still try to persist so the record exists, but there's no one
    // to answer with a 500 (or anything else) at this point.
    try { req.auditControl.persistBeforeResponse(statusCode, body); } catch { /* already logged by persist() */ }
    return undefined;
  }
  try {
    req.auditControl.persistBeforeResponse(statusCode, body);
  } catch {
    return res.status(500).json({ error: 'internal error: audit write failed — verify this write\'s outcome directly before retrying' });
  }
  return res.status(statusCode).json(body);
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
  try { scopes = JSON.parse(req.apiKey.scopes || '[]'); } catch { /* malformed row, report empty */ }
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

    // R2-L6: the GLOBAL blocked-dates check (equipment_id IS NULL) must also cover EVERY
    // day in that range — validateBookingDate above only ever checked the new START date,
    // and only when event_date itself changed, so extending event_end_date onto a blocked
    // day (or a multi-day move that merely passes THROUGH one) was never caught.
    if (dateList.length) {
      const placeholders = dateList.map(() => '?').join(',');
      const blockedDays = db.prepare(`
        SELECT date, reason FROM blocked_dates WHERE equipment_id IS NULL AND date IN (${placeholders})
      `).all(...dateList);
      for (const b of blockedDays) {
        conflicts.push({ type: 'calendar_rule', message: b.reason || 'that date is blocked', date: b.date });
      }
    }
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
// R2-L3: its own ceiling, independent of the refund ceiling — lowering
// OFFICE_REFUND_HARD_MAX_CENTS (e.g. to tighten refund policy) must never silently also
// lower this unrelated manual-payment sanity limit. A bigger figure belongs in
// accounting, not a phone-collected cash/check record.
const MAX_MANUAL_PAYMENT_CENTS = MANUAL_PAYMENT_HARD_MAX_CENTS;

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
  return respondToMoneyWrite(req, res, 201, {
    payment_id: result.paymentId,
    booking_number: booking.booking_number,
    amount_cents: amountCents,
    payment_method,
    new_balance: result.newBalance,
    new_status: result.newStatus,
    card_charged: false, // this is a manual/offline record — no card was ever charged
  });
});

// R2-M1: reserves a payment-link (key_id, Idempotency-Key) pair synchronously, BEFORE any
// Stripe call — a concurrent duplicate request (or a stub/network hiccup that doesn't
// dedupe on Stripe's side) hits the UNIQUE index and gets 409 instead of racing to create
// a second real Checkout Session with no audit row for the loser. If a reservation for
// this exact pair already exists (a retry, whatever its outcome), it's reused as-is,
// including its `expires_at` — never recomputed — so a retry sends byte-identical params
// to Stripe and Stripe's OWN idempotency key can actually dedupe it (a freshly computed
// `now + 24h` on each attempt drifted by whatever elapsed and turned every retry into a
// Stripe idempotency error instead of a dedupe).
// R2-M1: reservation ids currently being processed (between reservePaymentLink returning
// and the Checkout Session call finishing), IN THIS PROCESS ONLY — mirrors
// routes/office.js's refundsInFlight. Without this, two genuinely concurrent requests
// would both pass reservePaymentLink's SELECT-then-INSERT (the second one finding the
// FIRST request's just-inserted row and treating it as a legitimate "resume" instead of a
// live duplicate), and both would proceed to call Stripe.
const linkReservationsInFlight = new Set();

function reservePaymentLink(db, { key, booking, idempotencyKey, requestHash, amountCents }) {
  const attempt = db.transaction(() => {
    const existing = db.prepare(`
      SELECT * FROM office_payment_link_reservations WHERE key_id = ? AND idempotency_key = ?
    `).get(key.id, idempotencyKey);
    if (existing) {
      if (existing.booking_id !== booking.id) {
        return { ok: false, status: 409, body: { error: 'Idempotency-Key was already used for a different booking' } };
      }
      if (existing.request_hash && requestHash && existing.request_hash !== requestHash) {
        return { ok: false, status: 422, body: { error: 'Idempotency-Key was already used with a different request body' } };
      }
      return { ok: true, reservationId: existing.id, expiresAt: existing.expires_at, resumed: true };
    }

    const id = uuid();
    const expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // M2: 24h expiry, fixed at reservation time
    db.prepare(`INSERT INTO office_payment_link_reservations
      (id, key_id, idempotency_key, request_hash, booking_id, amount_cents, expires_at, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`).run(
      id, key.id, idempotencyKey, requestHash, booking.id, amountCents, expiresAt);
    return { ok: true, reservationId: id, expiresAt, resumed: false };
  });

  try {
    // R2-L4: BEGIN IMMEDIATE, not the default deferred BEGIN — this is a check-then-
    // insert against a table a second Node PROCESS could also be writing (e.g. a second
    // app instance behind a future load balancer). A deferred transaction only acquires
    // its write lock at the first write, so two processes could both pass the SELECT
    // read under a read lock before either upgrades to a write lock, then both bounce off
    // SQLITE_BUSY at nearly the same moment rather than cleanly serializing. `.immediate()`
    // takes the write lock up front, so the second transaction blocks (then proceeds
    // safely, seeing the first's committed row) instead of racing.
    return attempt.immediate();
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE constraint failed')) {
      return { ok: false, status: 409, body: { error: 'a payment-link reservation already exists for this idempotency key' } };
    }
    throw err;
  }
}

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

  // R2-M1: reserved BEFORE the Stripe call — see reservePaymentLink above.
  const reservation = reservePaymentLink(db, {
    key: req.apiKey, booking, idempotencyKey: req.idempotencyKey, requestHash: req.requestHash, amountCents,
  });
  if (!reservation.ok) return res.status(reservation.status).json(reservation.body);

  // A genuinely concurrent duplicate: reservePaymentLink's SELECT found the OTHER
  // request's row (already inserted, but that request hasn't finished with Stripe yet)
  // and would otherwise treat it as a safe "resume". 409 instead of a second concurrent
  // Checkout Session call.
  if (linkReservationsInFlight.has(reservation.reservationId)) {
    return res.status(409).json({ error: 'a payment-link reservation for this idempotency key is already being processed' });
  }
  linkReservationsInFlight.add(reservation.reservationId);

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(booking.customer_id);
  // Same base as routes/booking.js's own pay routes — not EVENT_BASE_URL (that's for the
  // walk-up event flow and has nothing to do with a booking's pay pages).
  const baseUrl = process.env.BASE_URL || 'https://bouncemanrentals.com';

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
      expiresAt: reservation.expiresAt,
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
    linkReservationsInFlight.delete(reservation.reservationId);
    db.prepare("UPDATE office_payment_link_reservations SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?")
      .run(err.message, reservation.reservationId);
    console.error('[OFFICE API] createPaymentLink failed:', err.message);
    return res.status(502).json({ error: `Stripe error: ${err.message}` });
  }
  linkReservationsInFlight.delete(reservation.reservationId);

  db.prepare("UPDATE office_payment_link_reservations SET status = 'succeeded', session_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(session.id, reservation.reservationId);

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
  return respondToMoneyWrite(req, res, 201, { url: session.url, session_id: session.id, amount_cents: amountCents, sms_sent: smsSent });
}));

// ---------------------------------------------------------------------------
// Refunds (C1) — see docs/office-api.md for the full reservation-ledger design.
//
// The refundable-balance rule (across ALL keys — the ledger sums below are scoped only
// by payment_id, never by key_id, because a payment can only be refunded once no matter
// which key initiates it):
//
//   confirmed_cents = MAX(webhook-recorded refund_amount,
//                         live Stripe amount_refunded (C1.4/R2-H1 — FAILS CLOSED: a
//                           failed/timed-out/malformed live lookup rejects the whole
//                           refund request with 503 before this formula ever runs, rather
//                           than silently omitting this term),
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

// R3-M3/R4-L3: while ANY reservation on this SAME PAYMENT — across every key — is still
// pending/needs_review, a brand-new reservation must be refused outright, even if there'd
// be numeric room under the caps/remainder. A new reservation on top of one whose Stripe
// outcome is unknown can double-pay once the unresolved one turns out to have succeeded
// (the caps/remainder math is deliberately conservative about counting an unresolved row,
// but "conservative" only bounds how much MORE can go out — it doesn't make a second
// attempt safe). Shared by reserveRefund AND dry_run (R4-L3) so a preview can never say
// "yes" to a refund the real call would then reject with this exact 409.
function findUnresolvedRefundForPayment(db, paymentId) {
  return db.prepare(`
    SELECT id FROM office_refunds WHERE payment_id = ? AND status IN ('pending', 'needs_review') LIMIT 1
  `).get(paymentId);
}

function unresolvedRefundBody(unresolvedId) {
  return {
    error: 'unresolved_refund', ledger_id: unresolvedId, retry_with_same_idempotency_key: true,
    message: 'A previous refund on this payment has an unknown outcome; retry that request with its original Idempotency-Key, or wait for reconcile.',
  };
}

// C1: everything that decides whether a refund is ALLOWED, plus the ledger INSERT that
// reserves it, happens inside one synchronous better-sqlite3 transaction — better-sqlite3
// runs transactions fully synchronously, so no other request's reservation can interleave
// mid-check even though the rest of this route handler is async and awaits Stripe. This is
// what makes the per-key caps and the refundable-remainder check hold under real
// concurrency, not just when calls happen to be serialized.
function reserveRefund(db, { key, booking, payment, amountCents, idempotencyKey, requestHash, reason, confirmedBy, liveRefundedCents }) {
  const attempt = db.transaction(() => {
    // The caller must retry the ORIGINAL Idempotency-Key (which resumes/dedupes against
    // Stripe) or wait for reconcile — see findUnresolvedRefundForPayment above.
    const unresolved = findUnresolvedRefundForPayment(db, payment.id);
    if (unresolved) {
      return { ok: false, status: 409, body: unresolvedRefundBody(unresolved.id) };
    }

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
    // R2-L4: BEGIN IMMEDIATE (not the default deferred BEGIN) — this is the
    // check-the-remainder-then-insert transaction a second Node PROCESS sharing this
    // SQLite file could also be running (multi-process is not today's deployment, but the
    // review flagged the deferred-BEGIN gap explicitly — see
    // tests/office-multiproc.test.js). A deferred transaction only takes its write lock at
    // the first write, so two processes' reads could both proceed under a read lock before
    // either upgrades, racing on SQLITE_BUSY instead of cleanly serializing. `.immediate()`
    // takes the write lock immediately, so a concurrent transaction from another process
    // blocks (then safely sees the first's committed reservation) instead of racing it.
    return attempt.immediate();
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE constraint failed')) {
      return { ok: false, status: 409, body: { error: 'a refund reservation already exists for this idempotency key' } };
    }
    throw err;
  }
}

// R3-M2: Stripe forgets an idempotency key after ~24h — a same-key resume of a reservation
// older than this is refused (marked needs_review, told to wait for reconcile/resolve)
// rather than calling refunds.create again and risking a genuine SECOND refund if the
// first attempt actually went through and Stripe no longer recognizes the key.
// Comfortably under 24h so a client retrying right at the boundary never loses a race
// against Stripe's own expiry.
const RESUME_MAX_AGE_MS = 23 * 60 * 60 * 1000;

// Finalizing to 'failed' also frees the reservation's idempotency_key (renamed off to
// the side, same convention as middleware/office-auth.js's audit-log handling) so a
// retry with the SAME Idempotency-Key can reserve fresh instead of hitting the
// UNIQUE(key_id, idempotency_key) index of the now-dead attempt. R2-C1:
// errorClassification is set to 'definitive' only when this 'failed' came from a
// DEFINITIVE Stripe error (lib/stripe-errors.js) — never for the ambiguous-outcome path,
// which never calls this function with status:'failed' at all (see attemptStripeRefund).
function finalizeRefundLedger(db, ledgerId, { status, stripeRefundId = null, stripeStatus = null, error = null, errorClassification = null }) {
  if (status === 'failed') {
    db.prepare(`UPDATE office_refunds SET status = ?, stripe_refund_id = ?, stripe_status = ?, error = ?, error_classification = ?,
      idempotency_key = idempotency_key || ':failed:' || id, updated_at = datetime('now')
      WHERE id = ? AND status = 'pending'`).run(status, stripeRefundId, stripeStatus, error, errorClassification, ledgerId);
    return;
  }
  db.prepare("UPDATE office_refunds SET status = ?, stripe_refund_id = ?, stripe_status = ?, error = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, stripeRefundId, stripeStatus, error, ledgerId);
}

// R2-C1: makes the actual Stripe refunds.create call for a reservation (fresh or resumed)
// and finalizes/responds based on the outcome. Shared by both the normal "just reserved"
// path and the "resuming a pending/needs_review row from a prior ambiguous outcome" path
// below, so the error-classification logic can never drift between the two.
// R2-C1: ledger ids currently inside attemptStripeRefund, IN THIS PROCESS ONLY — lets the
// route below tell a genuinely-concurrent duplicate request (same Idempotency-Key,
// arriving while the original call to Stripe is still outstanding) apart from a
// sequential retry of an already-finished ambiguous/needs_review attempt. The former
// still gets 409 (never a second concurrent Stripe call); the latter resumes the same
// reservation. Deliberately in-memory/per-process: a crash empties it, which is correct
// — nothing is "in flight" anymore once the process that was handling it is gone, and a
// resume is exactly what should happen next (via reconcile or a plain retry).
const refundsInFlight = new Set();

async function attemptStripeRefund(db, req, res, { ledgerId, booking, payment, amountCents, paymentIntentId, chargeId, confirmedBy, liveChargeChecked }) {
  refundsInFlight.add(ledgerId);
  try {
    return await attemptStripeRefundInner(db, req, res, { ledgerId, booking, payment, amountCents, paymentIntentId, chargeId, confirmedBy, liveChargeChecked });
  } finally {
    refundsInFlight.delete(ledgerId);
  }
}

// Shared by every path that ends up with a REAL Stripe refund object to finalize from —
// a fresh refunds.create() response, a resume that found one via findRefundByOfficeId, or
// a "definitive-looking" error that findRefundByOfficeId then confirmed a refund DOES
// exist for (R3-C1(b)). Always responds 201 (Stripe successfully returned/confirmed a
// refund OBJECT; a later failure/cancellation is corrected by routes/webhooks.js's
// charge.refund.updated handler, not here) and never renames/releases the reservation.
function finalizeFromStripeRefund(db, req, res, { ledgerId, booking, payment, amountCents, liveChargeChecked }, refund) {
  const failedLikeStatuses = new Set(['failed', 'canceled']);
  const ledgerStatus = failedLikeStatuses.has(refund.status) ? 'failed' : 'succeeded';
  finalizeRefundLedger(db, ledgerId, { status: ledgerStatus, stripeRefundId: refund.id, stripeStatus: refund.status });

  res.locals.audit = {
    entity_type: 'booking', entity_id: booking.booking_number, action: 'office_api_refund',
    after: { ledger_id: ledgerId, refund_id: refund.id, payment_id: payment.id, amount_cents: amountCents, status: ledgerStatus, stripe_status: refund.status },
    amount_cents: amountCents,
    stripe_object_id: refund.id,
  };

  // Bookkeeping (payments.refund_amount, bookings.total/balance_due) is intentionally
  // NOT done here — routes/webhooks.js's charge.refunded handler is the single place
  // that reduces the booking's books, so a webhook retry or delay can never be
  // double-counted against a write this endpoint already made.
  return respondToMoneyWrite(req, res, 201, {
    refund_id: refund.id,
    booking_number: booking.booking_number,
    payment_id: payment.id,
    amount_cents: amountCents,
    status: refund.status,
    ledger_status: ledgerStatus,
    bookkeeping_via: 'stripe_webhook',
    live_charge_checked: liveChargeChecked,
  });
}

// Shared by every path that ends up NOT being able to determine whether Stripe actually
// processed a refund — keeps the ledger row exactly as it is (still counted, never
// renamed) and responds with the {outcome:"unknown"} contract callers must retry with the
// SAME Idempotency-Key against.
function respondAmbiguous(db, req, res, { ledgerId, liveChargeChecked }, errorMessage, isTimeout) {
  db.prepare("UPDATE office_refunds SET error = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('pending', 'needs_review')")
    .run(errorMessage, ledgerId);
  res.locals.audit = { ...res.locals.audit, after: { ...(res.locals.audit && res.locals.audit.after), status: 'unknown', error: errorMessage } };
  console.error('[OFFICE API] Stripe refund outcome UNKNOWN (ambiguous error, reservation kept):', errorMessage);
  const status = isTimeout ? 504 : 502;
  return respondToMoneyWrite(req, res, status, {
    error: `Stripe error, outcome unknown: ${errorMessage}`,
    outcome: 'unknown',
    ledger_id: ledgerId,
    retry_with_same_idempotency_key: true,
    live_charge_checked: liveChargeChecked,
  });
}

async function attemptStripeRefundInner(db, req, res, { ledgerId, booking, payment, amountCents, paymentIntentId, chargeId, confirmedBy, liveChargeChecked }) {
  // Written explicitly, before the Stripe call — never dependent on res 'finish' alone,
  // so a client disconnect mid-refund (see middleware/office-auth.js's registerWriteAudit,
  // which also fires on 'close') still leaves a record.
  res.locals.audit = {
    entity_type: 'booking', entity_id: booking.booking_number, action: 'office_api_refund',
    after: { ledger_id: ledgerId, payment_id: payment.id, amount_cents: amountCents, status: 'pending' },
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
      // R2-C1: reused byte-for-byte on a same-key retry (SAME ledgerId), which is what
      // lets Stripe's own 24h idempotency dedupe actually apply.
      idempotencyKey: `office-refund-${ledgerId}`,
      metadata: {
        office_refund_id: ledgerId,
        booking_number: booking.booking_number,
        payment_id: payment.id,
        api_key: req.apiKey.name,
        reason: String(req.body.reason || '').slice(0, 450),
        confirmed_by: confirmedBy,
      },
    });
  } catch (err) {
    // R2-C1/R3-C1: only a DEFINITIVE Stripe error (a real 4xx, excluding 409/429, from one
    // of the four error types that mean "Stripe never touched the charge") is even a
    // CANDIDATE for finalizing 'failed' and releasing the reservation. Everything else —
    // no statusCode, a 5xx, StripeAPIError, StripeConnectionError, StripeIdempotencyError,
    // a timeout, a 409/429, or an unrecognized error — might mean Stripe actually
    // processed the refund before the response was lost, so the reservation MUST stay
    // counted and MUST NOT be retried with a new idempotency key.
    if (isDefinitiveStripeError(err)) {
      // R3-C1(b): stripe-node still retries once after ECONNRESET/EPIPE regardless of
      // maxNetworkRetries (see services/stripe.js), and that hidden retry can land a
      // genuinely-definitive-shaped 4xx (400/402/401/403) on an attempt whose ORIGINAL try
      // may already have gone through at Stripe. Before finalizing 'failed' — which
      // releases the reservation and lets a retry pay out again — confirm directly with
      // Stripe by looking the refund up. Never trust the thrown error alone.
      let lookup;
      try {
        lookup = { found: await stripeService.findRefundByOfficeId(ledgerId, payment) };
      } catch (lookupErr) {
        lookup = { failed: true, error: lookupErr };
      }

      if (lookup.failed) {
        console.error('[OFFICE API] Stripe refund error looked definitive, but confirming via findRefundByOfficeId FAILED — keeping reservation pending (ambiguous):', err.message, '|', lookup.error.message);
        return respondAmbiguous(db, req, res, { ledgerId, liveChargeChecked },
          `${err.message} (could not confirm with Stripe: ${lookup.error.message})`, false);
      }

      if (lookup.found) {
        console.warn('[OFFICE API] Stripe refund error looked definitive, but a matching refund DOES exist at Stripe — finalizing from it, never releasing the reservation:', err.message);
        return finalizeFromStripeRefund(db, req, res, { ledgerId, booking, payment, amountCents, liveChargeChecked }, lookup.found);
      }

      // Confirmed: Stripe genuinely has no refund for this reservation — safe to release
      // and let a retry reserve fresh.
      finalizeRefundLedger(db, ledgerId, { status: 'failed', error: err.message, errorClassification: 'definitive' });
      res.locals.audit = { ...res.locals.audit, after: { ...res.locals.audit.after, status: 'failed', error: err.message } };
      console.error('[OFFICE API] Stripe refund failed (definitive, confirmed no refund exists):', err.message);
      return respondToMoneyWrite(req, res, 502, { error: `Stripe error: ${err.message}`, live_charge_checked: liveChargeChecked });
    }

    // Ambiguous (incl. 409/429 — R3-C1(a)): keep the row exactly as it is (still 'pending'
    // or 'needs_review', still counted against the remainder/caps) and just record the
    // error for visibility. Never renamed, never released — a same-key retry finds this
    // row and reuses it (see the route below); a new-key retry is refused outright (R3-M3).
    return respondAmbiguous(db, req, res, { ledgerId, liveChargeChecked }, err.message, isTimeoutError(err));
  }

  // L2: Stripe's own 'failed'/'canceled' refund statuses must not count toward the cap —
  // they release the reservation just like a thrown Stripe error would. This is a REAL
  // Stripe answer (not a thrown error), so it's never ambiguous and never touches
  // error/error_classification.
  return finalizeFromStripeRefund(db, req, res, { ledgerId, booking, payment, amountCents, liveChargeChecked }, refund);
}

router.post('/bookings/:booking_number/refunds', requireScope('refunds:create'), refundLimiter, asyncHandler(async (req, res) => {
  const db = getDb();
  const booking = findBookingByNumber(db, req.params.booking_number);
  if (!booking) return res.status(404).json({ error: 'booking not found' });

  // R2-C1: a retry with the SAME Idempotency-Key whose ledger row is still 'pending' or
  // 'needs_review' — from a prior AMBIGUOUS Stripe outcome, or a process crash between
  // reserving and finalizing — reuses that exact reservation and re-issues the SAME
  // Stripe idempotency key, rather than a fresh reservation with fresh cap headroom.
  //
  // R2-L2: a row already 'succeeded' USUALLY never reaches here — middleware/office-
  // auth.js's generic idempotency replay answers it first, straight from a 2xx audit row.
  // The one case that doesn't: a client disconnect writes a 499 audit row (via
  // registerWriteAudit's 'close' handler, which fires before the Stripe call — and
  // therefore the real 201 — even exists), and that row is never updated in place once
  // the refund actually finalizes (the ledger, not the audit log, is authoritative here).
  // A same-key retry then finds a non-2xx, non-ambiguous audit row, which middleware
  // retires as a "genuine failure" and processes fresh — so this endpoint has to check
  // the LEDGER for an already-'succeeded' row itself and replay 201 from it directly
  // (no second Stripe call), rather than letting reserveRefund's UNIQUE-constraint catch
  // turn it into a confusing 409. The retry's OWN audit row (fresh, since the old 499 one
  // was already retired) correctly records 201; the old 499 row is kept as history.
  //
  // A request whose row is genuinely still in-flight in THIS process (not yet reserved at
  // all) falls through to the normal reserveRefund path below, whose UNIQUE-constraint
  // catch returns 409.
  const resumable = db.prepare(`
    SELECT * FROM office_refunds WHERE key_id = ? AND idempotency_key = ? AND status IN ('pending', 'needs_review', 'succeeded')
  `).get(req.apiKey.id, req.idempotencyKey);

  if (resumable) {
    if (refundsInFlight.has(resumable.id)) {
      return res.status(409).json({ error: 'a refund reservation for this idempotency key is already being processed' });
    }
    if (resumable.booking_id !== booking.id) {
      return res.status(409).json({ error: 'Idempotency-Key was already used for a different booking' });
    }
    if (resumable.request_hash && req.requestHash && resumable.request_hash !== req.requestHash) {
      return res.status(422).json({ error: 'Idempotency-Key was already used with a different request body' });
    }

    if (resumable.status === 'succeeded') {
      // R2-L2: replay straight from the ledger — the authoritative record — never a
      // second Stripe call.
      return respondToMoneyWrite(req, res, 201, {
        refund_id: resumable.stripe_refund_id,
        booking_number: booking.booking_number,
        payment_id: resumable.payment_id,
        amount_cents: resumable.amount_cents,
        status: resumable.stripe_status,
        ledger_status: resumable.status,
        bookkeeping_via: 'stripe_webhook',
        live_charge_checked: false,
      });
    }

    const resumedPayment = db.prepare('SELECT * FROM payments WHERE id = ?').get(resumable.payment_id);
    if (!resumedPayment) return res.status(500).json({ error: 'internal error: reserved refund has no matching payment row' });
    const resumedPI = resumedPayment.stripe_payment_id && resumedPayment.stripe_payment_id.startsWith('pi_') ? resumedPayment.stripe_payment_id : null;
    const resumedCharge = !resumedPI && resumedPayment.stripe_charge_id && resumedPayment.stripe_charge_id.startsWith('ch_') ? resumedPayment.stripe_charge_id : null;

    // R3-M2: before ever re-issuing refunds.create on a resume, check with Stripe
    // directly. Stripe forgets an idempotency key after ~24h, so a same-key retry past
    // that window would otherwise be treated as brand new and could pay out a SECOND real
    // refund for an outcome that was actually ambiguous-but-succeeded the first time.
    let resumeLookup;
    try {
      resumeLookup = { found: await stripeService.findRefundByOfficeId(resumable.id, resumedPayment) };
    } catch (lookupErr) {
      resumeLookup = { failed: true, error: lookupErr };
    }

    if (resumeLookup.failed) {
      console.error('[OFFICE API] resume: findRefundByOfficeId lookup failed — staying pending (ambiguous), no refunds.create call:', resumeLookup.error.message);
      return respondAmbiguous(db, req, res, { ledgerId: resumable.id, liveChargeChecked: false }, resumeLookup.error.message, false);
    }

    if (resumeLookup.found) {
      return finalizeFromStripeRefund(db, req, res, {
        ledgerId: resumable.id, booking, payment: resumedPayment, amountCents: resumable.amount_cents, liveChargeChecked: false,
      }, resumeLookup.found);
    }

    // Nothing found at Stripe yet. If this reservation is old enough that Stripe may have
    // already forgotten the idempotency key (~24h), calling refunds.create again risks a
    // genuine SECOND refund instead of Stripe's own dedupe catching it — refuse and
    // require reconcile/a human resolve instead of retrying blind.
    const ageMs = Date.now() - new Date(`${resumable.created_at}Z`).getTime();
    if (ageMs >= RESUME_MAX_AGE_MS) {
      db.prepare("UPDATE office_refunds SET status = 'needs_review', updated_at = datetime('now') WHERE id = ? AND status IN ('pending', 'needs_review')").run(resumable.id);
      console.warn('[OFFICE API] resume: reservation is older than the safe same-key resume window — marked needs_review instead of retrying Stripe:', resumable.id);
      res.locals.audit = {
        entity_type: 'booking', entity_id: booking.booking_number, action: 'office_api_refund',
        after: { ledger_id: resumable.id, payment_id: resumedPayment.id, amount_cents: resumable.amount_cents, status: 'needs_review' },
        amount_cents: resumable.amount_cents,
      };
      return respondToMoneyWrite(req, res, 409, {
        error: 'refund_needs_reconcile', ledger_id: resumable.id,
        message: 'this reservation is old enough that Stripe may have forgotten the idempotency key — it has been marked needs_review; wait for the reconcile job or use scripts/resolve-office-refund.js',
      });
    }

    return attemptStripeRefund(db, req, res, {
      ledgerId: resumable.id, booking, payment: resumedPayment, amountCents: resumable.amount_cents,
      paymentIntentId: resumedPI, chargeId: resumedCharge, confirmedBy: resumable.confirmed_by,
      // Not re-verified on resume — the reservation was already validated (and is still
      // held) at the time it was first made; re-running the live check would add another
      // network round-trip without changing anything this endpoint would do differently.
      liveChargeChecked: false,
    });
  }

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

  // C1.4/R2-H1: a live check against Stripe's own record of the charge, so a refund
  // issued from the Stripe Dashboard (or anywhere outside this app) that the
  // `charge.refunded` webhook hasn't caught up on yet still shrinks the refundable
  // remainder. FAILS CLOSED (R2-H1): if this throws — network error, timeout, or
  // malformed/untrustworthy data (see services/stripe.js's assertUsableCharge) — the
  // refund is refused with 503 BEFORE any reservation and with ZERO refunds.create calls,
  // for both a real attempt and a dry_run. Fetched OUTSIDE reserveRefund's synchronous
  // transaction (it's a network call), then passed in as a plain number — the
  // reservation's atomicity guarantee doesn't depend on this call, only on the ledger
  // checks already inside it.
  let liveRefundedCents;
  try {
    liveRefundedCents = await stripeService.getLiveRefundedCents({
      paymentIntentId, chargeId, expectedAmountCents: Math.round((payment.amount || 0) * 100),
    });
  } catch (err) {
    console.error('[OFFICE API] live charge lookup unverified — failing closed, no reservation, no Stripe refund call:', err.message);
    return res.status(503).json({ error: 'live_check_unavailable', detail: err.message });
  }
  const liveChargeChecked = true;

  if (req.body.dry_run) {
    // R4-L3: preview the SAME unresolved-refund refusal the real call would give (§ R3-M3)
    // — otherwise a dry_run could return a clean "yes" for a request that then 409s for
    // real, which is worse than no preview at all.
    const unresolved = findUnresolvedRefundForPayment(db, payment.id);
    if (unresolved) {
      return res.status(409).json({ ...unresolvedRefundBody(unresolved.id), live_charge_checked: liveChargeChecked });
    }
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

  return attemptStripeRefund(db, req, res, {
    ledgerId: reservation.ledgerId, booking, payment, amountCents, paymentIntentId, chargeId, confirmedBy, liveChargeChecked,
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

// LEDGER-3 (round-5 ruling): not used by any route — computeRefundLimits is otherwise
// unreachable from outside this module. Exported so a direct unit test can seed a
// pending/needs_review row and prove the term still reduces refundableCents, in case a
// future relaxation of R3-M3's blanket unresolved-refund refusal ever makes this the only
// thing preventing a double refund. R6-I3: gated to test only — it was never reachable
// over HTTP even in prod (router._test isn't a route, and nothing iterates/serializes the
// router), but there's no reason for the property to exist on the prod export at all.
if (process.env.NODE_ENV === 'test') {
  router._test = { computeRefundLimits };
}

module.exports = router;
