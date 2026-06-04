const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { getDb } = require('../db');
const { v4: uuid } = require('uuid');
const dayjs = require('dayjs');
const { getSettings, generateBookingNumber, getPrice, getWetUpcharge, getBookedEquipmentIds, getDeliveryFee, getDistanceFee, calcPricing } = require('../lib/helpers');
const emailService = require('../services/email');
const stripeService = require('../services/stripe');
const { notifyNewBooking } = require('../services/notifications');
const facebookAds = require('../services/facebook-ads');

// HIGH-6: Rate limiter for booking endpoints
const bookingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 booking attempts per hour per IP
  message: 'Too many booking attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  validate: false
});

// Step 1 — pick date & duration first
router.get('/', (req, res) => {
  const settings = getSettings();
  res.render('public/booking/step1-date', {
    title: 'Book Your Rental Online | Bounce Man | Tonkawa OK',
    metaDescription: 'Book your bounce house or water slide rental online with Bounce Man. Easy 4-step process, instant confirmation, and free delivery to Tonkawa, Ponca City & Blackwell OK.',
    canonicalPath: '/booking',
    settings,
    page: 'booking'
  });
});

// Step 2 — select equipment (filtered by date availability)
router.get('/select', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const eventDate = req.query.event_date || '';
  const rentalDuration = req.query.rental_duration || 'daily';
  const eventStartTime = req.query.event_start_time || '09:00';
  const eventEndTime = req.query.event_end_time || '19:00';

  const equipment = db.prepare(`
    SELECT e.*,
      (SELECT image_path FROM equipment_images WHERE equipment_id = e.id AND is_primary = 1 LIMIT 1) as image
    FROM equipment e WHERE e.status = 'available' AND e.category != 'add-ons' ORDER BY e.sort_order
  `).all();
  const categories = db.prepare("SELECT * FROM categories WHERE active = 1 AND slug != 'add-ons' ORDER BY sort_order").all();

  const addons = db.prepare(`
    SELECT e.*,
      (SELECT image_path FROM equipment_images WHERE equipment_id = e.id AND is_primary = 1 LIMIT 1) as image
    FROM equipment e WHERE e.status = 'available' AND e.category = 'add-ons' ORDER BY e.sort_order
  `).all();

  const bookedCounts = getBookedEquipmentIds(db, eventDate, eventStartTime, eventEndTime);
  equipment.forEach(item => {
    const booked = bookedCounts.get(item.id) || 0;
    const qty = item.quantity || 1;
    item.booked = booked >= qty;
    item.availableQty = qty - booked;
  });
  addons.forEach(item => {
    const booked = bookedCounts.get(item.id) || 0;
    item.booked = booked >= (item.quantity || 1);
  });

  // For booked equipment, find which other time windows still have availability
  const TIME_WINDOWS = [
    { label: 'Morning', start: '08:00', end: '12:00' },
    { label: 'Afternoon', start: '12:00', end: '17:00' },
    { label: 'Evening', start: '17:00', end: '21:00' },
  ];
  for (const item of equipment) {
    if (!item.booked || !eventDate) { item.availableSlots = []; continue; }
    item.availableSlots = [];
    for (const w of TIME_WINDOWS) {
      if (eventStartTime >= w.start && eventStartTime < w.end) continue;
      const wCounts = getBookedEquipmentIds(db, eventDate, w.start, w.end);
      const wBooked = wCounts.get(item.id) || 0;
      if (wBooked < (item.quantity || 1)) item.availableSlots.push(w.label);
    }
  }

  const currentTimeLabel = TIME_WINDOWS.find(function(w){ return eventStartTime >= w.start && eventStartTime < w.end; });
  const currentTimeLabelStr = currentTimeLabel ? currentTimeLabel.label : 'This time';

  res.render('public/booking/step2-select', {
    title: 'Choose Your Rentals - Bounce Man',
    settings, equipment, categories, addons,
    eventDate, rentalDuration, eventStartTime, eventEndTime,
    currentTimeLabel: currentTimeLabelStr,
    page: 'booking'
  });
});

// Check availability for multiple items on a date
router.post('/check-date', (req, res) => {
  const db = getDb();
  const { date, equipment_ids, start_time, end_time } = req.body;

  if (!date || !equipment_ids?.length) {
    return res.json({ available: false, message: 'Date and equipment required' });
  }

  // Check blocked dates
  const blocked = db.prepare('SELECT * FROM blocked_dates WHERE date = ? AND equipment_id IS NULL').get(date);
  if (blocked) return res.json({ available: false, message: blocked.reason || 'Date unavailable' });

  // Check each item (time-overlap aware)
  const unavailable = [];
  for (const eqId of equipment_ids) {
    let bookedCount;
    if (start_time && end_time) {
      bookedCount = db.prepare(`
        SELECT COUNT(*) as cnt FROM bookings b
        JOIN booking_items bi ON bi.booking_id = b.id
        WHERE b.event_date = ? AND bi.equipment_id = ? AND b.status NOT IN ('cancelled', 'declined')
          AND b.event_start_time < ? AND b.event_end_time > ?
      `).get(date, eqId, end_time, start_time);
    } else {
      bookedCount = db.prepare(`
        SELECT COUNT(*) as cnt FROM bookings b
        JOIN booking_items bi ON bi.booking_id = b.id
        WHERE b.event_date = ? AND bi.equipment_id = ? AND b.status NOT IN ('cancelled', 'declined')
      `).get(date, eqId);
    }
    const eqInfo = db.prepare('SELECT name, quantity FROM equipment WHERE id = ?').get(eqId);
    if (bookedCount && bookedCount.cnt >= (eqInfo?.quantity || 1)) unavailable.push(eqInfo?.name || 'Item');

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

// Check ZIP code against delivery zones
router.get('/check-zip', async (req, res) => {
  const db = getDb();
  const zip = req.query.zip;
  if (!zip) return res.json({ valid: false, message: 'ZIP code required' });
  const { fee, zone } = getDeliveryFee(db, zip);
  if (fee >= 0) {
    return res.json({ valid: true, fee, zone, message: fee === 0 ? 'Free delivery!' : 'Delivery fee: $' + fee.toFixed(0) });
  }
  // Out of zone — calculate by distance
  const dist = await getDistanceFee(zip);
  if (!dist) {
    return res.json({ valid: false, fee: 0, message: 'We couldn\'t verify that ZIP code. Please call (580) 308-9288.' });
  }
  res.json({ valid: true, fee: dist.fee, zone: 'Extended (' + dist.miles + ' mi)', message: dist.city + ', ' + dist.state + ' is ' + dist.miles + ' miles away. Delivery fee: $' + dist.fee + ' ($1.50/mile round trip)' });
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
router.post('/review', bookingLimiter, async (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const {
    equipment_ids, event_date, event_start_time, event_end_time,
    first_name, last_name, email, phone,
    delivery_address, delivery_city, delivery_zip,
    event_type, venue_type, surface_type, power_available,
    delivery_notes, discount_code, rental_duration, wet_items,
    tax_exempt_claimed
  } = req.body;

  const items = Array.isArray(equipment_ids) ? equipment_ids : (equipment_ids || '').split(',').filter(Boolean);
  const wetItemIds = new Set((wet_items || '').split(',').filter(Boolean));
  const duration = rental_duration || 'daily';

  let subtotal = 0;
  const lineItems = [];
  for (const eqId of items) {
    const eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(eqId);
    if (!eq) continue;
    const isWet = wetItemIds.has(eqId);
    const basePrice = getPrice(eq, duration);
    const unitPrice = isWet ? basePrice + getWetUpcharge(eq) : basePrice;
    lineItems.push({
      equipment_id: eqId,
      item_name: isWet ? eq.name + ' (Wet)' : eq.name,
      unit_price: unitPrice,
      total_price: unitPrice,
      duration_type: duration,
      wet_option: isWet ? 1 : 0,
      image: db.prepare('SELECT image_path FROM equipment_images WHERE equipment_id = ? AND is_primary = 1 LIMIT 1').get(eqId)?.image_path
    });
    subtotal += unitPrice;
  }

  let { fee: delivery_fee } = getDeliveryFee(db, delivery_zip);
  if (delivery_fee < 0) {
    const dist = await getDistanceFee(delivery_zip);
    delivery_fee = dist ? dist.fee : 100;
  }

  let discount_amount = 0;
  if (discount_code) {
    const code = db.prepare('SELECT * FROM discount_codes WHERE code = ? AND active = 1').get(discount_code.toUpperCase());
    if (code) {
      discount_amount = code.type === 'percent'
        ? Math.round(subtotal * (code.value / 100) * 100) / 100
        : code.value;
    }
  }

  const taxExemptClaimed = tax_exempt_claimed === '1';
  const pricing = calcPricing(settings, subtotal, delivery_fee, delivery_city, taxExemptClaimed);
  const { taxRate: tax_rate, taxAmount: tax_amount, damageWaiverFee: damage_waiver_fee, total: rawTotal } = pricing;
  const total = rawTotal - discount_amount;
  const reviewDepositPct = parseFloat(settings.deposit_percent || '50') / 100;
  const deposit_amount = Math.floor(total * reviewDepositPct * 100) / 100;

  res.render('public/booking/step4-review', {
    title: 'Review Your Booking - Bounce Man',
    settings,
    lineItems,
    customer: { first_name, last_name, email, phone },
    delivery: { delivery_address, delivery_city, delivery_zip, delivery_notes, venue_type, surface_type, power_available },
    event: { event_date, event_start_time, event_end_time, event_type },
    pricing: { subtotal, delivery_fee, tax_rate, tax_amount, discount_amount, discount_code, damage_waiver_fee, total, deposit_amount },
    wet_items: wet_items || '',
    rental_duration: duration,
    tax_exempt_claimed: taxExemptClaimed,
    page: 'booking'
  });
});

// Submit booking
router.post('/submit', bookingLimiter, async (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const data = req.body;

  // MED-5: Sanitize and validate customer fields
  const sanitize = (s, maxLen = 200) => (s || '').toString().trim().substring(0, maxLen);
  data.first_name = sanitize(data.first_name, 100);
  data.last_name = sanitize(data.last_name, 100);
  data.email = sanitize(data.email, 254);
  data.phone = sanitize(data.phone, 20);
  data.delivery_address = sanitize(data.delivery_address, 300);
  data.delivery_city = sanitize(data.delivery_city, 100);
  data.delivery_zip = sanitize(data.delivery_zip, 10);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    return res.status(400).send('Invalid email address');
  }

  try {
    // CRIT-1: Recalculate all pricing server-side — never trust form-submitted totals
    const submitItems = Array.isArray(data.equipment_ids) ? data.equipment_ids : (data.equipment_ids || '').split(',').filter(Boolean);
    const submitWetIdsSet = new Set((data.wet_items || '').split(',').filter(Boolean));
    const submitDuration = data.rental_duration || 'daily';
    let recalcSubtotal = 0;
    for (const eqId of submitItems) {
      const eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(eqId);
      if (!eq) continue;
      const isWet = submitWetIdsSet.has(eqId);
      const basePrice = getPrice(eq, submitDuration);
      recalcSubtotal += isWet ? basePrice + getWetUpcharge(eq) : basePrice;
    }
    let { fee: recalcDeliveryFee } = getDeliveryFee(db, data.delivery_zip);
    if (recalcDeliveryFee < 0) {
      const dist = await getDistanceFee(data.delivery_zip);
      recalcDeliveryFee = dist ? dist.fee : 100;
    }
    let recalcDiscountAmount = 0;
    if (data.discount_code) {
      const code = db.prepare('SELECT * FROM discount_codes WHERE code = ? AND active = 1').get(data.discount_code.toUpperCase());
      if (code) {
        recalcDiscountAmount = code.type === 'percent'
          ? Math.round(recalcSubtotal * (code.value / 100) * 100) / 100
          : code.value;
      }
    }
    const existingCustomer = data.email ? db.prepare('SELECT tax_exempt FROM customers WHERE email = ?').get(data.email) : null;
    const taxExempt = (existingCustomer && existingCustomer.tax_exempt) || data.tax_exempt_claimed === '1';
    const recalcPricing = calcPricing(settings, recalcSubtotal, recalcDeliveryFee, data.delivery_city, taxExempt);
    const recalcTotal = recalcPricing.total - recalcDiscountAmount;
    // Override form data with server-calculated values
    data.subtotal = recalcSubtotal;
    data.delivery_fee = recalcDeliveryFee;
    data.tax_rate = recalcPricing.taxRate;
    data.tax_amount = recalcPricing.taxAmount;
    data.damage_waiver_fee = recalcPricing.damageWaiverFee;
    data.total = recalcTotal;
    const depositPercent = parseFloat(settings.deposit_percent || '50') / 100;
    data.deposit_amount = Math.floor(recalcTotal * depositPercent * 100) / 100;
    data.discount_amount = recalcDiscountAmount;

    // Availability guard: prevent double-booking (race condition protection)
    const submitDate = data.event_date;
    const submitStartTime = data.event_start_time;
    const submitEndTime = data.event_end_time;
    for (const eqId of submitItems) {
      const conflict = db.prepare(`
        SELECT b.booking_number FROM bookings b
        JOIN booking_items bi ON bi.booking_id = b.id
        WHERE b.event_date = ? AND bi.equipment_id = ? AND b.status NOT IN ('cancelled', 'declined')
          AND b.event_start_time < ? AND b.event_end_time > ?
        LIMIT 1
      `).get(submitDate, eqId, submitEndTime, submitStartTime);
      if (conflict) {
        const eq = db.prepare('SELECT name FROM equipment WHERE id = ?').get(eqId);
        return res.status(409).render('error', {
          title: 'Equipment No Longer Available',
          message: `Sorry, ${eq?.name || 'the selected equipment'} was just booked for that time slot. Please go back and choose a different time.`,
          status: 409
        });
      }
    }

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
      delivery_notes, surface_type, power_available, sms_consent,
      subtotal, delivery_fee, tax_amount, tax_rate, discount_amount, discount_code,
      damage_waiver_fee, total, deposit_amount, balance_due, payment_status, tax_exempt_claimed
    ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, 'OK', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      bookingId, bookingNumber, customerId,
      data.event_date, data.event_start_time, data.event_end_time,
      data.event_type, data.venue_type,
      data.delivery_address, data.delivery_city, data.delivery_zip,
      data.delivery_notes, data.surface_type, data.power_available ? 1 : 0,
      data.sms_consent ? 1 : 0,
      parseFloat(data.subtotal), parseFloat(data.delivery_fee),
      parseFloat(data.tax_amount), parseFloat(data.tax_rate),
      parseFloat(data.discount_amount || 0), data.discount_code || null,
      parseFloat(data.damage_waiver_fee || 0),
      parseFloat(data.total), parseFloat(data.deposit_amount),
      parseFloat(data.total) - parseFloat(data.deposit_amount), 'unpaid',
      taxExempt ? 1 : 0
    );

    // Add line items
    const equipmentIds = Array.isArray(data.equipment_ids) ? data.equipment_ids : (data.equipment_ids || '').split(',').filter(Boolean);
    const submitWetIds = new Set((data.wet_items || '').split(',').filter(Boolean));
    const bookingDuration = data.rental_duration || 'daily';
    for (const eqId of equipmentIds) {
      const eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(eqId);
      if (!eq) continue;
      const isWet = submitWetIds.has(eqId);
      const basePrice = getPrice(eq, bookingDuration);
      const unitPrice = isWet ? basePrice + getWetUpcharge(eq) : basePrice;
      const itemName = isWet ? eq.name + ' (Wet)' : eq.name;
      db.prepare(`INSERT INTO booking_items (id, booking_id, equipment_id, item_name, unit_price, total_price, duration_type, wet_option)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(uuid(), bookingId, eqId, itemName, unitPrice, unitPrice, bookingDuration, isWet ? 1 : 0);
    }

    // Update customer stats
    db.prepare('UPDATE customers SET total_bookings = total_bookings + 1 WHERE id = ?').run(customerId);

    // Create contract
    let contractId = null;
    const template = db.prepare('SELECT * FROM contract_templates WHERE is_default = 1 AND active = 1').get();
    if (template) {
      contractId = uuid();
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

    // Create Stripe checkout session for deposit
    const depositAmount = parseFloat(data.deposit_amount);
    const itemNames = equipmentIds.map(id => db.prepare('SELECT name FROM equipment WHERE id = ?').get(id)?.name).filter(Boolean).join(', ');
    const baseUrl = process.env.BASE_URL || 'https://bouncemanrentals.com';

    try {
      const session = await stripeService.createCheckoutSession({
        bookingId,
        bookingNumber,
        depositAmount,
        customerEmail: data.email,
        description: `${itemNames} — Deposit for ${bookingNumber}`,
        successUrl: `${baseUrl}/booking/confirmation?booking_number=${bookingNumber}`,
        cancelUrl: `${baseUrl}/booking/lookup?booking_number=${bookingNumber}`
      });

      db.prepare("UPDATE bookings SET payment_method = 'stripe', internal_notes = ? WHERE id = ?")
        .run(`stripe_session:${session.id}`, bookingId);

      console.log('[BOOKING] Created', bookingNumber, '-> Stripe session', session.id);
      return res.redirect(303, session.url);
    } catch (stripeErr) {
      console.error('[STRIPE ERROR]', stripeErr.message);
      // Stripe failed but booking was created — show confirmation without payment
      if (data.email) {
        const bookingForEmail = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
        const itemsForEmail = db.prepare('SELECT * FROM booking_items WHERE booking_id = ?').all(bookingId);
        emailService.sendBookingConfirmation(bookingForEmail, { first_name: data.first_name, last_name: data.last_name, email: data.email }, itemsForEmail, contractId)
          .then(() => db.prepare('UPDATE bookings SET confirmation_email_sent = 1 WHERE id = ?').run(bookingId))
          .catch(err => console.error('[EMAIL ERROR]', err.message));
      }
      res.render('public/booking/confirmation', {
        title: 'Booking Confirmed! - Bounce Man',
        settings, bookingNumber, bookingId,
        page: 'booking'
      });
    }
  } catch (err) {
    console.error('[BOOKING ERROR]', err);
    res.status(500).render('error', { title: 'Booking Error', message: 'Something went wrong. Please try again or call us.', status: 500 });
  }
});

// Confirmation page (after Stripe success redirect)
router.get('/confirmation', async (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const bookingNumber = req.query.booking_number;

  if (!bookingNumber) {
    return res.redirect('/');
  }

  const booking = db.prepare('SELECT * FROM bookings WHERE booking_number = ?').get(bookingNumber);
  if (!booking) {
    return res.redirect('/');
  }

  // Mark deposit as paid if Stripe session completed
  const notes = booking.internal_notes || '';
  const sessionMatch = notes.match(/stripe_session:(cs_[a-zA-Z0-9_]+)/);
  if (sessionMatch && !booking.confirmation_email_sent) {
    try {
      const session = await stripeService.retrieveSession(sessionMatch[1]);
      if (session.payment_status === 'paid') {
        db.prepare("UPDATE bookings SET status = 'confirmed', payment_status = 'deposit_paid', deposit_paid = 1, balance_due = total - ?, updated_at = datetime('now') WHERE id = ?")
          .run(booking.deposit_amount, booking.id);
        console.log('[STRIPE] Deposit confirmed for', bookingNumber);

        // Send confirmation email + Slack notification now that payment is confirmed
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(booking.customer_id);
        const items = db.prepare('SELECT * FROM booking_items WHERE booking_id = ?').all(booking.id);
        if (customer?.email) {
          const contract = db.prepare('SELECT id FROM contracts WHERE booking_id = ?').get(booking.id);
          emailService.sendBookingConfirmation(
            { ...booking, payment_status: 'deposit_paid', deposit_paid: 1 },
            customer, items, contract?.id
          ).then(() => {
            db.prepare('UPDATE bookings SET confirmation_email_sent = 1 WHERE id = ?').run(booking.id);
          }).catch(err => console.error('[EMAIL ERROR]', err.message));
        }
        // Slack notification — payment confirmed
        notifyNewBooking({ ...booking, payment_status: 'deposit_paid' }, customer, items)
          .catch(err => console.error('[NOTIFY ERROR]', err.message));

        // Server-side Facebook Pixel — Purchase event
        const fbBooking = { ...booking, payment_status: 'deposit_paid', deposit_paid: 1 };
        facebookAds.sendPixelEvent('Purchase', {
          value: booking.deposit_amount,
          currency: 'USD',
          content_name: 'Bounce House Rental Deposit',
          content_type: 'product',
          order_id: bookingNumber,
          event_source_url: 'https://bouncemanrentals.com/booking/confirmation',
        }, {
          email: customer?.email,
          phone: customer?.phone,
          first_name: customer?.first_name,
          last_name: customer?.last_name,
        }).catch(err => console.error('[FB PIXEL ERROR]', err.message));
      }
    } catch (err) {
      console.error('[STRIPE CHECK ERROR]', err.message);
    }
  }

  res.render('public/booking/confirmation', {
    title: 'Booking Confirmed! - Bounce Man',
    settings,
    bookingNumber,
    bookingId: booking.id,
    page: 'booking'
  });
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

// ============================================
// PAY BALANCE ROUTES
// ============================================

// Pay remaining balance - shows amount and redirects to Stripe
router.get('/pay/:bookingNumber', async (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const booking = db.prepare(`
    SELECT b.*, c.first_name, c.last_name, c.email, c.phone
    FROM bookings b
    JOIN customers c ON c.id = b.customer_id
    WHERE b.booking_number = ?
  `).get(req.params.bookingNumber);

  if (!booking) {
    return res.status(404).render('public/error', { title: 'Not Found', settings, message: 'Booking not found' });
  }

  if (parseFloat(booking.balance_due) <= 0) {
    return res.render('public/booking/already-paid', { title: 'Already Paid', settings, booking });
  }

  // Create Stripe Checkout session for balance
  try {
    const stripe = require('../services/stripe');
    const baseUrl = process.env.BASE_URL || 'https://bouncemanrentals.com';

    const session = await stripe.createCheckoutSession({
      bookingId: booking.id,
      bookingNumber: booking.booking_number,
      depositAmount: parseFloat(booking.balance_due),
      customerEmail: booking.email,
      description: `Balance payment for booking ${booking.booking_number} - Event ${booking.event_date}`,
      successUrl: `${baseUrl}/booking/pay/${booking.booking_number}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${baseUrl}/booking/pay/${booking.booking_number}/cancel`
    });

    res.redirect(303, session.url);
  } catch (err) {
    console.error('[PAY BALANCE] Stripe error:', err.message);
    res.status(500).render('public/error', { title: 'Payment Error', settings, message: 'Unable to process payment. Please try again or call us.' });
  }
});

// Payment success
router.get('/pay/:bookingNumber/success', async (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const { session_id } = req.query;

  const booking = db.prepare(`
    SELECT b.*, c.first_name, c.last_name, c.email, c.phone, c.id as cust_id
    FROM bookings b
    JOIN customers c ON c.id = b.customer_id
    WHERE b.booking_number = ?
  `).get(req.params.bookingNumber);

  if (!booking) {
    return res.status(404).render('public/error', { title: 'Not Found', settings, message: 'Booking not found' });
  }

  // Verify payment with Stripe
  if (session_id) {
    try {
      const stripe = require('../services/stripe');
      const session = await stripe.retrieveSession(session_id);

      if (session.payment_status === 'paid') {
        const amountPaid = session.amount_total / 100;

        // Record the payment
        const paymentId = require('crypto').randomUUID();
        db.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, created_at) 
          VALUES (?, ?, ?, ?, charge, card, ?, completed, datetime(now))`).run(paymentId, booking.id, booking.cust_id, amountPaid, session.payment_intent?.id || session.id);

        // Update booking balance
        const newBalance = Math.max(0, parseFloat(booking.balance_due) - amountPaid);
        const newStatus = newBalance <= 0 ? 'paid' : 'partial';
        db.prepare('UPDATE bookings SET balance_due = ?, payment_status = ?, updated_at = datetime(now) WHERE id = ?')
          .run(newBalance, newStatus, booking.id);

        // Send Slack notification
        const slack = require('../services/notifications');
        if (slack.sendSlackMessage) {
          slack.sendSlackMessage({
            text: ':white_check_mark: *Balance Paid Online* - ' + booking.booking_number,
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text: ':white_check_mark: *Balance Paid Online*\n*' + booking.first_name + ' ' + booking.last_name + '* paid remaining balance' } },
              { type: 'section', fields: [
                { type: 'mrkdwn', text: '*Booking:*\n' + booking.booking_number },
                { type: 'mrkdwn', text: '*Amount:*\n$' + amountPaid.toFixed(2) },
                { type: 'mrkdwn', text: '*Event Date:*\n' + booking.event_date },
                { type: 'mrkdwn', text: '*Status:*\n:white_check_mark: ' + newStatus.toUpperCase() }
              ]}
            ]
          }).catch(e => console.error('[SLACK] Balance payment notification failed:', e.message));
        }

        // Send receipt email
        const email = require('../services/email');
        email.sendPaymentReceipt(booking, { first_name: booking.first_name, last_name: booking.last_name, email: booking.email }, amountPaid)
          .catch(e => console.error('[EMAIL] Receipt failed:', e.message));

        console.log('[PAY BALANCE] $' + amountPaid.toFixed(2) + ' paid for ' + booking.booking_number);
      }
    } catch (err) {
      console.error('[PAY BALANCE] Stripe verification error:', err.message);
    }
  }

  res.render('public/booking/payment-success', { title: 'Payment Complete!', settings, booking });
});

// Payment cancelled
router.get('/pay/:bookingNumber/cancel', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const booking = db.prepare('SELECT * FROM bookings WHERE booking_number = ?').get(req.params.bookingNumber);

  res.render('public/booking/payment-cancel', { title: 'Payment Cancelled', settings, booking });
});

router.get('/manage/:bookingNumber', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const booking = db.prepare(`
    SELECT b.*, c.first_name, c.last_name, c.email, c.phone
    FROM bookings b
    JOIN customers c ON c.id = b.customer_id
    WHERE b.booking_number = ?
  `).get(req.params.bookingNumber);

  if (!booking) {
    return res.status(404).render('public/error', { title: 'Not Found', settings, message: 'Booking not found' });
  }

  const items = db.prepare('SELECT item_name FROM booking_items WHERE booking_id = ?').all(booking.id);
  const contract = db.prepare('SELECT * FROM contracts WHERE booking_id = ?').get(booking.id);
  const itemList = items.map(i => i.item_name).join(', ');

  res.render('public/booking/manage', { title: 'Your Booking', settings, booking, contract, itemList, page: 'booking' });
});

module.exports = router;
