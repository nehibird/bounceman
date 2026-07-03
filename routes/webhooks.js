const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { v4: uuid } = require('uuid');
const stripeService = require('../services/stripe');
const crypto = require('crypto');
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID || '2549cba6-1c8e-44df-86ed-a0f7533c182c';

// SECURITY: require SARAH_API_KEY (no insecure fallback) — used to auth internal /api/sarah/* calls
const SARAH_API_KEY = process.env.SARAH_API_KEY;
if (!SARAH_API_KEY) throw new Error('[SECURITY] SARAH_API_KEY environment variable is required');

// SECURITY: verify Slack request signatures (v0 HMAC) with 5-min replay window
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
function verifySlackSignature(req) {
  if (!SLACK_SIGNING_SECRET) return false;
  const sig = req.headers['x-slack-signature'];
  const ts = req.headers['x-slack-request-timestamp'];
  if (!sig || !ts) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > 300) return false;
  const body = req.rawBody ? req.rawBody.toString('utf8') : '';
  const mine = 'v0=' + crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update('v0:' + ts + ':' + body).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(sig)); } catch { return false; }
}

// SECURITY: validate Twilio request signatures. Monitor-mode by default (logs valid/invalid);
// set TWILIO_VALIDATE_ENFORCE=true to reject unsigned/invalid requests.
const TWILIO_VALIDATE_ENFORCE = process.env.TWILIO_VALIDATE_ENFORCE === 'true';
function guardTwilio(req, res) {
  let ok = false;
  try {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const sig = req.headers['x-twilio-signature'];
    if (authToken && sig) {
      const base = process.env.PUBLIC_BASE_URL || 'https://bouncemanrentals.com';
      ok = require('twilio').validateRequest(authToken, sig, base + req.originalUrl, req.body || {});
    }
  } catch (e) { console.error('[TWILIO AUTH] validate error:', e.message); }
  if (ok) {
    console.log('[TWILIO AUTH] valid signature on ' + req.originalUrl);
  } else {
    console.warn('[TWILIO AUTH] INVALID signature on ' + req.originalUrl + ' (enforce=' + TWILIO_VALIDATE_ENFORCE + ')');
    if (TWILIO_VALIDATE_ENFORCE) { res.status(403).type('text/xml').send('<Response><Reject/></Response>'); return false; }
  }
  return true;
}

// SECURITY: Vapi webhook auth via X-Vapi-Secret header. Monitor-mode by default;
// set VAPI_VALIDATE_ENFORCE=true to reject calls without the matching secret.
const VAPI_VALIDATE_ENFORCE = process.env.VAPI_VALIDATE_ENFORCE === 'true';
function guardVapi(req, res) {
  const expected = process.env.VAPI_SERVER_SECRET;
  const got = req.headers['x-vapi-secret'];
  let ok = false;
  if (expected && got) {
    try { ok = crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected)); } catch { ok = false; }
  }
  if (ok) {
    console.log('[VAPI AUTH] valid secret');
  } else {
    console.warn('[VAPI AUTH] INVALID/missing secret (enforce=' + VAPI_VALIDATE_ENFORCE + ')');
    if (VAPI_VALIDATE_ENFORCE) { res.status(401).json({ error: 'unauthorized' }); return false; }
  }
  return true;
}

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

        // Walk-up event payment (registration_id in metadata)
        if (!bookingId && session.metadata && session.metadata.registration_id) {
          const regId = session.metadata.registration_id;
          const eventId = session.metadata.event_id;
          const reg = db.prepare('SELECT * FROM walk_up_registrations WHERE id = ?').get(regId);
          if (!reg) { console.error('[Stripe Webhook] Walk-up reg not found:', regId); break; }

          // Dedup
          if (reg.payment_status === 'completed') { console.log('[Stripe Webhook] Walk-up already completed:', regId); break; }

          // Assign wristbands atomically using transaction
          const evRow = db.prepare('SELECT * FROM walk_up_events WHERE id = ?').get(eventId);
          const { start, end } = db.transaction((eid, count) => {
            const ev = db.prepare('SELECT wristband_counter FROM walk_up_events WHERE id = ?').get(eid);
            const s = (ev ? ev.wristband_counter : 0) + 1;
            const e = s + count - 1;
            db.prepare('UPDATE walk_up_events SET wristband_counter = ? WHERE id = ?').run(e, eid);
            return { start: s, end: e };
          })(eventId, reg.kid_count);

          const amountPaid = (session.amount_total || 0) / 100;
          db.prepare(`UPDATE walk_up_registrations SET payment_status = 'completed', stripe_payment_intent = ?, amount_paid = ?, wristband_start = ?, wristband_end = ? WHERE id = ?`)
            .run(session.payment_intent, amountPaid, start, end, regId);

          const updatedReg = db.prepare('SELECT * FROM walk_up_registrations WHERE id = ?').get(regId);
          console.log(`[Stripe Webhook] Walk-up payment completed: ${reg.parent_name}, wristbands ${start}-${end}`);

          // Update Slack card if one exists
          setTimeout(async () => {
            try {
              const slackToken = process.env.SLACK_BOT_TOKEN;
              if (slackToken && updatedReg.slack_card_ts && updatedReg.slack_card_channel) {
                const wristbandLabel = start === end ? '#' + start : '#' + start + '–#' + end;
                const blocks = [
                  { type: 'header', text: { type: 'plain_text', text: '🎈 ' + updatedReg.parent_name + ' — Ready!' } },
                  { type: 'section', fields: [
                    { type: 'mrkdwn', text: '*Phone:*\n' + (updatedReg.parent_phone || 'N/A') },
                    { type: 'mrkdwn', text: '*Event:*\n' + (evRow ? evRow.name : 'Walk-Up Event') }
                  ]},
                  { type: 'section', fields: [
                    { type: 'mrkdwn', text: '*Waiver:*\n✅ Signed' },
                    { type: 'mrkdwn', text: '*Payment:*\n✅ $' + amountPaid.toFixed(2) }
                  ]},
                  { type: 'section', fields: [
                    { type: 'mrkdwn', text: '*Kids:*\n' + updatedReg.kid_count },
                    { type: 'mrkdwn', text: '*Wristband' + (updatedReg.kid_count > 1 ? 's' : '') + ':*\n' + wristbandLabel }
                  ]},
                  { type: 'context', elements: [{ type: 'mrkdwn', text: '✅ All done — send them to the bounce house!' }] }
                ];
                await fetch('https://slack.com/api/chat.update', {
                  method: 'POST',
                  headers: { 'Authorization': 'Bearer ' + slackToken, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ channel: updatedReg.slack_card_channel, ts: updatedReg.slack_card_ts, blocks, text: updatedReg.parent_name + ' — paid & ready' })
                });
              }
              // Also post a new notification to #events if no card to update
              if (slackToken && (!updatedReg.slack_card_ts)) {
                const eventsChannel = process.env.SLACK_BOOKINGS_CHANNEL || 'C0B40UJSHHS';
                const wristbandLabel = start === end ? '#' + start : '#' + start + '–#' + end;
                await fetch('https://slack.com/api/chat.postMessage', {
                  method: 'POST',
                  headers: { 'Authorization': 'Bearer ' + slackToken, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ channel: eventsChannel, text: '✅ ' + updatedReg.parent_name + ' paid $' + amountPaid.toFixed(2) + ' — wristbands ' + wristbandLabel })
                });
              }
            } catch (e) { console.error('[Stripe Webhook] Walk-up Slack notify failed:', e.message); }
          }, 0);
          break;
        }

        if (!bookingId) {
          console.log('[Stripe Webhook] No booking_id or registration_id in metadata, skipping');
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

        // Flip the existing Slack card(s) Payment Status in place (no new card).
        try {
          const notif = require('../services/notifications');
          await notif.refreshDeliveryCard(bookingId);
          await notif.updateBookingSlackCard(bookingId);
        } catch (e) { console.error('[Stripe Webhook] card refresh failed:', e.message); }

        // Send confirmation email (webhook is reliable path; page redirect may never fire)
        setTimeout(async () => {
          try {
            const refreshedBooking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
            if (!refreshedBooking.confirmation_email_sent) {
              const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(refreshedBooking.customer_id);
              const items = db.prepare('SELECT * FROM booking_items WHERE booking_id = ?').all(bookingId);
              if (customer && customer.email) {
                const contract = db.prepare('SELECT id FROM contracts WHERE booking_id = ?').get(bookingId);
                const emailService = require('../services/email');
                await emailService.sendBookingConfirmation(refreshedBooking, customer, items, contract && contract.id);
                db.prepare('UPDATE bookings SET confirmation_email_sent = 1 WHERE id = ?').run(bookingId);
                console.log('[Stripe Webhook] Confirmation email sent to', customer.email);

                // Also fire Slack booking card if never created
                const notifs = require('../services/notifications');
                notifs.notifyNewBooking(refreshedBooking, customer, items)
                  .catch(e2 => console.error('[STRIPE WEBHOOK] Slack notify failed:', e2.message));
              }
            }
          } catch (e) { console.error('[STRIPE WEBHOOK] Confirmation email failed:', e.message); }
        }, 0);

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
  if (!verifySlackSignature(req)) return res.status(401).send('invalid signature');
  // Slack URL verification challenge
  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  // Acknowledge immediately (Slack requires < 3s response)
  res.json({ ok: true });

  const event = req.body.event;
  if (!event) return;

  // App Home opened — publish dashboard view
  if (event.type === 'app_home_opened') {
    const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
    if (!SLACK_TOKEN) return;
    try {
      const db = getDb();
      const today = new Date().toISOString().split('T')[0];

      // Today's active events
      const todayEvents = db.prepare('SELECT * FROM walk_up_events WHERE event_date = ? AND active = 1 ORDER BY price_per_kid ASC').all(today);

      // Today's registrations
      const todayRegs = db.prepare(
        "SELECT r.*, e.name as event_name, e.price_per_kid FROM walk_up_registrations r JOIN walk_up_events e ON r.event_id = e.id WHERE r.created_at >= ? ORDER BY r.created_at DESC"
      ).all(today + ' 00:00:00');

      const totalKids = todayRegs.reduce((s, r) => s + (r.kid_count || 0), 0);
      const totalRevenue = todayRegs.filter(r => r.payment_status === 'completed').reduce((s, r) => s + parseFloat(r.amount_paid || 0), 0);
      const signedWaivers = todayRegs.filter(r => r.waiver_signed).length;

      const blocks = [
        { type: 'header', text: { type: 'plain_text', text: '🎈 Bounce Man Dashboard', emoji: true } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: '*Today:* ' + new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) }] },
        { type: 'divider' }
      ];

      // Stats row
      blocks.push({
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: '*Kids Today*\n' + totalKids },
          { type: 'mrkdwn', text: '*Revenue*\n$' + totalRevenue.toFixed(2) },
          { type: 'mrkdwn', text: '*Registrations*\n' + todayRegs.length },
          { type: 'mrkdwn', text: '*Waivers Signed*\n' + signedWaivers }
        ]
      });
      blocks.push({ type: 'divider' });

      // Today's events
      if (todayEvents.length > 0) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*📅 Today\'s Events*' } });
        for (const ev of todayEvents) {
          const evRegs = todayRegs.filter(r => r.event_id === ev.id);
          const evKids = evRegs.reduce((s, r) => s + (r.kid_count || 0), 0);
          const priceLabel = parseFloat(ev.price_per_kid) === 0 ? 'Free (Google Review)' : '$' + parseFloat(ev.price_per_kid).toFixed(0) + '/kid';
          blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: '*' + ev.name + '*  •  ' + priceLabel + '\n' + ev.location + '  •  ' + evRegs.length + ' registrations, ' + evKids + ' kids' },
            accessory: { type: 'button', text: { type: 'plain_text', text: 'Open Site' }, url: (process.env.BASE_URL || 'https://bouncemanrentals.com') + '/event/' + ev.slug, action_id: 'open_event_' + ev.id }
          });
        }
        blocks.push({ type: 'divider' });
      } else {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No active events today_' } });
        blocks.push({ type: 'divider' });
      }

      // Recent registrations
      if (todayRegs.length > 0) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*📋 Today\'s Registrations*' } });
        for (const r of todayRegs.slice(0, 8)) {
          const waiverIcon = r.waiver_signed ? '✅' : '❌';
          const payIcon = r.payment_status === 'completed' ? '✅' : '⏳';
          const wristbands = r.wristband_start == null ? '—' : (r.wristband_start === r.wristband_end ? '#' + r.wristband_start : '#' + r.wristband_start + '–#' + r.wristband_end);
          blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: '*' + r.parent_name + '*  •  ' + r.kid_count + ' kid' + (r.kid_count !== 1 ? 's' : '') + '  •  ' + wristbands + '\nWaiver ' + waiverIcon + '  |  Payment ' + payIcon + '  |  $' + parseFloat(r.amount_paid || 0).toFixed(2) }
          });
        }
      } else {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No registrations yet today_' } });
      }

      blocks.push({ type: 'divider' });

      // Commands reference
      blocks.push({ type: 'header', text: { type: 'plain_text', text: '💬 What I Can Do', emoji: true } });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '*Send a parent the paid event link + waiver*\n`text [Name] at [phone] a parent form`\n_Example: text Brenna at 5801234567 a parent form_' }
      });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '*Send a parent the free bounce link (Google Review)*\n`text [Name] at [phone] a free link`\n_Example: text Marcus at 5809876543 a free link_' }
      });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '*Create a rental booking*\n`book [Name] on [date] for [equipment]`\n_Example: book Sarah Johnson on June 14 for the Blue Crush slide all day_' }
      });
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'DM me directly or mention @Sarah in any channel. I\'ll post tracking cards to <#' + (process.env.SLACK_BOOKINGS_CHANNEL || 'C0B40UJSHHS') + '>.' }]
      });

      await fetch('https://slack.com/api/views.publish', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: event.user, view: { type: 'home', blocks } })
      });
    } catch (e) {
      console.error('[APP_HOME] Error publishing home view:', e.message);
    }
    return;
  }

  // === Text-thread reply in #texts -> send an SMS back to that customer ===
  const TEXTS_CHANNEL = process.env.SLACK_TEXTS_CHANNEL || 'C0B845ESG30';
  if (event.type === 'message' && event.channel === TEXTS_CHANNEL) {
    if (event.bot_id || event.subtype || event.app_id) return;      // ignore our own echoes / edits
    if (!event.thread_ts || event.thread_ts === event.ts) return;   // only replies inside a customer thread
    const outText = String(event.text || '')
      .replace(/<([^|>]+)\|([^>]+)>/g, '$2')   // <url|label> -> label
      .replace(/<([^>]+)>/g, '$1')             // <url> -> url
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .trim();
    if (!outText) return;
    try {
      const db = getDb();
      const key = req.body.event_id || event.client_msg_id || (event.channel + ':' + event.ts);
      try { db.prepare('INSERT INTO slack_events_seen (event_key) VALUES (?)').run(key); }
      catch (dup) { return; }  // duplicate delivery (Slack retry) — already handled
      const notif = require('../services/notifications');
      const phone = notif.threadPhone(event.channel, event.thread_ts);
      if (!phone) { console.warn('[SMS THREAD] no phone mapped for thread', event.thread_ts); return; }
      await require('../services/sms').sendSms('+1' + phone, outText, { fromSlack: { channel: event.channel, ts: event.ts } });
      console.log('[SMS THREAD] Slack reply -> SMS to +1' + phone);
    } catch (e) { console.error('[SMS THREAD] handler error:', e.message); }
    return;
  }

  const isDm = event.type === 'message' && event.channel_type === 'im';
  if (event.type !== 'app_mention' && !isDm) return;

  // Ignore bot messages and message subtypes (edits, deletions) to prevent loops
  if (event.bot_id || event.subtype) return;

  const BOOKINGS_CHANNEL = process.env.SLACK_BOOKINGS_CHANNEL || 'C0B40UJSHHS';
  const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
  const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
  const text = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim(); // Strip @mention if present

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
- "overnight" = overnight duration, times 09:00-23:59 (full day of use plus the night; 9 AM next-day pickup)
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

      const label = isFree ? 'Free (Google Review)' : '$' + walkUpEvent.price_per_kid + '/kid';
      const firstName = parsed.first_name || 'Customer';

      // No phone — ask for it
      if (!parsed.phone) {
        await slackReply(SLACK_TOKEN, event.channel, event.ts,
          "What's " + firstName + "'s phone number? Example: _text " + firstName + ' at 5801234567 ' + (isFree ? 'a free link' : 'a parent form') + '_');
        return;
      }

      const eventUrl = baseUrl + '/event/' + walkUpEvent.slug + '?phone=' + encodeURIComponent(parsed.phone);
      const smsBody = 'Hi ' + firstName + '! Bounce Man here 🎈 Tap to fill in your info, sign the waiver' +
        (isFree ? ' (free 15-min session):' : ' and pay $' + walkUpEvent.price_per_kid + '/kid:') +
        ' ' + eventUrl;

      let smsSent = false;
      try {
        await smsService.sendSms(parsed.phone, smsBody);
        smsSent = true;
      } catch (e) {
        console.error('[SARAH-SLACK] SMS failed:', e.message);
      }

      // Post live tracking card to #events
      const bookingsChannel = process.env.SLACK_BOOKINGS_CHANNEL || 'C0B40UJSHHS';
      const cardBlocks = [
        { type: 'header', text: { type: 'plain_text', text: '🎈 ' + firstName + ' — Link Sent' } },
        { type: 'section', fields: [
          { type: 'mrkdwn', text: '*Phone:*\n' + parsed.phone },
          { type: 'mrkdwn', text: '*Event:*\n' + walkUpEvent.name + ' (' + label + ')' }
        ]},
        { type: 'section', fields: [
          { type: 'mrkdwn', text: '*Waiver:*\n❌ Not yet' },
          { type: 'mrkdwn', text: '*Payment:*\n' + (isFree ? '✅ Free' : '❌ Pending') }
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
        if (cardData.ok) {
          db.prepare('INSERT OR REPLACE INTO pending_slack_cards (phone, channel, ts, first_name, event_id) VALUES (?, ?, ?, ?, ?)').run(
            parsed.phone, cardData.channel, cardData.ts, firstName, walkUpEvent.id
          );
        }
      } catch (cardErr) {
        console.error('[SARAH-SLACK] Card post failed:', cardErr.message);
      }

      if (smsSent) {
        await slackReact(SLACK_TOKEN, event.channel, event.ts, 'white_check_mark');
      } else {
        await slackReply(SLACK_TOKEN, event.channel, event.ts, ':warning: SMS failed to ' + parsed.phone + '. Share manually: ' + eventUrl);
      }
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

async function slackReact(token, channel, ts, emoji) {
  await fetch('https://slack.com/api/reactions.add', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, timestamp: ts, name: emoji })
  });
}

async function slackDeleteMessage(channel, ts) {
  const userToken = process.env.SLACK_USER_TOKEN;
  if (!userToken) return { ok: false, error: 'no_user_token' };
  const r = await fetch('https://slack.com/api/chat.delete', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + userToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, ts })
  });
  return r.json();
}


// Slack interactivity endpoint (button clicks)
router.post('/slack/interactivity', async (req, res) => {
  try {
    // Diagnostic: log every hit + whether the signature verifies, so silent button
    // failures (request never arrives vs signature rejected) can be told apart.
    console.log('[SLACK INTERACT] endpoint hit | sig:', req.headers['x-slack-signature'] ? 'present' : 'MISSING',
      '| ts:', req.headers['x-slack-request-timestamp'] || 'none', '| body.payload:', req.body && req.body.payload ? 'present' : 'MISSING');
    if (!verifySlackSignature(req)) {
      console.log('[SLACK INTERACT] signature REJECTED (check SLACK_SIGNING_SECRET vs Slack app)');
      return res.status(401).send('invalid signature');
    }
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
      await handleOnMyWay(value, user, response_url, message, payload);
    } else if (actionId === 'record_payment' || actionId === 'record_payment_modal') {
      await handleRecordPayment(value, user, response_url);
    } else if (actionId === 'toggle_sarah_sms') {
      const sarahSms = require('../services/sarah-sms');
      sarahSms.setEnabled(!sarahSms.isEnabled());
      await respondToSlack(response_url, { replace_original: true, blocks: sarahCardBlocks(sarahSms.isEnabled()), text: 'Sarah text auto-reply is now ' + (sarahSms.isEnabled() ? 'ON' : 'OFF') });
    } else if (actionId === 'sms_send_suggested') {
      const r = await require('../services/sarah-sms').actOnSuggestion(value.id, 'send', user && (user.name || user.id));
      if (!r.ok) await respondToSlack(response_url, { response_type: 'ephemeral', text: ':x: ' + r.error });
    } else if (actionId === 'sms_dismiss_suggested') {
      await require('../services/sarah-sms').actOnSuggestion(value.id, 'dismiss', user && (user.name || user.id));
    } else if (actionId === 'call_back') {
      await handleCallBack(value, user, response_url, message);
    }

  } catch (err) {
    console.error('[SLACK INTERACT] Error:', err.message);
  }
});

// Record a cash/check payment collected on delivery, then flip the card's Payment Status in place.
async function handleRecordPayment(value, user, response_url) {
  const { getDb } = require('../db');
  const notif = require('../services/notifications');
  const db = getDb();
  const { booking_id, booking_number } = value;

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking_id);
  if (!booking) {
    await respondToSlack(response_url, { response_type: 'ephemeral', text: ':x: Booking not found' });
    return;
  }
  const balance = parseFloat(booking.balance_due) || 0;
  if (balance <= 0) {
    await respondToSlack(response_url, { response_type: 'ephemeral', text: ':white_check_mark: ' + booking_number + ' is already paid in full.' });
    return;
  }

  try {
    const crypto = require('crypto');
    db.prepare("INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, status, notes, created_at) VALUES (?, ?, ?, ?, 'charge', 'check', 'completed', ?, datetime('now'))")
      .run(crypto.randomUUID(), booking.id, booking.customer_id, balance, 'Cash/check collected on delivery - recorded via Slack by ' + (user.name || user.id));
    db.prepare("UPDATE bookings SET balance_due = 0, payment_status = 'paid', deposit_paid = 1, updated_at = datetime('now') WHERE id = ?").run(booking.id);
    try { db.prepare('UPDATE customers SET total_revenue = total_revenue + ? WHERE id = ?').run(balance, booking.customer_id); } catch (e) { /* non-critical */ }
    try {
      db.prepare('INSERT INTO activity_log (id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), 'payment_received', 'booking', booking.id, JSON.stringify({ amount: balance, method: 'check', source: 'slack_record_payment', by: user.id }));
    } catch (e) { /* activity_log optional */ }
    console.log('[RECORD PAYMENT] $' + balance.toFixed(2) + ' (cash/check) recorded for', booking_number, 'by', user.id);
  } catch (err) {
    console.error('[RECORD PAYMENT] failed:', err.message);
    await respondToSlack(response_url, { response_type: 'ephemeral', text: ':x: Failed to record payment: ' + err.message });
    return;
  }

  // Flip the existing card(s) to Paid in Full — no new card.
  try { await notif.refreshDeliveryCard(booking.id); } catch (e) { console.error('[RECORD PAYMENT] card refresh failed:', e.message); }
  try { await notif.updateBookingSlackCard(booking.id); } catch (e) { /* new-booking card optional */ }

  await respondToSlack(response_url, { response_type: 'ephemeral', text: ':white_check_mark: Recorded *$' + balance.toFixed(2) + '* as paid for ' + booking_number + '. Card updated to *Paid in Full*.' });
}

async function handleOnMyWay(value, user, response_url, originalMessage, payload) {
  const { getDb } = require('../db');
  const smsService = require('../services/sms');
  const db = getDb();

  const { booking_id, booking_number, phone, first_name } = value;
  const channel = (payload && payload.channel && payload.channel.id) || (payload && payload.container && payload.container.channel_id) || null;
  const ts = (originalMessage && originalMessage.ts) || (payload && payload.message && payload.message.ts) || null;

  const booking = db.prepare('SELECT b.*, c.signed as contract_signed, c.id as contract_id FROM bookings b LEFT JOIN contracts c ON c.booking_id = b.id WHERE b.id = ?').get(booking_id);
  if (!booking) { await respondToSlack(response_url, { response_type: 'ephemeral', text: ':x: Booking not found' }); return; }

  const issues = [];
  if (!booking.contract_signed) issues.push(':warning: Contract NOT signed');
  if (parseFloat(booking.balance_due) > 0) issues.push(':moneybag: $' + parseFloat(booking.balance_due).toFixed(2) + ' balance due');

  const customerPhone = phone || booking.phone;
  let smsOk = false;
  if (customerPhone) {
    try {
      const baseUrl = process.env.BASE_URL || 'https://bouncemanrentals.com';
      let smsMsg = 'Bounce Man is on the way! ' + first_name + ', we should arrive within 30-60 minutes.';
      if (!booking.contract_signed && booking.contract_id) smsMsg += '\\n\\nPlease sign your rental agreement before we arrive: ' + baseUrl + '/contract/' + booking.contract_id;
      if (parseFloat(booking.balance_due) > 0) smsMsg += '\\n\\nPay your remaining balance of $' + parseFloat(booking.balance_due).toFixed(2) + ': ' + baseUrl + '/booking/pay/' + booking_number;
      smsMsg += '\\n\\nSee you soon!';
      await smsService.sendSms(customerPhone, smsMsg);
      smsOk = true;
      console.log('[ON MY WAY] SMS sent to', customerPhone, 'for', booking_number);
    } catch (err) {
      console.error('[ON MY WAY] SMS failed:', err.message);
      issues.push(':x: SMS failed: ' + err.message);
    }
  } else {
    issues.push(':warning: No phone number for SMS');
  }

  const sentTime = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }) + ' CT';
  const srcBlocks = Array.isArray(originalMessage && originalMessage.blocks) ? originalMessage.blocks : [];
  // Swap the "On My Way" button for a sent-state button; keep any other buttons (e.g. Record Payment).
  const newBlocks = srcBlocks.map(function (b) {
    if (b.type !== 'actions') return b;
    const els = (b.elements || []).filter(function (e) { return e.action_id !== 'on_my_way'; });
    els.unshift({ type: 'button', text: { type: 'plain_text', text: ':white_check_mark: On My Way — Sent ' + sentTime, emoji: true }, action_id: 'omw_sent_noop', value: '{}' });
    return { type: 'actions', elements: els };
  });
  const banner = { type: 'section', text: { type: 'mrkdwn', text: ':truck::white_check_mark: *On the way!* Text ' + (smsOk ? 'sent to' : 'attempted for') + ' *' + (first_name || 'the customer') + '* (' + (customerPhone || 'no number') + ') at ' + sentTime + (issues.length ? '\\n' + issues.join('\\n') : '') } };
  const finalBlocks = [banner].concat(newBlocks, [{ type: 'context', elements: [{ type: 'mrkdwn', text: 'Sent by <@' + user.id + '>' }] }]);
  const fallbackText = ':truck: On My Way sent to ' + (first_name || 'customer');

  // Reliable update via chat.update (response_url expires after ~30 min / 5 uses).
  let updated = false;
  if (channel && ts) {
    try {
      const r = await fetch('https://slack.com/api/chat.update', { method: 'POST', headers: { 'Authorization': 'Bearer ' + process.env.SLACK_BOT_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: channel, ts: ts, text: fallbackText, blocks: finalBlocks }) });
      const d = await r.json();
      updated = !!d.ok;
      if (!d.ok) console.error('[ON MY WAY] chat.update failed:', d.error);
    } catch (e) { console.error('[ON MY WAY] chat.update error:', e.message); }
  }
  if (!updated) {
    await respondToSlack(response_url, { replace_original: true, text: fallbackText, blocks: finalBlocks });
  }
}

// Maps a Slack user ID -> the cell phone we should ring when they click "Call Back".
// Whoever clicks gets called on THEIR phone first, then bridged to the customer
// (caller ID shows the Bounce Man business line, so personal cells stay private).
const CALLBACK_AGENTS = {
  'U0AQ2GH9XFD': '+15806281765', // Nehemiah Reese
  'U0AQ2GGNY0K': '+19403678241'  // Brana (The Bounce Babe)
};
const CALLBACK_DEFAULT = '+15806281765'; // fallback -> Nehemiah

async function handleCallBack(value, user, response_url, originalMessage) {
  const customerNumber = value.caller;
  const agentNumber = CALLBACK_AGENTS[user.id] || CALLBACK_DEFAULT;

  if (!customerNumber || !/^\+1[2-9]\d{9}$/.test(customerNumber)) {
    await respondToSlack(response_url, { replace_original: false, response_type: 'ephemeral', text: ':x: No valid customer number on this call to call back.' });
    return;
  }

  try {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    // Leg 1: call the agent's cell. When they answer, the TwiML dials the customer
    // (caller ID = Bounce Man business line so the customer recognizes it and the
    //  agent's personal number is never exposed).
    const recBase = process.env.PUBLIC_BASE_URL || 'https://bouncemanrentals.com';
    const recCb = `${recBase}/api/webhooks/callback-recording?customer=${encodeURIComponent(customerNumber)}`;
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Connecting you to your Bounce Man customer now.</Say><Dial callerId="${BM_NUMBER}" timeout="30" record="record-from-answer-dual" recordingStatusCallback="${recCb}" recordingStatusCallbackEvent="completed">${customerNumber}</Dial></Response>`;
    await twilio.calls.create({ to: agentNumber, from: BM_NUMBER, twiml });
    console.log('[CALL BACK] Ringing agent', agentNumber, '(slack', user.id + ') then bridging to', customerNumber);
  } catch (err) {
    console.error('[CALL BACK] error:', err.message);
    await respondToSlack(response_url, { replace_original: false, response_type: 'ephemeral', text: ':x: Call back failed: ' + err.message });
    return;
  }

  const agentLabel = user.id in CALLBACK_AGENTS ? '<@' + user.id + '>' : '<@' + user.id + '> (default → Nehemiah)';
  const ringTime = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }) + ' CT';
  const banner = { type: 'section', text: { type: 'mrkdwn', text: ':telephone_receiver::arrow_right: *Calling back ' + customerNumber + '* — ringing ' + agentLabel + ' first, then connecting the customer. (' + ringTime + ')' } };
  const updatedBlocks = [banner, ...originalMessage.blocks.filter(b => b.type !== 'actions')];
  await respondToSlack(response_url, {
    replace_original: true,
    blocks: updatedBlocks,
    text: ':telephone_receiver: Calling back ' + customerNumber
  });
}

async function respondToSlack(response_url, payload) {
  try {
    const r = await fetch(response_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) console.error('[SLACK RESPOND] non-ok status', r.status);
  } catch (e) { console.error('[SLACK RESPOND] failed:', e.message); }
}

function sarahCardBlocks(enabled) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: ':robot_face: *Sarah \u2014 Text Auto-Reply*\n' + (enabled ? ':large_green_circle: *ON* \u2014 Sarah replies to customer texts (answers questions, quotes, checks availability, books + sends deposit links).' : ':red_circle: *OFF* \u2014 incoming texts come to you only; Sarah stays quiet.') } },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: enabled ? 'Turn Sarah OFF' : 'Turn Sarah ON', emoji: true }, style: enabled ? 'danger' : 'primary', action_id: 'toggle_sarah_sms', value: 'toggle' }] }
  ];
}

const BM_NUMBER = '+15803089288'; // BounceMan's Twilio number — appears as SIP FROM on bridge legs

// ── Internal tool executor: calls our sarah endpoints from within the webhook ──
const TRANSFER_TARGET = '+15806281765'; // Nehemiah's cell

async function callSarahToolInternal(name, args, callerPhone, vapiCallId) {
  if (name === 'transferCall') {
    // Vapi's transferCall over a SIP-bridged call can't reliably reach an external PSTN
    // number, so we redirect the live Twilio call leg to Nehemiah instead. We look up the
    // Twilio CallSid stored during twilio-gather (keyed by the real caller's phone).
    try {
      const db = getDb();
      let realPhone = (callerPhone && callerPhone !== BM_NUMBER) ? callerPhone : null;
      if (!realPhone && vapiCallId) {
        try {
          const row = db.prepare('SELECT real_caller_phone FROM sip_call_map WHERE vapi_call_id = ?').get(vapiCallId);
          if (row && row.real_caller_phone && row.real_caller_phone !== BM_NUMBER) realPhone = row.real_caller_phone;
        } catch (e) { /* ignore */ }
      }
      let callSid = null;
      try {
        const row = db.prepare(`SELECT call_sid FROM twilio_call_map WHERE caller_phone = ? AND created_at > datetime('now', '-60 minutes') ORDER BY created_at DESC LIMIT 1`).get(realPhone);
        callSid = row && row.call_sid;
      } catch (e) { /* ignore */ }
      if (!callSid) {
        console.error('[TRANSFER] No live Twilio CallSid for caller', realPhone, '— cannot transfer');
        return { result: 'TRANSFER_UNAVAILABLE: Could not connect the caller to Nehemiah right now. Apologize briefly, tell them Nehemiah will call them right back, then end the call politely.' };
      }
      const twilio = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const BASE = process.env.PUBLIC_BASE_URL || 'https://bouncemanrentals.com';
      // Screened transfer: <Number url> plays a press-any-key whisper so voicemail
      // (which can't press a key) is never bridged to the customer; the Dial action
      // routes to a graceful callback message if Nehemiah doesn't pick up.
      // A short leading <Say> bridges the dead-air gap between Vapi's request-start line
      // and this redirect taking effect — callers were hanging up into silence (~8s).
      const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Please hold while I connect you.</Say><Dial action="${BASE}/api/webhooks/transfer-result?parent=${callSid}" method="POST" callerId="${BM_NUMBER}" timeout="25"><Number url="${BASE}/api/webhooks/transfer-screen?parent=${callSid}" method="POST">${TRANSFER_TARGET}</Number></Dial></Response>`;
      await twilio.calls(callSid).update({ twiml });
      console.log('[TRANSFER] Redirected Twilio call', callSid, 'to', TRANSFER_TARGET, 'for caller', realPhone);
      return { result: 'TRANSFER_INITIATED to ' + TRANSFER_TARGET };
    } catch (err) {
      console.error('[TRANSFER] error:', err.message);
      return { result: 'TRANSFER_UNAVAILABLE: Could not connect the call (' + err.message + '). Apologize, tell the caller Nehemiah will call them right back, then end the call politely.' };
    }
  }
  if (name === 'endCall') return { result: 'CALL_ENDED' };

  const pathMap = {
    checkAvailability: 'check-availability',
    createAndSendLink: 'create-and-send-link',
    sendCheckoutLink: 'send-checkout-link',
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

  if (name === 'createAndSendLink' || name === 'sendCheckoutLink') {
    if (!args.phone || args.phone.includes('{{') || args.phone === BM_NUMBER) {
      args.phone = getRealPhone();
    }
  }
  if (name === 'lookupBooking') {
    if (!args.phone || args.phone.includes('{{') || args.phone === BM_NUMBER) {
      args.phone = getRealPhone();
    }
  }

  const SARAH_KEY = SARAH_API_KEY;
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
  if (!guardVapi(req, res)) return;
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

    // Build a block card so we can attach a "Call Back" button. Slack section text
    // caps at 3000 chars, so split the body across blocks safely.
    const isCallable = /^\+1[2-9]\d{9}$/.test(callerNumber);
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `${headerLine}\n${metaLine}\n${recordingLine}` } }
    ];
    if (summary) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Summary:*\n${summary}`.slice(0, 2999) } });
    if (transcript) {
      const MAX = 2700;
      const t = transcript.length > MAX ? transcript.slice(0, MAX) + '\n…[truncated]' : transcript;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Transcript:*\n\`\`\`${t}\`\`\`` } });
    }
    if (isCallable) {
      blocks.push({
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: '📞 Call Back', emoji: true },
          style: 'primary',
          action_id: 'call_back',
          value: JSON.stringify({ caller: callerNumber })
        }]
      });
    }

    try {
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: PHONE_CALLS_CHANNEL, text: slackText, blocks, unfurl_links: false })
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
// Inbound SMS -> log to communications + ping Slack (chat UI reads communications)
router.post('/twilio-sms', (req, res) => {
  if (!guardTwilio(req, res)) return;
  const from = req.body.From || '';
  const body = (req.body.Body || '').trim();
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  try { require('../services/sms').logSms('inbound', from, body || (numMedia > 0 ? '[photo]' : ''), 'received'); } catch (e) { console.error('[SMS IN] log failed:', e.message); }
  try {
    if (body) require('../services/notifications').postSmsToThread(from, body, 'inbound').catch(e => console.error('[SMS IN] thread post:', e.message));
  } catch (e) { console.error('[SMS IN] slack failed:', e.message); }
  // MMS: pull each attachment from Twilio (needs Basic auth) and upload it into the customer's #texts thread
  if (numMedia > 0) {
    const SID = process.env.TWILIO_ACCOUNT_SID, TOK = process.env.TWILIO_AUTH_TOKEN;
    const auth = 'Basic ' + Buffer.from(SID + ':' + TOK).toString('base64');
    const notif = require('../services/notifications');
    for (let i = 0; i < numMedia; i++) {
      const url = req.body['MediaUrl' + i];
      const ctype = req.body['MediaContentType' + i] || 'application/octet-stream';
      if (!url) continue;
      (async () => {
        try {
          const r = await fetch(url, { headers: { Authorization: auth } });
          const buf = Buffer.from(await r.arrayBuffer());
          const ext = (ctype.split('/')[1] || 'bin').split(';')[0];
          await notif.uploadFileToThread(from, buf, 'mms-' + i + '-' + Date.now() + '.' + ext, ctype, ':camera: Attachment from customer');
        } catch (e) { console.error('[MMS IN] media', i, e.message); }
      })();
    }
  }
  if (body) { try { require('../services/sarah-sms').handleInboundSms(from, body).catch(e => console.error('[SARAH-SMS]', e.message)); } catch (e) { console.error('[SARAH-SMS] trigger:', e.message); } }
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

router.post('/twilio-entry', (req, res) => {
  if (!guardTwilio(req, res)) return;
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
  if (!guardTwilio(req, res)) return;
  const digit = (req.body?.Digits || '').trim();
  res.type('text/xml');
  if (digit === '1') {
    const callerPhone = (req.body?.From || '+15803089288').trim();
    const callSid = (req.body?.CallSid || '').trim();
    // Store the live Twilio CallSid keyed by caller phone so transferCall can redirect
    // this exact call leg to Nehemiah later (Vapi can't reach external PSTN over the bridge).
    if (callSid) {
      try {
        const db = getDb();
        db.prepare(`CREATE TABLE IF NOT EXISTS twilio_call_map (
          call_sid TEXT PRIMARY KEY,
          caller_phone TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        )`).run();
        db.prepare(`INSERT OR REPLACE INTO twilio_call_map (call_sid, caller_phone, created_at) VALUES (?, ?, datetime('now'))`).run(callSid, callerPhone);
      } catch (e) { console.error('[TWILIO GATHER] call map store failed:', e.message); }
    }
    console.log('[TWILIO GATHER] Digit=1, caller:', callerPhone, 'CallSid:', callSid, '-> SIP dial to sip:bounceman@sip.vapi.ai');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${callerPhone}"><Sip>sip:bounceman@sip.vapi.ai</Sip></Dial></Response>`);
  } else {
    console.log('[TWILIO GATHER] Digit=' + (digit || 'none') + ' -> hanging up');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
});

// ============================================================
// Screened owner-transfer routes (used by the transferCall redirect)
// ============================================================
// Parent CallSids the owner actively ACCEPTED (pressed a key), so transfer-result
// can distinguish a real connect from voicemail/no-answer. In-memory; the whole
// transfer lifecycle is well under a minute.
const transferAccepted = new Map(); // parentCallSid -> ms timestamp
function _pruneTransfers() {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [k, t] of transferAccepted) { if (t < cutoff) transferAccepted.delete(k); }
}

// Whisper played to the owner's phone when it answers. A human presses a key to
// accept; voicemail can't, so it falls through to <Hangup/> and is never bridged.
router.post('/transfer-screen', (req, res) => {
  if (!guardTwilio(req, res)) return;
  const parent = (req.query.parent || '').trim();
  const BASE = process.env.PUBLIC_BASE_URL || 'https://bouncemanrentals.com';
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" timeout="8" action="${BASE}/api/webhooks/transfer-accept?parent=${encodeURIComponent(parent)}" method="POST"><Say>Bounce Man customer on the line. Press any key to connect.</Say></Gather><Hangup/></Response>`);
});

// Owner pressed a key -> mark accepted and bridge (the whisper sub-flow completes
// without a hangup, so Twilio connects the two parties).
router.post('/transfer-accept', (req, res) => {
  if (!guardTwilio(req, res)) return;
  const parent = (req.query.parent || '').trim();
  if (parent) { _pruneTransfers(); transferAccepted.set(parent, Date.now()); }
  console.log('[TRANSFER] Owner accepted transfer for parent', parent);
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Connecting now.</Say></Response>`);
});

// Fires when the <Dial> to the owner ends. If he never accepted (no answer, busy,
// or voicemail), tell the customer he'll call back instead of dropping them silently
// or dumping them into his personal voicemail.
router.post('/transfer-result', (req, res) => {
  if (!guardTwilio(req, res)) return;
  const parent = (req.query.parent || '').trim();
  const status = (req.body && req.body.DialCallStatus) || '';
  const accepted = !!parent && transferAccepted.has(parent);
  if (parent) transferAccepted.delete(parent);
  res.type('text/xml');
  if (accepted) {
    console.log('[TRANSFER] Result for', parent, 'status=' + status, '-> was connected, ending');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  } else {
    console.log('[TRANSFER] Result for', parent, 'status=' + status, '-> owner unavailable, callback message');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, Nehemiah is not available to take your call right now. He will call you back as soon as he can. Thanks for calling Bounce Man. Goodbye.</Say><Hangup/></Response>`);
  }
});

// Twilio fires this when a Call Back (click-to-dial) recording finishes.
// Posts a "Listen" link to the bookings channel, mirroring the inbound call cards.
router.post('/callback-recording', async (req, res) => {
  res.status(204).end();
  try {
    const recUrl = req.body && req.body.RecordingUrl;
    if (!recUrl) return;
    const customer = req.query.customer || 'customer';
    const token = process.env.SLACK_BOT_TOKEN;
    const channel = process.env.SLACK_BOOKINGS_CHANNEL || 'C0B40UJSHHS';
    if (!token) { console.log('[CALLBACK REC] recorded', recUrl, '(no SLACK_BOT_TOKEN to post)'); return; }
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, text: ':headphones: Call-back with ' + customer + ' recorded — <' + recUrl + '.mp3|Listen to recording>' })
    });
    console.log('[CALLBACK REC] posted recording for', customer, recUrl);
  } catch (e) { console.error('[CALLBACK REC] error:', e.message); }
});

// === Slash command: /text <phone|first-name> <message> — start a NEW conversation as Bounce Man ===
router.post('/slack/command', async (req, res) => {
  if (!verifySlackSignature(req)) return res.status(401).send('invalid signature');
  const raw = (req.body.text || '').trim();
  const usage = 'Usage: `/text <phone or first name> <message>`\nExample: `/text 5806281765 Hey! It’s Bounce Man.`';
  if (!raw) return res.json({ response_type: 'ephemeral', text: usage });
  const sp = raw.indexOf(' ');
  if (sp < 0) return res.json({ response_type: 'ephemeral', text: ':warning: Add a message after the number/name.\n' + usage });
  const target = raw.slice(0, sp).trim();
  const message = raw.slice(sp + 1).trim();
  if (!message) return res.json({ response_type: 'ephemeral', text: ':warning: The message was empty.\n' + usage });

  const db = getDb();
  const digits = target.replace(/\D/g, '');
  let phone = null, who = null;
  if (digits.length === 10 || (digits.length === 11 && digits[0] === '1')) {
    phone = digits.length === 10 ? '+1' + digits : '+' + digits;
    const p10 = digits.slice(-10);
    const rows = db.prepare("SELECT first_name, last_name, phone FROM customers WHERE phone IS NOT NULL AND phone != ''").all();
    const m = rows.find(r => String(r.phone).replace(/\D/g, '').slice(-10) === p10);
    who = m ? (((m.first_name || '') + ' ' + (m.last_name || '')).trim() || phone) : phone;
  } else {
    const matches = db.prepare("SELECT first_name, last_name, phone FROM customers WHERE phone IS NOT NULL AND phone != '' AND lower(first_name) = lower(?)").all(target);
    if (matches.length === 0) return res.json({ response_type: 'ephemeral', text: ':x: No customer named *' + target + '* with a phone on file. Try their number: `/text 5806281765 ...`' });
    if (matches.length > 1) return res.json({ response_type: 'ephemeral', text: ':grey_question: Multiple people named *' + target + '*. Use a number instead — ' + matches.map(m => (((m.first_name || '') + ' ' + (m.last_name || '')).trim()) + ' (' + m.phone + ')').join(', ') });
    phone = matches[0].phone;
    who = ((matches[0].first_name || '') + ' ' + (matches[0].last_name || '')).trim();
  }

  res.json({ response_type: 'ephemeral', text: ':outbox_tray: Sending to *' + who + '*…' });
  const TEXTS = process.env.SLACK_TEXTS_CHANNEL || 'C0B845ESG30';
  try {
    await require('../services/sms').sendSms(phone, message);
    await respondToSlack(req.body.response_url, { replace_original: true, response_type: 'ephemeral', text: ':white_check_mark: Sent to *' + who + '*. It’s a thread in <#' + TEXTS + '> now — their reply comes back there.' });
  } catch (e) {
    await respondToSlack(req.body.response_url, { replace_original: true, response_type: 'ephemeral', text: ':x: Couldn’t send to ' + who + ': ' + e.message });
  }
});

module.exports = router;
