const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { resolveDeliveryFee } = require('../lib/helpers');
const { requireAuth } = require('./auth');
const cookieParser = require('cookie-parser');
const { v4: uuid } = require('uuid');
const smsService = require('../services/sms');

router.use(cookieParser());

// Public API: Check availability
router.get('/availability', (req, res) => {
  const db = getDb();
  const { date, equipment_id } = req.query;
  if (!date) return res.json({ error: 'date required' });

  const blocked = db.prepare('SELECT * FROM blocked_dates WHERE date = ? AND (equipment_id IS NULL OR equipment_id = ?)').get(date, equipment_id || null);
  if (blocked) return res.json({ available: false, reason: blocked.reason });

  if (equipment_id) {
    const booked = db.prepare(`SELECT b.id FROM bookings b JOIN booking_items bi ON bi.booking_id = b.id
      WHERE b.event_date = ? AND bi.equipment_id = ? AND b.status NOT IN ('cancelled','declined')`).get(date, equipment_id);
    if (booked) return res.json({ available: false, reason: 'Already booked' });
  }

  // Return all booked equipment for that date
  const bookedItems = db.prepare(`SELECT bi.equipment_id FROM bookings b JOIN booking_items bi ON bi.booking_id = b.id
    WHERE b.event_date = ? AND b.status NOT IN ('cancelled','declined')`).all(date);

  res.json({ available: true, booked_equipment_ids: bookedItems.map(b => b.equipment_id) });
});

// Public API: Equipment list
router.get('/equipment', (req, res) => {
  const db = getDb();
  const equipment = db.prepare(`SELECT e.id, e.name, e.slug, e.category, e.short_description, e.dimensions,
    e.capacity_kids, e.age_range, e.price_daily, e.price_weekend, e.price_wet, e.featured,
    (SELECT image_path FROM equipment_images WHERE equipment_id = e.id AND is_primary = 1 LIMIT 1) as image
    FROM equipment e WHERE e.status = 'available' ORDER BY e.sort_order`).all();
  res.json(equipment);
});

// Public API: Delivery fee lookup
router.get('/delivery-fee', async (req, res) => {
  const db = getDb();
  const { zip } = req.query;
  if (!zip) return res.json({ fee: 0, zone: 'unknown', found: false });
  const r = await resolveDeliveryFee(db, zip);
  res.json({ fee: r.fee, zone: r.zone, found: true, miles: r.miles, city: r.city, state: r.state });
});

// Public API: Validate discount code
router.post('/validate-discount', (req, res) => {
  const db = getDb();
  const { code, subtotal } = req.body;
  const discount = db.prepare('SELECT * FROM discount_codes WHERE code = ? AND active = 1').get(code?.toUpperCase());

  if (!discount) return res.json({ valid: false, message: 'Invalid discount code' });
  if (discount.max_uses && discount.uses_count >= discount.max_uses) return res.json({ valid: false, message: 'Code has expired' });
  if (discount.valid_from && new Date(discount.valid_from) > new Date()) return res.json({ valid: false, message: 'Code not yet active' });
  if (discount.valid_until && new Date(discount.valid_until) < new Date()) return res.json({ valid: false, message: 'Code has expired' });
  if (discount.min_order && subtotal < discount.min_order) return res.json({ valid: false, message: `Minimum order $${discount.min_order}` });

  let amount = 0;
  if (discount.type === 'percent') amount = Math.round(subtotal * (discount.value / 100) * 100) / 100;
  else amount = discount.value;

  res.json({ valid: true, type: discount.type, value: discount.value, discount_amount: amount });
});

// === N8N INTEGRATION ENDPOINTS (key-based auth, before requireAuth) ===
function requireN8nKey(req, res, next) {
  const key = req.headers['x-n8n-key'];
  if (!key || key !== process.env.N8N_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.delete('/communications/:id', requireN8nKey, (req, res) => {
  getDb().prepare('DELETE FROM communications WHERE id = ?').run(req.params.id);
  console.log('[API] Communication deleted:', req.params.id);
  res.json({ success: true });
});

router.get('/communications/bot-status/:email', requireN8nKey, (req, res) => {
  const row = getDb().prepare(
    "SELECT bot_paused FROM communications WHERE recipient = ? AND type = 'contact_form' ORDER BY rowid DESC LIMIT 1"
  ).get(req.params.email);
  res.json({ bot_paused: row ? !!row.bot_paused : false });
});

router.post('/communications', requireN8nKey, (req, res) => {
  const { recipient, subject, body, metadata } = req.body;
  const id = uuid();
  getDb().prepare(`INSERT INTO communications (id, type, direction, subject, body, recipient, metadata)
    VALUES (?, 'email', 'outbound', ?, ?, ?, ?)`).run(
    id, subject || 'AI Auto-Reply', body || '', recipient || '',
    JSON.stringify(metadata || {})
  );
  console.log('[API] Outbound communication saved:', id);
  res.json({ success: true, id });
});

// === PROTECTED API ROUTES ===

// Facebook Commerce Manager product feed
// URL: https://bouncemanrentals.com/api/products/feed.csv
router.get('/products/feed.csv', (req, res) => {
  const db = getDb();

  const equipment = db.prepare(`
    SELECT e.id, e.name, e.slug, e.short_description, e.price_4hr, e.price_daily, e.category
    FROM equipment e
    WHERE e.status = 'available' AND e.category NOT IN ('add_ons', 'add-ons')
    ORDER BY e.sort_order
  `).all();

  const imageMap = {};
  db.prepare('SELECT equipment_id, image_path, is_primary FROM equipment_images ORDER BY is_primary DESC').all()
    // The "before we set up" rules card is a text graphic. It belongs in the on-site
    // gallery but not in a commerce feed — Meta rejects catalog images that are mostly text.
    .filter(row => !row.image_path.includes('rules-card'))
    .forEach(row => {
      if (!imageMap[row.equipment_id]) imageMap[row.equipment_id] = { primary: null, additional: [] };
      if (row.is_primary) imageMap[row.equipment_id].primary = row.image_path;
      else imageMap[row.equipment_id].additional.push(row.image_path);
    });

  const BASE = 'https://bouncemanrentals.com';
  const GPC = 'Toys & Games > Outdoor Play Equipment > Inflatable Bouncers';

  const headers = ['id','title','description','availability','condition','price','link','image_link','additional_image_link','brand','google_product_category'];

  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  const rows = equipment.map(e => {
    const imgs = imageMap[e.id] || { primary: null, additional: [] };
    const primaryImg = imgs.primary ? BASE + imgs.primary : '';
    const addlImgs = imgs.additional.slice(0, 9).map(p => BASE + p).join(',');
    const price = (e.price_4hr || e.price_daily || 0).toFixed(2) + ' USD';
    const desc = e.short_description || (e.name + ' rental — Kay County OK');
    const link = BASE + '/equipment/' + e.slug;
    return [
      e.id,
      e.name + ' Rental',
      desc,
      'in stock',
      'new',
      price,
      link,
      primaryImg,
      addlImgs,
      'Bounce Man',
      GPC
    ].map(escape).join(',');
  });

  const csv = [headers.join(','), ...rows].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="bounceman-products.csv"');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(csv);
});

// GET /api/ads/google/callback — Google Ads OAuth callback (PUBLIC: before requireAuth so Google's session-less redirect reaches it)
router.get('/ads/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/admin/ads/google?error=' + encodeURIComponent(error));
  if (!code)  return res.redirect('/admin/ads/google?error=no_code');
  try {
    const googleAds = require('../services/google-ads');
    await googleAds.handleCallback(code);
    res.redirect('/admin/ads/google?connected=1');
  } catch (e) {
    console.error('[GOOGLE ADS] callback error:', e.message);
    res.redirect('/admin/ads/google?error=' + encodeURIComponent(e.message));
  }
});

// Cloudflare Turnstile verification. Returns true when the visitor cleared the
// challenge — or when no secret is configured, so the sandbox still works.
// A siteverify outage fails OPEN: the backstops below still bound the damage,
// and silently swallowing real leads is worse than the bot risk it would cover.
async function verifyTurnstile(req) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  const token = (req.body || {})['cf-turnstile-response'];
  if (!token) return false;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: req.ip || '' }),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    const data = await resp.json();
    if (!data.success) console.warn('[LEAD] turnstile rejected:', (data['error-codes'] || []).join(','));
    return !!data.success;
  } catch (e) {
    console.error('[LEAD] turnstile verify unreachable, allowing through:', e.message);
    return true;
  }
}

// Lead-capture coupon popup (PUBLIC — must be before requireAuth): save the lead, text them
// the $10 code, then let Sarah take over the reply. The opener is sent via sendSms (logged to
// `communications` as outbound), so Sarah replays it as her first turn when they text back.
router.post('/lead', async (req, res) => {
  try {
    const { name, phone, email, sms_optin, website_url, _ts } = req.body || {};
    if (website_url) return res.json({ ok: true });                       // honeypot → silently drop bots
    if (_ts && (Date.now() - Number(_ts)) < 1500) return res.status(400).json({ ok: false, error: 'Please try again.' });

    // Cloudflare Turnstile — the real bot gate. Everything below it (honeypot,
    // timing, dupe window, daily cap) stays as defense in depth. No secret
    // configured (sandbox/dev) means verification is skipped, not failed.
    if (!(await verifyTurnstile(req))) {
      return res.status(400).json({ ok: false, error: "Couldn't verify you're human — please try again." });
    }
    if (!name || !phone || !email) return res.status(400).json({ ok: false, error: 'Please fill in your name, phone, and email.' });
    if (!sms_optin) return res.status(400).json({ ok: false, error: 'Please check the box so we can text your code.' });
    const digits = String(phone).replace(/\D/g, '').slice(-10);
    if (digits.length !== 10) return res.status(400).json({ ok: false, error: 'Please enter a valid 10-digit phone number.' });

    const db = getDb();
    const parts = String(name).trim().split(/\s+/);
    const first_name = parts[0];
    const last_name = parts.slice(1).join(' ');
    const norm = (s) => String(s || '').replace(/\D/g, '').slice(-10);
    const existing = db.prepare('SELECT id, email FROM customers').all().find((c) => norm(c.phone) === digits);
    if (!existing) {
      db.prepare("INSERT INTO customers (id, first_name, last_name, email, phone, state, source) VALUES (?, ?, ?, ?, ?, 'OK', 'lead_popup')")
        .run(uuid(), first_name, last_name || '', email || null, digits);
    } else if (email && !existing.email) {
      db.prepare("UPDATE customers SET email = ?, updated_at = datetime('now') WHERE id = ?").run(email, existing.id);
    }

    // Text the code — this becomes Sarah's first turn, so their reply threads
    // straight into her. Guarded against repeats and bot blasts (see sms.js).
    const opener = 'Hi ' + first_name + "! This is Sarah with Bounce Man. Here's your $10 code: SAVE10 — just enter it at checkout. What day are you thinking for your party?";
    smsService.sendLeadOpener(digits, opener, 'lead_popup')
      .catch((e) => console.error('[LEAD] opener SMS failed:', e.message));

    // ...and email it too. The text starts the conversation; the email is what
    // they can still find next week when the text is buried.
    if (email) {
      require('../services/email').sendCouponCode(email, first_name, 'SAVE10', 10)
        .catch((e) => console.error('[LEAD] coupon email failed:', e.message));
    }

    return res.json({ ok: true });   // always show success — don't reveal the guard to bots
  } catch (e) {
    console.error('[LEAD] error:', e.message);
    return res.status(500).json({ ok: false, error: 'Something went wrong — please try again.' });
  }
});

router.use(requireAuth);

// Calendar events (for FullCalendar)
router.get('/calendar-events', (req, res) => {
  const db = getDb();
  const bookings = db.prepare(`
    SELECT b.id, b.booking_number, b.event_date, b.event_start_time, b.event_end_time, b.status,
      c.first_name || ' ' || c.last_name as customer_name,
      GROUP_CONCAT(bi.item_name, ', ') as items
    FROM bookings b JOIN customers c ON c.id = b.customer_id
    LEFT JOIN booking_items bi ON bi.booking_id = b.id
    WHERE b.status NOT IN ('cancelled','declined')
    GROUP BY b.id
  `).all();

  const events = bookings.map(b => ({
    id: b.id,
    title: `${b.customer_name} - ${b.items || 'No items'}`,
    start: `${b.event_date}T${b.event_start_time}`,
    end: `${b.event_date}T${b.event_end_time}`,
    url: `/admin/bookings/${b.id}`,
    color: b.status === 'confirmed' ? '#28a745' : b.status === 'pending' ? '#ffc107' : '#6c757d',
    extendedProps: { booking_number: b.booking_number, status: b.status }
  }));

  // Add blocked dates
  const blocked = db.prepare('SELECT * FROM blocked_dates').all();
  blocked.forEach(bd => {
    events.push({
      title: bd.reason || 'Blocked',
      start: bd.date,
      allDay: true,
      color: '#dc3545',
      display: 'background'
    });
  });

  res.json(events);
});

// Dashboard stats (for AJAX refresh)
router.get('/stats', (req, res) => {
  const db = getDb();
  const dayjs = require('dayjs');
  const today = dayjs().format('YYYY-MM-DD');
  const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');

  res.json({
    todayBookings: db.prepare('SELECT COUNT(*) as c FROM bookings WHERE event_date = ?').get(today).c,
    monthRevenue: db.prepare("SELECT COALESCE(SUM(total), 0) as r FROM bookings WHERE created_at >= ? AND status != 'cancelled'").get(monthStart).r,
    pendingBookings: db.prepare("SELECT COUNT(*) as c FROM bookings WHERE status = 'pending'").get().c,
    unsignedContracts: db.prepare('SELECT COUNT(*) as c FROM contracts WHERE signed = 0').get().c
  });
});

// Blocked dates management
router.post('/blocked-dates', (req, res) => {
  const db = getDb();
  const { date, reason, equipment_id } = req.body;
  db.prepare('INSERT INTO blocked_dates (id, date, reason, equipment_id) VALUES (?, ?, ?, ?)')
    .run(uuid(), date, reason || null, equipment_id || null);
  res.json({ success: true });
});

router.delete('/blocked-dates/:id', (req, res) => {
  getDb().prepare('DELETE FROM blocked_dates WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Quick booking create (admin)
router.post('/bookings/quick', (req, res) => {
  const db = getDb();
  const data = req.body;

  let customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(data.email);
  const customerId = customer?.id || uuid();
  if (!customer) {
    db.prepare('INSERT INTO customers (id, first_name, last_name, email, phone) VALUES (?, ?, ?, ?, ?)')
      .run(customerId, data.first_name, data.last_name, data.email, data.phone);
  }

  const bookingId = uuid();
  const prefix = 'BM';
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 5).toUpperCase();
  const bookingNumber = `${prefix}-${ts}-${rand}`;

  db.prepare(`INSERT INTO bookings (id, booking_number, customer_id, status, event_date,
    event_start_time, event_end_time, delivery_address, delivery_city, delivery_zip, total, balance_due)
    VALUES (?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    bookingId, bookingNumber, customerId, data.event_date, data.event_start_time,
    data.event_end_time, data.delivery_address, data.delivery_city, data.delivery_zip,
    data.total || 0, data.total || 0
  );

  res.json({ success: true, booking_id: bookingId, booking_number: bookingNumber });
});

module.exports = router;
