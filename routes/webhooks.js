const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { v4: uuid } = require('uuid');
const stripeService = require('../services/stripe');
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID || '2549cba6-1c8e-44df-86ed-a0f7533c182c';

// Stripe webhook
router.post('/stripe', async (req, res) => {
  const webhookSecret = process.env.STRIPE_EVENT_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[Stripe Webhook] STRIPE_EVENT_WEBHOOK_SECRET not set');
    return res.status(400).json({ error: 'Stripe webhook not configured' });
  }

  try {
    const sig = req.headers['stripe-signature'];
    const event = stripeService.constructWebhookEvent(req.body, sig, webhookSecret);
    const db = getDb();

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const bookingId = session.metadata && session.metadata.booking_id;
        if (!bookingId) {
          console.log('[Stripe Webhook] No booking_id in metadata, skipping');
          break;
        }

        const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
        if (!booking) {
          console.log('[Stripe Webhook] Booking not found:', bookingId);
          break;
        }

        // Dedup: success redirect may have already recorded this payment via payment intent ID
        const piId = typeof session.payment_intent === 'string'
          ? session.payment_intent
          : (session.payment_intent && session.payment_intent.id ? session.payment_intent.id : session.id);

        const existing = db.prepare('SELECT id FROM payments WHERE stripe_payment_id = ?').get(piId);
        if (existing) {
          console.log('[Stripe Webhook] Payment already recorded for', piId, '- skipping');
          break;
        }

        const amountPaid = (session.amount_total || 0) / 100;

        db.prepare(
          "INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, stripe_payment_id, status) VALUES (?, ?, ?, ?, 'charge', 'stripe', ?, 'completed')"
        ).run(uuid(), bookingId, booking.customer_id, amountPaid, piId);

        const totalPaid = db.prepare(
          "SELECT COALESCE(SUM(amount), 0) as paid FROM payments WHERE booking_id = ? AND status = 'completed'"
        ).get(bookingId).paid;

        const newBalance = Math.max(0, booking.total - totalPaid);
        const depositPaid = totalPaid >= booking.deposit_amount ? 1 : 0;
        const paymentStatus = newBalance <= 0 ? 'paid' : (depositPaid ? 'deposit_paid' : 'partial');
        const bookingStatus = depositPaid ? 'confirmed' : booking.status;

        db.prepare(
          "UPDATE bookings SET status = ?, payment_status = ?, balance_due = ?, deposit_paid = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(bookingStatus, paymentStatus, newBalance, depositPaid, bookingId);

        db.prepare('UPDATE customers SET total_revenue = total_revenue + ? WHERE id = ?')
          .run(amountPaid, booking.customer_id);

        db.prepare('INSERT INTO activity_log (id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)')
          .run(uuid(), 'payment_received', 'booking', bookingId,
            JSON.stringify({ amount: amountPaid, method: 'stripe', source: 'webhook' }));

        console.log('[Stripe Webhook] checkout.session.completed: booking', bookingId,
          'confirmed, $' + amountPaid.toFixed(2) + ' recorded via webhook');

        // Update Slack live card if one exists for this booking
        setTimeout(async () => {
          try {
            const { updateBookingSlackCard } = require('../services/notifications');
            await updateBookingSlackCard(bookingId);
          } catch (e) { console.error('[STRIPE WEBHOOK] Slack card update failed:', e.message); }
        }, 0);
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object;
        const refundAmount = charge.amount_refunded / 100;
        const payment = db.prepare(
          'SELECT * FROM payments WHERE stripe_payment_id = ? OR stripe_charge_id = ?'
        ).get(charge.payment_intent || charge.id, charge.id);
        if (payment) {
          db.prepare('UPDATE payments SET refund_amount = ? WHERE id = ?')
            .run(refundAmount, payment.id);
          console.log('[Stripe Webhook] charge.refunded: $' + refundAmount.toFixed(2) + ' recorded');
        } else {
          console.log('[Stripe Webhook] charge.refunded: no matching payment found for', charge.id);
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
  const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
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
  "action": "create_booking" or "send_customer_links" or "unknown",
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
- Default status to "confirmed" since the owner is creating it directly
- For "message/text [name] at [phone] a parent form" or similar: use action "send_customer_links" with fields: first_name, last_name (if given), phone, free (true if "free", "google review", "no charge", or "15 min" mentioned, else false), notes`
          },
          { role: 'user', content: text }
        ],
        response_format: { type: 'json_object' }
      })
    });

    const aiData = await aiResp.json();
    let parsed;
    try {
      let rawContent = aiData.choices[0].message.content;
      rawContent = rawContent.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      parsed = JSON.parse(rawContent);
    } catch (e) {
      console.error('[SARAH-SLACK] AI parse error:', e.message, 'Raw:', JSON.stringify(aiData).slice(0,300));
      await slackReply(SLACK_TOKEN, event.channel, event.ts, ':thinking_face: Got your message but had trouble parsing it. Try: "text Brenna at 9403678241 a parent form"');
      return;
    }

    // === SEND EVENT LINKS (parent waiver + payment for walk-up events) ===
    if (parsed.action === 'send_customer_links') {
      const smsService = require('../services/sms');
      const baseUrl = process.env.BASE_URL || 'https://bouncemanrentals.com';
      const today = new Date().toISOString().split('T')[0];
      const isFree = parsed.free === true;

      // Find next upcoming active event (today or future, within 7 days) — free = price 0, paid = price > 0
      const futureDate = new Date(); futureDate.setDate(futureDate.getDate() + 7);
      const futureDateStr = futureDate.toISOString().split('T')[0];
      const walkUpEvent = db.prepare(
        'SELECT * FROM walk_up_events WHERE event_date >= ? AND event_date <= ? AND active = 1 AND price_per_kid ' +
        (isFree ? '= 0' : '> 0') +
        ' ORDER BY event_date ASC LIMIT 1'
      ).get(today, futureDateStr);

      if (!walkUpEvent) {
        await slackReply(SLACK_TOKEN, event.channel, event.ts, ':warning: No active walk-up event found in the next 7 days. Set one up in the DB first.');
        return;
      }

      const eventUrl = baseUrl + '/event/' + walkUpEvent.slug + "?phone=" + encodeURIComponent(parsed.phone || "");
      const smsBody = 'Hi ' + (parsed.first_name || 'there') + '! Bounce Man here 🎈 Tap to fill in your info, sign the waiver' +
        (isFree ? ' (free 15-min session):' : ' and pay $' + walkUpEvent.price_per_kid + '/kid:') +
        ' ' + eventUrl;

      let smsSent = false;
      if (parsed.phone) {
        try {
          await smsService.sendSms(parsed.phone, smsBody);
          smsSent = true;
        } catch (e) {
          console.error('[SARAH-SLACK] SMS failed:', e.message);
        }
      }

      const label = isFree ? 'Free (Google Review)' : '$' + walkUpEvent.price_per_kid + '/kid';
      const firstName = parsed.first_name || 'Customer';

      // Post live tracking card to #bookings
      const bookingsChannel = process.env.SLACK_BOOKINGS_CHANNEL || 'C0AQF8ZAEBE';
      const cardBlocks = [
        { type: 'header', text: { type: 'plain_text', text: '\u{1F388} ' + firstName + ' — Link Sent' } },
        { type: 'section', fields: [
          { type: 'mrkdwn', text: '*Phone:*\n' + (parsed.phone || 'N/A') },
          { type: 'mrkdwn', text: '*Event:*\n' + walkUpEvent.name + ' (' + label + ')' }
        ]},
        { type: 'section', fields: [
          { type: 'mrkdwn', text: '*Waiver:*\n\u274C Not yet' },
          { type: 'mrkdwn', text: '*Payment:*\n\u274C Pending' }
        ]},
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Link sent — waiting for ' + firstName + ' to fill out the form' }] }
      ];

      try {
        const cardResp = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: bookingsChannel, blocks: cardBlocks, text: firstName + ' — link sent' })
        });
        const cardData = await cardResp.json();
        if (cardData.ok && parsed.phone) {
          db.prepare('INSERT OR REPLACE INTO pending_slack_cards (phone, channel, ts, first_name, event_id) VALUES (?, ?, ?, ?, ?)').run(
            parsed.phone, cardData.channel, cardData.ts, firstName, walkUpEvent.id
          );
        }
      } catch (cardErr) {
        console.error('[SARAH-SLACK] Card post failed:', cardErr.message);
      }

      const confirmMsg = smsSent
        ? ':white_check_mark: Sent ' + firstName + ' the event link (' + label + '). Card posted to #bookings — will auto-update when they sign and pay.'
        : ':warning: SMS failed. Share this link manually: ' + eventUrl;
      await slackReply(SLACK_TOKEN, event.channel, event.ts, confirmMsg);
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
    db.prepare('INSERT INTO customers (id, first_name, last_name, email, phone, source) VALUES (?, ?, ?, ?, ?, \'slack\')').run(
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


// Slack interactivity endpoint (button clicks)
router.post('/slack/interactivity', async (req, res) => {
  try {
    // Slack sends payload as form-urlencoded
    const payload = JSON.parse(req.body.payload);

    // Immediately acknowledge (Slack expects 200 within 3s)
    res.status(200).send('');

    const { type, user, actions, response_url, message } = payload;

    if (type !== 'block_actions' || !actions || actions.length === 0) {
      return;
    }

    const action = actions[0];
    const actionId = action.action_id;
    const value = action.value ? JSON.parse(action.value) : {};

    console.log('[SLACK INTERACT]', actionId, value);

    if (actionId === 'on_my_way') {
      await handleOnMyWay(value, user, response_url, message);
    } else if (actionId === 'record_payment_modal') {
      // Future: Open modal for payment recording
      await respondToSlack(response_url, { text: 'Record Payment modal coming soon. For now, use Admin > Bookings > ' + value.booking_number });
    }

  } catch (err) {
    console.error('[SLACK INTERACT] Error:', err.message);
  }
});

async function handleOnMyWay(value, user, response_url, originalMessage) {
  const { getDb } = require('../db');
  const smsService = require('../services/sms');
  const db = getDb();

  const { booking_id, booking_number, phone, first_name } = value;

  // Get current booking status
  const booking = db.prepare(`
    SELECT b.*, c.signed as contract_signed
    FROM bookings b
    LEFT JOIN contracts c ON c.booking_id = b.id
    WHERE b.id = ?
  `).get(booking_id);

  if (!booking) {
    await respondToSlack(response_url, { text: ':x: Booking not found' });
    return;
  }

  const issues = [];
  if (!booking.contract_signed) issues.push(':warning: Contract NOT signed');
  if (parseFloat(booking.balance_due) > 0) issues.push(':moneybag: $' + parseFloat(booking.balance_due).toFixed(2) + ' balance due');

  // Send SMS to customer
  const customerPhone = phone || booking.phone;
  if (customerPhone) {
    try {
      await smsService.sendSMS(customerPhone,
        'Bounce Man is on the way! ' + first_name + ', we should arrive within 30-60 minutes. See you soon!');
      console.log('[ON MY WAY] SMS sent to', customerPhone, 'for', booking_number);
    } catch (err) {
      console.error('[ON MY WAY] SMS failed:', err.message);
      issues.push(':x: SMS failed: ' + err.message);
    }
  } else {
    issues.push(':warning: No phone number for SMS');
  }

  // Update the Slack message with confirmation
  const statusText = issues.length > 0
    ? issues.join('\n')
    : ':white_check_mark: All clear!';

  const updatedBlocks = originalMessage.blocks.filter(b => b.type !== 'actions');
  updatedBlocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: ':truck: *On My Way* sent by <@' + user.id + '> at ' + new Date().toLocaleTimeString() }]
  });
  updatedBlocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: statusText }
  });

  await respondToSlack(response_url, {
    replace_original: true,
    blocks: updatedBlocks,
    text: 'On My Way notification sent for ' + booking_number
  });
}

async function respondToSlack(response_url, payload) {
  await fetch(response_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

const BM_NUMBER = '+15803089288'; // BounceMan's Twilio number — appears as SIP FROM on bridge legs

// ── Internal tool executor: calls our sarah endpoints from within the webhook ──
async function callSarahToolInternal(name, args, callerPhone, vapiCallId) {
  if (name === 'transferCall') return { result: 'TRANSFER_INITIATED to +15806281765' };
  if (name === 'endCall') return { result: 'CALL_ENDED' };

  const pathMap = {
    checkAvailability: 'check-availability',
    createAndSendLink: 'create-and-send-link',
    lookupBooking: 'lookup-booking'
  };
  const path = pathMap[name];
  if (!path) return { error: `Unknown tool: ${name}` };

  // Resolve the real caller's phone. When calls come through the SIP bridge, Twilio
  // injects BM_NUMBER as the SIP FROM (ignores callerId for external SIP URIs).
  // We stored the real phone in sip_call_map during assistant-request, and GPT-4.1
  // also knows it from {{customerPhone}} in the system prompt and should pass it in args.
  const getRealPhone = () => {
    if (callerPhone && callerPhone !== BM_NUMBER) return callerPhone;
    if (vapiCallId) {
      try {
        const db = getDb();
        const row = db.prepare('SELECT real_caller_phone FROM sip_call_map WHERE vapi_call_id = ?').get(vapiCallId);
        if (row?.real_caller_phone && row.real_caller_phone !== BM_NUMBER) return row.real_caller_phone;
      } catch (e) { /* ignore */ }
    }
    return callerPhone;
  };

  if (name === 'createAndSendLink') {
    if (!args.phone || args.phone.includes('{{') || args.phone === BM_NUMBER) {
      args.phone = getRealPhone();
    }
  }
  if (name === 'lookupBooking') {
    if (!args.phone || args.phone.includes('{{') || args.phone === BM_NUMBER) {
      args.phone = getRealPhone();
    }
  }

  const SARAH_KEY = process.env.SARAH_API_KEY || 'sarah-bm-k3y-2026-s3cur3';
  const PORT = process.env.PORT || 3200;
  const r = await fetch(`http://localhost:${PORT}/api/sarah/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sarah-key': SARAH_KEY },
    body: JSON.stringify(args)
  });
  return r.json();
}

// ============================================================
// VAPI WEBHOOK — End-of-call reports → Slack #phone-calls
// POST /api/webhooks/vapi
// ============================================================
router.post('/vapi', async (req, res) => {
  const msg = req.body?.message;
  if (!msg) return res.json({ received: true });

  // ─── ASSISTANT REQUEST: intercept before Sarah picks up ───────────────────
  if (msg.type === 'assistant-request') {
    const db = getDb();
    const callerNumber = msg.call?.customer?.number || '';
    const callId = msg.call?.id || '';

    const logBlock = (status, reason) => {
      try {
        db.prepare(`INSERT INTO call_log (id, caller_number, vapi_call_id, status, block_reason, called_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))`).run(uuid(), callerNumber, callId, status, reason || null);
      } catch (e) { /* ignore */ }
    };

    // Ensure sip_call_map table exists for phone bridging
    try {
      db.prepare(`CREATE TABLE IF NOT EXISTS sip_call_map (
        vapi_call_id TEXT PRIMARY KEY,
        real_caller_phone TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )`).run();
    } catch (e) { /* ignore */ }

    // Helper: build response with real caller's phone injected as {{customerPhone}}
    const connectToSarah = (realPhone) => {
      if (callId && realPhone) {
        try { db.prepare('INSERT OR REPLACE INTO sip_call_map (vapi_call_id, real_caller_phone) VALUES (?, ?)').run(callId, realPhone); } catch (e) { /* ignore */ }
      }
      console.log('[VAPI] Connecting to Sarah — customerPhone:', realPhone || 'unknown');
      return res.json({
        assistantId: VAPI_ASSISTANT_ID,
        assistantOverrides: { variableValues: { customerPhone: realPhone || '' } }
      });
    };

    // 0. Skip spam filtering for outbound calls
    if (msg.call?.type === 'outboundPhoneCall') {
      return connectToSarah(callerNumber);
    }

    // 0b. Owner/bridge whitelist — never block
    const WHITELIST = ['+15806281765', '+15803089288'];
    if (WHITELIST.includes(callerNumber)) {
      let realPhone = callerNumber;
      if (callerNumber === BM_NUMBER) {
        // SIP bridge leg — real caller's phone is in call_log from twilio-entry (last ~2 min)
        try {
          const recent = db.prepare(`
            SELECT caller_number FROM call_log
            WHERE status = 'allowed' AND caller_number != ?
            AND called_at > datetime('now', '-120 seconds')
            ORDER BY called_at DESC LIMIT 1
          `).get(BM_NUMBER);
          if (recent?.caller_number) realPhone = recent.caller_number;
        } catch (e) { /* ignore */ }
        console.log('[VAPI] SIP bridge leg — resolved real caller:', realPhone);
      }
      return connectToSarah(realPhone);
    }

    // 1. Non-US number (valid US: +1 followed by area code 2-9 + 9 more digits)
    if (callerNumber && !/^\+1[2-9]\d{9}$/.test(callerNumber)) {
      logBlock('blocked', 'non_us_number');
      console.log('[VAPI SPAM]', callerNumber, '-> blocked (non-US)');
      return res.json({ error: 'Service unavailable from your number.' });
    }

    // 2. Explicit blocklist
    try {
      const blocked = db.prepare('SELECT reason FROM blocked_numbers WHERE number = ?').get(callerNumber);
      if (blocked) {
        logBlock('blocked', 'blocklist:' + blocked.reason);
        console.log('[VAPI SPAM]', callerNumber, '-> blocked (blocklist)');
        return res.json({ error: 'This number has been blocked.' });
      }
    } catch (e) { /* ignore if table not yet created */ }

    // 3. Rate limit: count twilio-entry rows only (twilio-entry already logs 'allowed' rows,
    //    so we don't double-log here — just check the count from twilio-entry logs)
    try {
      const recent = db.prepare(`SELECT COUNT(*) as c FROM call_log
        WHERE caller_number = ? AND called_at > datetime('now', '-24 hours')`).get(callerNumber);
      if (recent && recent.c >= 10) {
        db.prepare(`INSERT OR IGNORE INTO blocked_numbers (id, number, reason, auto_blocked)
          VALUES (?, ?, 'rate_limit_exceeded', 1)`).run(uuid(), callerNumber);
        logBlock('blocked', 'rate_limit');
        console.log('[VAPI SPAM]', callerNumber, '-> auto-blocked (rate limit:', recent.c + ' calls/24h)');
        return res.json({ error: 'Too many calls from this number.' });
      }
    } catch (e) { /* ignore if table not yet created */ }

    // 4. Allowed -> connect to Sarah
    return connectToSarah(callerNumber);
  }

  // ─── TOOL CALLS: execute tools internally, return results synchronously ─────
  if (msg.type === 'tool-calls') {
    const toolCallList = msg.toolCallList || [];
    const callerPhone = msg.call?.customer?.number || '';
    const vapiCallId = msg.call?.id || '';
    const results = [];

    for (const tc of toolCallList) {
      const name = tc.function?.name;
      const rawArgs = tc.function?.arguments;
      const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : (rawArgs || {});
      try {
        const result = await callSarahToolInternal(name, args, callerPhone, vapiCallId);
        console.log('[VAPI TOOL]', name, 'args:', JSON.stringify(args).slice(0, 80), '-> result:', JSON.stringify(result).slice(0, 120));
        results.push({ toolCallId: tc.id, result: JSON.stringify(result) });
      } catch (err) {
        console.error('[VAPI TOOL]', name, 'ERROR:', err.message);
        results.push({ toolCallId: tc.id, result: JSON.stringify({ error: err.message }) });
      }
    }

    return res.json({ results });
  }

  // ─── ALL OTHER EVENTS: acknowledge then process async ────────────────────
  res.json({ received: true });

  const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
  const PHONE_CALLS_CHANNEL = process.env.SLACK_CHANNEL_ID || 'C0AQ5LT666R';

  if (msg.type === 'end-of-call-report') {
    const call = msg.call || {};
    const callerNumber = call.customer?.number || 'Unknown';
    const startedAt = call.startedAt ? new Date(call.startedAt) : null;
    const endedAt = call.endedAt ? new Date(call.endedAt) : null;
    const durationSec = (startedAt && endedAt) ? Math.round((endedAt - startedAt) / 1000) : null;
    const durationStr = durationSec != null
      ? (durationSec >= 60 ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` : `${durationSec}s`)
      : 'unknown';
    const cost = call.cost != null ? `$${Number(call.cost).toFixed(4)}` : 'n/a';
    const endedReason = call.endedReason || 'unknown';
    const recordingUrl = msg.artifact?.recordingUrl || msg.artifact?.stereoRecordingUrl || call.recordingUrl || null;
    const summary = msg.summary || call.summary || null;
    const transcript = msg.transcript || call.transcript || null;

    const headerLine = `:telephone_receiver: *Inbound Call* from ${callerNumber}`;
    const metaLine = `Duration: ${durationStr} | Ended: ${endedReason} | Cost: ${cost}`;
    const recordingLine = recordingUrl ? `:headphones: <${recordingUrl}|Listen to Recording>` : ':mute: No recording available';
    const summarySection = summary ? `\n*Summary:*\n${summary}` : '';

    let transcriptSection = '';
    if (transcript) {
      const MAX = 2800;
      const truncated = transcript.length > MAX ? transcript.slice(0, MAX) + '\n…[truncated]' : transcript;
      transcriptSection = `\n*Transcript:*\n\`\`\`${truncated}\`\`\``;
    }

    const slackText = `${headerLine}\n${metaLine}\n${recordingLine}${summarySection}${transcriptSection}`;

    try {
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: PHONE_CALLS_CHANNEL, text: slackText, unfurl_links: false })
      });
      console.log('[VAPI] End-of-call report posted to Slack for', callerNumber);
    } catch (err) {
      console.error('[VAPI] Slack post failed:', err.message);
    }

    // Also log to DB activity log
    try {
      const db = getDb();
      db.prepare(`INSERT INTO activity_log (id, action, entity_type, entity_id, details, ip_address)
        VALUES (?, 'sarah_call_completed', 'call', ?, ?, ?)`).run(
        uuid(), call.id || uuid(),
        JSON.stringify({ caller: callerNumber, duration_sec: durationSec, ended_reason: endedReason, cost: call.cost, recording_url: recordingUrl }),
        req.ip
      );
    } catch (dbErr) {
      console.error('[VAPI] DB log failed:', dbErr.message);
    }
  }
});

// ============================================================
// POST /api/webhooks/twilio-entry
// Twilio voice_url endpoint — spam filter before Vapi
// Returns TwiML: hangup for spam, Redirect to Vapi for clean calls
// ============================================================
router.post('/twilio-entry', (req, res) => {
  const from = (req.body?.From || '').trim();
  const callId = req.body?.CallSid || '';
  const db = getDb();

  const twimlHangup = (msg) => {
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>${msg}</Say><Hangup/></Response>`);
  };

  const twimlGather = () => {
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" action="/api/webhooks/twilio-gather" method="POST" timeout="8"><Play>https://bouncemanrentals.com/assets/audio/thanks-for-calling.mp3</Play></Gather><Hangup/></Response>`);
  };

  const logCall = (status, reason) => {
    try {
      db.prepare(`INSERT INTO call_log (id, caller_number, vapi_call_id, status, block_reason, called_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))`).run(uuid(), from, callId, status, reason || null);
    } catch (e) { /* ignore */ }
  };

  // 0. Owner whitelist — never block or rate-limit
  const WHITELIST = ['+15806281765'];
  if (WHITELIST.includes(from)) {
    logCall('allowed', null);
    console.log('[TWILIO ENTRY] Whitelisted number', from, '-> press-1 gate');
    return twimlGather();
  }

  // 1. Non-US numbers
  if (from && !/^\+1[2-9]\d{9}$/.test(from)) {
    logCall('blocked', 'non_us_number');
    console.log('[TWILIO SPAM]', from, '-> blocked (non-US)');
    return twimlHangup("We're sorry, this service is not available from your number.");
  }

  // 1b. Landline / VoIP detection via Twilio Lookup (async — best effort, non-blocking)
  // Fire lookup in background; block if confirmed non-mobile
  (async () => {
    try {
      const lookupRes = await fetch(
        `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(from)}?Fields=line_type_intelligence`,
        { headers: { 'Authorization': 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64') } }
      );
      const data = await lookupRes.json();
      const lineType = data?.line_type_intelligence?.type;
      if (lineType && lineType !== 'mobile' && lineType !== 'nonFixedVoip') {
        db.prepare(`INSERT OR IGNORE INTO blocked_numbers (id, number, reason, auto_blocked) VALUES (?, ?, 'non_mobile', 1)`)
          .run(uuid(), from);
        console.log('[TWILIO SPAM]', from, '-> auto-blocked async (line type:', lineType + ')');
      }
    } catch (e) { /* ignore — don't block call if lookup fails */ }
  })();

  // 2. Explicit blocklist
  try {
    const blocked = db.prepare('SELECT reason FROM blocked_numbers WHERE number = ?').get(from);
    if (blocked) {
      logCall('blocked', 'blocklist:' + blocked.reason);
      console.log('[TWILIO SPAM]', from, '-> blocked (blocklist)');
      return twimlHangup("We're sorry, this number has been blocked.");
    }
  } catch (e) { /* ignore */ }

  // 3. Rate limit: >5 calls in 24 hours
  try {
    const recent = db.prepare(`SELECT COUNT(*) as c FROM call_log
      WHERE caller_number = ? AND called_at > datetime('now', '-24 hours')`).get(from);
    if (recent && recent.c >= 5) {
      db.prepare(`INSERT OR IGNORE INTO blocked_numbers (id, number, reason, auto_blocked)
        VALUES (?, ?, 'rate_limit_exceeded', 1)`).run(uuid(), from);
      logCall('blocked', 'rate_limit');
      console.log('[TWILIO SPAM]', from, '-> auto-blocked (rate limit:', recent.c + ' calls/24h)');
      return twimlHangup("We're sorry, we've received too many calls from your number.");
    }
  } catch (e) { /* ignore */ }

  // Clean — log and present press-1 IVR
  logCall('allowed', null);
  console.log('[TWILIO ENTRY] Inbound from', from || 'Unknown', '-> press-1 gate');
  twimlGather();
});

// ============================================================
// POST /api/webhooks/twilio-gather
// Handles the press-1 response. On "1": uses <Dial><Sip> to bridge the
// caller into Vapi via a Twilio SIP Domain. <Redirect> always fails because
// Vapi requires CallStatus=ringing, but by gather time the call is in-progress.
// <Dial><Sip> creates a fresh ringing leg that Vapi accepts.
// ============================================================
router.post('/twilio-gather', (req, res) => {
  const digit = (req.body?.Digits || '').trim();
  res.type('text/xml');
  if (digit === '1') {
    const callerPhone = (req.body?.From || '+15803089288').trim();
    console.log('[TWILIO GATHER] Digit=1, caller:', callerPhone, '-> SIP dial to sip:bounceman@sip.vapi.ai');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${callerPhone}"><Sip>sip:bounceman@sip.vapi.ai</Sip></Dial></Response>`);
  } else {
    console.log('[TWILIO GATHER] Digit=' + (digit || 'none') + ' -> hanging up');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
});

module.exports = router;
