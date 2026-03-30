const fs = require('fs');
const Database = require('better-sqlite3');
const { v4: uuid } = require('uuid');

// ============================================
// 1. Add speaker as add-on in database
// ============================================
const db = new Database('data/bounceman.db');

// Add add_ons category
const catExists = db.prepare("SELECT id FROM categories WHERE slug = 'add_ons'").get();
if (!catExists) {
  db.prepare("INSERT INTO categories (id, name, slug, description, sort_order, active) VALUES (?, 'Add-Ons', 'add_ons', 'Party extras to make your event even better', 10, 1)")
    .run(uuid());
  console.log('Added add_ons category');
}

// Add Soundboks speaker
const speakerExists = db.prepare("SELECT id FROM equipment WHERE slug = 'party-speaker'").get();
if (!speakerExists) {
  const speakerId = uuid();
  db.prepare(`INSERT INTO equipment (id, name, slug, category, short_description, dimensions, capacity_kids, age_range, setup_time_min, power_required, price_4hr, price_daily, price_overnight, deposit_amount, status, featured, sort_order, condition)
    VALUES (?, 'Bluetooth Party Speaker', 'party-speaker', 'add_ons', 'Massive Bluetooth speaker for your event — plays loud enough for any outdoor party. Connects to any phone.', 'Portable', NULL, 'All ages', 2, 'Battery powered', 50, 75, 75, 0, 'available', 0, 10, 'excellent')`)
    .run(speakerId);
  
  // Add placeholder image
  db.prepare("INSERT INTO equipment_images (id, equipment_id, image_path, is_primary, sort_order) VALUES (?, ?, '/assets/images/equipment/placeholder-bounce.jpg', 1, 0)")
    .run(uuid(), speakerId);
  console.log('Added Bluetooth Party Speaker as add-on');
} else {
  console.log('Speaker already exists');
}

// ============================================
// 2. Update equipment route to support date filter
// ============================================
let publicRoutes = fs.readFileSync('routes/public.js', 'utf8');

// Replace the equipment route to add date filtering
const oldEquipRoute = `router.get('/equipment', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const category = req.query.category;

  let equipment;
  if (category) {
    equipment = db.prepare(\`
      SELECT e.*,
        (SELECT image_path FROM equipment_images WHERE equipment_id = e.id AND is_primary = 1 LIMIT 1) as image
      FROM equipment e
      WHERE e.status = 'available' AND e.category = ?
      ORDER BY e.sort_order
    \`).all(category);
  } else {
    equipment = db.prepare(\`
      SELECT e.*,
        (SELECT image_path FROM equipment_images WHERE equipment_id = e.id AND is_primary = 1 LIMIT 1) as image
      FROM equipment e
      WHERE e.status = 'available'
      ORDER BY e.sort_order
    \`).all();
  }

  const categories = db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY sort_order').all();

  res.render('public/equipment', {
    title: 'Our Equipment - Bounce Man Rentals',
    settings,
    equipment,
    categories,
    activeCategory: category || 'all',
    page: 'equipment'
  });
});`;

const newEquipRoute = `router.get('/equipment', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const category = req.query.category;
  const eventDate = req.query.date;

  let equipment;
  const baseQuery = \`SELECT e.*,
    (SELECT image_path FROM equipment_images WHERE equipment_id = e.id AND is_primary = 1 LIMIT 1) as image
  FROM equipment e
  WHERE e.status = 'available' AND e.category != 'add_ons'\`;

  if (category && category !== 'all') {
    equipment = db.prepare(baseQuery + ' AND e.category = ? ORDER BY e.sort_order').all(category);
  } else {
    equipment = db.prepare(baseQuery + ' ORDER BY e.sort_order').all();
  }

  // If date provided, filter out booked items
  if (eventDate) {
    const bookedIds = db.prepare(\`
      SELECT DISTINCT bi.equipment_id FROM bookings b
      JOIN booking_items bi ON bi.booking_id = b.id
      WHERE b.event_date = ? AND b.status NOT IN ('cancelled', 'declined')
    \`).all(eventDate).map(r => r.equipment_id);

    const blockedIds = db.prepare('SELECT equipment_id FROM blocked_dates WHERE date = ? AND equipment_id IS NOT NULL')
      .all(eventDate).map(r => r.equipment_id);

    const unavailableIds = new Set([...bookedIds, ...blockedIds]);
    equipment = equipment.map(item => ({
      ...item,
      booked: unavailableIds.has(item.id)
    }));
  }

  const categories = db.prepare("SELECT * FROM categories WHERE active = 1 AND slug != 'add_ons' ORDER BY sort_order").all();

  res.render('public/equipment', {
    title: 'Our Equipment - Bounce Man Rentals',
    settings,
    equipment,
    categories,
    activeCategory: category || 'all',
    eventDate: eventDate || '',
    page: 'equipment'
  });
});`;

if (publicRoutes.includes("const category = req.query.category;\n\n  let equipment;")) {
  publicRoutes = publicRoutes.replace(oldEquipRoute, newEquipRoute);
  fs.writeFileSync('routes/public.js', publicRoutes);
  console.log('Updated equipment route with date filter');
} else {
  console.log('WARNING: Could not find equipment route to replace');
}

// ============================================
// 3. Update equipment.ejs with date picker
// ============================================
let eqTemplate = fs.readFileSync('views/public/equipment.ejs', 'utf8');

// Add date picker after the section title
const oldTitle = `<div class="section-title">
      <h2>Our Equipment</h2>
      <p>Browse our inventory and find the perfect rental for your event</p>
    </div>`;

const newTitle = `<div class="section-title">
      <h2>Our Equipment</h2>
      <p>Browse our inventory and find the perfect rental for your event</p>
    </div>

    <!-- Date Filter -->
    <div class="text-center mb-4">
      <form method="GET" action="/equipment" class="d-inline-flex align-items-center gap-2 flex-wrap justify-content-center">
        <label for="date" class="fw-bold mb-0">Check availability for:</label>
        <input type="date" id="date" name="date" class="form-control form-control-sm" style="width:auto;display:inline-block" value="\${eventDate || ''}" min="\${new Date().toISOString().split('T')[0]}">
        \${category && category !== 'all' ? '<input type="hidden" name="category" value="' + category + '">' : ''}
        <button type="submit" class="btn btn-sm btn-bm rounded-pill">Check Date</button>
        \${eventDate ? '<a href="/equipment" class="btn btn-sm btn-outline-secondary rounded-pill">Clear</a>' : ''}
      </form>
    </div>`;

eqTemplate = eqTemplate.replace(oldTitle, newTitle);

// Update card to show booked/unavailable state
eqTemplate = eqTemplate.replace(
  `<a href="/equipment/\${item.slug}" class="equipment-card-link" style="text-decoration:none;color:inherit;display:block">
        <div class="equipment-card" style="cursor:pointer">`,
  `<a href="/equipment/\${item.slug}" class="equipment-card-link" style="text-decoration:none;color:inherit;display:block\${item.booked ? ';opacity:0.5' : ''}">
        <div class="equipment-card" style="cursor:pointer\${item.booked ? ';position:relative' : ''}">
          \${item.booked ? '<div style="position:absolute;top:10px;right:10px;background:#dc3545;color:white;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:bold;z-index:1">Booked</div>' : ''}`
);

fs.writeFileSync('views/public/equipment.ejs', eqTemplate);
console.log('Updated equipment template with date picker');

// ============================================
// 4. Add add-on upsell to booking step 2 (after date selection)
// ============================================
let step2 = fs.readFileSync('views/public/booking/step2-date.ejs', 'utf8');

// Check if add-ons section already exists
if (!step2.includes('add-ons')) {
  // We need to update the booking route to pass add-ons to step2
  let bookingRoutes = fs.readFileSync('routes/booking.js', 'utf8');
  
  // Update step2 route to include add-ons
  bookingRoutes = bookingRoutes.replace(
    `router.get('/date', (req, res) => {
  const settings = getSettings();
  const items = req.query.items ? req.query.items.split(',') : [];

  res.render('public/booking/step2-date', {
    title: 'Choose Date & Time - Bounce Man',
    settings, selectedItems: items,
    page: 'booking'
  });
});`,
    `router.get('/date', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const items = req.query.items ? req.query.items.split(',') : [];

  // Get add-on items
  const addons = db.prepare(\`
    SELECT e.*,
      (SELECT image_path FROM equipment_images WHERE equipment_id = e.id AND is_primary = 1 LIMIT 1) as image
    FROM equipment e
    WHERE e.category = 'add_ons' AND e.status = 'available'
    ORDER BY e.sort_order
  \`).all();

  res.render('public/booking/step2-date', {
    title: 'Choose Date & Time - Bounce Man',
    settings, selectedItems: items, addons,
    page: 'booking'
  });
});`
  );
  
  fs.writeFileSync('routes/booking.js', bookingRoutes);
  console.log('Updated booking route with add-ons');
}

console.log('\nAll updates complete!');
