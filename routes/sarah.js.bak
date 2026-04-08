const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { v4: uuid } = require('uuid');

function getSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function normalizePhone(raw) {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
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
    : db.prepare("SELECT * FROM walk_up_events WHERE active = 1 ORDER BY event_date DESC LIMIT 1").get();

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
  const today = new Date().toISOString().split('T')[0];
  const events = db.prepare("SELECT * FROM walk_up_events WHERE active = 1").all();

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
  const events = db.prepare("SELECT id, name, event_date, price_per_kid FROM walk_up_events WHERE active = 1 ORDER BY event_date DESC").all();
  res.json({ success: true, events });
});

module.exports = router;
