const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { getDb } = require('../db');
const { v4: uuid } = require('uuid');
const dayjs = require('dayjs');
const { getSettings, generateBookingNumber, getPrice, getWetUpcharge, getBookedEquipmentIds, getDeliveryFee, getDistanceFee, resolveDeliveryFee, resolveTaxCity, calcPricing, availabilityWindow, overnightExtraHoldDate, getSaturdayOvernightSpillover, priceForBooking, weekdaySpecialApplies, isFullDayOnlyDate, maxExtraDaysAvailable, freeExtraDayDiscount, surfaceSurcharge, isoOffset, isBlockedByWetDryRule, formatRentalPeriod, fmtTime12, rentalDays } = require('../lib/helpers');
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
  const rentalDays = parseInt(req.query.rental_days) || 1;
  const eventEndDate = req.query.event_end_date || isoOffset(eventDate, rentalDays - 1);
  const readyBy = req.query.ready_by || eventStartTime;

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

  const bookedCounts = getBookedEquipmentIds(db, eventDate, eventStartTime, eventEndTime, rentalDuration);

  // For multiday: also check each additional day
  const allDayBookedMaps = [bookedCounts];
  if (rentalDays > 1 && eventDate) {
    for (let d = 1; d < rentalDays; d++) {
      const checkDate = isoOffset(eventDate, d);
      const dayMap = getBookedEquipmentIds(db, checkDate, '00:00', '23:59:59', 'daily');
      allDayBookedMaps.push(dayMap);
    }
  }

  equipment.forEach(item => {
    let maxBooked = 0;
    for (const dayMap of allDayBookedMaps) {
      maxBooked = Math.max(maxBooked, dayMap.get(item.id) || 0);
    }
    const qty = item.quantity || 1;
    item.booked = maxBooked >= qty;
    item.availableQty = qty - (bookedCounts.get(item.id) || 0);

    try {
      item.computedPrice = priceForBooking(db, item, { duration: rentalDuration, days: rentalDays, wet: false, date: eventDate });
    } catch(e) {
      item.computedPrice = item.price_daily || 0;
    }
    try {
      item.computedWetPrice = priceForBooking(db, item, { duration: rentalDuration, days: rentalDays, wet: true, date: eventDate });
    } catch(e) {
      item.computedWetPrice = null;
    }

    // Weekday special: single full-day booking on a qualifying weekday is priced at the
    // half-day rate. Expose the original (struck-through) full-day price for the badge.
    item.specialApplies = (rentalDuration === 'daily' && rentalDays <= 1 && eventDate)
      ? weekdaySpecialApplies(db, eventDate) : false;
    if (item.specialApplies) {
      try { item.regularPrice = priceForBooking(db, item, { duration: rentalDuration, days: rentalDays, wet: false, date: eventDate, ignoreSpecial: true }); } catch(e) { item.regularPrice = null; }
      try { item.regularWetPrice = priceForBooking(db, item, { duration: rentalDuration, days: rentalDays, wet: true, date: eventDate, ignoreSpecial: true }); } catch(e) { item.regularWetPrice = null; }
    }

    let extraAvail = 0;
    if (!item.booked && eventDate) {
      extraAvail = maxExtraDaysAvailable(db, item.id, eventDate, 1);
    }
    if (rentalDays > 1 && !item.booked && eventDate) {
      item.multidayUnavailable = extraAvail < (rentalDays - 1);
    } else {
      item.multidayUnavailable = false;
    }
    // Expose extra-day pricing + availability for step 2 upsell
    if (!item.booked && eventDate) {
      item.maxExtraDays = extraAvail;
      try {
        const price2 = priceForBooking(db, item, { duration: 'daily', days: 2, wet: false, date: eventDate });
        const price1 = priceForBooking(db, item, { duration: 'daily', days: 1, wet: false, date: eventDate });
        item.extraDayPrice = Math.round((price2 - price1) * 100) / 100;
      } catch(e) {
        item.extraDayPrice = null;
        item.maxExtraDays = 0;
      }
    } else {
      item.extraDayPrice = null;
      item.maxExtraDays = 0;
    }
  });

  addons.forEach(item => {
    const booked = bookedCounts.get(item.id) || 0;
    item.booked = booked >= (item.quantity || 1);
    try {
      item.computedPrice = priceForBooking(db, item, { duration: rentalDuration, days: rentalDays, wet: false, date: eventDate });
    } catch(e) {
      item.computedPrice = item.price_daily || 0;
    }
  });

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
    rentalDays, eventEndDate, readyBy,
    currentTimeLabel: currentTimeLabelStr,
    page: 'booking'
  });
});
// Check availability for multiple items on a date
router.post('/check-date', (req, res) => {
  const db = getDb();
  const { date, equipment_ids, start_time, end_time, duration, days } = req.body;

  if (!date || !equipment_ids?.length) {
    return res.json({ available: false, message: 'Date and equipment required' });
  }

  const blocked = db.prepare('SELECT * FROM blocked_dates WHERE date = ? AND equipment_id IS NULL').get(date);
  if (blocked) return res.json({ available: false, message: blocked.reason || 'Date unavailable' });

  const rentalDays = parseInt(days) || 1;
  const win = availabilityWindow(date, duration, start_time, end_time);
  const extraHoldDate = overnightExtraHoldDate(date, duration);
  const spilloverIds = getSaturdayOvernightSpillover(db, date);

  const datesToCheck = [{ date, win }];
  if (rentalDays > 1) {
    for (let d = 1; d < rentalDays; d++) {
      const checkDate = isoOffset(date, d);
      datesToCheck.push({ date: checkDate, win: { start: '00:00', end: '23:59:59' } });
    }
  }

  const unavailable = [];
  for (const eqId of equipment_ids) {
    const eqInfo = db.prepare('SELECT name, quantity FROM equipment WHERE id = ?').get(eqId);
    let isUnavailable = false;

    for (const { date: checkDate, win: checkWin } of datesToCheck) {
      const bookedCounts = getBookedEquipmentIds(db, checkDate, checkWin.start, checkWin.end, duration);
      const bookedQty = bookedCounts.get(eqId) || 0;
      if (bookedQty >= (eqInfo?.quantity || 1)) { isUnavailable = true; break; }
      const blockedItem = db.prepare('SELECT * FROM blocked_dates WHERE date = ? AND equipment_id = ?').get(checkDate, eqId);
      if (blockedItem) { isUnavailable = true; break; }
    }

    if (!isUnavailable && extraHoldDate) {
      const sunConflict = db.prepare(`
        SELECT COUNT(*) as cnt FROM bookings b
        JOIN booking_items bi ON bi.booking_id = b.id
        WHERE b.event_date = ? AND bi.equipment_id = ? AND b.status NOT IN ('cancelled', 'declined')
      `).get(extraHoldDate, eqId);
      const sunBlocked = db.prepare("SELECT id FROM blocked_dates WHERE date = ? AND (equipment_id = ? OR equipment_id IS NULL) LIMIT 1").get(extraHoldDate, eqId);
      if ((sunConflict && sunConflict.cnt >= (eqInfo?.quantity || 1)) || sunBlocked) isUnavailable = true;
    }
    if (!isUnavailable && spilloverIds.has(eqId)) isUnavailable = true;

    if (isUnavailable) unavailable.push(eqInfo?.name || 'Item');
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
  const r = await resolveDeliveryFee(db, zip);
  if (r.fee === 0) return res.json({ valid: true, fee: 0, zone: r.zone, message: 'Free delivery!' });
  if (r.miles) return res.json({ valid: true, fee: r.fee, zone: r.zone, message: `${r.city}, ${r.state} is ${r.miles} miles away. Delivery fee: $${r.fee}.` });
  return res.json({ valid: true, fee: r.fee, zone: r.zone, message: 'Delivery fee: $' + r.fee.toFixed(0) });
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
    tax_exempt_claimed, tax_exempt_cert, rental_days, event_end_date, ready_by
  } = req.body;

  // Reject a past event date — client-side flatpickr minDate is bypassable via direct POST.
  const todayCT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  if (!event_date || event_date < todayCT) {
    return res.status(400).render('error', { title: 'Invalid Event Date', message: 'Please choose an event date of today or later.', status: 400 });
  }

  const items = Array.isArray(equipment_ids) ? equipment_ids : (equipment_ids || '').split(',').filter(Boolean);
  const wetItemIds = new Set((wet_items || '').split(',').filter(Boolean));
  const duration = rental_duration || 'daily';
  const days = duration === '4hr' ? 1 : Math.min(30, Math.max(1, parseInt(rental_days) || 1));

  // Labor Day / Memorial Day are full-day single-day rentals only (no half-day, multi-day, or overnight).
  if (isFullDayOnlyDate(event_date) && (duration !== 'daily' || days > 1)) {
    return res.status(400).render('error', { title: 'Full-Day Rental Only', message: 'Labor Day and Memorial Day are full-day rentals only — please choose the Full Day option for that date.', status: 400 });
  }

  let subtotal = 0;
  const lineItems = [];
  for (const eqId of items) {
    const eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(eqId);
    if (!eq) continue;
    const isWet = wetItemIds.has(eqId);
    let unitPrice;
    try {
      unitPrice = priceForBooking(db, eq, { duration, days, wet: isWet, date: event_date });
    } catch(e) {
      const basePrice = getPrice(eq, duration);
      unitPrice = isWet ? basePrice + getWetUpcharge(eq) : basePrice;
    }
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

  const { fee: delivery_fee } = await resolveDeliveryFee(db, delivery_zip);

  let discount_amount = 0;
  if (discount_code) {
    const code = db.prepare('SELECT * FROM discount_codes WHERE code = ? AND active = 1').get(discount_code.toUpperCase());
    if (code) {
      discount_amount = code.type === 'percent'
        ? Math.round(subtotal * (code.value / 100) * 100) / 100
        : Math.min(code.value, subtotal);
    }
  }

  // Accept-then-verify: honor the exemption immediately when the customer provides a
  // permit #, so the displayed total and the actual charge match (no more "$0.00 shown
  // but tax still charged"). The claim + permit # are recorded below and surfaced on the
  // new-booking Slack card so an admin can verify the permit before delivery.
  const taxExemptClaimed = tax_exempt_claimed === '1';
  const taxExemptHonored = taxExemptClaimed && !!(tax_exempt_cert && String(tax_exempt_cert).trim());
  // Promo: 3+ items → one extra day free.
  const free_extra_day = freeExtraDayDiscount(db, items, { days, wetSet: wetItemIds, date: event_date });
  // Hard-surface (concrete/asphalt) or indoor setups need sandbags → 10% surcharge.
  const surface_fee = surfaceSurcharge(subtotal, surface_type, venue_type);
  // Tax jurisdiction from the ZIP (not the free-typed city); discount reduces the taxable base.
  const tax_city = await resolveTaxCity(delivery_zip, delivery_city);
  const pricing = calcPricing(settings, subtotal, delivery_fee, tax_city, taxExemptHonored, surface_fee, discount_amount + free_extra_day);
  const { taxRate: tax_rate, taxAmount: tax_amount, damageWaiverFee: damage_waiver_fee, total: rawTotal } = pricing;
  const total = Math.max(0, rawTotal - discount_amount - free_extra_day);
  const reviewDepositPct = parseFloat(settings.deposit_percent || '50') / 100;
  const deposit_amount = Math.floor(total * reviewDepositPct * 100) / 100;

  res.render('public/booking/step4-review', {
    title: 'Review Your Booking - Bounce Man',
    settings,
    lineItems,
    customer: { first_name, last_name, email, phone },
    delivery: { delivery_address, delivery_city, delivery_zip, delivery_notes, venue_type, surface_type, power_available },
    event: { event_date, event_start_time, event_end_time, event_type },
    pricing: { subtotal, delivery_fee, tax_rate, tax_amount, discount_amount, discount_code, free_extra_day, surface_fee, damage_waiver_fee, total, deposit_amount },
    wet_items: wet_items || '',
    rental_duration: duration,
    rental_days: days,
    event_end_date: isoOffset(event_date, days - 1),
    ready_by: ready_by || event_start_time,
    tax_exempt_claimed: taxExemptClaimed,
    tax_exempt_cert: tax_exempt_cert || '',
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
  // Reject a past event date on direct POST (mirrors the /review guard).
  const submitTodayCT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  if (!data.event_date || data.event_date < submitTodayCT) {
    return res.status(400).render('error', { title: 'Invalid Event Date', message: 'Please choose an event date of today or later.', status: 400 });
  }
  // Require the core customer/delivery fields server-side (client `required` is bypassable).
  for (const [field, label] of [['first_name','first name'],['last_name','last name'],['phone','phone'],['delivery_address','delivery address'],['delivery_city','delivery city'],['delivery_zip','delivery ZIP']]) {
    if (!data[field] || !String(data[field]).trim()) {
      return res.status(400).render('error', { title: 'Missing Information', message: `Please provide your ${label} to complete the booking.`, status: 400 });
    }
  }
  if (!(Array.isArray(data.equipment_ids) ? data.equipment_ids.length : (data.equipment_ids || '').split(',').filter(Boolean).length)) {
    return res.status(400).render('error', { title: 'No Equipment Selected', message: 'Please select at least one item to rent.', status: 400 });
  }

  try {
    // CRIT-1: Recalculate all pricing server-side
    const submitItems = Array.isArray(data.equipment_ids) ? data.equipment_ids : (data.equipment_ids || '').split(',').filter(Boolean);
    const submitWetIdsSet = new Set((data.wet_items || '').split(',').filter(Boolean));
    const submitDuration = data.rental_duration || 'daily';
    const submitDays = submitDuration === '4hr' ? 1 : Math.min(30, Math.max(1, parseInt(data.rental_days) || 1));
    const submitEndDate = isoOffset(data.event_date, submitDays - 1);

    // Labor Day / Memorial Day are full-day single-day rentals only (mirrors the /review guard).
    if (isFullDayOnlyDate(data.event_date) && (submitDuration !== 'daily' || submitDays > 1)) {
      return res.status(400).render('error', { title: 'Full-Day Rental Only', message: 'Labor Day and Memorial Day are full-day rentals only — please choose the Full Day option for that date.', status: 400 });
    }

    let recalcSubtotal = 0;
    for (const eqId of submitItems) {
      const eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(eqId);
      if (!eq) continue;
      const isWet = submitWetIdsSet.has(eqId);
      let unitPrice;
      try {
        unitPrice = priceForBooking(db, eq, { duration: submitDuration, days: submitDays, wet: isWet, date: data.event_date });
      } catch(e) {
        const basePrice = getPrice(eq, submitDuration);
        unitPrice = isWet ? basePrice + getWetUpcharge(eq) : basePrice;
      }
      recalcSubtotal += unitPrice;
    }
    const { fee: recalcDeliveryFee } = await resolveDeliveryFee(db, data.delivery_zip);
    let recalcDiscountAmount = 0;
    if (data.discount_code) {
      const code = db.prepare('SELECT * FROM discount_codes WHERE code = ? AND active = 1').get(data.discount_code.toUpperCase());
      if (code) {
        recalcDiscountAmount = code.type === 'percent'
          ? Math.round(recalcSubtotal * (code.value / 100) * 100) / 100
          : Math.min(code.value, recalcSubtotal);
      }
    }
    // Accept-then-verify: honor the exemption on entry when a permit # was provided, so
    // the charged total matches the review page. Recorded on the booking + customer below;
    // the permit # is surfaced on the Slack card for an admin to verify before delivery.
    const taxExempt = data.tax_exempt_claimed === '1' && !!(data.tax_exempt_cert && String(data.tax_exempt_cert).trim());
    // Promo: 3+ items → one extra day free (same helper the review preview uses).
    const recalcFreeExtraDay = freeExtraDayDiscount(db, submitItems, { days: submitDays, wetSet: submitWetIdsSet, date: data.event_date });
    // Hard-surface/indoor 10% surcharge (same helper the review preview uses).
    const recalcSurfaceFee = surfaceSurcharge(recalcSubtotal, data.surface_type, data.venue_type);
    // Tax jurisdiction from the ZIP (not the free-typed city); discount reduces the taxable base.
    const recalcTaxCity = await resolveTaxCity(data.delivery_zip, data.delivery_city);
    const recalcPricing = calcPricing(settings, recalcSubtotal, recalcDeliveryFee, recalcTaxCity, taxExempt, recalcSurfaceFee, recalcDiscountAmount + recalcFreeExtraDay);
    const recalcTotal = Math.max(0, recalcPricing.total - recalcDiscountAmount - recalcFreeExtraDay);
    data.subtotal = recalcSubtotal;
    data.delivery_fee = recalcDeliveryFee;
    data.surface_fee = recalcSurfaceFee;
    data.tax_rate = recalcPricing.taxRate;
    data.tax_amount = recalcPricing.taxAmount;
    data.damage_waiver_fee = recalcPricing.damageWaiverFee;
    data.total = recalcTotal;
    const depositPercent = parseFloat(settings.deposit_percent || '50') / 100;
    data.deposit_amount = Math.floor(recalcTotal * depositPercent * 100) / 100;
    // Store code discount + promo combined so downstream totals reconcile.
    data.discount_amount = recalcDiscountAmount + recalcFreeExtraDay;

    // H-3: Overnight time-normalization (defensive against crafted POSTs)
    if (data.rental_duration === 'overnight') {
      data.event_start_time = '09:00';
      data.event_end_time = '23:59';
    }

    // Availability guard: prevent double-booking
    const submitDate = data.event_date;
    const checkWin = availabilityWindow(submitDate, submitDuration, data.event_start_time, data.event_end_time);
    const extraHoldDate = overnightExtraHoldDate(submitDate, submitDuration);
    const spilloverIds = getSaturdayOvernightSpillover(db, submitDate);

    const allCheckDates = [{ date: submitDate, win: checkWin }];
    if (submitDays > 1) {
      for (let d = 1; d < submitDays; d++) {
        const cd = isoOffset(submitDate, d);
        allCheckDates.push({ date: cd, win: { start: '00:00', end: '23:59:59' } });
      }
    }

    for (const eqId of submitItems) {
      for (const { date: checkDate, win: cWin } of allCheckDates) {
        const bookedCounts = getBookedEquipmentIds(db, checkDate, cWin.start, cWin.end, submitDuration);
        const bookedQty = bookedCounts.get(eqId) || 0;
        const eqInfo = db.prepare('SELECT name, quantity FROM equipment WHERE id = ?').get(eqId);
        if (bookedQty >= (eqInfo?.quantity || 1)) {
          return res.status(409).render('error', {
            title: 'Equipment No Longer Available',
            message: `Sorry, ${eqInfo?.name || 'the selected equipment'} is not available for one or more days in your rental. Please go back and try different dates.`,
            status: 409
          });
        }
      }

      // H-1: Wet->dry rule check (mirrors sarah.js ~line 404)
      const submitWetThisItem = submitWetIdsSet.has(eqId);
      if (!submitWetThisItem && isBlockedByWetDryRule(db, eqId, submitDate, checkWin.start, false)) {
        const eqWdInfo = db.prepare('SELECT name FROM equipment WHERE id = ?').get(eqId);
        return res.status(409).render('error', {
          title: 'Equipment Unavailable',
          message: `Sorry, ${eqWdInfo?.name || 'the selected equipment'} can't be booked dry within 48 hours of a wet rental. Please choose a different date.`,
          status: 409
        });
      }

      // Overnight/Sunday spillover check on day 1
      let conflict = null;
      if (extraHoldDate) {
        conflict = db.prepare(`
          SELECT b.booking_number FROM bookings b
          JOIN booking_items bi ON bi.booking_id = b.id
          WHERE b.event_date = ? AND bi.equipment_id = ? AND b.status NOT IN ('cancelled', 'declined')
          LIMIT 1
        `).get(extraHoldDate, eqId)
          || db.prepare("SELECT id FROM blocked_dates WHERE date = ? AND (equipment_id = ? OR equipment_id IS NULL) LIMIT 1").get(extraHoldDate, eqId);
      }
      if (!conflict && spilloverIds.has(eqId)) conflict = { booking_number: 'overnight-hold' };
      if (conflict) {
        const eq = db.prepare('SELECT name FROM equipment WHERE id = ?').get(eqId);
        return res.status(409).render('error', {
          title: 'Equipment No Longer Available',
          message: `Sorry, ${eq?.name || 'the selected equipment'} was just booked for that time slot. Please go back and choose a different time.`,
          status: 409
        });
      }
    }

    // Wrap all inserts in a transaction
    let bookingId, bookingNumber, customerId, contractId = null;

    const insertTxn = db.transaction(() => {
      let customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(data.email);
      customerId = customer?.id || uuid();

      if (!customer) {
        db.prepare(`INSERT INTO customers (id, first_name, last_name, email, phone, address, city, state, zip, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'OK', ?, 'website')`).run(
          customerId, data.first_name, data.last_name, data.email, data.phone,
          data.delivery_address, data.delivery_city, data.delivery_zip
        );
      }

      bookingId = uuid();
      bookingNumber = generateBookingNumber();

      db.prepare(`INSERT INTO bookings (
        id, booking_number, customer_id, status, event_date, event_end_date, event_start_time, event_end_time,
        event_type, venue_type, delivery_address, delivery_city, delivery_state, delivery_zip,
        delivery_notes, surface_type, power_available, sms_consent,
        subtotal, delivery_fee, surface_fee, tax_amount, tax_rate, discount_amount, discount_code,
        damage_waiver_fee, total, deposit_amount, balance_due, payment_status, tax_exempt_claimed
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, 'OK', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        bookingId, bookingNumber, customerId,
        data.event_date, submitEndDate, data.event_start_time, data.event_end_time,
        data.event_type, data.venue_type,
        data.delivery_address, data.delivery_city, data.delivery_zip,
        data.delivery_notes, data.surface_type, data.power_available ? 1 : 0,
        data.sms_consent ? 1 : 0,
        parseFloat(data.subtotal), parseFloat(data.delivery_fee), parseFloat(data.surface_fee || 0),
        parseFloat(data.tax_amount), parseFloat(data.tax_rate),
        parseFloat(data.discount_amount || 0), data.discount_code || null,
        parseFloat(data.damage_waiver_fee || 0),
        parseFloat(data.total), parseFloat(data.deposit_amount),
        Math.round((parseFloat(data.total) - parseFloat(data.deposit_amount)) * 100) / 100, 'unpaid',
        (data.tax_exempt_claimed === '1') ? 1 : 0 // record the exemption REQUEST (honored only if cert-backed above)
      );

      // Record the claimed exemption permit # on the customer for admin to verify.
      // Does NOT set tax_exempt=1, so tax stays charged until an admin verifies the cert.
      if (data.tax_exempt_claimed === '1' && data.tax_exempt_cert) {
        try {
          db.prepare('UPDATE customers SET tax_exempt_cert = ? WHERE id = ?')
            .run(String(data.tax_exempt_cert).trim().slice(0, 100), customerId);
        } catch (e) { console.error('[BOOKING] store tax_exempt_cert failed:', e.message); }
      }

      // Add line items using priceForBooking
      for (const eqId of submitItems) {
        const eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(eqId);
        if (!eq) continue;
        const isWet = submitWetIdsSet.has(eqId);
        let unitPrice;
        try {
          unitPrice = priceForBooking(db, eq, { duration: submitDuration, days: submitDays, wet: isWet, date: data.event_date });
        } catch(e) {
          const basePrice = getPrice(eq, submitDuration);
          unitPrice = isWet ? basePrice + getWetUpcharge(eq) : basePrice;
        }
        const itemName = isWet ? eq.name + ' (Wet)' : eq.name;
        db.prepare(`INSERT INTO booking_items (id, booking_id, equipment_id, item_name, unit_price, total_price, duration_type, wet_option, rental_days)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uuid(), bookingId, eqId, itemName, unitPrice, unitPrice, submitDuration, isWet ? 1 : 0, submitDays);
      }

      // Update customer stats
      db.prepare('UPDATE customers SET total_bookings = total_bookings + 1 WHERE id = ?').run(customerId);

      // Create contract
      const template = db.prepare('SELECT * FROM contract_templates WHERE is_default = 1 AND active = 1').get();
      if (template) {
        contractId = uuid();
        let content2 = template.content
          .replace(/\{\{booking_number\}\}/g, bookingNumber)
          .replace(/\{\{event_date\}\}/g, data.event_date)
          .replace(/\{\{event_start_time\}\}/g, data.event_start_time)
          .replace(/\{\{event_end_time\}\}/g, data.event_end_time)
          .replace(/\{\{delivery_address\}\}/g, `${data.delivery_address}, ${data.delivery_city}, OK ${data.delivery_zip}`)
          .replace(/\{\{items_list\}\}/g, submitItems.map(id => db.prepare('SELECT name FROM equipment WHERE id = ?').get(id)?.name).filter(Boolean).join(', '))
          .replace(/\{\{total\}\}/g, parseFloat(data.total).toFixed(2))
          .replace(/\{\{deposit_amount\}\}/g, parseFloat(data.deposit_amount).toFixed(2))
          .replace(/\{\{customer_name\}\}/g, `${data.first_name} ${data.last_name}`)
          .replace(/\{\{cancellation_hours\}\}/g, settings.cancellation_hours || '48');

        db.prepare(`INSERT INTO contracts (id, booking_id, customer_id, template_id, content)
          VALUES (?, ?, ?, ?, ?)`).run(contractId, bookingId, customerId, template.id, content2);
      }

      // Log activity
      db.prepare(`INSERT INTO activity_log (id, action, entity_type, entity_id, details, ip_address)
        VALUES (?, 'booking_created', 'booking', ?, ?, ?)`).run(
        uuid(), bookingId, JSON.stringify({ booking_number: bookingNumber, customer: `${data.first_name} ${data.last_name}` }), req.ip
      );
    });

    insertTxn();

    // Sign-before-pay
    if (contractId) {
      console.log('[BOOKING] Created', bookingNumber, '-> sign agreement', contractId);
      return res.redirect(303, `/contract/${contractId}`);
    }

    // Stripe checkout
    const depositAmount = parseFloat(data.deposit_amount);
    const itemNames = submitItems.map(id => db.prepare('SELECT name FROM equipment WHERE id = ?').get(id)?.name).filter(Boolean).join(', ');
    const baseUrl = process.env.BASE_URL || 'https://bouncemanrentals.com';

    // No deposit due (comped / fully-discounted booking) — Stripe rejects sub-$0.50 charges,
    // which would otherwise strand the booking as "confirmed" but unpaid. Mark it settled
    // (balance collected on delivery), send the confirmation, and skip Stripe entirely.
    if (!(depositAmount >= 0.5)) {
      db.prepare("UPDATE bookings SET deposit_paid = 1, payment_method = 'none' WHERE id = ?").run(bookingId);
      if (data.email) {
        const bookingForEmail = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
        const itemsForEmail = db.prepare('SELECT * FROM booking_items WHERE booking_id = ?').all(bookingId);
        emailService.sendBookingConfirmation(bookingForEmail, { first_name: data.first_name, last_name: data.last_name, email: data.email }, itemsForEmail, contractId)
          .then(() => db.prepare('UPDATE bookings SET confirmation_email_sent = 1 WHERE id = ?').run(bookingId))
          .catch(err => console.error('[EMAIL ERROR]', err.message));
      }
      console.log('[BOOKING] Created', bookingNumber, '-> $0 deposit, marked settled (no Stripe)');
      return res.render('public/booking/confirmation', { title: 'Booking Confirmed! - Bounce Man', settings, bookingNumber, bookingId, page: 'booking' });
    }

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

  // Log who opened the confirmation page (real client IP via Cloudflare + user agent) so an
  // unexpected alert can be traced to a bot/crawler vs a real visitor. Not personally identifying.
  const visitorIp = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip;
  console.log('[CONFIRMATION VIEW]', bookingNumber, '| ip:', visitorIp, '| ua:', req.headers['user-agent'] || 'unknown');

  // Google Ads conversion should only fire for a genuinely paid deposit (set true below on payment).
  let depositPaid = booking.deposit_paid === 1 || booking.payment_status === 'deposit_paid';

  // Mark deposit as paid if Stripe session completed
  const notes = booking.internal_notes || '';
  const sessionMatch = notes.match(/stripe_session:(cs_[a-zA-Z0-9_]+)/);
  if (sessionMatch && !booking.confirmation_email_sent) {
    try {
      const session = await stripeService.retrieveSession(sessionMatch[1]);
      if (session.payment_status === 'paid') {
        // Set confirmation_email_sent=1 HERE (not only in the email callback below) so this
        // block runs exactly ONCE per booking. Bug fix: bookings made WITHOUT an email never
        // got this flag set, so re-opening their confirmation link re-fired the "New Booking"
        // Slack alert (and conversion events) on every visit. This is the process-once guard.
        db.prepare("UPDATE bookings SET status = 'confirmed', payment_status = 'deposit_paid', deposit_paid = 1, confirmation_email_sent = 1, balance_due = total - ?, updated_at = datetime('now') WHERE id = ?")
          .run(booking.deposit_amount, booking.id);
        depositPaid = true;
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
          // Full booking value (matches the Google Ads conversion) so Facebook and
          // Google report the same sale amount and can be compared apples-to-apples.
          value: booking.total || booking.deposit_amount,
          currency: 'USD',
          content_name: 'Bounce House Rental',
          content_type: 'product',
          order_id: bookingNumber,
          // Shared with the browser pixel event for deduplication.
          event_id: bookingNumber,
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

  // Google Enhanced Conversions for Web: hash the customer's email/phone server-side
  // (SHA-256 of normalized values) so only the HASHES reach the page — never raw PII.
  // gtag sends these with the conversion so Google can match ad clicks lost to
  // cookie/browser restrictions (~5-10% more conversions recovered).
  let ecEmailHash, ecPhoneHash;
  if (depositPaid) {
    const cust = db.prepare('SELECT email, phone FROM customers WHERE id = ?').get(booking.customer_id);
    const crypto = require('crypto');
    const sha = v => crypto.createHash('sha256').update(v).digest('hex');
    if (cust?.email) ecEmailHash = sha(cust.email.trim().toLowerCase());
    if (cust?.phone) {
      const digits = cust.phone.replace(/\D/g, '');
      const e164 = digits.length === 10 ? '+1' + digits : (digits.length === 11 && digits[0] === '1' ? '+' + digits : '+' + digits);
      ecPhoneHash = sha(e164);
    }
  }

  res.render('public/booking/confirmation', {
    title: 'Booking Confirmed! - Bounce Man',
    settings,
    bookingNumber,
    bookingId: booking.id,
    depositPaid,
    conversionValue: booking.total || booking.deposit_amount || 0,
    ecEmailHash,
    ecPhoneHash,
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

  booking.rental_period = formatRentalPeriod(booking);
  booking.time_display = fmtTime12(booking.event_start_time) + ' - ' + fmtTime12(booking.event_end_time) + (rentalDays(booking) > 1 ? ' (each day)' : '');

  res.render('public/booking/lookup', {
    title: `Booking ${booking.booking_number}`, settings, page: 'booking',
    booking, items, payments, contract, error: null
  });
});

// ============================================
// PAY BALANCE ROUTES
// ============================================

// Pay the DEPOSIT (used by the sign-before-pay flow: after signing the rental
// agreement, the customer lands here to pay the deposit via Stripe).
router.get('/pay-deposit/:bookingNumber', async (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const booking = db.prepare(`
    SELECT b.*, c.email FROM bookings b JOIN customers c ON c.id = b.customer_id
    WHERE b.booking_number = ?
  `).get(req.params.bookingNumber);

  if (!booking) {
    return res.status(404).render('error', { title: 'Not Found', message: 'Booking not found', status: 404 });
  }
  // Deposit already paid — go straight to the confirmation page.
  if (booking.deposit_paid) {
    return res.redirect(`/booking/confirmation?booking_number=${booking.booking_number}`);
  }

  const depositAmount = parseFloat(booking.deposit_amount);
  const itemNames = db.prepare('SELECT item_name FROM booking_items WHERE booking_id = ?').all(booking.id).map(i => i.item_name).join(', ');
  const baseUrl = process.env.BASE_URL || 'https://bouncemanrentals.com';

  // No deposit due — Stripe rejects sub-$0.50 charges; mark settled (balance on delivery) and confirm.
  if (!(depositAmount >= 0.5)) {
    db.prepare("UPDATE bookings SET deposit_paid = 1, payment_method = 'none' WHERE id = ?").run(booking.id);
    return res.redirect(`/booking/confirmation?booking_number=${booking.booking_number}`);
  }

  try {
    const session = await stripeService.createCheckoutSession({
      bookingId: booking.id,
      bookingNumber: booking.booking_number,
      depositAmount,
      customerEmail: booking.email,
      description: `${itemNames} — Deposit for ${booking.booking_number}`,
      successUrl: `${baseUrl}/booking/confirmation?booking_number=${booking.booking_number}`,
      cancelUrl: `${baseUrl}/booking/lookup?booking_number=${booking.booking_number}`
    });
    db.prepare("UPDATE bookings SET payment_method = 'stripe', internal_notes = ? WHERE id = ?")
      .run(`stripe_session:${session.id}`, booking.id);
    return res.redirect(303, session.url);
  } catch (err) {
    console.error('[PAY DEPOSIT] Stripe error:', err.message);
    // Stripe failed but the booking + signed agreement exist — show confirmation.
    return res.render('public/booking/confirmation', {
      title: 'Booking Confirmed! - Bounce Man',
      settings, bookingNumber: booking.booking_number, bookingId: booking.id, page: 'booking'
    });
  }
});

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
        const intentId = (session.payment_intent && session.payment_intent.id) ? session.payment_intent.id : (session.payment_intent || session.id);

        // Record the payment — idempotent: the Stripe webhook may have recorded it first
        // (both paths dedup on stripe_payment_id, so the balance is only ever counted once).
        const existing = db.prepare('SELECT id FROM payments WHERE stripe_payment_id = ?').get(intentId);
        if (!existing) {
          const paymentId = require('crypto').randomUUID();
          db.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status, created_at)
            VALUES (?, ?, ?, ?, 'charge', 'card', ?, 'completed', datetime('now'))`).run(paymentId, booking.id, booking.customer_id, amountPaid, intentId);

          const newBalance = Math.max(0, parseFloat(booking.balance_due) - amountPaid);
          const newStatus = newBalance <= 0 ? 'paid' : 'partial';
          db.prepare("UPDATE bookings SET balance_due = ?, payment_status = ?, updated_at = datetime('now') WHERE id = ?")
            .run(newBalance, newStatus, booking.id);
          try { db.prepare('UPDATE customers SET total_revenue = total_revenue + ? WHERE id = ?').run(amountPaid, booking.customer_id); } catch (e) { /* non-critical */ }
        }

        // Flip the existing Slack card(s) Payment Status in place — no new card.
        try {
          const notif = require('../services/notifications');
          await notif.refreshDeliveryCard(booking.id);
          await notif.updateBookingSlackCard(booking.id);
        } catch (e) { console.error('[PAY BALANCE] card refresh failed:', e.message); }

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

  if (booking) booking.rental_period = formatRentalPeriod(booking);
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

  booking.rental_period = formatRentalPeriod(booking);

  res.render('public/booking/manage', { title: 'Your Booking', settings, booking, contract, itemList, page: 'booking' });
});

module.exports = router;
