const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { requireAuth } = require('./auth');
const cookieParser = require('cookie-parser');
const { v4: uuid } = require('uuid');

router.use(cookieParser());

// Public API: Check availability
router.get('/availability', (req, res) => {
  const db = getDb();
  const { date, equipment_id } = req.query;
  if (!date) return res.json({ error: 'date required' });

  const blocked = db.prepare('SELECT * FROM blocked_dates WHERE date = ? AND (equipment_id IS NULL OR equipment_id = ?)').get(date, equipment_id || null);
  if (blocked) return res.json({ available: false, reason: blocked.reason });

  if (equipment_id) {
    const booked = db.prepare(`SELECT b.id FROM bookings b JOIN booking_items bi ON bi.booking_id = b.id
      WHERE b.event_date = ? AND bi.equipment_id = ? AND b.status NOT IN ('cancelled','declined')`).get(date, equipment_id);
    if (booked) return res.json({ available: false, reason: 'Already booked' });
  }

  // Return all booked equipment for that date
  const bookedItems = db.prepare(`SELECT bi.equipment_id FROM bookings b JOIN booking_items bi ON bi.booking_id = b.id
    WHERE b.event_date = ? AND b.status NOT IN ('cancelled','declined')`).all(date);

  res.json({ available: true, booked_equipment_ids: bookedItems.map(b => b.equipment_id) });
});

// Public API: Equipment list
router.get('/equipment', (req, res) => {
  const db = getDb();
  const equipment = db.prepare(`SELECT e.id, e.name, e.slug, e.category, e.short_description, e.dimensions,
    e.capacity_kids, e.age_range, e.price_daily, e.price_weekend, e.price_wet, e.featured,
    (SELECT image_path FROM equipment_images WHERE equipment_id = e.id AND is_primary = 1 LIMIT 1) as image
    FROM equipment e WHERE e.status = 'available' ORDER BY e.sort_order`).all();
  res.json(equipment);
});

// Public API: Delivery fee lookup
router.get('/delivery-fee', (req, res) => {
  const db = getDb();
  const { zip } = req.query;
  if (!zip) return res.json({ fee: 0, zone: 'unknown' });

  const zone = db.prepare("SELECT * FROM delivery_zones WHERE active = 1 AND (',' || zip_codes || ',') LIKE ?").get(`%,${zip},%`);
  res.json({ fee: zone ? zone.delivery_fee : null, zone: zone?.name || 'Outside service area', found: !!zone });
});

// Public API: Validate discount code
router.post('/validate-discount', (req, res) => {
  const db = getDb();
  const { code, subtotal } = req.body;
  const discount = db.prepare('SELECT * FROM discount_codes WHERE code = ? AND active = 1').get(code?.toUpperCase());

  if (!discount) return res.json({ valid: false, message: 'Invalid discount code' });
  if (discount.max_uses && discount.uses_count >= discount.max_uses) return res.json({ valid: false, message: 'Code has expired' });
  if (discount.valid_from && new Date(discount.valid_from) > new Date()) return res.json({ valid: false, message: 'Code not yet active' });
  if (discount.valid_until && new Date(discount.valid_until) < new Date()) return res.json({ valid: false, message: 'Code has expired' });
  if (discount.min_order && subtotal < discount.min_order) return res.json({ valid: false, message: `Minimum order $${discount.min_order}` });

  let amount = 0;
  if (discount.type === 'percent') amount = Math.round(subtotal * (discount.value / 100) * 100) / 100;
  else amount = discount.value;

  res.json({ valid: true, type: discount.type, value: discount.value, discount_amount: amount });
});

// === N8N INTEGRATION ENDPOINTS (key-based auth, before requireAuth) ===
function requireN8nKey(req, res, next) {
  const key = req.headers['x-n8n-key'];
  if (!key || key !== process.env.N8N_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.delete('/communications/:id', requireN8nKey, (req, res) => {
  getDb().prepare('DELETE FROM communications WHERE id = ?').run(req.params.id);
  console.log('[API] Communication deleted:', req.params.id);
  res.json({ success: true });
});

router.get('/communications/bot-status/:email', requireN8nKey, (req, res) => {
  const row = getDb().prepare(
    "SELECT bot_paused FROM communications WHERE recipient = ? AND type = 'contact_form' ORDER BY rowid DESC LIMIT 1"
  ).get(req.params.email);
  res.json({ bot_paused: row ? !!row.bot_paused : false });
});

router.post('/communications', requireN8nKey, (req, res) => {
  const { recipient, subject, body, metadata } = req.body;
  const id = uuid();
  getDb().prepare(`INSERT INTO communications (id, type, direction, subject, body, recipient, metadata)
    VALUES (?, 'email', 'outbound', ?, ?, ?, ?)`).run(
    id, subject || 'AI Auto-Reply', body || '', recipient || '',
    JSON.stringify(metadata || {})
  );
  console.log('[API] Outbound communication saved:', id);
  res.json({ success: true, id });
});

// === PROTECTED API ROUTES ===
router.use(requireAuth);

// Calendar events (for FullCalendar)
router.get('/calendar-events', (req, res) => {
  const db = getDb();
  const bookings = db.prepare(`
    SELECT b.id, b.booking_number, b.event_date, b.event_start_time, b.event_end_time, b.status,
      c.first_name || ' ' || c.last_name as customer_name,
      GROUP_CONCAT(bi.item_name, ', ') as items
    FROM bookings b JOIN customers c ON c.id = b.customer_id
    LEFT JOIN booking_items bi ON bi.booking_id = b.id
    WHERE b.status NOT IN ('cancelled','declined')
    GROUP BY b.id
  `).all();

  const events = bookings.map(b => ({
    id: b.id,
    title: `${b.customer_name} - ${b.items || 'No items'}`,
    start: `${b.event_date}T${b.event_start_time}`,
    end: `${b.event_date}T${b.event_end_time}`,
    url: `/admin/bookings/${b.id}`,
    color: b.status === 'confirmed' ? '#28a745' : b.status === 'pending' ? '#ffc107' : '#6c757d',
    extendedProps: { booking_number: b.booking_number, status: b.status }
  }));

  // Add blocked dates
  const blocked = db.prepare('SELECT * FROM blocked_dates').all();
  blocked.forEach(bd => {
    events.push({
      title: bd.reason || 'Blocked',
      start: bd.date,
      allDay: true,
      color: '#dc3545',
      display: 'background'
    });
  });

  res.json(events);
});

// Dashboard stats (for AJAX refresh)
router.get('/stats', (req, res) => {
  const db = getDb();
  const dayjs = require('dayjs');
  const today = dayjs().format('YYYY-MM-DD');
  const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');

  res.json({
    todayBookings: db.prepare("SELECT COUNT(*) as c FROM bookings WHERE event_date = ?").get(today).c,
    monthRevenue: db.prepare("SELECT COALESCE(SUM(total), 0) as r FROM bookings WHERE created_at >= ? AND status != 'cancelled'").get(monthStart).r,
    pendingBookings: db.prepare("SELECT COUNT(*) as c FROM bookings WHERE status = 'pending'").get().c,
    unsignedContracts: db.prepare("SELECT COUNT(*) as c FROM contracts WHERE signed = 0").get().c
  });
});

// Blocked dates management
router.post('/blocked-dates', (req, res) => {
  const db = getDb();
  const { date, reason, equipment_id } = req.body;
  db.prepare('INSERT INTO blocked_dates (id, date, reason, equipment_id) VALUES (?, ?, ?, ?)')
    .run(uuid(), date, reason || null, equipment_id || null);
  res.json({ success: true });
});

router.delete('/blocked-dates/:id', (req, res) => {
  getDb().prepare('DELETE FROM blocked_dates WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Quick booking create (admin)
router.post('/bookings/quick', (req, res) => {
  const db = getDb();
  const data = req.body;

  let customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(data.email);
  const customerId = customer?.id || uuid();
  if (!customer) {
    db.prepare(`INSERT INTO customers (id, first_name, last_name, email, phone) VALUES (?, ?, ?, ?, ?)`)
      .run(customerId, data.first_name, data.last_name, data.email, data.phone);
  }

  const bookingId = uuid();
  const prefix = 'BM';
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 5).toUpperCase();
  const bookingNumber = `${prefix}-${ts}-${rand}`;

  db.prepare(`INSERT INTO bookings (id, booking_number, customer_id, status, event_date,
    event_start_time, event_end_time, delivery_address, delivery_city, delivery_zip, total, balance_due)
    VALUES (?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    bookingId, bookingNumber, customerId, data.event_date, data.event_start_time,
    data.event_end_time, data.delivery_address, data.delivery_city, data.delivery_zip,
    data.total || 0, data.total || 0
  );

  res.json({ success: true, booking_id: bookingId, booking_number: bookingNumber });
});

module.exports = router;
