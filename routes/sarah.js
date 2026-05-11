const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { v4: uuid } = require('uuid');
const stripeService = require('../services/stripe');
const smsService = require('../services/sms');
const emailService = require('../services/email');
const notificationsService = require('../services/notifications');
const { getSettings, generateBookingNumber, getPrice, getBookedEquipmentIds, getDeliveryFee, calcPricing, fmtDate, normalizePhone, resolveDate } = require('../lib/helpers');

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
router.post('/check-availability', (req, res) => {
  const db = getDb();
  const { date: rawDate, zip } = req.body;

  if (!rawDate) return res.status(400).json({ error: 'Date required' });

  // Resolve natural language dates ("next Saturday", "April 15th", "tomorrow", etc.)
  const date = resolveDate(rawDate);
  if (!date) {
    return res.json({ available: false, message: `I didn't quite catch that date. Could you say it again, like "May tenth" or "next Saturday"?` });
  }

  // Validate date is in the future
  const today = new Date().toISOString().slice(0, 10);
  if (date < today) {
    return res.json({ available: false, message: 'That date has already passed. Can I help you find a future date?' });
  }

  // Check global blocked dates
  const blocked = db.prepare('SELECT reason FROM blocked_dates WHERE date = ? AND equipment_id IS NULL').get(date);
  if (blocked) {
    return res.json({ available: false, message: blocked.reason || 'Sorry, that date is completely booked.' });
  }

  // Get all rentable equipment (not add-ons)
  const allEquipment = db.prepare("SELECT id, name, category, price_daily, price_4hr, price_overnight FROM equipment WHERE status = 'available' AND category != 'add_ons' ORDER BY sort_order").all();

  const bookedIds = getBookedEquipmentIds(db, date);

  const available = allEquipment.filter(e => !bookedIds.has(e.id));
  const unavailable = allEquipment.filter(e => bookedIds.has(e.id));

  if (available.length === 0) {
    return res.json({
      available: false,
      message: `Sorry, all our equipment is booked on ${fmtDate(date)}. Would you like to try a different date?`
    });
  }

  // Get add-ons too
  const addons = db.prepare("SELECT id, name, price_daily, price_4hr FROM equipment WHERE status = 'available' AND category = 'add_ons'").all();

  // Calculate delivery fee and totals if zip provided
  const settings = getSettings();
  let delivery_fee = 0, delivery_zone = null, sample_total = null, sample_deposit = null;
  if (zip) {
    const zoneResult = getDeliveryFee(db, zip);
    delivery_fee = zoneResult.fee;
    delivery_zone = zoneResult.zone;
    // Sample total using first available item (full day) so Sarah can quote a ballpark
    if (available.length > 0) {
      const samplePrice = available[0].price_daily;
      const pricing = calcPricing(settings, samplePrice, delivery_fee);
      sample_total = pricing.total;
      sample_deposit = pricing.depositAmount;
    }
  }

  const listing = available.map(e => {
    let line = `${e.name}: $${e.price_4hr} half day, $${e.price_daily} full day`;
    if (zip && delivery_fee === 0) line += ' (free delivery to your area)';
    else if (zip) line += ` + $${delivery_fee} delivery`;
    return line;
  }).join('. ');

  const addonListing = addons.map(a => `${a.name}: $${a.price_4hr} half day, $${a.price_daily} full day`).join('. ');

  const deliveryNote = zip
    ? (delivery_zone ? ` Delivery to your area: ${delivery_fee === 0 ? 'FREE' : `$${delivery_fee}`} (${delivery_zone}).` : ' Your zip is outside our standard zones — we may still deliver, fee to be confirmed.')
    : '';

  const equipmentWithIds = available.map(e => ({
      id: e.id,
      name: e.name,
      category: e.category,
      price_4hr: e.price_4hr,
      price_daily: e.price_daily,
      price_overnight: e.price_overnight
    }));
  const addonsWithIds = addons.map(a => ({
      id: a.id,
      name: a.name,
      price_4hr: a.price_4hr,
      price_daily: a.price_daily
    }));

  // Build result string with IDs so LLM can use them in createAndSendLink
  const equipmentLines = available.map(e =>
    `${e.name} (equipment_id: ${e.id}) — $${e.price_4hr} half day, $${e.price_daily} full day, $${e.price_overnight} overnight`
  ).join('\n');
  const addonLines = addons.map(a =>
    `${a.name} (equipment_id: ${a.id}) — $${a.price_4hr} half day, $${a.price_daily} full day`
  ).join('\n');
  const unavailLine = unavailable.length > 0 ? `\nAlready booked: ${unavailable.map(e => e.name).join(', ')}.` : '';
  const deliveryLine = zip ? (delivery_fee === 0 ? `\nDelivery: FREE to zip ${zip}.` : `\nDelivery fee: $${delivery_fee} to zip ${zip}.`) : '';

  const resultText = `Available on ${fmtDate(date)} (${date}):\n${equipmentLines}\nAdd-ons:\n${addonLines}${unavailLine}${deliveryLine}\n\nUse the equipment_id values above when calling createAndSendLink.`;

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
    message: `Great news! On ${fmtDate(date)} we have: ${listing}. Add-ons: ${addonListing}.${deliveryNote}${unavailable.length > 0 ? ` Already booked that day: ${unavailable.map(e => e.name).join(', ')}.` : ''}`
  });
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
router.post('/get-quote', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const { equipment_ids, duration, delivery_zip } = req.body;

  if (!equipment_ids || !equipment_ids.length) {
    return res.status(400).json({ error: 'At least one equipment_id required' });
  }

  const dur = duration || 'daily';
  let subtotal = 0;
  const lineItems = [];

  for (const eqId of equipment_ids) {
    const eq = db.prepare('SELECT * FROM equipment WHERE id = ? AND status = ?').get(eqId, 'available');
    if (!eq) continue;
    const price = getPrice(eq, dur);
    lineItems.push({ id: eq.id, name: eq.name, price, duration: dur });
    subtotal += price;
  }

  if (lineItems.length === 0) {
    return res.status(400).json({ error: 'No valid equipment found for those IDs' });
  }

  const { fee: delivery_fee, zone: zone_name } = getDeliveryFee(db, delivery_zip);
  const { taxAmount: tax_amount, damageWaiverFee: damage_waiver_fee, total, depositAmount: deposit_amount } = calcPricing(settings, subtotal, delivery_fee);

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
    power_available
  } = req.body;

  // Validate required fields
  if (!first_name || !phone || !equipment_ids?.length || !event_date) {
    const missing = [];
    if (!first_name) missing.push('first name');
    if (!phone) missing.push('phone number');
    if (!equipment_ids?.length) missing.push('equipment selection');
    if (!event_date) missing.push('event date');
    return res.status(400).json({
      error: `Missing required info: ${missing.join(', ')}`,
      missing_fields: missing
    });
  }

  try {
    const dur = duration || 'daily';

    // Calculate pricing
    let subtotal = 0;
    const lineItems = [];
    for (const eqId of equipment_ids) {
      const eq = db.prepare('SELECT * FROM equipment WHERE id = ? AND status = ?').get(eqId, 'available');
      if (!eq) continue;
      const price = getPrice(eq, dur);
      lineItems.push({ equipment_id: eq.id, item_name: eq.name, unit_price: price, total_price: price, duration_type: dur });
      subtotal += price;
    }

    if (lineItems.length === 0) {
      return res.status(400).json({ error: 'None of the selected equipment is available' });
    }

    // Verify date availability
    for (const item of lineItems) {
      const conflict = db.prepare(`
        SELECT 1 FROM bookings b JOIN booking_items bi ON bi.booking_id = b.id
        WHERE b.event_date = ? AND bi.equipment_id = ? AND b.status NOT IN ('cancelled', 'declined')
      `).get(event_date, item.equipment_id);
      if (conflict) {
        return res.json({
          success: false,
          error: `Sorry, ${item.item_name} just got booked for ${fmtDate(event_date)}. Want to try a different date?`
        });
      }
    }

    const { fee: delivery_fee } = getDeliveryFee(db, delivery_zip);

    // Apply discount code if provided
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
        subtotal = Math.max(0, subtotal - discount_amount);
      }
    }

    const { taxRate: tax_rate, taxAmount: tax_amount, damageWaiverFee: damage_waiver_fee, total, depositAmount: deposit_amount } = calcPricing(settings, subtotal, delivery_fee);

    // Create or find customer
    let customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(normalizePhone(phone));
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

    db.prepare(`INSERT INTO bookings (
      id, booking_number, customer_id, status, event_date, event_start_time, event_end_time,
      event_type, venue_type, delivery_address, delivery_city, delivery_state, delivery_zip,
      surface_type, power_available,
      subtotal, delivery_fee, tax_amount, tax_rate, discount_amount,
      damage_waiver_fee, total, deposit_amount, balance_due, payment_status
    ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, 'residential', ?, ?, 'OK', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      bookingId, bookingNumber, customerId,
      event_date, event_start_time || '9:00 AM', event_end_time || '1:00 PM',
      event_type || 'birthday_party',
      delivery_address || '', delivery_city || '', delivery_zip || '',
      surface_type || 'grass',
      powerAvailable,
      subtotal, delivery_fee, tax_amount, tax_rate, discount_amount,
      damage_waiver_fee, total, deposit_amount, total, 'unpaid'
    );

    // Add line items
    for (const item of lineItems) {
      db.prepare(`INSERT INTO booking_items (id, booking_id, equipment_id, item_name, unit_price, total_price, duration_type)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(uuid(), bookingId, item.equipment_id, item.item_name, item.unit_price, item.total_price, item.duration_type);
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
      description: `${itemNames} — ${fmtDate(event_date)} — Deposit`,
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
          .replace(/\{\{event_date\}\}/g, fmtDate(event_date))
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
    const smsBody = `Hi ${first_name}! Here's your Bounce Man booking for ${fmtDate(event_date)}:\n\n` +
      `${itemNames}\n` +
      `Total: $${total.toFixed(2)}\n` +
      `Deposit due now: $${deposit_amount.toFixed(2)}\n\n` +
      `Pay here: ${paymentUrl}\n\n` +
      `Booking #${bookingNumber} — Questions? Call (580) 308-9288`;
    try {
      await smsService.sendSms(phone, smsBody);
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
      sms_sent: true,
      message: `I've created booking #${bookingNumber}! To lock it in, pay the deposit of $${deposit_amount.toFixed(2)} at this link: ${paymentUrl} — that's your secure Stripe checkout. The remaining $${(total - deposit_amount).toFixed(2)} is due on delivery day. Do you have a pen or can you pull that up right now?`
    });
  } catch (err) {
    console.error('[SARAH] Create booking error:', err);
    res.status(500).json({ error: `Booking failed: ${err.message}` });
  }
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
router.post('/delivery-zones', (req, res) => {
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
    return res.json({
      found: false,
      message: `Zip code ${zip} is outside our standard delivery zones. We can still deliver — there may be an extra fee. Let me get your info and the owner will confirm the delivery fee.`
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
    const client = getTwilio();
    await client.messages.create({
      body: pricingText,
      from: process.env.TWILIO_PHONE,
      to: normalizePhone(phone)
    });
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
    const client = getTwilio();
    await client.messages.create({
      body: `Hey! Sign your waiver and pay for your kids to bounce at ${event.name}: ${url}`,
      from: process.env.TWILIO_PHONE,
      to: normalizePhone(phone)
    });
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
    const normalized = normalizePhone(phone);
    const customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(normalized);
    if (customer) {
      booking = db.prepare(`SELECT b.* FROM bookings b
        WHERE b.customer_id = ? AND b.status NOT IN ('cancelled','declined')
        ORDER BY b.event_date DESC LIMIT 1`).get(customer.id);
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
