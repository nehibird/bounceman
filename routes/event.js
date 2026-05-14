const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { v4: uuid } = require('uuid');


const fs = require('fs');
const path = require('path');

function saveSignedWaiver(reg, event) {
  const uploadDir = path.join(__dirname, '..', 'uploads', 'waivers');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

  const signedAt = new Date(reg.waiver_signed_at || Date.now()).toLocaleString('en-US', { timeZone: 'America/Chicago' });
  const kidNames = (() => { try { return JSON.parse(reg.kid_names || '[]').join(', ') || 'Not specified'; } catch { return 'Not specified'; } })();

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Signed Waiver — ${reg.parent_name}</title>
<style>
  body { font-family: Arial, sans-serif; max-width: 700px; margin: 40px auto; padding: 20px; color: #333; }
  h1 { color: #e74c3c; } h2 { color: #555; border-bottom: 1px solid #ddd; padding-bottom: 8px; }
  .meta { background: #f8f9fa; padding: 16px; border-radius: 8px; margin-bottom: 24px; }
  .meta p { margin: 4px 0; } .waiver-text { font-size: 13px; line-height: 1.7; }
  .signature-section { margin-top: 32px; border-top: 2px solid #333; padding-top: 16px; }
  .sig-img { border: 1px solid #ccc; border-radius: 4px; background: #fff; max-width: 400px; }
  .footer { margin-top: 24px; font-size: 11px; color: #888; }
</style></head>
<body>
<h1>Bounce Man LLC — Signed Liability Waiver</h1>
<div class="meta">
  <p><strong>Event:</strong> ${event.name}</p>
  <p><strong>Event Date:</strong> ${event.event_date}</p>
  <p><strong>Location:</strong> ${event.location || 'Blinn Park, Tonkawa OK'}</p>
  <p><strong>Parent/Guardian:</strong> ${reg.parent_name}</p>
  <p><strong>Phone:</strong> ${reg.parent_phone || 'N/A'}</p>
  <p><strong>Number of Children:</strong> ${reg.kid_count}</p>
  <p><strong>Child Name(s):</strong> ${kidNames}</p>
  <p><strong>Signed At:</strong> ${signedAt} CT</p>
  <p><strong>IP Address:</strong> ${reg.signer_ip || 'N/A'}</p>
  <p><strong>Registration ID:</strong> ${reg.id}</p>
</div>
<h2>Liability Waiver Agreement</h2>
<div class="waiver-text">
  <p>By signing below, I acknowledge and agree to the following:</p>
  <p><strong>1. ASSUMPTION OF RISK:</strong> I understand that the use of inflatable equipment involves inherent risks including but not limited to falls, collisions, sprains, fractures, and other injuries. I voluntarily assume all risks associated with participation.</p>
  <p><strong>2. RELEASE OF LIABILITY:</strong> I hereby release, waive, and discharge Bounce Man LLC, its owners, employees, agents, and representatives from any and all liability, claims, demands, or causes of action arising out of or related to any injury, damage, or loss sustained while using the equipment.</p>
  <p><strong>3. INDEMNIFICATION:</strong> I agree to indemnify and hold harmless Bounce Man LLC from any claims, damages, or expenses arising from my child's participation.</p>
  <p><strong>4. SUPERVISION:</strong> I understand that Bounce Man LLC provides equipment only and does not supervise children. I am responsible for supervising my child(ren) at all times.</p>
  <p><strong>5. RULES:</strong> I agree that my child(ren) will follow all safety rules including: no shoes, no food/drinks, no sharp objects, no rough play, and observe maximum capacity limits.</p>
  <p>This waiver is binding on myself, my heirs, and legal representatives.</p>
</div>
<div class="signature-section">
  <p><strong>Electronic Signature of Parent/Guardian:</strong></p>
  <img class="sig-img" src="${reg.waiver_signature}" alt="Signature" />
  <p style="margin-top:8px"><em>${reg.parent_name} — signed ${signedAt} CT</em></p>
</div>
<div class="footer">
  <p>This document was electronically signed and is legally binding. Bounce Man LLC · Tonkawa, OK · (580) 308-9288</p>
</div>
</body></html>`;

  const filename = `waiver-${reg.id}.html`;
  const filepath = path.join(uploadDir, filename);
  fs.writeFileSync(filepath, html, 'utf8');
  return '/uploads/waivers/' + filename;
}

function getSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function getStripe() {
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// Atomic wristband assignment (transaction)
function assignWristbands(eventId, kidCount) {
  const db = getDb();
  const assign = db.transaction((eid, count) => {
    const event = db.prepare('SELECT wristband_counter FROM walk_up_events WHERE id = ?').get(eid);
    if (!event) throw new Error('Event not found');
    const start = event.wristband_counter + 1;
    const end = start + count - 1;
    db.prepare('UPDATE walk_up_events SET wristband_counter = ? WHERE id = ?').run(end, eid);
    return { start, end };
  });
  return assign(eventId, kidCount);
}

// Slack notification helper
async function notifySlack(reg, event) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!token || !channel) return;
  const wristbands = reg.wristband_start === reg.wristband_end
    ? `#${reg.wristband_start}`
    : `#${reg.wristband_start}-#${reg.wristband_end}`;
  const text = `${reg.parent_name} paid $${reg.amount_paid.toFixed(2)} for ${reg.kid_count} kid${reg.kid_count > 1 ? 's' : ''} at *${event.name}* -- waiver signed -- wristband ${wristbands}`;
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, text })
    });
  } catch (err) {
    console.error('[EVENT] Slack notification failed:', err.message);
  }
}

async function updateSlackCard(reg, eventRow, waiverSigned, paymentComplete) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || !reg.slack_card_ts || !reg.slack_card_channel) return;
  const priceLabel = eventRow.price_per_kid === 0 ? 'Free (Google Review)' : '$' + eventRow.price_per_kid + '/kid';
  const firstName = (reg.parent_name || 'Customer').split(' ')[0];
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '\u{1F388} ' + firstName + ' — ' + (paymentComplete ? 'All Done!' : 'Waiver Signed') } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: '*Phone:*\n' + (reg.parent_phone || 'N/A') },
      { type: 'mrkdwn', text: '*Event:*\n' + eventRow.name + ' (' + priceLabel + ')' }
    ]},
    { type: 'section', fields: [
      { type: 'mrkdwn', text: '*Waiver:*\n' + (waiverSigned ? '\u2705 Signed' : '\u274C Not yet') },
      { type: 'mrkdwn', text: '*Payment:*\n' + (paymentComplete ? '\u2705 Paid ($' + reg.amount_paid.toFixed(2) + ')' : '\u274C Pending') }
    ]}
  ];
  if (paymentComplete && reg.wristband_start) {
    const wb = reg.wristband_start === reg.wristband_end ? '#' + reg.wristband_start : '#' + reg.wristband_start + '-#' + reg.wristband_end;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Wristbands:* ' + wb + ' \u00B7 ' + reg.kid_count + ' kid' + (reg.kid_count > 1 ? 's' : '') } });
  }
  try {
    const slackRes = await fetch('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: reg.slack_card_channel, ts: reg.slack_card_ts, blocks, text: firstName + ' — ' + (paymentComplete ? 'paid' : 'waiver signed') })
    });
    const slackJson = await slackRes.json();
    if (!slackJson.ok) console.error('[EVENT] Slack card update failed:', slackJson.error);
  } catch (err) {
    console.error('[EVENT] Slack card update failed:', err.message);
  }
}

// GET /event — Walk-up registration page

router.get('/', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const eventId = req.query.event;
  const kiosk = req.query.kiosk === '1';
  const events = db.prepare('SELECT * FROM walk_up_events WHERE active = 1 ORDER BY event_date DESC').all();
  const selectedEvent = eventId
    ? db.prepare('SELECT * FROM walk_up_events WHERE id = ? AND active = 1').get(eventId)
    : null;

  res.render('public/event/walkin', {
    title: 'Walk-Up Registration - Bounce Man',
    settings, events, selectedEvent, kiosk,
    stripeKey: process.env.STRIPE_PUBLISHABLE_KEY,
    page: 'event'
  });
});

// POST /event/pay — Create Stripe Checkout Session
router.post('/pay', async (req, res) => {
  const db = getDb();
  const stripe = getStripe();
  const { event_id, parent_name, parent_phone, kid_count, kid_names, waiver_signature } = req.body;

  if (!event_id || !parent_name || !kid_count || kid_count < 1 || !waiver_signature) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const event = db.prepare('SELECT * FROM walk_up_events WHERE id = ? AND active = 1').get(event_id);
  if (!event) return res.status(404).json({ error: 'Event not found or inactive' });

  const regId = uuid();
  const amount = event.price_per_kid * kid_count;

  // Create pending registration with waiver
  db.prepare(`INSERT INTO walk_up_registrations
    (id, event_id, parent_name, parent_phone, kid_count, kid_names,
     waiver_signed, waiver_signature, waiver_signed_at, signer_ip, amount_paid, payment_status)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), ?, ?, 'pending')`).run(
    regId, event_id, parent_name, parent_phone || null, parseInt(kid_count),
    JSON.stringify(kid_names || []),
    waiver_signature, req.ip, amount
  );

  // Save signed waiver document
  const regForWaiver = db.prepare('SELECT * FROM walk_up_registrations WHERE id = ?').get(regId);
  const eventForWaiver = db.prepare('SELECT * FROM walk_up_events WHERE id = ?').get(event_id);
  try { saveSignedWaiver(regForWaiver, eventForWaiver); } catch (wErr) { console.error('[EVENT] Waiver save failed:', wErr.message); }

  // Check for pending Slack card (from @sarah send link) and attach to this registration
  if (parent_phone) {
    const normalizedPhone = parent_phone.replace(/\D/g, '');
    const allCards = db.prepare('SELECT channel, ts, phone FROM pending_slack_cards').all();
    const pendingCard = allCards.find(c => c.phone.replace(/\D/g, '') === normalizedPhone);
    if (pendingCard) {
      console.log('[EVENT] Slack card matched for', normalizedPhone, '-> ts:', pendingCard.ts);
      db.prepare('UPDATE walk_up_registrations SET slack_card_channel = ?, slack_card_ts = ? WHERE id = ?').run(pendingCard.channel, pendingCard.ts, regId);
      db.prepare('DELETE FROM pending_slack_cards WHERE phone = ?').run(pendingCard.phone);
    }
  }

  // Free events: skip Stripe, assign wristbands and complete immediately
  if (amount === 0) {
    try {
      const { start, end } = assignWristbands(event_id, parseInt(kid_count));
      db.prepare(`UPDATE walk_up_registrations SET
        payment_status = 'completed', wristband_start = ?, wristband_end = ?
        WHERE id = ?`).run(start, end, regId);
      const updatedReg = db.prepare('SELECT * FROM walk_up_registrations WHERE id = ?').get(regId);
      await notifySlack(updatedReg, event);
      await updateSlackCard(updatedReg, event, true, true);
      return res.json({ url: `/event/success?reg_id=${regId}` });
    } catch (err) {
      console.error('[EVENT] Free registration error:', err.message);
      return res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
  }

  // Update Slack card to show waiver signed, payment pending
  const regForCard = db.prepare('SELECT * FROM walk_up_registrations WHERE id = ?').get(regId);
  const eventForCard = db.prepare('SELECT * FROM walk_up_events WHERE id = ?').get(event_id);
  await updateSlackCard(regForCard, eventForCard, true, false);

  try {
    const baseUrl = process.env.EVENT_BASE_URL || `${req.protocol}://${req.get('host')}/event`;
    const kiosk = req.body.kiosk ? '&kiosk=1' : '';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${event.name} - Bounce Man`,
            description: `${kid_count} kid${kid_count > 1 ? 's' : ''} - includes waiver`
          },
          unit_amount: Math.round(event.price_per_kid * 100)
        },
        quantity: parseInt(kid_count)
      }],
      mode: 'payment',
      success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}${kiosk}`,
      cancel_url: `${baseUrl}?event=${event_id}${kiosk}`,
      metadata: {
        registration_id: regId,
        event_id: event_id
      }
    });

    db.prepare('UPDATE walk_up_registrations SET stripe_session_id = ? WHERE id = ?').run(session.id, regId);

    res.json({ url: session.url });
  } catch (err) {
    console.error('[EVENT] Stripe session error:', err.message);
    res.status(500).json({ error: 'Payment setup failed. Please try again.' });
  }
});

// GET /event/success — Post-payment confirmation
router.get('/success', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const sessionId = req.query.session_id;
  const kiosk = req.query.kiosk === '1';

  const regId = req.query.reg_id;

  // Free registrations come with reg_id directly; paid come with session_id
  let reg;
  if (regId) {
    reg = db.prepare('SELECT r.*, e.name as event_name, e.id as ev_id FROM walk_up_registrations r JOIN walk_up_events e ON e.id = r.event_id WHERE r.id = ?').get(regId);
  } else if (sessionId) {
    reg = db.prepare('SELECT r.*, e.name as event_name, e.id as ev_id FROM walk_up_registrations r JOIN walk_up_events e ON e.id = r.event_id WHERE r.stripe_session_id = ?').get(sessionId);
  }

  if (!reg) return res.redirect('/event');

  res.render('public/event/success', {
    title: 'All Set! - Bounce Man',
    settings, reg, kiosk, sessionId,
    page: 'event'
  });
});

// GET /event/status — JSON polling for payment status
router.get('/status', (req, res) => {
  const db = getDb();
  const reg = db.prepare('SELECT payment_status, wristband_start, wristband_end FROM walk_up_registrations WHERE stripe_session_id = ?').get(req.query.session_id);
  if (!reg) return res.json({ status: 'not_found' });
  res.json({ status: reg.payment_status, wristband_start: reg.wristband_start, wristband_end: reg.wristband_end });
});

// POST /event/webhook — Stripe webhook for event payments
router.post('/webhook', async (req, res) => {
  const stripe = getStripe();
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_EVENT_WEBHOOK_SECRET;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[EVENT WEBHOOK] Signature verification failed:', err.message);
    return res.status(400).send('Webhook signature failed');
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const regId = session.metadata?.registration_id;
    const eventId = session.metadata?.event_id;

    if (!regId) {
      console.error('[EVENT WEBHOOK] No registration_id in metadata');
      return res.json({ received: true });
    }

    const db = getDb();
    const reg = db.prepare('SELECT * FROM walk_up_registrations WHERE id = ?').get(regId);
    if (!reg) {
      console.error('[EVENT WEBHOOK] Registration not found:', regId);
      return res.json({ received: true });
    }

    try {
      // Assign wristbands atomically
      const { start, end } = assignWristbands(eventId, reg.kid_count);

      // Update registration
      db.prepare(`UPDATE walk_up_registrations SET
        payment_status = 'completed',
        stripe_payment_intent = ?,
        wristband_start = ?,
        wristband_end = ?
        WHERE id = ?`).run(session.payment_intent, start, end, regId);

      // Slack notification
      const event = db.prepare('SELECT * FROM walk_up_events WHERE id = ?').get(eventId);
      const updatedReg = db.prepare('SELECT * FROM walk_up_registrations WHERE id = ?').get(regId);
      await notifySlack(updatedReg, event);
      await updateSlackCard(updatedReg, event, true, true);

      db.prepare('UPDATE walk_up_registrations SET slack_notified = 1 WHERE id = ?').run(regId);

      console.log(`[EVENT WEBHOOK] Payment completed: ${reg.parent_name}, ${reg.kid_count} kids, wristbands ${start}-${end}`);
    } catch (err) {
      console.error('[EVENT WEBHOOK] Processing error:', err.message);
    }
  }

  res.json({ received: true });
});


// GET /event/:slug --- Slug-based event shortlink (must be last to avoid shadowing /success, /status)
router.get('/:slug', (req, res) => {
  const db = getDb();
  const event = db.prepare('SELECT id FROM walk_up_events WHERE slug = ? AND active = 1').get(req.params.slug);
  if (!event) return res.redirect('/event');
  return res.redirect('/event?event=' + event.id);
});

module.exports = router;
