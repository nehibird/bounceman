const express = require('express');
const router = express.Router();
const { getDb } = require('../db');

// Helper: get settings as object
function getSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// Homepage
router.get('/', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const featured = db.prepare(`
    SELECT e.*,
      (SELECT image_path FROM equipment_images WHERE equipment_id = e.id AND is_primary = 1 LIMIT 1) as image
    FROM equipment e
    WHERE e.status = 'available' AND e.featured = 1
    ORDER BY e.sort_order
  `).all();

  const categories = db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY sort_order').all();
  const reviews = db.prepare('SELECT * FROM reviews WHERE approved = 1 ORDER BY created_at DESC LIMIT 6').all();

  res.render('public/index', {
    title: settings.meta_title,
    settings,
    featured,
    categories,
    reviews,
    page: 'home'
  });
});

// Equipment catalog
router.get('/equipment', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const category = req.query.category;

  let equipment;
  if (category) {
    equipment = db.prepare(`
      SELECT e.*,
        (SELECT image_path FROM equipment_images WHERE equipment_id = e.id AND is_primary = 1 LIMIT 1) as image
      FROM equipment e
      WHERE e.status = 'available' AND e.category = ?
      ORDER BY e.sort_order
    `).all(category);
  } else {
    equipment = db.prepare(`
      SELECT e.*,
        (SELECT image_path FROM equipment_images WHERE equipment_id = e.id AND is_primary = 1 LIMIT 1) as image
      FROM equipment e
      WHERE e.status = 'available' AND e.category != 'add-ons'
      ORDER BY e.sort_order
    `).all();
  }

  const categories = db.prepare("SELECT * FROM categories WHERE active = 1 AND slug != 'add-ons' ORDER BY sort_order").all();

  res.render('public/equipment', {
    title: 'Our Equipment - Bounce Man Rentals',
    settings,
    equipment,
    categories,
    activeCategory: category || 'all',
    page: 'equipment'
  });
});

// Equipment detail
router.get('/equipment/:slug', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const item = db.prepare('SELECT * FROM equipment WHERE slug = ? AND status = ?').get(req.params.slug, 'available');

  if (!item) return res.status(404).render('public/404', { title: 'Not Found', settings });

  const images = db.prepare('SELECT * FROM equipment_images WHERE equipment_id = ? ORDER BY sort_order').all(item.id);
  const related = db.prepare(`
    SELECT e.*,
      (SELECT image_path FROM equipment_images WHERE equipment_id = e.id AND is_primary = 1 LIMIT 1) as image
    FROM equipment e
    WHERE e.category = ? AND e.id != ? AND e.status = 'available'
    ORDER BY RANDOM() LIMIT 3
  `).all(item.category, item.id);

  const reviews = db.prepare(`
    SELECT r.* FROM reviews r
    JOIN booking_items bi ON bi.booking_id = r.booking_id
    WHERE bi.equipment_id = ? AND r.approved = 1
    ORDER BY r.created_at DESC LIMIT 5
  `).all(item.id);

  res.render('public/equipment-detail', {
    title: `${item.name} - Bounce Man Rentals`,
    settings,
    item,
    images,
    related,
    reviews,
    page: 'equipment'
  });
});

// Packages
router.get('/packages', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const packages = db.prepare(`
    SELECT p.*,
      GROUP_CONCAT(e.name, ', ') as items_list
    FROM packages p
    LEFT JOIN package_items pi ON pi.package_id = p.id
    LEFT JOIN equipment e ON e.id = pi.equipment_id
    WHERE p.active = 1
    GROUP BY p.id
  `).all();

  res.render('public/packages', {
    title: 'Rental Packages - Bounce Man Rentals',
    settings,
    packages,
    page: 'packages'
  });
});

// About
router.get('/about', (req, res) => {
  const settings = getSettings();
  res.render('public/about', { title: 'About Us - Bounce Man Rentals', settings, page: 'about' });
});

// Contact
router.get('/contact', (req, res) => {
  const settings = getSettings();
  res.render('public/contact', { title: 'Contact Us - Bounce Man Rentals', settings, page: 'contact' });
});

// Contact form POST
router.post('/contact', (req, res) => {
  const db = getDb();
  const { v4: uuid } = require('uuid');
  const { name, email, phone, message, event_date } = req.body;

  // Save as lead/communication
  db.prepare(`INSERT INTO communications (id, type, direction, subject, body, recipient, metadata)
    VALUES (?, 'contact_form', 'inbound', ?, ?, ?, ?)`).run(
    uuid(), `Contact from ${name}`, message, email,
    JSON.stringify({ name, email, phone, event_date })
  );

  res.render('public/contact', {
    title: 'Contact Us - Bounce Man Rentals',
    settings: getSettings(),
    page: 'contact',
    success: 'Thanks for reaching out! We\'ll get back to you within 24 hours.'
  });
});

// How it works
router.get('/how-it-works', (req, res) => {
  const settings = getSettings();
  res.render('public/how-it-works', { title: 'How It Works - Bounce Man Rentals', settings, page: 'how-it-works' });
});

// Reviews page
router.get('/reviews', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const reviews = db.prepare('SELECT * FROM reviews WHERE approved = 1 ORDER BY created_at DESC').all();
  res.render('public/reviews', { title: 'Reviews - Bounce Man Rentals', settings, reviews, page: 'reviews' });
});

// Submit review
router.post('/reviews', (req, res) => {
  const db = getDb();
  const { v4: uuid } = require('uuid');
  const { booking_number, rating, comment, customer_name } = req.body;

  let booking_id = null;
  if (booking_number) {
    const booking = db.prepare('SELECT id FROM bookings WHERE booking_number = ?').get(booking_number);
    if (booking) booking_id = booking.id;
  }

  db.prepare(`INSERT INTO reviews (id, booking_id, rating, comment, customer_name, approved)
    VALUES (?, ?, ?, ?, ?, 0)`).run(uuid(), booking_id, parseInt(rating), comment, customer_name);

  res.redirect('/reviews?submitted=1');
});

// Availability check (AJAX)
router.get('/check-availability', (req, res) => {
  const db = getDb();
  const { date, equipment_id } = req.query;

  if (!date) return res.json({ available: false, message: 'Date required' });

  // Check blocked dates
  const blocked = db.prepare(`
    SELECT * FROM blocked_dates
    WHERE date = ? AND (equipment_id IS NULL OR equipment_id = ?)
  `).get(date, equipment_id || null);

  if (blocked) return res.json({ available: false, message: blocked.reason || 'Date unavailable' });

  // Check existing bookings for that date
  if (equipment_id) {
    const booked = db.prepare(`
      SELECT b.id FROM bookings b
      JOIN booking_items bi ON bi.booking_id = b.id
      WHERE b.event_date = ? AND bi.equipment_id = ? AND b.status NOT IN ('cancelled', 'declined')
    `).get(date, equipment_id);

    if (booked) return res.json({ available: false, message: 'Already booked for this date' });
  }

  res.json({ available: true, message: 'Available!' });
});

// FAQ
router.get('/faq', (req, res) => {
  const settings = getSettings();
  res.render('public/faq', { title: 'FAQ - Bounce Man Rentals', settings, page: 'faq' });
});

// Service areas
router.get('/service-areas', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const zones = db.prepare('SELECT * FROM delivery_zones WHERE active = 1 ORDER BY delivery_fee').all();
  res.render('public/service-areas', { title: 'Service Areas - Bounce Man Rentals', settings, zones, page: 'service-areas' });
});

// Privacy Policy
router.get('/privacy', (req, res) => {
  const settings = getSettings();
  res.render('public/privacy', { title: 'Privacy Policy - Bounce Man Rentals', settings, page: 'privacy' });
});

// Terms and Conditions
router.get('/terms', (req, res) => {
  const settings = getSettings();
  res.render('public/terms', { title: 'Terms & Conditions - Bounce Man Rentals', settings, page: 'terms' });
});

// Digital contract signing
router.get('/contract/:id', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const contract = db.prepare(`
    SELECT c.*, b.booking_number, b.event_date,
      cu.first_name, cu.last_name
    FROM contracts c
    JOIN bookings b ON b.id = c.booking_id
    JOIN customers cu ON cu.id = c.customer_id
    WHERE c.id = ?
  `).get(req.params.id);

  if (!contract) return res.status(404).render('public/404', { title: 'Not Found', settings, page: '404' });
  if (contract.signed) return res.render('public/contract-signed', { title: 'Rental Agreement Signed', settings, contract, page: 'contract' });

  res.render('public/contract', { title: 'Sign Rental Agreement', settings, contract, page: 'contract' });
});

// Sign contract POST
router.post('/contract/:id/sign', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const { signature_data, signer_name } = req.body;
  const ip = req.ip;

  const contract = db.prepare('SELECT * FROM contracts WHERE id = ? AND signed = 0').get(req.params.id);
  if (!contract) {
    if (req.headers['content-type']?.includes('json')) {
      return res.status(404).json({ error: 'Contract not found or already signed' });
    }
    return res.redirect('/contract/' + req.params.id);
  }

  db.prepare(`UPDATE contracts SET signed = 1, signature_data = ?, signed_at = datetime('now'),
    signer_ip = ?, signer_name = ? WHERE id = ?`).run(signature_data, ip, signer_name, req.params.id);

  db.prepare(`UPDATE bookings SET contract_signed = 1, contract_signed_at = datetime('now'),
    contract_signature = ? WHERE id = ?`).run(signature_data, contract.booking_id);

  if (req.headers['content-type']?.includes('json')) {
    return res.json({ success: true, message: 'Contract signed successfully!' });
  }
  res.redirect('/contract/' + req.params.id);
});

module.exports = router;
