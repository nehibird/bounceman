const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { v4: uuid } = require('uuid');
const dayjs = require('dayjs');

function getSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function generateBookingNumber() {
  const prefix = 'BM';
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

// Booking start — select equipment
router.get('/', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const equipment = db.prepare(`
    SELECT e.*,
      (SELECT image_path FROM equipment_images WHERE equipment_id = e.id AND is_primary = 1 LIMIT 1) as image
    FROM equipment e WHERE e.status = 'available' ORDER BY e.sort_order
  `).all();
  const categories = db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY sort_order').all();
  const packages = db.prepare('SELECT * FROM packages WHERE active = 1').all();

  res.render('public/booking/step1-select', {
    title: 'Book Your Rental - Bounce Man',
    settings, equipment, categories, packages,
    page: 'booking'
  });
});

// Step 2 — date & time
router.get('/date', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const items = req.query.items ? req.query.items.split(',') : [];

  // Get add-on items
  const addons = db.prepare(`
    SELECT e.*,
      (SELECT image_path FROM equipment_images WHERE equipment_id = e.id AND is_primary = 1 LIMIT 1) as image
    FROM equipment e
    WHERE e.category = 'add_ons' AND e.status = 'available'
    ORDER BY e.sort_order
  `).all();

  res.render('public/booking/step2-date', {
    title: 'Choose Date & Time - Bounce Man',
    settings, selectedItems: items, addons,
    page: 'booking'
  });
});

// Check availability for multiple items on a date
router.post('/check-date', (req, res) => {
  const db = getDb();
  const { date, equipment_ids } = req.body;

  if (!date || !equipment_ids?.length) {
    return res.json({ available: false, message: 'Date and equipment required' });
  }

  // Check blocked dates
  const blocked = db.prepare('SELECT * FROM blocked_dates WHERE date = ? AND equipment_id IS NULL').get(date);
  if (blocked) return res.json({ available: false, message: blocked.reason || 'Date unavailable' });

  // Check each item
  const unavailable = [];
  for (const eqId of equipment_ids) {
    const booked = db.prepare(`
      SELECT e.name FROM bookings b
      JOIN booking_items bi ON bi.booking_id = b.id
      JOIN equipment e ON e.id = bi.equipment_id
      WHERE b.event_date = ? AND bi.equipment_id = ? AND b.status NOT IN ('cancelled', 'declined')
    `).get(date, eqId);
    if (booked) unavailable.push(booked.name);

    const blockedItem = db.prepare('SELECT * FROM blocked_dates WHERE date = ? AND equipment_id = ?').get(date, eqId);
    if (blockedItem) {
      const eq = db.prepare('SELECT name FROM equipment WHERE id = ?').get(eqId);
      unavailable.push(eq?.name || 'Item');
    }
  }

  if (unavailable.length > 0) {
    return res.json({ available: false, message: `Unavailable: ${unavailable.join(', ')}` });
  }

  res.json({ available: true, message: 'All items available!' });
});

// Step 3 — customer details & delivery
router.get('/details', (req, res) => {
  const settings = getSettings();
  const zones = getDb().prepare('SELECT * FROM delivery_zones WHERE active = 1 ORDER BY delivery_fee').all();

  res.render('public/booking/step3-details', {
    title: 'Your Details - Bounce Man',
    settings, zones,
    page: 'booking'
  });
});

// Step 4 — review & pay
router.post('/review', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const {
    equipment_ids, event_date, event_start_time, event_end_time,
    first_name, last_name, email, phone,
    delivery_address, delivery_city, delivery_zip,
    event_type, venue_type, surface_type, power_available,
    delivery_notes, discount_code, rental_duration
  } = req.body;

  const items = Array.isArray(equipment_ids) ? equipment_ids : [equipment_ids];
  const duration = rental_duration || 'daily';

  // Calculate pricing based on rental duration
  let subtotal = 0;
  const lineItems = [];
  for (const eqId of items) {
    const eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(eqId);
    if (!eq) continue;

    let unitPrice;
    if (duration === '4hr') {
      unitPrice = eq.price_4hr || Math.round(eq.price_daily * 0.65 * 100) / 100;
    } else if (duration === 'overnight') {
      unitPrice = eq.price_overnight || Math.round(eq.price_daily * 1.15 * 100) / 100;
    } else {
      unitPrice = eq.price_daily;
    }

    lineItems.push({
      equipment_id: eqId,
      item_name: eq.name,
      unit_price: unitPrice,
      total_price: unitPrice,
      duration_type: duration,
      image: db.prepare('SELECT image_path FROM equipment_images WHERE equipment_id = ? AND is_primary = 1 LIMIT 1').get(eqId)?.image_path
    });
    subtotal += unitPrice;
  }

  // Delivery fee by zip
  let delivery_fee = 0;
  if (delivery_zip) {
    const zone = db.prepare("SELECT * FROM delivery_zones WHERE active = 1 AND (',' || zip_codes || ',') LIKE ?")
      .get(`%,${delivery_zip},%`);
    delivery_fee = zone ? zone.delivery_fee : parseFloat(settings.default_delivery_fee || '0');
  }

  // Tax
  const tax_rate = parseFloat(settings.tax_rate || '0.085');
  const tax_amount = Math.round(subtotal * tax_rate * 100) / 100;

  // Discount
  let discount_amount = 0;
  if (discount_code) {
    const code = db.prepare('SELECT * FROM discount_codes WHERE code = ? AND active = 1').get(discount_code.toUpperCase());
    if (code) {
      if (code.type === 'percent') {
        discount_amount = Math.round(subtotal * (code.value / 100) * 100) / 100;
      } else {
        discount_amount = code.value;
      }
    }
  }

  // Damage waiver
  const damage_waiver_fee = parseFloat(settings.damage_waiver_fee || '15');

  const total = subtotal + delivery_fee + tax_amount + damage_waiver_fee - discount_amount;
  const deposit_pct = parseFloat(settings.deposit_percent || '25') / 100;
  const deposit_amount = Math.round(total * deposit_pct * 100) / 100;

  res.render('public/booking/step4-review', {
    title: 'Review Your Booking - Bounce Man',
    settings,
    lineItems,
    customer: { first_name, last_name, email, phone },
    delivery: { delivery_address, delivery_city, delivery_zip, delivery_notes, venue_type, surface_type, power_available },
    event: { event_date, event_start_time, event_end_time, event_type },
    pricing: { subtotal, delivery_fee, tax_rate, tax_amount, discount_amount, discount_code, damage_waiver_fee, total, deposit_amount },
    rental_duration: duration,
    page: 'booking'
  });
});

// Submit booking
router.post('/submit', async (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const data = req.body;

  try {
    // Create or find customer
    let customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(data.email);
    const customerId = customer?.id || uuid();

    if (!customer) {
      db.prepare(`INSERT INTO customers (id, first_name, last_name, email, phone, address, city, state, zip, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'OK', ?, 'website')`).run(
        customerId, data.first_name, data.last_name, data.email, data.phone,
        data.delivery_address, data.delivery_city, data.delivery_zip
      );
    }

    const bookingId = uuid();
    const bookingNumber = generateBookingNumber();

    db.prepare(`INSERT INTO bookings (
      id, booking_number, customer_id, status, event_date, event_start_time, event_end_time,
      event_type, venue_type, delivery_address, delivery_city, delivery_state, delivery_zip,
      delivery_notes, surface_type, power_available,
      subtotal, delivery_fee, tax_amount, tax_rate, discount_amount, discount_code,
      damage_waiver_fee, total, deposit_amount, balance_due, payment_status
    ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, 'OK', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      bookingId, bookingNumber, customerId,
      data.event_date, data.event_start_time, data.event_end_time,
      data.event_type, data.venue_type,
      data.delivery_address, data.delivery_city, data.delivery_zip,
      data.delivery_notes, data.surface_type, data.power_available ? 1 : 0,
      parseFloat(data.subtotal), parseFloat(data.delivery_fee),
      parseFloat(data.tax_amount), parseFloat(data.tax_rate),
      parseFloat(data.discount_amount || 0), data.discount_code || null,
      parseFloat(data.damage_waiver_fee || 0),
      parseFloat(data.total), parseFloat(data.deposit_amount),
      parseFloat(data.total), 'unpaid'
    );

    // Add line items
    const equipmentIds = Array.isArray(data.equipment_ids) ? data.equipment_ids : [data.equipment_ids];
    const bookingDuration = data.rental_duration || 'daily';
    for (const eqId of equipmentIds) {
      const eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(eqId);
      if (!eq) continue;

      let unitPrice;
      if (bookingDuration === '4hr') {
        unitPrice = eq.price_4hr || Math.round(eq.price_daily * 0.65 * 100) / 100;
      } else if (bookingDuration === 'overnight') {
        unitPrice = eq.price_overnight || Math.round(eq.price_daily * 1.15 * 100) / 100;
      } else {
        unitPrice = eq.price_daily;
      }

      db.prepare(`INSERT INTO booking_items (id, booking_id, equipment_id, item_name, unit_price, total_price, duration_type)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(uuid(), bookingId, eqId, eq.name, unitPrice, unitPrice, bookingDuration);
    }

    // Update customer stats
    db.prepare('UPDATE customers SET total_bookings = total_bookings + 1 WHERE id = ?').run(customerId);

    // Create contract
    const template = db.prepare('SELECT * FROM contract_templates WHERE is_default = 1 AND active = 1').get();
    if (template) {
      const contractId = uuid();
      let content = template.content
        .replace(/\{\{booking_number\}\}/g, bookingNumber)
        .replace(/\{\{event_date\}\}/g, data.event_date)
        .replace(/\{\{event_start_time\}\}/g, data.event_start_time)
        .replace(/\{\{event_end_time\}\}/g, data.event_end_time)
        .replace(/\{\{delivery_address\}\}/g, `${data.delivery_address}, ${data.delivery_city}, OK ${data.delivery_zip}`)
        .replace(/\{\{items_list\}\}/g, equipmentIds.map(id => db.prepare('SELECT name FROM equipment WHERE id = ?').get(id)?.name).filter(Boolean).join(', '))
        .replace(/\{\{total\}\}/g, parseFloat(data.total).toFixed(2))
        .replace(/\{\{deposit_amount\}\}/g, parseFloat(data.deposit_amount).toFixed(2))
        .replace(/\{\{customer_name\}\}/g, `${data.first_name} ${data.last_name}`)
        .replace(/\{\{cancellation_hours\}\}/g, settings.cancellation_hours || '48');

      db.prepare(`INSERT INTO contracts (id, booking_id, customer_id, template_id, content)
        VALUES (?, ?, ?, ?, ?)`).run(contractId, bookingId, customerId, template.id, content);
    }

    // Log activity
    db.prepare(`INSERT INTO activity_log (id, action, entity_type, entity_id, details, ip_address)
      VALUES (?, 'booking_created', 'booking', ?, ?, ?)`).run(
      uuid(), bookingId, JSON.stringify({ booking_number: bookingNumber, customer: `${data.first_name} ${data.last_name}` }), req.ip
    );

    res.render('public/booking/confirmation', {
      title: 'Booking Confirmed! - Bounce Man',
      settings,
      bookingNumber,
      bookingId,
      page: 'booking'
    });
  } catch (err) {
    console.error('[BOOKING ERROR]', err);
    res.status(500).render('error', { title: 'Booking Error', message: 'Something went wrong. Please try again or call us.', status: 500 });
  }
});

// Booking lookup
router.get('/lookup', (req, res) => {
  const settings = getSettings();
  res.render('public/booking/lookup', { title: 'Check Your Booking', settings, page: 'booking', booking: null, error: null });
});

router.post('/lookup', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const { booking_number, email } = req.body;

  const booking = db.prepare(`
    SELECT b.*, c.first_name, c.last_name, c.email, c.phone
    FROM bookings b
    JOIN customers c ON c.id = b.customer_id
    WHERE b.booking_number = ? AND c.email = ?
  `).get(booking_number, email);

  if (!booking) {
    return res.render('public/booking/lookup', {
      title: 'Check Your Booking', settings, page: 'booking',
      booking: null, error: 'Booking not found. Check your booking number and email.'
    });
  }

  const items = db.prepare('SELECT * FROM booking_items WHERE booking_id = ?').all(booking.id);
  const payments = db.prepare('SELECT * FROM payments WHERE booking_id = ? ORDER BY created_at DESC').all(booking.id);
  const contract = db.prepare('SELECT * FROM contracts WHERE booking_id = ?').get(booking.id);

  res.render('public/booking/lookup', {
    title: `Booking ${booking.booking_number}`, settings, page: 'booking',
    booking, items, payments, contract, error: null
  });
});

module.exports = router;
