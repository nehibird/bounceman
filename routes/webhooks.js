const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { v4: uuid } = require('uuid');

// Stripe webhook
router.post('/stripe', async (req, res) => {
  const db = getDb();
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));

  if (!settings.stripe_webhook_secret) {
    return res.status(400).json({ error: 'Stripe webhook not configured' });
  }

  try {
    const stripe = require('stripe')(settings.stripe_secret_key);
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(req.body, sig, settings.stripe_webhook_secret);

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const bookingId = pi.metadata?.booking_id;
        if (!bookingId) break;

        const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
        if (!booking) break;

        db.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method,
          stripe_payment_id, card_last4, card_brand, status)
          VALUES (?, ?, ?, ?, 'charge', 'stripe', ?, ?, ?, 'completed')`).run(
          uuid(), bookingId, booking.customer_id, pi.amount / 100,
          pi.id, pi.charges?.data?.[0]?.payment_method_details?.card?.last4 || '',
          pi.charges?.data?.[0]?.payment_method_details?.card?.brand || ''
        );

        const totalPaid = db.prepare('SELECT COALESCE(SUM(amount), 0) as paid FROM payments WHERE booking_id = ? AND status = ?')
          .get(bookingId, 'completed').paid;
        const newBalance = booking.total - totalPaid;

        db.prepare(`UPDATE bookings SET payment_status = ?, balance_due = ?, deposit_paid = ?,
          updated_at = datetime('now') WHERE id = ?`).run(
          newBalance <= 0 ? 'paid' : 'partial', Math.max(0, newBalance),
          totalPaid >= booking.deposit_amount ? 1 : 0, bookingId
        );

        // Update customer revenue
        db.prepare('UPDATE customers SET total_revenue = total_revenue + ? WHERE id = ?')
          .run(pi.amount / 100, booking.customer_id);

        db.prepare('INSERT INTO activity_log (id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)')
          .run(uuid(), 'payment_received', 'booking', bookingId, JSON.stringify({ amount: pi.amount / 100, method: 'stripe' }));

        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object;
        const refundAmount = charge.amount_refunded / 100;
        const payment = db.prepare('SELECT * FROM payments WHERE stripe_charge_id = ?').get(charge.id);
        if (payment) {
          db.prepare('UPDATE payments SET refund_amount = ? WHERE id = ?').run(refundAmount, payment.id);
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Stripe Webhook Error]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// === SLACK EVENTS (Sarah @mention in #bookings) ===
router.post('/slack/events', async (req, res) => {
  // Slack URL verification challenge
  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  // Acknowledge immediately (Slack requires < 3s response)
  res.json({ ok: true });

  const event = req.body.event;
  if (!event || event.type !== 'app_mention') return;

  // Ignore bot messages to prevent loops
  if (event.bot_id) return;

  const BOOKINGS_CHANNEL = process.env.SLACK_BOOKINGS_CHANNEL || 'C0AQF8ZAEBE';
  const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
  const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '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';
  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim(); // Strip @mention

  console.log('[SARAH-SLACK] Message from', event.user, ':', text);

  try {
    const db = getDb();
    const { generateBookingNumber } = require('../lib/helpers');

    // Get equipment catalog for AI context
    const equipment = db.prepare("SELECT id, name, price_4hr, price_daily, price_overnight, category FROM equipment WHERE status = 'available' ORDER BY sort_order").all();

    // Call AI to parse the natural language into booking data
    const aiResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + OPENROUTER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4',
        max_tokens: 1000,
        messages: [
          {
            role: 'system',
            content: `You are Sarah, the AI assistant for Bounce Man LLC. Parse Slack messages from the owner into booking data. Today is ${new Date().toISOString().split('T')[0]}.

Available equipment:
${equipment.map(e => `- ${e.name} (ID: ${e.id}): $${e.price_4hr} (4hr) / $${e.price_daily} (full day) / $${e.price_overnight} (overnight). Category: ${e.category}`).join('\n')}

Return a JSON object with these fields:
{
  "action": "create_booking" or "unknown",
  "first_name": "customer first name",
  "last_name": "customer last name (or empty string)",
  "email": "email or null if not provided",
  "phone": "phone or null if not provided",
  "event_date": "YYYY-MM-DD format",
  "event_start_time": "HH:MM (24hr, default 09:00)",
  "event_end_time": "HH:MM (24hr, default based on duration)",
  "equipment_ids": ["array of equipment IDs to book"],
  "duration_type": "4hr" or "daily" or "overnight",
  "notes": "any special notes from the message",
  "payment_status": "unpaid" or "deposit_paid" or "paid",
  "status": "confirmed" or "pending",
  "confirmation_message": "a brief friendly confirmation message for Slack"
}

Rules:
- "all day" = daily duration, times 09:00-19:00
- "half day" = 4hr duration
- Match equipment names loosely (e.g., "Blue Crush slide" = Blue Crush Slide)
- If equipment not specified, leave equipment_ids empty and ask in confirmation_message
- If date unclear, use the next occurrence of the mentioned day
- If owner says "might pay" or "prepare for payment", set payment_status to "unpaid"
- Default status to "confirmed" since the owner is creating it directly`
          },
          { role: 'user', content: text }
        ],
        response_format: { type: 'json_object' }
      })
    });

    const aiData = await aiResp.json();
    let parsed;
    try {
      parsed = JSON.parse(aiData.choices[0].message.content);
    } catch (e) {
      await slackReply(SLACK_TOKEN, event.channel, event.ts, 'Sorry, I couldn\'t understand that. Try something like: "Create a booking for John Smith on July 4th for the Blue Crush Slide all day"');
      return;
    }

    if (parsed.action !== 'create_booking' || !parsed.event_date) {
      await slackReply(SLACK_TOKEN, event.channel, event.ts, parsed.confirmation_message || 'I\'m not sure what you need. Try: "Create a booking for [name] on [date] for [equipment]"');
      return;
    }

    if (!parsed.equipment_ids || parsed.equipment_ids.length === 0) {
      await slackReply(SLACK_TOKEN, event.channel, event.ts, parsed.confirmation_message || 'Which equipment should I book? We have: ' + equipment.filter(e => !['add_ons','add-ons'].includes(e.category)).map(e => e.name).join(', '));
      return;
    }

    // Create customer
    const customerId = uuid();
    db.prepare(`INSERT INTO customers (id, first_name, last_name, email, phone, source) VALUES (?, ?, ?, ?, ?, 'slack')`).run(
      customerId, parsed.first_name || 'Unknown', parsed.last_name || '', parsed.email || null, parsed.phone || null
    );

    // Calculate pricing
    let subtotal = 0;
    const items = [];
    for (const eqId of parsed.equipment_ids) {
      const equip = db.prepare('SELECT * FROM equipment WHERE id = ?').get(eqId);
      if (!equip) continue;
      const dur = parsed.duration_type || 'daily';
      const price = dur === '4hr' ? equip.price_4hr : dur === 'overnight' ? equip.price_overnight : equip.price_daily;
      subtotal += price;
      items.push({ id: eqId, name: equip.name, price, dur });
    }

    const total = subtotal;
    const depositAmount = Math.round(total * 0.5 * 100) / 100;
    const bookingId = uuid();
    const bookingNumber = generateBookingNumber();

    db.prepare(`INSERT INTO bookings (id, booking_number, customer_id, status, event_date,
      event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due,
      payment_status, internal_notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`).run(
      bookingId, bookingNumber, customerId, parsed.status || 'confirmed',
      parsed.event_date, parsed.event_start_time || '09:00', parsed.event_end_time || '17:00',
      subtotal, total, depositAmount, total,
      parsed.payment_status || 'unpaid', parsed.notes || 'Created via Slack by Sarah'
    );

    // Add booking items
    for (const item of items) {
      db.prepare(`INSERT INTO booking_items (id, booking_id, equipment_id, item_name, item_type, quantity, unit_price, total_price, duration_type)
        VALUES (?, ?, ?, ?, 'equipment', 1, ?, ?, ?)`).run(
        uuid(), bookingId, item.id, item.name, item.price, item.price, item.dur
      );
    }

    console.log('[SARAH-SLACK] Booking created:', bookingNumber);

    // Reply in thread
    const itemList = items.map(i => i.name + ' ($' + i.price + ')').join(', ');
    const msg = `Done! Booking *${bookingNumber}* created:\n` +
      `*Customer:* ${parsed.first_name} ${parsed.last_name}\n` +
      `*Date:* ${parsed.event_date}\n` +
      `*Equipment:* ${itemList}\n` +
      `*Total:* $${total.toFixed(2)}\n` +
      `*Payment:* ${parsed.payment_status || 'unpaid'}\n` +
      (parsed.notes ? `*Notes:* ${parsed.notes}\n` : '') +
      `<https://bouncemanrentals.com/admin/bookings/${bookingId}|View in Admin>`;

    await slackReply(SLACK_TOKEN, event.channel, event.ts, msg);

  } catch (err) {
    console.error('[SARAH-SLACK] Error:', err.message);
    try {
      await slackReply(process.env.SLACK_BOT_TOKEN, event.channel, event.ts, 'Something went wrong: ' + err.message);
    } catch (e) { /* ignore */ }
  }
});

async function slackReply(token, channel, thread_ts, text) {
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, thread_ts, text })
  });
}

module.exports = router;
