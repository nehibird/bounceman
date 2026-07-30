const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { v4: uuid } = require('uuid');
const stripeService = require('../services/stripe');
const smsService = require('../services/sms');
const emailService = require('../services/email');
const notificationsService = require('../services/notifications');
const { getSettings, generateBookingNumber, getPrice, getWetUpcharge, getBookedEquipmentIds, getDeliveryFee, resolveDeliveryFee, calcPricing, fmtDate, normalizePhone, resolveDate, overnightExtraHoldDate, getSaturdayOvernightSpillover, priceForBooking, weekdaySpecialApplies, isBlockedByWetDryRule, isoOffset, todayCT, validateBookingDate, dowOf } = require('../lib/helpers');

// Wet-capable equipment: water slides + combo units (per-unit $20 wet upcharge).
const isWetCapable = (eq) => ['water-slides', 'combo-units'].includes(eq.category) || Number(eq.price_wet) > 0;

// Find a customer by phone regardless of how the number was stored. Website bookings
// save formatted numbers ("(580) 884-7806") while Sarah saves digits-only, so an exact
// `WHERE phone = ?` match misses most customers. This strips formatting from the stored
// value and matches on the last 10 digits.
function findCustomerByPhone(db, phone) {
  const n = normalizePhone(phone);
  if (!n || n.length < 10) return null;
  return db.prepare(
    "SELECT * FROM customers WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(phone,''),'(',''),')',''),'-',''),' ',''),'+',''),'.','') LIKE '%' || ? LIMIT 1"
  ).get(n);
}

function getTwilio() {
  return require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// API key auth middleware
router.use((req, res, next) => {
  const key = req.headers['x-sarah-key'];
  if (key !== process.env.SARAH_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Vapi wraps tool arguments: {message: {toolCallList: [{function: {arguments: "..."}}]}}
// Unwrap so all route handlers can read req.body.fieldName directly.
router.use((req, res, next) => {
  const toolCall = req.body?.message?.toolCallList?.[0];
  if (toolCall?.function?.arguments) {
    const args = toolCall.function.arguments;
    try { req.body = typeof args === 'string' ? JSON.parse(args) : args; } catch (e) {}
  }
  next();
});

// ============================================================
// VAPI TOOL ENDPOINTS — Sarah's e-commerce brain
// ============================================================

// POST /api/sarah/check-availability
// Vapi calls this when customer asks about a date
router.post('/check-availability', async (req, res) => {
  try {
  const db = getDb();
  const { date: rawDate, zip } = req.body;

  if (!rawDate) return res.status(400).json({ error: 'Date required' });

  // Resolve natural language dates ("next Saturday", "April 15th", "tomorrow", etc.)
  const date = resolveDate(rawDate);
  if (!date) {
    return res.json({ available: false, message: `I didn't quite catch that date. Could you say it again, like "May tenth" or "next Saturday"?` });
  }

  // Validate date is in the future (in CENTRAL time — see todayCT)
  const today = todayCT();
  if (date < today) {
    return res.json({ available: false, message: 'That date has already passed. Can I help you find a future date?' });
  }

  // Check global blocked dates
  const blocked = db.prepare('SELECT reason FROM blocked_dates WHERE date = ? AND equipment_id IS NULL').get(date);
  if (blocked) {
    return res.json({ available: false, message: blocked.reason || 'Sorry, that date is completely booked.' });
  }

  // Get all rentable equipment (not add-ons)
  const allEquipment = db.prepare("SELECT id, name, category, quantity, price_daily, price_4hr, price_overnight, slug FROM equipment WHERE status = 'available' AND category != 'add_ons' ORDER BY sort_order").all();

  // Check each time window separately for accurate per-slot availability
  const bookedMorning   = getBookedEquipmentIds(db, date, '09:00:00', '13:00:00', '4hr');
  const bookedAfternoon = getBookedEquipmentIds(db, date, '15:00:00', '19:00:00', '4hr');
  const bookedFullDay   = getBookedEquipmentIds(db, date, '09:00:00', '19:00:00', 'daily');

  const slotAvail = (e, bookedMap) => (bookedMap.get(e.id) || 0) < (e.quantity || 1);

  const equipmentWithSlots = allEquipment.map(e => ({
    ...e,
    morningOpen:   slotAvail(e, bookedMorning),
    afternoonOpen: slotAvail(e, bookedAfternoon),
    fullDayOpen:   slotAvail(e, bookedFullDay),
    isAnyOpen:     slotAvail(e, bookedMorning) || slotAvail(e, bookedAfternoon)
  }));

  const available   = equipmentWithSlots.filter(e => e.isAnyOpen);
  const unavailable = equipmentWithSlots.filter(e => !e.isAnyOpen);

  // Weekday special (e.g. "Last Month of Summer"): a single-day FULL-DAY rental on a
  // qualifying weekday bills at the half-day rate. The website already prices this via
  // priceForBooking; Sarah used to read price_daily straight off the equipment row, so she
  // quoted the undiscounted price and never mentioned the offer. Price every unit the same
  // way the website does, and keep the regular price so she can name the saving out loud.
  const specialOn = weekdaySpecialApplies(db, date);
  const specialLabel = (() => {
    try {
      const r = db.prepare('SELECT value FROM settings WHERE key = \'weekday_special_label\'').get();
      return (r && r.value) || 'weekday special';
    } catch (e) { return 'weekday special'; }
  })();
  const priceOf = (e, opts) => priceForBooking(db, e, { duration: 'daily', days: 1, wet: false, date, ...opts });
  available.forEach(e => {
    e.fullDayPrice = priceOf(e);
    e.regularFullDayPrice = priceOf(e, { ignoreSpecial: true });
    e.fullDaySaving = Math.max(0, (e.regularFullDayPrice || 0) - (e.fullDayPrice || 0));
  });
  const specialApplies = specialOn && available.some(e => e.fullDaySaving > 0);
  // Add-ons go through priceForBooking on the website too, so price them the same way here
  // or Sarah's quote drifts from what the customer is actually charged at checkout.
  const priceAddon = (a) => {
    a.fullDayPrice = priceOf(a);
    a.regularFullDayPrice = priceOf(a, { ignoreSpecial: true });
    a.fullDaySaving = Math.max(0, (a.regularFullDayPrice || 0) - (a.fullDayPrice || 0));
    return a;
  };

  if (available.length === 0) {
    return res.json({
      available: false,
      message: `Sorry, all our equipment is booked on ${fmtDate(date)}. Would you like to try a different date?`
    });
  }

  // Get add-ons too
  const addons = db.prepare("SELECT id, name, price_daily, price_4hr FROM equipment WHERE status = 'available' AND category = 'add_ons'").all().map(priceAddon);

  // Calculate delivery fee and totals if zip provided
  const settings = getSettings();
  let delivery_fee = 0, delivery_zone = null, sample_total = null, sample_deposit = null;
  if (zip) {
    const zoneResult = await resolveDeliveryFee(db, zip);
    delivery_fee = zoneResult.fee;
    delivery_zone = zoneResult.zone;
    // Sample total using first available item (full day) so Sarah can quote a ballpark
    if (available.length > 0) {
      const samplePrice = available[0].fullDayPrice;
      const pricing = calcPricing(settings, samplePrice, delivery_fee);
      sample_total = pricing.total;
      sample_deposit = pricing.depositAmount;
    }
  }

  const listing = available.map(e => {
    const partialNote = e.fullDayOpen ? '' :
      ` [${[e.morningOpen && 'morning', e.afternoonOpen && 'afternoon'].filter(Boolean).join(' or ')} half day only]`;
    const fullDayBit = e.fullDayOpen
      ? (e.fullDaySaving > 0
        ? `, $${e.fullDayPrice} full day (${specialLabel} — normally $${e.regularFullDayPrice})`
        : `, $${e.fullDayPrice} full day`)
      : '';
    let line = `${e.name}${partialNote}: $${e.price_4hr} half day${fullDayBit}`;
    if (zip && delivery_fee === 0) line += ' (free delivery to your area)';
    else if (zip) line += ` + $${delivery_fee} delivery`;
    return line;
  }).join('. ');

  const addonListing = addons.map(a => `${a.name}: $${a.price_4hr} half day, $${a.fullDayPrice} full day`).join('. ');

  const deliveryNote = zip
    ? ` Delivery to your area: ${delivery_fee === 0 ? 'FREE' : `$${delivery_fee}`}${delivery_zone ? ` (${delivery_zone})` : ''}.`
    : '';

  const equipmentWithIds = available.map(e => ({
      id: e.id,
      name: e.name,
      category: e.category,
      price_4hr: e.price_4hr,
      price_daily: e.fullDayPrice,
      price_daily_regular: e.regularFullDayPrice,
      special_saving: e.fullDaySaving,
      price_overnight: e.price_overnight
    }));
  const addonsWithIds = addons.map(a => ({
      id: a.id,
      name: a.name,
      price_4hr: a.price_4hr,
      price_daily: a.fullDayPrice,
      price_daily_regular: a.regularFullDayPrice
    }));

  // Build result string with IDs so LLM can use them in createAndSendLink
  const equipmentLines = available.map(e => {
    const pageLink = e.slug ? ` — page (photos): https://bouncemanrentals.com/equipment/${e.slug}` : '';
    if (e.fullDayOpen) {
      const fullDay = e.fullDaySaving > 0
        ? `$${e.fullDayPrice} full day (${specialLabel}: normally $${e.regularFullDayPrice}, saves $${e.fullDaySaving})`
        : `$${e.fullDayPrice} full day`;
      return `${e.name} (equipment_id: ${e.id}) — $${e.price_4hr} half day, ${fullDay}, $${e.price_overnight} overnight${pageLink}`;
    }
    const slots = [e.morningOpen && 'morning half day (9 AM–1 PM)', e.afternoonOpen && 'afternoon half day (3–7 PM)'].filter(Boolean);
    return `${e.name} (equipment_id: ${e.id}) — $${e.price_4hr} [PARTIAL: ${slots.join(' or ')} only — do NOT book full day or overnight for this item]${pageLink}`;
  }).join('\n');
  const addonLines = addons.map(a =>
    `${a.name} (equipment_id: ${a.id}) — $${a.price_4hr} half day, $${a.fullDayPrice} full day`
  ).join('\n');
  const unavailLine = unavailable.length > 0 ? `\nFully booked (do not offer): ${unavailable.map(e => e.name).join(', ')}.` : '';
  const deliveryLine = zip ? (delivery_fee === 0 ? `\nDelivery: FREE to zip ${zip}.` : `\nDelivery fee: $${delivery_fee} to zip ${zip}.`) : '';

  // The model reliably acts on this string, not on the adjacent JSON fields — so the special
  // has to be stated here in words, not just priced in.
  const specialLine = specialApplies
    ? `\n\nSPECIAL ACTIVE — ${specialLabel}: on this date a FULL DAY is billed at the half-day price. The full-day prices above are already discounted. Tell the caller about this offer and name the saving; it applies to single-day full-day rentals on qualifying weekdays only (not half day, not multi-day, not overnight).`
    : '';

  const resultText = `Available on ${fmtDate(date)} (${date}):\n${equipmentLines}\nAdd-ons:\n${addonLines}${unavailLine}${deliveryLine}${specialLine}\n\nWhen the caller picks a unit, call sendCheckoutLink with ONLY the equipment_id of the unit or units they actually chose. Never pass this whole list — sending every ID books every unit.`;

  res.json({
    result: resultText,
    available: true,
    date,
    date_formatted: fmtDate(date),
    delivery_fee,
    delivery_zone,
    equipment: equipmentWithIds,
    addons: addonsWithIds,
    unavailable: unavailable.map(e => e.name),
    special_active: specialApplies,
    special_label: specialApplies ? specialLabel : null,
    message: `Great news! On ${fmtDate(date)} we have: ${listing}. Add-ons: ${addonListing}.${deliveryNote}${unavailable.length > 0 ? ` Already booked that day: ${unavailable.map(e => e.name).join(', ')}.` : ''}${specialApplies ? ` Heads up — our ${specialLabel} is on for that day: a full day costs the half-day price.` : ''}`
  });
  } catch (err) {
    console.error('[sarah] check-availability error:', err);
    return res.status(200).json({ result: 'Sorry, I had trouble checking that — let me try again.', available: false });
  }
});

// POST /api/sarah/list-equipment
// Vapi calls this when customer asks "what do you have?"
router.post('/list-equipment', (req, res) => {
  const db = getDb();

  const equipment = db.prepare("SELECT id, name, category, description, short_description, dimensions, capacity_kids, age_range, price_4hr, price_daily, price_overnight FROM equipment WHERE status = 'available' AND category != 'add_ons' ORDER BY sort_order").all();
  const addons = db.prepare("SELECT id, name, description, price_4hr, price_daily FROM equipment WHERE status = 'available' AND category = 'add_ons' ORDER BY sort_order").all();

  const listing = equipment.map(e => {
    let desc = `${e.name}`;
    if (e.capacity_kids) desc += ` (fits ${e.capacity_kids} kids)`;
    desc += `: $${e.price_4hr} for 4 hours, $${e.price_daily} full day`;
    return desc;
  }).join('. ');

  const addonListing = addons.map(a => `${a.name}: $${a.price_4hr} for 4 hours, $${a.price_daily} full day`).join('. ');

  res.json({
    equipment: equipment.map(e => ({
      id: e.id,
      name: e.name,
      category: e.category,
      description: e.short_description || e.description,
      dimensions: e.dimensions,
      capacity_kids: e.capacity_kids,
      age_range: e.age_range,
      price_4hr: e.price_4hr,
      price_daily: e.price_daily,
      price_overnight: e.price_overnight
    })),
    addons: addons.map(a => ({
      id: a.id,
      name: a.name,
      description: a.description,
      price_4hr: a.price_4hr,
      price_daily: a.price_daily
    })),
    message: `We have ${equipment.length} rental items: ${listing}. We also have add-ons: ${addonListing}.`
  });
});

// POST /api/sarah/get-quote
// Vapi calls this to calculate a total before sending payment link
router.post('/get-quote', async (req, res) => {
  try {
  const db = getDb();
  const settings = getSettings();
  const { equipment_ids, duration, delivery_zip, wet } = req.body;

  if (!equipment_ids || !equipment_ids.length) {
    return res.status(400).json({ error: 'At least one equipment_id required' });
  }

  const dur = duration || 'daily';
  const reqDaysQuote = parseInt(req.body.days) || 1;
  let subtotal = 0;
  const lineItems = [];

  for (const eqId of equipment_ids) {
    const eq = db.prepare('SELECT * FROM equipment WHERE id = ? AND status = ?').get(eqId, 'available');
    if (!eq) continue;
    const useWet = wet === true && isWetCapable(eq);
    const price = priceForBooking(db, eq, { duration: dur, days: reqDaysQuote, wet: useWet, date: req.body.date || null });
    lineItems.push({ id: eq.id, name: useWet ? eq.name + ' (Wet)' : eq.name, price, duration: dur });
    subtotal += price;
  }

  if (lineItems.length === 0) {
    return res.status(400).json({ error: 'No valid equipment found for those IDs' });
  }

  const { fee: delivery_fee, zone: zone_name } = await resolveDeliveryFee(db, delivery_zip);
  const { taxAmount: tax_amount, damageWaiverFee: damage_waiver_fee, total, depositAmount: deposit_amount } = calcPricing(settings, subtotal, delivery_fee, req.body.delivery_city || null);

  const itemList = lineItems.map(i => `${i.name} ($${i.price})`).join(', ');

  res.json({
    line_items: lineItems,
    subtotal,
    delivery_fee,
    delivery_zone: zone_name,
    tax_amount,
    damage_waiver_fee,
    total,
    deposit_amount,
    balance_due: Math.round((total - deposit_amount) * 100) / 100,
    duration: dur,
    message: `Here's your quote: ${itemList}. Subtotal $${subtotal.toFixed(2)}, delivery $${delivery_fee.toFixed(2)}, tax $${tax_amount.toFixed(2)}, total $${total.toFixed(2)}. To reserve, the deposit is $${deposit_amount.toFixed(2)} and the remaining $${(total - deposit_amount).toFixed(2)} is due on delivery day.`
  });
  } catch (err) {
    console.error('[sarah] get-quote error:', err);
    return res.status(200).json({ error: 'quote_failed', message: 'Sorry, I had trouble building that quote.' });
  }
});

// POST /api/sarah/create-and-send-link
// The big one — creates a booking + Stripe checkout + texts payment link
router.post('/create-and-send-link', async (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const {
    first_name, last_name, email, phone,
    equipment_ids, duration,
    event_date, event_start_time, event_end_time,
    delivery_address, delivery_city, delivery_zip,
    event_type, surface_type, discount_code,
    power_available, wet
  } = req.body;

  // Validate required fields (street address + zip required for phone bookings)
  if (!first_name || !phone || !equipment_ids?.length || !event_date || !delivery_address || !delivery_zip) {
    const missing = [];
    if (!first_name) missing.push('first name');
    if (!phone) missing.push('phone number');
    if (!equipment_ids?.length) missing.push('equipment selection');
    if (!event_date) missing.push('event date');
    if (!delivery_address) missing.push('delivery street address');
    if (!delivery_zip) missing.push('delivery zip code');
    return res.status(400).json({
      error: `Missing required info: ${missing.join(', ')}`,
      missing_fields: missing
    });
  }

  try {
    const dur = duration || 'daily';

    // -- Normalize date to ISO (YYYY-MM-DD) + canonical 24h slot times so Sarah's
    //    bookings match the website format (blocked_dates, reminders, lead-time all read them). --
    const eventDateISO = resolveDate(event_date);
    if (!eventDateISO || !/^\d{4}-\d{2}-\d{2}$/.test(eventDateISO)) {
      return res.json({ success: false, error: `I couldn't lock in that date. Could you say it like "June fourteenth"?` });
    }
    const to24h = t => {
      if (!t) return null;
      const m = String(t).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
      if (!m) return null;
      let h = parseInt(m[1]); const min = m[2] || '00'; const mer = (m[3] || '').toUpperCase();
      if (mer === 'PM' && h !== 12) h += 12;
      if (mer === 'AM' && h === 12) h = 0;
      return `${String(h).padStart(2, '0')}:${min}`;
    };
    let startTime, endTime;
    if (dur === 'daily') { startTime = '09:00'; endTime = '19:00'; }
    // Overnight = full day + the night: 9 AM drop-off, held through the night (stored 23:59
    // of day 1 so it occupies all of day 1); "9 AM next-day pickup" is display-only.
    else if (dur === 'overnight') { startTime = '09:00'; endTime = '23:59'; }
    else { // 4hr — morning vs afternoon from requested start time
      const reqStart = to24h(event_start_time);
      const startH = reqStart ? parseInt(reqStart.split(':')[0]) : 9;
      if (startH >= 12) { startTime = '15:00'; endTime = '19:00'; }
      else { startTime = '09:00'; endTime = '13:00'; }
    }

    // -- Booking guards (Sarah previously bypassed every calendar rule the website enforces) --
    // Shared with send-checkout-link so both paths enforce identical rules — see
    // helpers.validateBookingDate.
    const guard = validateBookingDate(db, eventDateISO, { duration: dur, startTime });
    if (guard) return res.json({ success: false, ...guard });
    // Sunday occupancy below is whole-day rather than half-day split.
    const dow = dowOf(eventDateISO);

    // Calculate pricing (wet upcharge applies to water-capable units when caller chose wet)
    const reqDays = Math.min(30, Math.max(1, parseInt(req.body.days) || 1));
    let subtotal = 0;
    const lineItems = [];
    for (const eqId of equipment_ids) {
      const eq = db.prepare('SELECT * FROM equipment WHERE id = ? AND status = ?').get(eqId, 'available');
      if (!eq) continue;
      const useWet = wet === true && isWetCapable(eq);
      const unitPrice = priceForBooking(db, eq, { duration: dur, days: reqDays, wet: useWet, date: eventDateISO });
      lineItems.push({ equipment_id: eq.id, item_name: useWet ? eq.name + ' (Wet)' : eq.name, unit_price: unitPrice, total_price: unitPrice, duration_type: dur, wet_option: useWet ? 1 : 0 });
      subtotal += unitPrice;
    }

    if (lineItems.length === 0) {
      return res.status(400).json({ error: 'None of the selected equipment is available' });
    }

    // Verify date availability using buffered getBookedEquipmentIds + wet/dry rule (same as website)
    let checkStart, checkEnd;
    if (dur === 'overnight') {
      // Overnight occupies all of day 1.
      checkStart = '09:00:00'; checkEnd = '23:59:59';
    } else if (dow === 0) {
      // Sunday: whole-day occupancy (no half-day splitting on Sundays).
      checkStart = '00:00:00'; checkEnd = '23:59:59';
    } else if (dur === 'daily') {
      checkStart = '09:00:00'; checkEnd = '19:00:00';
    } else { // 4hr — determine morning vs afternoon from event_start_time
      const sh = event_start_time ? parseInt(String(event_start_time).match(/\d{1,2}/)?.[0] || '9', 10) : 9;
      if (sh >= 12) { checkStart = '15:00:00'; checkEnd = '19:00:00'; }
      else           { checkStart = '09:00:00'; checkEnd = '13:00:00'; }
    }
    // Use buffered getBookedEquipmentIds + wet/dry rule (same as website)
    const bookedCounts = getBookedEquipmentIds(db, eventDateISO, checkStart, checkEnd, dur);
    for (const item of lineItems) {
      const eq = db.prepare('SELECT quantity FROM equipment WHERE id = ?').get(item.equipment_id);
      const totalQty = eq ? (eq.quantity || 1) : 1;
      const bookedQty = bookedCounts.get(item.equipment_id) || 0;
      if (bookedQty >= totalQty) {
        return res.json({ success: false, error: `Sorry, ${item.item_name} is fully booked for that time on ${fmtDate(eventDateISO)}. Want to try a different slot or date?` });
      }
      const useWetItem = item.wet_option === 1;
      if (!useWetItem && isBlockedByWetDryRule(db, item.equipment_id, eventDateISO, checkStart, false)) {
        return res.json({ success: false, error: `Sorry, ${item.item_name} can't be booked dry within 48 hours of a wet rental. Want to try a different date?` });
      }
    }
    // Multiday: check each extra day
    if (reqDays > 1) {
      for (let d = 1; d < reqDays; d++) {
        const extraDate = isoOffset(eventDateISO, d);
        const extraCounts = getBookedEquipmentIds(db, extraDate, '00:00', '23:59:59', 'daily');
        for (const item of lineItems) {
          const eq = db.prepare('SELECT quantity FROM equipment WHERE id = ?').get(item.equipment_id);
          const totalQty = eq ? (eq.quantity || 1) : 1;
          if ((extraCounts.get(item.equipment_id) || 0) >= totalQty) {
            return res.json({ success: false, error: `Sorry, ${item.item_name} isn't available on day ${d+1} of your ${reqDays}-day rental. Want to try different dates?` });
          }
        }
      }
    }

    const { fee: delivery_fee } = await resolveDeliveryFee(db, delivery_zip);

    // Apply discount code if provided (canonical order: compute discount but DON'T subtract from subtotal yet)
    let discount_amount = 0;
    let applied_code = null;
    if (discount_code) {
      const code = db.prepare('SELECT * FROM discount_codes WHERE code = ? AND active = 1').get(discount_code.toUpperCase());
      if (code) {
        discount_amount = code.type === 'percent'
          ? Math.round(subtotal * (code.value / 100) * 100) / 100
          : Math.min(code.value, subtotal);
        applied_code = code.code;
        db.prepare('UPDATE discount_codes SET uses_count = uses_count + 1 WHERE id = ?').run(code.id);
        // DO NOT subtract from subtotal yet — tax must be computed on undiscounted subtotal
      }
    }

    const { taxRate: tax_rate, taxAmount: tax_amount, damageWaiverFee: damage_waiver_fee, total: rawTotal, depositAmount: deposit_amount_raw } = calcPricing(settings, subtotal, delivery_fee, delivery_city);
    const total = Math.round((rawTotal - discount_amount) * 100) / 100;
    const deposit_amount = Math.min(parseFloat(settings.deposit_flat || '50'), total);  // flat $50 deposit

    // Create or find customer (format-agnostic so returning website customers aren't duplicated)
    let customer = findCustomerByPhone(db, phone);
    if (!customer && email) {
      customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(email);
    }
    const customerId = customer?.id || uuid();

    if (!customer) {
      db.prepare(`INSERT INTO customers (id, first_name, last_name, email, phone, address, city, state, zip, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'OK', ?, 'phone')`).run(
        customerId, first_name, last_name || '', email || null, normalizePhone(phone),
        delivery_address || null, delivery_city || null, delivery_zip || null
      );
    }

    const powerAvailable = power_available === false ? 0 : 1;

    // Create booking
    const bookingId = uuid();
    const bookingNumber = generateBookingNumber();

    // H-4: compute event_end_date for multiday sarah bookings (days 2+ otherwise invisible to availability)
    const sarahEndDate = reqDays > 1 ? require('../lib/helpers').isoOffset(eventDateISO, reqDays - 1) : null;

    db.prepare(`INSERT INTO bookings (
      id, booking_number, customer_id, status, event_date, event_end_date, event_start_time, event_end_time,
      event_type, venue_type, delivery_address, delivery_city, delivery_state, delivery_zip,
      surface_type, power_available,
      subtotal, delivery_fee, tax_amount, tax_rate, discount_amount,
      damage_waiver_fee, total, deposit_amount, balance_due, payment_status, source
    ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, 'residential', ?, ?, 'OK', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sarah')`).run(
      bookingId, bookingNumber, customerId,
      eventDateISO, sarahEndDate, startTime, endTime,
      event_type || 'birthday_party',
      delivery_address || '', delivery_city || '', delivery_zip || '',
      surface_type || 'grass',
      powerAvailable,
      subtotal, delivery_fee, tax_amount, tax_rate, discount_amount,
      damage_waiver_fee, total, deposit_amount, Math.round((total - deposit_amount) * 100) / 100, 'unpaid'
    );

    // Add line items
    for (const item of lineItems) {
      db.prepare(`INSERT INTO booking_items (id, booking_id, equipment_id, item_name, unit_price, total_price, duration_type, wet_option, rental_days)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uuid(), bookingId, item.equipment_id, item.item_name, item.unit_price, item.total_price, item.duration_type, item.wet_option || 0, reqDays);
    }

    // Update customer stats
    db.prepare('UPDATE customers SET total_bookings = total_bookings + 1 WHERE id = ?').run(customerId);

    // Create Stripe checkout session for deposit
    const baseUrl = process.env.EVENT_BASE_URL || 'https://bouncemanrentals.com/event';
    const itemNames = lineItems.map(i => i.item_name).join(', ');

    const session = await stripeService.createCheckoutSession({
      bookingId,
      bookingNumber,
      depositAmount: deposit_amount,
      customerEmail: email || undefined,
      description: `${itemNames} — ${fmtDate(eventDateISO)} — Deposit`,
      successUrl: `${baseUrl.replace('/event', '')}/booking/lookup?booking_number=${bookingNumber}&paid=1`,
      cancelUrl: `${baseUrl.replace('/event', '')}/booking/lookup?booking_number=${bookingNumber}`
    });

    // Store Stripe session ID on booking
    db.prepare("UPDATE bookings SET payment_method = 'stripe', internal_notes = ? WHERE id = ?")
      .run(`stripe_session:${session.id}`, bookingId);

    // Create contract from default template
    let contractId = null;
    try {
      const template = db.prepare('SELECT * FROM contract_templates WHERE is_default = 1 AND active = 1').get();
      if (template) {
        contractId = uuid();
        const customerForContract = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
        const content = (template.content || '')
          .replace(/\{\{customer_name\}\}/g, `${first_name} ${last_name || ''}`.trim())
          .replace(/\{\{booking_number\}\}/g, bookingNumber)
          .replace(/\{\{event_date\}\}/g, fmtDate(eventDateISO))
          .replace(/\{\{equipment\}\}/g, lineItems.map(i => i.item_name).join(', '))
          .replace(/\{\{total\}\}/g, `$${total.toFixed(2)}`);
        db.prepare('INSERT INTO contracts (id, booking_id, customer_id, template_id, content) VALUES (?, ?, ?, ?, ?)')
          .run(contractId, bookingId, customerId, template.id, content);
      }
    } catch (contractErr) {
      console.error('[SARAH] Contract creation failed (non-fatal):', contractErr.message);
    }

    // Notify Slack #bookings of new booking
    const bookingForNotify = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    const customerForNotify = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    notificationsService.notifyNewBooking(bookingForNotify, customerForNotify, lineItems)
      .catch(err => console.error('[SARAH] Slack notify failed (non-fatal):', err.message));

    // Payment link URL
    const paymentUrl = session.url;

    // Send booking confirmation SMS (A2P 10DLC campaign verified 2026-04-27)
    const smsBody = `Hi ${first_name}! Here's your Bounce Man booking for ${fmtDate(eventDateISO)}:\n\n` +
      `${itemNames}\n` +
      `Total: $${total.toFixed(2)}\n` +
      `Deposit due now: $${deposit_amount.toFixed(2)}\n\n` +
      `Pay here: ${paymentUrl}\n\n` +
      `Booking #${bookingNumber} — Questions? Call (580) 308-9288`;
    // Track the real outcome — this used to swallow the failure and still report success.
    let smsOk = false;
    try {
      await smsService.sendSms(phone, smsBody);
      smsOk = true;
      console.log('[SARAH] SMS sent to', phone);
    } catch (smsErr) {
      console.error('[SARAH] SMS failed:', smsErr.message);
    }

    // Log activity
    db.prepare(`INSERT INTO activity_log (id, action, entity_type, entity_id, details, ip_address)
      VALUES (?, 'booking_created_by_sarah', 'booking', ?, ?, ?)`).run(
      uuid(), bookingId, JSON.stringify({ booking_number: bookingNumber, customer: `${first_name} ${last_name || ''}`, source: 'phone_ai' }), req.ip
    );

    console.log(`[SARAH] Booking ${bookingNumber} created for ${phone}, payment URL: ${paymentUrl}`);

    res.json({
      result: `Booking confirmed! Number: ${bookingNumber}. Total: $${total.toFixed(2)}. Deposit: $${deposit_amount.toFixed(2)} due now. Balance: $${(total - deposit_amount).toFixed(2)} due on delivery. Payment link texted to customer. URL: ${paymentUrl}`,
      success: true,
      booking_number: bookingNumber,
      booking_id: bookingId,
      stripe_session_id: session.id,
      total: total,
      deposit_amount: deposit_amount,
      balance_due: Math.round((total - deposit_amount) * 100) / 100,
      payment_url: paymentUrl,
      sms_sent: smsOk,
      message: `I've created booking #${bookingNumber}! To lock it in, pay the deposit of $${deposit_amount.toFixed(2)} at this link: ${paymentUrl} — that's your secure Stripe checkout. The remaining $${(total - deposit_amount).toFixed(2)} is due on delivery day. Do you have a pen or can you pull that up right now?`
    });
  } catch (err) {
    console.error('[SARAH] Create booking error:', err);
    res.status(500).json({ error: `Booking failed: ${err.message}` });
  }
});

// POST /api/sarah/send-checkout-link
// Texts the customer a PRE-FILLED website checkout link (unit + date/time + wet
// already selected). The customer fills in their own info/address and pays the
// deposit on the site, which calculates delivery + tax. No booking is created here.
router.post('/send-checkout-link', async (req, res) => {
  const db = getDb();
  const { equipment_ids, duration, wet, event_date, event_start_time, phone, days } = req.body;
  const reqDays = Math.min(30, Math.max(1, parseInt(days) || 1));

  if (!phone) return res.status(400).json({ error: 'phone required' });
  if (!equipment_ids || !equipment_ids.length) {
    return res.json({ success: false, error: 'I need to know which unit before I can send a link.' });
  }

  const eventDateISO = resolveDate(event_date);
  if (!eventDateISO || !/^\d{4}-\d{2}-\d{2}$/.test(eventDateISO)) {
    return res.json({ success: false, error: `I couldn't lock in that date — could you say it like "July fourth"?` });
  }

  // Never text a checkout link to our own business line. If caller-phone resolution failed
  // upstream, {{customerPhone}} is BM_NUMBER and the customer silently never gets the link —
  // this is what happened on CALL #25. Fail loudly instead of pretending it was sent.
  const BM_NUMBER_DIGITS = '5803089288';
  if (normalizePhone(phone) === BM_NUMBER_DIGITS) {
    console.error('[SARAH] REFUSED checkout link to Bounce Man\'s own number — caller phone did not resolve');
    return res.json({
      success: false,
      error: `I don't have a good number to text that to. What's the best number to send the checkout link to?`
    });
  }

  // Sundays are full-day or overnight only — bump a half-day request up to full day.
  const dow = new Date(`${eventDateISO}T12:00:00`).getDay();
  let dur = duration || 'daily';
  if (dow === 0 && dur === '4hr') dur = 'daily';
  if (reqDays > 1 && dur === '4hr') dur = 'daily'; // multi-day is billed as full days

  // Time window by duration (matches the website + overnight 9->9 model).
  let startTime, endTime;
  if (dur === 'overnight') { startTime = '09:00'; endTime = '23:59'; }
  else if (dur === 'daily') { startTime = '09:00'; endTime = '19:00'; }
  else { // 4hr — morning vs afternoon from requested start hour
    const sh = event_start_time ? parseInt(String(event_start_time).match(/\d{1,2}/)?.[0] || '9', 10) : 9;
    if (sh >= 12) { startTime = '15:00'; endTime = '19:00'; }
    else { startTime = '09:00'; endTime = '13:00'; }
  }

  // Calendar rules the website enforces. These previously existed only in
  // create-and-send-link, which the live assistant does not call — so a link could be texted
  // for an off-season, blocked, past, or <24h date and only get rejected once the customer
  // had already tapped through to the site.
  // Use `dur`/`startTime` (post Sunday-bump) so the Sunday rule auto-corrects a half-day
  // request rather than erroring, and the lead-time check uses the real start hour.
  const guard = validateBookingDate(db, eventDateISO, { duration: dur, startTime });
  if (guard) return res.json({ success: false, ...guard });

  // Validate units + figure out which are wet.
  const validIds = [];
  const wetIds = [];
  const names = [];
  for (const id of equipment_ids) {
    const eq = db.prepare("SELECT * FROM equipment WHERE id = ? AND status = 'available'").get(id);
    if (!eq) continue;
    validIds.push(eq.id);
    names.push(eq.name);
    if (wet === true && isWetCapable(eq)) wetIds.push(eq.id);
  }
  if (!validIds.length) {
    return res.json({ success: false, error: "I couldn't find that unit — want me to recheck what's available?" });
  }

  // Backstop: the model sometimes hands back every ID from the checkAvailability listing
  // instead of the one the caller chose, which texts a checkout link for the whole fleet.
  // Nobody rents every unit we own, so treat "all available rentable units" as a mistake and
  // make Sarah confirm rather than sending it.
  try {
    const rentable = validIds.filter(id => {
      const e = db.prepare('SELECT category FROM equipment WHERE id = ?').get(id);
      return e && e.category !== 'add_ons';
    });
    if (rentable.length >= 3) {
      const openNow = db.prepare('SELECT id FROM equipment WHERE status = \'available\' AND category != \'add_ons\'').all().map(r => r.id);
      const coversEverything = openNow.length > 0 && openNow.every(id => rentable.includes(id));
      if (coversEverything) {
        console.error('[SARAH] REFUSED checkout link covering every rentable unit —', rentable.length, 'units; model likely passed the whole list');
        return res.json({
          success: false,
          error: "Just to make sure I get this right — which unit did you want? I don't want to send you a link for all of them."
        });
      }
    }
  } catch (e) { console.error('[SARAH] all-units guard failed:', e.message); }

  // Re-check availability at send time — the unit may have been booked between
  // checkAvailability and the caller making up their mind.
  try {
    const win = dur === 'overnight' ? ['09:00:00', '23:59:00'] : (dur === 'daily' ? ['09:00:00', '19:00:00'] : [startTime + ':00', endTime + ':00']);
    const bookedNow = getBookedEquipmentIds(db, eventDateISO, win[0], win[1], dur);
    const takenNames = [];
    for (const id of validIds) {
      const eq = db.prepare('SELECT name, quantity FROM equipment WHERE id = ?').get(id);
      if (eq && (bookedNow.get(id) || 0) >= (eq.quantity || 1)) takenNames.push(eq.name);
    }
    if (takenNames.length) {
      return res.json({
        success: false,
        error: `Someone just booked the ${takenNames.join(' and ')} for ${fmtDate(eventDateISO)} while we were talking. Want me to check what else is open that day?`
      });
    }
  } catch (e) { console.error('[SARAH] send-checkout-link availability recheck failed:', e.message); }

  const publicBase = (process.env.EVENT_BASE_URL || 'https://bouncemanrentals.com/event').replace('/event', '');
  let q = `items=${validIds.join(',')}&event_date=${eventDateISO}&rental_duration=${dur}&event_start_time=${startTime}&event_end_time=${endTime}`;
  if (wetIds.length) q += `&wet_items=${wetIds.join(',')}`;
  if (reqDays > 1) q += `&rental_days=${reqDays}&event_end_date=${isoOffset(eventDateISO, reqDays - 1)}`;
  const link = `${publicBase}/booking/details?${q}`;

  const nameList = names.join(', ');
  const smsBody = `Here's your checkout link for ${nameList} on ${fmtDate(eventDateISO)}! Fill out your info and pay the deposit to lock it in — once the deposit's in, your date is reserved:\n\n${link}\n\nQuestions? Call (580) 308-9288`;
  try {
    await smsService.sendSms(phone, smsBody);
    console.log('[SARAH] checkout link sent to', phone, '->', link);
  } catch (smsErr) {
    console.error('[SARAH] checkout link SMS failed:', smsErr.message);
    return res.status(500).json({ success: false, error: `Couldn't send the text: ${smsErr.message}` });
  }

  return res.json({
    success: true,
    link,
    sms_sent: true,
    message: `Sent! I just texted you a checkout link for ${nameList}. Fill out your info and pay the deposit and you're locked in — once the deposit's in, your date is reserved.`
  });
});

// POST /api/sarah/check-payment
// Vapi calls this to see if customer completed the Stripe payment
router.post('/check-payment', async (req, res) => {
  const { booking_number } = req.body;
  if (!booking_number) return res.status(400).json({ error: 'booking_number required' });

  const db = getDb();
  const booking = db.prepare('SELECT * FROM bookings WHERE booking_number = ?').get(booking_number);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  // Check if already marked paid
  if (booking.payment_status === 'deposit_paid' || booking.deposit_paid === 1) {
    return res.json({
      paid: true,
      booking_number: booking.booking_number,
      message: `Your deposit for booking #${booking.booking_number} has been received! You're all set for ${fmtDate(booking.event_date)}. We'll reach out before your event with delivery details.`
    });
  }

  // Try to check Stripe if we have a session ID
  const notes = booking.internal_notes || '';
  const sessionMatch = notes.match(/stripe_session:(cs_[a-zA-Z0-9_]+)/);
  if (sessionMatch) {
    try {
      const session = await stripeService.retrieveSession(sessionMatch[1]);
      if (session.payment_status === 'paid') {
        // Update booking
        db.prepare(`UPDATE bookings SET
          payment_status = 'deposit_paid', deposit_paid = 1,
          balance_due = total - ?, updated_at = datetime('now')
          WHERE id = ?`).run(booking.deposit_amount, booking.id);

        // Send confirmation email if customer has email on file
        try {
          const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(booking.customer_id);
          const items = db.prepare('SELECT * FROM booking_items WHERE booking_id = ?').all(booking.id);
          const contract = db.prepare('SELECT id FROM contracts WHERE booking_id = ?').get(booking.id);
          if (customer?.email) {
            emailService.sendBookingConfirmation(
              { ...booking, payment_status: 'deposit_paid', deposit_paid: 1 },
              customer, items, contract?.id
            ).catch(err => console.error('[SARAH] Confirmation email failed:', err.message));
          }
        } catch (emailErr) {
          console.error('[SARAH] Email lookup failed:', emailErr.message);
        }

        return res.json({
          paid: true,
          booking_number: booking.booking_number,
          message: `Your deposit for booking #${booking.booking_number} has been received! You're all set for ${fmtDate(booking.event_date)}. We'll reach out before your event with delivery details.`
        });
      }
    } catch (err) {
      console.error('[SARAH] Stripe check error:', err.message);
    }
  }

  res.json({
    paid: false,
    booking_number: booking.booking_number,
    message: `I haven't seen the payment come through yet for booking #${booking.booking_number}. Check your text messages for the payment link. It should take just a minute or two to complete.`
  });
});

// POST /api/sarah/delivery-zones
// Vapi calls this when customer asks about delivery area / fees
router.post('/delivery-zones', async (req, res) => {
  const db = getDb();
  const { zip } = req.body;

  const zones = db.prepare('SELECT name, zip_codes, delivery_fee FROM delivery_zones WHERE active = 1 ORDER BY delivery_fee').all();

  if (zip) {
    const match = db.prepare("SELECT * FROM delivery_zones WHERE active = 1 AND (',' || zip_codes || ',') LIKE ?")
      .get(`%,${zip},%`);
    if (match) {
      const fee = match.delivery_fee === 0 ? 'free' : `$${match.delivery_fee.toFixed(2)}`;
      return res.json({
        found: true,
        zone: match.name,
        fee: match.delivery_fee,
        message: `Delivery to ${zip} is ${fee}! That falls in our ${match.name} zone.`
      });
    }
    const r = await resolveDeliveryFee(db, zip);
    return res.json({
      found: false,
      fee: r.fee,
      zone: r.zone,
      message: `Delivery to ${zip} is $${r.fee}.`
    });
  }

  const zoneList = zones.map(z => {
    const fee = z.delivery_fee === 0 ? 'FREE' : `$${z.delivery_fee.toFixed(2)}`;
    return `${z.name}: ${fee}`;
  }).join('. ');

  res.json({ zones, message: `Our delivery zones: ${zoneList}. What's your zip code?` });
});

// ============================================================
// ORIGINAL ENDPOINTS (walk-up events, text pricing, etc.)
// ============================================================

// POST /api/sarah/text-pricing — Text pricing info to a phone number
router.post('/text-pricing', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });

  const settings = getSettings();
  const pricingText = settings.pricing_info || 'Contact us for pricing at bouncemanrentals.com';

  try {
    await require('../services/sms').sendSms(phone, pricingText);
    res.json({ success: true, message: `Pricing texted to ${phone}` });
  } catch (err) {
    console.error('[SARAH] Text pricing error:', err.message);
    res.status(500).json({ error: `Failed to send: ${err.message}` });
  }
});

// POST /api/sarah/walkin-link — Text walk-up event link to a phone number
router.post('/walkin-link', async (req, res) => {
  const { phone, event_id } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });

  const db = getDb();
  const event = event_id
    ? db.prepare('SELECT * FROM walk_up_events WHERE id = ? AND active = 1').get(event_id)
    : db.prepare('SELECT * FROM walk_up_events WHERE active = 1 ORDER BY event_date DESC LIMIT 1').get();

  if (!event) return res.status(404).json({ error: 'No active event found' });

  const baseUrl = process.env.EVENT_BASE_URL || 'https://bouncemanrentals.com/event';
  const url = `${baseUrl}?event=${event.id}`;

  try {
    await require('../services/sms').sendSms(phone, `Hey! Sign your waiver and pay for your kids to bounce at ${event.name}: ${url}`);
    res.json({ success: true, message: `Walk-up link sent to ${phone} for "${event.name}"` });
  } catch (err) {
    console.error('[SARAH] Walkin link error:', err.message);
    res.status(500).json({ error: `Failed to send: ${err.message}` });
  }
});

// POST /api/sarah/create-event — Create a new walk-up event
router.post('/create-event', (req, res) => {
  const { name, date, price_per_kid, location } = req.body;
  if (!name || !date || !price_per_kid) {
    return res.status(400).json({ error: 'Name, date, and price_per_kid required' });
  }

  const db = getDb();
  const id = uuid();
  db.prepare('INSERT INTO walk_up_events (id, name, event_date, location, price_per_kid, active) VALUES (?, ?, ?, ?, ?, 1)')
    .run(id, name, date, location || '', parseFloat(price_per_kid));

  res.json({ success: true, event_id: id, message: `Event "${name}" created for ${date} at $${parseFloat(price_per_kid).toFixed(0)}/kid` });
});

// GET /api/sarah/status — Today's event stats

// POST /api/sarah/lookup-booking
// Look up a customer's most recent booking by phone number or booking number
router.post('/lookup-booking', (req, res) => {
  const db = getDb();
  const { phone, booking_number } = req.body;

  let booking = null;

  if (booking_number) {
    booking = db.prepare(`SELECT b.*, c.first_name, c.last_name, c.email, c.phone as cust_phone
      FROM bookings b JOIN customers c ON c.id = b.customer_id
      WHERE b.booking_number = ?`).get(booking_number.toUpperCase());
  } else if (phone) {
    const customer = findCustomerByPhone(db, phone);
    if (customer) {
      // Soonest UPCOMING booking first (that's the one they're calling about); fall back
      // to their most recent past booking if they have nothing scheduled.
      booking = db.prepare(`SELECT b.* FROM bookings b
        WHERE b.customer_id = ? AND b.status NOT IN ('cancelled','declined')
        ORDER BY (b.event_date < date('now','-1 day')) ASC,
                 CASE WHEN b.event_date >= date('now','-1 day') THEN b.event_date END ASC,
                 b.event_date DESC
        LIMIT 1`).get(customer.id);
      if (booking) {
        booking.first_name = customer.first_name;
        booking.last_name = customer.last_name;
        booking.cust_phone = customer.phone;
      }
    }
  }

  if (!booking) {
    return res.json({
      found: false,
      message: "I don't see any bookings for that number. Would you like to make a new booking?"
    });
  }

  const items = db.prepare('SELECT item_name FROM booking_items WHERE booking_id = ?').all(booking.id);
  const itemNames = items.map(i => i.item_name).join(', ');
  const total = parseFloat(booking.total || 0).toFixed(2);
  const deposit = parseFloat(booking.deposit_amount || 0).toFixed(2);
  const balance = parseFloat(booking.balance_due || 0).toFixed(2);

  const payStatus = booking.payment_status === 'deposit_paid' ? 'deposit paid, balance due on delivery'
    : booking.payment_status === 'paid' ? 'paid in full'
    : 'deposit not yet paid';

  const lookupMessage = `Booking #${booking.booking_number} for ${fmtDate(booking.event_date)}: ${itemNames}. Status: ${booking.status}. Payment: ${payStatus}. Total: $${total}. Deposit: $${deposit}. Balance due on delivery: $${balance}.`;
  res.json({
    result: lookupMessage,
    found: true,
    booking_number: booking.booking_number,
    event_date: fmtDate(booking.event_date),
    items: itemNames,
    status: booking.status,
    payment_status: booking.payment_status,
    total,
    deposit_amount: deposit,
    balance_due: balance,
    message: lookupMessage
  });
});

router.get('/status', (req, res) => {
  const db = getDb();
  const events = db.prepare('SELECT * FROM walk_up_events WHERE active = 1').all();

  if (events.length === 0) {
    return res.json({ success: true, message: 'No active events.' });
  }

  const results = events.map(event => {
    const stats = db.prepare(`SELECT
      COUNT(*) as registrations,
      COALESCE(SUM(kid_count), 0) as kids,
      COALESCE(SUM(amount_paid), 0) as revenue
      FROM walk_up_registrations
      WHERE event_id = ? AND payment_status = 'completed'`).get(event.id);

    return `*${event.name}* (${event.event_date}): ${stats.kids} kids, ${stats.registrations} families, $${stats.revenue.toFixed(2)} revenue, ${event.wristband_counter} wristbands issued`;
  });

  res.json({ success: true, message: results.join('\n') });
});

// GET /api/sarah/events — List active events (for n8n to pick from)
router.get('/events', (req, res) => {
  const db = getDb();
  const events = db.prepare('SELECT id, name, event_date, price_per_kid FROM walk_up_events WHERE active = 1 ORDER BY event_date DESC').all();
  res.json({ success: true, events });
});

// POST /api/sarah/request-human
// Sarah calls this when caller demands to speak with a person.
// Sends Slack alert to Nehemiah with the caller's phone number.
router.post('/request-human', async (req, res) => {
  const { caller_phone, caller_name } = req.body;

  const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID || 'C0AQ5LT666R';

  const nameTag = caller_name ? ` (${caller_name})` : '';
  const phone = caller_phone || 'unknown';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🚨 *Caller wants to speak with you*\n📞 ${phone}${nameTag}\n_Sarah told them you'd call back within the hour._`
      }
    }
  ];

  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, blocks, text: 'Caller wants to speak with you: ' + phone + nameTag })
    });
  } catch (e) {
    console.error('[SARAH] request-human Slack error:', e.message);
  }

  res.json({ success: true, message: 'Nehemiah has been notified and will call you back within the hour.' });
});

module.exports = router;
