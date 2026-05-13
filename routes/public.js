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
    title: 'Bounce House & Water Slide Rentals in Tonkawa, Ponca City & Kay County OK | Bounce Man',
    metaDescription: 'Bounce Man rents bounce houses, water slides & combos in Tonkawa, Ponca City, Blackwell & Stillwater OK. Free delivery to Kay County. Book online today!',
    canonicalPath: '/',
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
      WHERE e.status = 'available'
      ORDER BY e.sort_order
    `).all();
  }

  const categories = db.prepare("SELECT * FROM categories WHERE active = 1 AND slug != 'add-ons' ORDER BY sort_order").all();

  res.render('public/equipment', {
    title: 'Rental Equipment - Water Slides, Bounce Houses & Combos | Bounce Man | Kay County OK',
    metaDescription: "Browse Bounce Man's rental equipment: Blue Crush water slides, Tropical Combo bounce & slide, Monkey Jumper bounce house. Serving Kay County, OK. Prices from $200/day.",
    canonicalPath: '/equipment',
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
    title: 'Rental Packages & Pricing | Bounce Man | Tonkawa OK',
    metaDescription: 'Save on party rentals with Bounce Man packages! Bundle bounce houses, water slides & add-ons for your event in Kay County, Oklahoma. View all packages and pricing.',
    canonicalPath: '/packages',
    settings,
    packages,
    page: 'packages'
  });
});

// About
router.get('/about', (req, res) => {
  const settings = getSettings();
  res.render('public/about', { title: 'About Bounce Man | Family-Owned Party Rentals | Tonkawa OK', metaDescription: 'Meet the Bounce Man family! We are a Christ-centered, family-owned bounce house rental company in Tonkawa, Oklahoma serving Kay County and surrounding communities.', canonicalPath: '/about', settings, page: 'about' });
});

// Contact
router.get('/contact', (req, res) => {
  const settings = getSettings();
  res.render('public/contact', { title: 'Contact Bounce Man | Party Equipment Rental | Tonkawa OK', metaDescription: 'Contact Bounce Man for bounce house and water slide rentals in Tonkawa, OK. Call (580) 308-9288 or send us a message. Serving Kay County and surrounding areas.', canonicalPath: '/contact', settings, page: 'contact' });
});

// Contact form POST
// Contact form rate limiting (per IP)
const contactRateMap = {};

router.post('/contact', (req, res) => {
  const db = getDb();
  const { v4: uuid } = require('uuid');
  const { name, email, phone, message, event_date, website_url, _ts, captcha, _captcha_answer } = req.body;

  // Spam check 0: CAPTCHA — math challenge
  if (!captcha || !_captcha_answer || String(captcha).trim() !== String(_captcha_answer).trim()) {
    console.log('[SPAM] CAPTCHA failed from', req.ip);
    return res.render('public/contact', { title: 'Contact Us - Bounce Man Rentals', settings: getSettings(), page: 'contact', success: 'Thanks for reaching out! We\'ll get back to you within 24 hours.' });
  }

  // Spam check 1: Honeypot — bots fill hidden "website_url" field
  if (website_url) {
    console.log('[SPAM] Honeypot triggered from', req.ip);
    return res.render('public/contact', { title: 'Contact Us - Bounce Man Rentals', settings: getSettings(), page: 'contact', success: 'Thanks for reaching out! We\'ll get back to you within 24 hours.' });
  }

  // Spam check 2: Timing — reject if submitted in under 3 seconds
  const formTime = parseInt(_ts || '0');
  if (formTime && (Date.now() - formTime) < 3000) {
    console.log('[SPAM] Too fast from', req.ip);
    return res.render('public/contact', { title: 'Contact Us - Bounce Man Rentals', settings: getSettings(), page: 'contact', success: 'Thanks for reaching out! We\'ll get back to you within 24 hours.' });
  }

  // Spam check 3: Rate limit — max 3 per IP per hour
  const ip = req.ip;
  const now = Date.now();
  if (!contactRateMap[ip]) contactRateMap[ip] = [];
  contactRateMap[ip] = contactRateMap[ip].filter(t => now - t < 3600000);
  if (contactRateMap[ip].length >= 3) {
    console.log('[SPAM] Rate limit hit from', ip);
    return res.render('public/contact', { title: 'Contact Us - Bounce Man Rentals', settings: getSettings(), page: 'contact', success: 'Thanks for reaching out! We\'ll get back to you within 24 hours.' });
  }
  contactRateMap[ip].push(now);

  // Save as lead/communication
  const commId = uuid();
  db.prepare(`INSERT INTO communications (id, type, direction, subject, body, recipient, metadata)
    VALUES (?, 'contact_form', 'inbound', ?, ?, ?, ?)`).run(
    commId, `Contact from ${name}`, message, email,
    JSON.stringify({ name, email, phone, event_date })
  );

  console.log('[CONTACT] Form submission from', name, email);

  // Send Slack notification
  try {
    const { notifyContactForm } = require('../services/notifications');
    notifyContactForm({ name, email, phone, message, event_date }).catch(e => console.error('[CONTACT] Slack notification error:', e.message));
  } catch (e) { console.error('[CONTACT] Slack require error:', e.message); }

  // Forward to info@ so owner can reply from email
  try {
    const { forwardContactForm } = require('../services/email');
    forwardContactForm({ name, email, phone, message, event_date }).catch(e => console.error('[CONTACT] Email forward error:', e.message));
  } catch (e) { console.error('[CONTACT] Email require error:', e.message); }

  // Trigger n8n AI auto-reply workflow
  try {
    const N8N_WEBHOOK = process.env.N8N_CONTACT_WEBHOOK;
    if (N8N_WEBHOOK) {
      fetch(N8N_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commId, name, email, phone, message, event_date })
      }).catch(e => console.error('[CONTACT] n8n webhook error:', e.message));
    }
  } catch (e) { console.error('[CONTACT] n8n trigger error:', e.message); }

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
  res.render('public/how-it-works', { title: 'How It Works - Easy Bounce House Rental | Bounce Man | Kay County OK', metaDescription: 'Renting a bounce house from Bounce Man is easy! Pick your date, choose your equipment, confirm your booking, and we deliver to your door in Tonkawa, Ponca City & Kay County OK.', canonicalPath: '/how-it-works', settings, page: 'how-it-works' });
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
  res.render('public/faq', { title: 'FAQ - Bounce House Rental Questions | Bounce Man | Kay County OK', metaDescription: 'Common questions about renting bounce houses and water slides in Kay County, OK. Learn about delivery, setup, safety, payment, and cancellation policies at Bounce Man.', canonicalPath: '/faq', settings, page: 'faq' });
});

// Service areas
router.get('/service-areas', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const zones = db.prepare('SELECT * FROM delivery_zones WHERE active = 1 ORDER BY delivery_fee').all();
  res.render('public/service-areas', { title: 'Service Areas | Bounce Man | Tonkawa, Ponca City, Blackwell, Stillwater OK', metaDescription: 'Bounce Man delivers bounce houses and water slides across Kay County, Oklahoma including Tonkawa, Ponca City, Blackwell, Newkirk, Kaw City & Stillwater. Check delivery fees.', canonicalPath: '/service-areas', settings, zones, page: 'service-areas' });
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

  // Update Slack live card if one exists for this booking
  setTimeout(async () => {
    try {
      const { updateBookingSlackCard } = require('../services/notifications');
      await updateBookingSlackCard(contract.booking_id);
    } catch (e) { console.error('[CONTRACT] Slack card update failed:', e.message); }
  }, 0);

  if (req.headers['content-type']?.includes('json')) {
    return res.json({ success: true, message: 'Contract signed successfully!' });
  }
  res.redirect('/contract/' + req.params.id);
});

// ===== CITY LANDING PAGES =====

const CITY_DATA = {
  tonkawa: {
    name: 'Tonkawa',
    h1: 'Bounce House Rentals in Tonkawa, Oklahoma',
    subheading: 'Your local bounce house & water slide rental company — right here in Tonkawa, Kay County.',
    freeDelivery: true,
    deliveryFee: null,
    deliveryNote: null,
    title: 'Bounce House & Water Slide Rentals in Tonkawa OK | Bounce Man',
    metaDescription: 'Bounce Man is your local bounce house rental company in Tonkawa, OK. FREE delivery in town. Water slides, bounce houses & combos from $200/day. Book online!',
    bodyHtml: '<p>Looking for a bounce house rental in <strong>Tonkawa, Oklahoma</strong>? You\'ve found your local source! Bounce Man LLC is based right here in Tonkawa at 113 North Barrick Way, making us the most convenient and affordable party equipment rental option in town.</p><p>We carry water slides, bounce houses, and combo units — everything you need to make your birthday party, church event, school carnival, or backyard bash truly unforgettable. As a locally owned and operated business, we take pride in serving our Tonkawa neighbors with top-quality, sanitized equipment and friendly service every time.</p><h3 style="color:var(--bm-blue);margin-top:24px">Delivery Right to Your Door in Tonkawa</h3><p><strong>Delivery is always FREE within Tonkawa.</strong> We haul, set up, inflate, and take everything down when the party is over. You don\'t lift a finger. Our units arrive clean, inspected, and ready to use.</p><h3 style="color:var(--bm-blue);margin-top:24px">Perfect for Any Tonkawa Event</h3><ul><li>Birthday parties (ages 2–18)</li><li>School &amp; church events</li><li>Community fundraisers</li><li>Neighborhood block parties</li><li>Sports team celebrations</li></ul><p>We operate Monday through Saturday, 8 AM to 7 PM (closed Sundays). Book online or call us at <strong>(580) 308-9288</strong>.</p>',
    nearbyCities: [
      { name: 'Ponca City', url: '/bounce-house-rental-ponca-city-ok' },
      { name: 'Blackwell', url: '/bounce-house-rental-blackwell-ok' },
      { name: 'Stillwater', url: '/bounce-house-rental-stillwater-ok' },
      { name: 'Kay County', url: '/water-slide-rental-kay-county-ok' }
    ]
  },
  poncaCity: {
    name: 'Ponca City',
    h1: 'Bounce House Rentals in Ponca City, Oklahoma',
    subheading: 'Serving Ponca City with FREE delivery on bounce houses, water slides & combo rentals.',
    freeDelivery: true,
    deliveryFee: null,
    deliveryNote: null,
    title: 'Bounce House Rentals in Ponca City OK | Bounce Man | Free Delivery',
    metaDescription: 'Bounce Man delivers bounce houses & water slides to Ponca City, OK — FREE. Serving Kay County families. From $200/day. Call (580) 308-9288.',
    bodyHtml: '<p>Planning a party in <strong>Ponca City, Oklahoma</strong>? Bounce Man delivers bounce houses and water slides directly to your home, backyard, or venue — <strong>free of charge</strong>. We\'re just a short drive from Tonkawa, making us your most affordable rental partner in the Ponca City area.</p><p>Ponca City is one of our busiest service areas with a vibrant community of families, schools, and churches. Whether you\'re hosting a birthday bash for 20 kids or a company picnic for 200 people, we have the right equipment for your event.</p><h3 style="color:var(--bm-blue);margin-top:24px">Top Picks for Ponca City Events</h3><p>Our <strong>Blue Crush Water Slide</strong> is always a hit at summer events in Ponca City — kids love it and parents love the smiles. The <strong>Tropical Combo</strong> is perfect for mixed-age birthday parties. And the <strong>Monkey Jumper</strong> keeps the little ones entertained for hours.</p><h3 style="color:var(--bm-blue);margin-top:24px">Easy Online Booking</h3><p>Book your Ponca City rental in minutes at BounceManRentals.com. Pick your date, choose your equipment, confirm your details, and we handle the rest. Questions? Call us at <strong>(580) 308-9288</strong>, Mon–Sat 8 AM–7 PM.</p>',
    nearbyCities: [
      { name: 'Tonkawa', url: '/bounce-house-rental-tonkawa-ok' },
      { name: 'Blackwell', url: '/bounce-house-rental-blackwell-ok' },
      { name: 'Kay County', url: '/water-slide-rental-kay-county-ok' }
    ]
  },
  blackwell: {
    name: 'Blackwell',
    h1: 'Bounce House Rentals in Blackwell, Oklahoma',
    subheading: 'Free delivery bounce house and water slide rentals for Blackwell, OK and surrounding Kay County areas.',
    freeDelivery: true,
    deliveryFee: null,
    deliveryNote: null,
    title: 'Bounce House Rentals in Blackwell OK | Bounce Man | Kay County',
    metaDescription: 'Rent bounce houses & water slides in Blackwell, OK with FREE delivery from Bounce Man. Perfect for birthday parties, church events & more. Book online today!',
    bodyHtml: '<p>Bounce Man is proud to serve the <strong>Blackwell, Oklahoma</strong> community with top-quality bounce house and inflatable water slide rentals. Our Blackwell deliveries are always free — we set up and take down at no extra cost to you.</p><p>Blackwell families have trusted us for birthday parties, school carnivals, church events, and more. With just a short drive from our Tonkawa base, we bring the fun straight to you.</p><h3 style="color:var(--bm-blue);margin-top:24px">What We Offer in Blackwell</h3><ul><li><strong>Blue Crush Water Slide</strong> — $375/day (2 units available)</li><li><strong>Tropical Combo Bounce &amp; Slide</strong> — $325/day</li><li><strong>Monkey Jumper Bounce House</strong> — $200/day</li><li><strong>Bluetooth Speaker Add-On</strong> — $75/day</li><li><strong>Portable Generator</strong> — $50/day</li></ul><h3 style="color:var(--bm-blue);margin-top:24px">Book Your Blackwell Rental</h3><p>Ready to book? Use our easy online booking system or call <strong>(580) 308-9288</strong>. We\'re available Monday through Saturday, 8 AM–7 PM. Early booking is recommended for summer weekends!</p>',
    nearbyCities: [
      { name: 'Tonkawa', url: '/bounce-house-rental-tonkawa-ok' },
      { name: 'Ponca City', url: '/bounce-house-rental-ponca-city-ok' },
      { name: 'Kay County', url: '/water-slide-rental-kay-county-ok' }
    ]
  },
  stillwater: {
    name: 'Stillwater',
    h1: 'Bounce House Rentals in Stillwater, Oklahoma',
    subheading: 'Serving OSU families, Greek life, and Stillwater events with water slides & bounce houses.',
    freeDelivery: false,
    deliveryFee: '$100',
    deliveryNote: 'Stillwater is about 60 miles from our Tonkawa base. A $100 delivery fee applies for extended travel. Still the best value for premium inflatables in Stillwater!',
    title: 'Bounce House & Water Slide Rentals in Stillwater OK | Bounce Man',
    metaDescription: 'Bounce Man delivers bounce houses & water slides to Stillwater OK, home of OSU. Perfect for Greek events, birthday parties & campus fairs. Call (580) 308-9288.',
    bodyHtml: '<p>Bounce Man serves <strong>Stillwater, Oklahoma</strong> — home of Oklahoma State University — with premium bounce house and inflatable water slide rentals. Stillwater is about 60 miles from our Tonkawa base, so a $100 extended delivery fee applies, but you still get the same professional setup, clean equipment, and friendly service.</p><p>Stillwater\'s diverse community of OSU students, faculty, families, and businesses creates a huge demand for unique event entertainment. Our inflatables have been a hit at Greek life events, graduation parties, tailgates, neighborhood gatherings, and kids\' birthday parties throughout Stillwater.</p><h3 style="color:var(--bm-blue);margin-top:24px">Great for Stillwater\'s Busy Event Season</h3><ul><li>OSU campus and Greek chapter events</li><li>Residential neighborhood parties</li><li>Church and community fundraisers</li><li>School field day &amp; carnival events</li><li>Corporate team-building and picnics</li></ul><h3 style="color:var(--bm-blue);margin-top:24px">Book in Advance — Stillwater Dates Fill Fast</h3><p>Stillwater events are popular and our schedule fills up quickly, especially in spring and fall. We recommend booking 2–4 weeks in advance. Call <strong>(580) 308-9288</strong> or book online today.</p>',
    nearbyCities: [
      { name: 'Tonkawa', url: '/bounce-house-rental-tonkawa-ok' },
      { name: 'Ponca City', url: '/bounce-house-rental-ponca-city-ok' },
      { name: 'Kay County', url: '/water-slide-rental-kay-county-ok' }
    ]
  },
  kayCounty: {
    name: 'Kay County',
    h1: 'Water Slide & Bounce House Rentals in Kay County, Oklahoma',
    subheading: "Bounce Man is Kay County's #1 party equipment rental company serving 40,000+ residents.",
    freeDelivery: true,
    deliveryFee: null,
    deliveryNote: null,
    title: 'Water Slide & Bounce House Rentals Kay County OK | Bounce Man',
    metaDescription: "Kay County's top bounce house & water slide rental. Bounce Man serves Tonkawa, Ponca City, Blackwell, Newkirk & all Kay County OK. FREE delivery. Book now!",
    bodyHtml: '<p><strong>Bounce Man LLC</strong> is proud to be Kay County\'s premier party equipment rental company. Based in Tonkawa, we serve the entire county including Ponca City, Blackwell, Newkirk, Kaw City, and surrounding communities. With <strong>free delivery throughout Kay County</strong>, we make it easy and affordable to add real excitement to any event.</p><p>Kay County, Oklahoma is a vibrant community of approximately 43,000 residents. We understand the unique needs of Kay County families — from large Ponca City birthday parties to intimate rural backyard celebrations near Kaw City. No location is too remote for Bounce Man!</p><h3 style="color:var(--bm-blue);margin-top:24px">Serving All of Kay County</h3><ul><li><strong>Tonkawa</strong> — Our home base, always free delivery</li><li><strong>Ponca City</strong> — Kay County\'s largest city, free delivery</li><li><strong>Blackwell</strong> — Southern Kay County, free delivery</li><li><strong>Newkirk</strong> — County seat, free delivery</li><li><strong>Kaw City</strong> — Eastern Kay County, free delivery</li></ul><h3 style="color:var(--bm-blue);margin-top:24px">Book Your Kay County Rental</h3><p>Call us at <strong>(580) 308-9288</strong>, Mon–Sat 8 AM–7 PM, or book instantly at BounceManRentals.com. We accept all major credit cards and Stripe-secured online payments.</p>',
    nearbyCities: [
      { name: 'Tonkawa', url: '/bounce-house-rental-tonkawa-ok' },
      { name: 'Ponca City', url: '/bounce-house-rental-ponca-city-ok' },
      { name: 'Blackwell', url: '/bounce-house-rental-blackwell-ok' },
      { name: 'Stillwater', url: '/bounce-house-rental-stillwater-ok' }
    ]
  }
};

// City landing page routes
router.get('/bounce-house-rental-tonkawa-ok', (req, res) => {
  const settings = getSettings();
  const cityData = CITY_DATA.tonkawa;
  res.render('public/city-landing', { title: cityData.title, metaDescription: cityData.metaDescription, canonicalPath: '/bounce-house-rental-tonkawa-ok', settings, cityData, page: 'city-landing' });
});

router.get('/bounce-house-rental-ponca-city-ok', (req, res) => {
  const settings = getSettings();
  const cityData = CITY_DATA.poncaCity;
  res.render('public/city-landing', { title: cityData.title, metaDescription: cityData.metaDescription, canonicalPath: '/bounce-house-rental-ponca-city-ok', settings, cityData, page: 'city-landing' });
});

router.get('/bounce-house-rental-blackwell-ok', (req, res) => {
  const settings = getSettings();
  const cityData = CITY_DATA.blackwell;
  res.render('public/city-landing', { title: cityData.title, metaDescription: cityData.metaDescription, canonicalPath: '/bounce-house-rental-blackwell-ok', settings, cityData, page: 'city-landing' });
});

router.get('/bounce-house-rental-stillwater-ok', (req, res) => {
  const settings = getSettings();
  const cityData = CITY_DATA.stillwater;
  res.render('public/city-landing', { title: cityData.title, metaDescription: cityData.metaDescription, canonicalPath: '/bounce-house-rental-stillwater-ok', settings, cityData, page: 'city-landing' });
});

router.get('/water-slide-rental-kay-county-ok', (req, res) => {
  const settings = getSettings();
  const cityData = CITY_DATA.kayCounty;
  res.render('public/city-landing', { title: cityData.title, metaDescription: cityData.metaDescription, canonicalPath: '/water-slide-rental-kay-county-ok', settings, cityData, page: 'city-landing' });
});

// ===== SITEMAP.XML =====
router.get('/sitemap.xml', (req, res) => {
  const baseUrl = 'https://bouncemanrentals.com';
  const today = new Date().toISOString().split('T')[0];

  const staticPages = [
    { loc: '/', priority: '1.0', changefreq: 'weekly' },
    { loc: '/equipment', priority: '0.9', changefreq: 'weekly' },
    { loc: '/packages', priority: '0.8', changefreq: 'monthly' },
    { loc: '/booking', priority: '0.9', changefreq: 'weekly' },
    { loc: '/how-it-works', priority: '0.7', changefreq: 'monthly' },
    { loc: '/about', priority: '0.6', changefreq: 'monthly' },
    { loc: '/contact', priority: '0.7', changefreq: 'monthly' },
    { loc: '/faq', priority: '0.6', changefreq: 'monthly' },
    { loc: '/reviews', priority: '0.5', changefreq: 'weekly' },
    { loc: '/service-areas', priority: '0.8', changefreq: 'monthly' },
    { loc: '/bounce-house-rental-tonkawa-ok', priority: '0.9', changefreq: 'monthly' },
    { loc: '/bounce-house-rental-ponca-city-ok', priority: '0.9', changefreq: 'monthly' },
    { loc: '/bounce-house-rental-blackwell-ok', priority: '0.8', changefreq: 'monthly' },
    { loc: '/bounce-house-rental-stillwater-ok', priority: '0.8', changefreq: 'monthly' },
    { loc: '/water-slide-rental-kay-county-ok', priority: '0.9', changefreq: 'monthly' }
  ];

  const db = getDb();
  const equipment = db.prepare("SELECT slug FROM equipment WHERE status = 'available'").all();

  let urlEntries = staticPages.map(p =>
    `  <url>\n    <loc>${baseUrl}${p.loc}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`
  ).join('\n');

  equipment.forEach(e => {
    urlEntries += `\n  <url>\n    <loc>${baseUrl}/equipment/${e.slug}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>`;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>`;

  res.set('Content-Type', 'application/xml');
  res.send(xml);
});

// ===== ROBOTS.TXT =====
router.get('/robots.txt', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send('User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /admin/\nDisallow: /api/\nDisallow: /booking/lookup\nDisallow: /contract/\nDisallow: /event/\n\nSitemap: https://bouncemanrentals.com/sitemap.xml\n');
});

module.exports = router;
