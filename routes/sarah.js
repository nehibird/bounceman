const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { v4: uuid } = require('uuid');
const stripeService = require('../services/stripe');
const smsService = require('../services/sms');
const { getSettings, generateBookingNumber, getPrice, getBookedEquipmentIds, getDeliveryFee, calcPricing, fmtDate, normalizePhone } = require('../lib/helpers');

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

// ============================================================
// VAPI TOOL ENDPOINTS — Sarah's e-commerce brain
// ============================================================

// POST /api/sarah/check-availability
// Vapi calls this when customer asks about a date
router.post('/check-availability', (req, res) => {
  const db = getDb();
  const { date } = req.body;

  if (!date) return res.status(400).json({ error: 'Date required (YYYY-MM-DD)' });

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

  const listing = available.map(e =>
    `${e.name}: $${e.price_4hr} for 4 hours, $${e.price_daily} full day`
  ).join('. ');

  const addonListing = addons.map(a => `${a.name}: $${a.price_4hr} for 4 hours, $${a.price_daily} full day`).join('. ');

  res.json({
    available: true,
    date: date,
    date_formatted: fmtDate(date),
    equipment: available.map(e => ({
      id: e.id,
      name: e.name,
      category: e.category,
      price_4hr: e.price_4hr,
      price_daily: e.price_daily,
      price_overnight: e.price_overnight
    })),
    addons: addons.map(a => ({
      id: a.id,
      name: a.name,
      price_4hr: a.price_4hr,
      price_daily: a.price_daily
    })),
    unavailable: unavailable.map(e => e.name),
    message: `Great news! On ${fmtDate(date)} we have: ${listing}. Add-ons available: ${addonListing}.${unavailable.length > 0 ? ` (Already booked: ${unavailable.map(e => e.name).join(', ')})` : ''}`
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
    event_type, surface_type
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

    // Create booking
    const bookingId = uuid();
    const bookingNumber = generateBookingNumber();

    db.prepare(`INSERT INTO bookings (
      id, booking_number, customer_id, status, event_date, event_start_time, event_end_time,
      event_type, venue_type, delivery_address, delivery_city, delivery_state, delivery_zip,
      surface_type, power_available,
      subtotal, delivery_fee, tax_amount, tax_rate, discount_amount,
      damage_waiver_fee, total, deposit_amount, balance_due, payment_status
    ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, 'residential', ?, ?, 'OK', ?, ?, 1, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(
      bookingId, bookingNumber, customerId,
      event_date, event_start_time || '9:00 AM', event_end_time || '1:00 PM',
      event_type || 'birthday_party',
      delivery_address || '', delivery_city || '', delivery_zip || '',
      surface_type || 'grass',
      subtotal, delivery_fee, tax_amount, tax_rate,
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

    // Text the payment link to the customer
    const paymentUrl = session.url;
    const smsBody = `Hi ${first_name}! Here's your Bounce Man booking for ${fmtDate(event_date)}:\n\n` +
      `${itemNames}\n` +
      `Total: ${total.toFixed(2)}\n` +
      `Deposit due now: ${deposit_amount.toFixed(2)}\n\n` +
      `Pay here: ${paymentUrl}\n\n` +
      `Booking #${bookingNumber} — Questions? Call (580) 308-9288`;

    let sms_sent = false;
    try {
      await smsService.sendSms(phone, smsBody);
      sms_sent = true;
    } catch (smsErr) {
      console.error('[SARAH] SMS failed (booking still created):', smsErr.message);
    }

    // Log activity
    db.prepare(`INSERT INTO activity_log (id, action, entity_type, entity_id, details, ip_address)
      VALUES (?, 'booking_created_by_sarah', 'booking', ?, ?, ?)`).run(
      uuid(), bookingId, JSON.stringify({ booking_number: bookingNumber, customer: `${first_name} ${last_name || ''}`, source: 'phone_ai' }), req.ip
    );

    console.log(`[SARAH] Booking ${bookingNumber} created, payment link texted to ${phone}`);

    res.json({
      success: true,
      booking_number: bookingNumber,
      booking_id: bookingId,
      stripe_session_id: session.id,
      total: total,
      deposit_amount: deposit_amount,
      balance_due: Math.round((total - deposit_amount) * 100) / 100,
      payment_url: paymentUrl,
      sms_sent,
      message: sms_sent
        ? `I've created booking #${bookingNumber} and just texted a payment link to your phone. The deposit is ${deposit_amount.toFixed(2)} and you can pay right from the link. The remaining ${(total - deposit_amount).toFixed(2)} is due on delivery day. Check your text messages!`
        : `I've created booking #${bookingNumber}! The deposit is ${deposit_amount.toFixed(2)}. I wasn't able to text the link, but you can pay at this URL: ${paymentUrl}. The remaining ${(total - deposit_amount).toFixed(2)} is due on delivery day.`
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

module.exports = router;
