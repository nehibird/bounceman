const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { requireAuth, requireAdmin } = require('./auth');
const multer = require('multer');
const path = require('path');
const { v4: uuid } = require('uuid');
const dayjs = require('dayjs');
const bcrypt = require('bcryptjs');

// File upload config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'equipment');
    require('fs').mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuid()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp|gif/;
  cb(null, allowed.test(path.extname(file.originalname).toLowerCase()));
}});

// Cookie parser for auth
const cookieParser = require('cookie-parser');
router.use(cookieParser());
router.use(requireAuth);

function getSettings() {
  const db = getDb();
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
}

// Dashboard
router.get('/', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const today = dayjs().format('YYYY-MM-DD');
  const weekAgo = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
  const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');

  const stats = {
    todayBookings: db.prepare("SELECT COUNT(*) as c FROM bookings WHERE event_date = ?").get(today).c,
    weekBookings: db.prepare("SELECT COUNT(*) as c FROM bookings WHERE created_at >= ?").get(weekAgo).c,
    monthRevenue: db.prepare("SELECT COALESCE(SUM(total), 0) as r FROM bookings WHERE created_at >= ? AND status != 'cancelled'").get(monthStart).r,
    pendingBookings: db.prepare("SELECT COUNT(*) as c FROM bookings WHERE status = 'pending'").get().c,
    totalCustomers: db.prepare("SELECT COUNT(*) as c FROM customers").get().c,
    totalEquipment: db.prepare("SELECT COUNT(*) as c FROM equipment").get().c,
    unsignedContracts: db.prepare("SELECT COUNT(*) as c FROM contracts WHERE signed = 0").get().c,
    pendingReviews: db.prepare("SELECT COUNT(*) as c FROM reviews WHERE approved = 0").get().c
  };

  const upcoming = db.prepare(`
    SELECT b.*, c.first_name, c.last_name, c.phone
    FROM bookings b JOIN customers c ON c.id = b.customer_id
    WHERE b.event_date >= ? AND b.status NOT IN ('cancelled', 'declined')
    ORDER BY b.event_date, b.event_start_time LIMIT 10
  `).all(today);

  const recentActivity = db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 15').all();

  res.render('admin/dashboard', {
    title: 'Dashboard - Bounce Man Admin',
    user: req.user, settings, stats, upcoming, recentActivity, page: 'dashboard'
  });
});

// === BOOKINGS ===
router.get('/bookings', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const status = req.query.status;
  const date = req.query.date;

  let query = `SELECT b.*, c.first_name, c.last_name, c.email, c.phone
    FROM bookings b JOIN customers c ON c.id = b.customer_id`;
  const params = [];
  const conditions = [];

  if (status) { conditions.push('b.status = ?'); params.push(status); }
  if (date) { conditions.push('b.event_date = ?'); params.push(date); }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY b.event_date DESC, b.created_at DESC';

  const bookings = db.prepare(query).all(...params);

  res.render('admin/bookings/list', {
    title: 'Bookings - Admin', user: req.user, settings, bookings,
    activeStatus: status || 'all', activeDate: date || '', page: 'bookings'
  });
});

router.get('/bookings/:id', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const booking = db.prepare(`SELECT b.*, c.* FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.id = ?`).get(req.params.id);
  if (!booking) return res.redirect('/admin/bookings');

  const items = db.prepare(`SELECT bi.*, e.category,
    (SELECT image_path FROM equipment_images WHERE equipment_id = bi.equipment_id AND is_primary = 1 LIMIT 1) as image
    FROM booking_items bi LEFT JOIN equipment e ON e.id = bi.equipment_id WHERE bi.booking_id = ?`).all(req.params.id);
  const payments = db.prepare('SELECT * FROM payments WHERE booking_id = ? ORDER BY created_at DESC').all(req.params.id);
  const contract = db.prepare('SELECT * FROM contracts WHERE booking_id = ?').get(req.params.id);
  const comms = db.prepare('SELECT * FROM communications WHERE booking_id = ? ORDER BY sent_at DESC').all(req.params.id);

  res.render('admin/bookings/detail', {
    title: `Booking ${booking.booking_number} - Admin`, user: req.user, settings,
    booking, items, payments, contract, comms, page: 'bookings'
  });
});

router.post('/bookings/:id/status', (req, res) => {
  const db = getDb();
  const { status } = req.body;
  db.prepare("UPDATE bookings SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, req.params.id);
  db.prepare('INSERT INTO activity_log (id, user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uuid(), req.user.id, 'booking_status_changed', 'booking', req.params.id, JSON.stringify({ status }));
  res.redirect(`/admin/bookings/${req.params.id}`);
});

router.post('/bookings/:id/notes', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE bookings SET internal_notes = ?, updated_at = datetime('now') WHERE id = ?").run(req.body.notes, req.params.id);
  res.redirect(`/admin/bookings/${req.params.id}`);
});

router.post('/bookings/:id/crew', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE bookings SET assigned_crew = ?, updated_at = datetime('now') WHERE id = ?").run(req.body.crew, req.params.id);
  res.redirect(`/admin/bookings/${req.params.id}`);
});

// === EQUIPMENT ===
router.get('/equipment', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const equipment = db.prepare(`SELECT e.*,
    (SELECT image_path FROM equipment_images WHERE equipment_id = e.id AND is_primary = 1 LIMIT 1) as image
    FROM equipment e ORDER BY e.sort_order`).all();
  const categories = db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY sort_order').all();

  res.render('admin/equipment/list', {
    title: 'Equipment - Admin', user: req.user, settings, equipment, categories, page: 'equipment'
  });
});

router.get('/equipment/new', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const categories = db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY sort_order').all();
  res.render('admin/equipment/form', {
    title: 'Add Equipment - Admin', user: req.user, settings, categories,
    item: null, images: [], page: 'equipment'
  });
});

router.post('/equipment', upload.array('images', 10), (req, res) => {
  const db = getDb();
  const data = req.body;
  const itemId = uuid();
  const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  db.prepare(`INSERT INTO equipment (id, name, slug, category, description, short_description,
    dimensions, weight_lbs, capacity_kids, age_range, setup_time_min, power_required,
    price_hourly, price_4hr, price_daily, price_weekend, price_overnight, price_wet, deposit_amount,
    replacement_cost, manufacturer, model, serial_number, purchase_date, condition, status, featured, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    itemId, data.name, slug, data.category, data.description, data.short_description,
    data.dimensions, data.weight_lbs || null, data.capacity_kids || null, data.age_range,
    data.setup_time_min || 15, data.power_required || '1 standard outlet',
    data.price_hourly || null, data.price_4hr || null, data.price_daily,
    data.price_weekend || null, data.price_overnight || null, data.price_wet || null, data.deposit_amount || 50,
    data.replacement_cost || null, data.manufacturer, data.model, data.serial_number,
    data.purchase_date || null, data.condition || 'excellent', data.status || 'available',
    data.featured ? 1 : 0, data.sort_order || 0
  );

  // Handle uploaded images
  if (req.files?.length) {
    req.files.forEach((file, i) => {
      db.prepare('INSERT INTO equipment_images (id, equipment_id, image_path, is_primary, sort_order) VALUES (?, ?, ?, ?, ?)')
        .run(uuid(), itemId, `/uploads/equipment/${file.filename}`, i === 0 ? 1 : 0, i);
    });
  }

  db.prepare('INSERT INTO activity_log (id, user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uuid(), req.user.id, 'equipment_created', 'equipment', itemId, JSON.stringify({ name: data.name }));

  res.redirect('/admin/equipment');
});

router.get('/equipment/:id/edit', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const item = db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id);
  if (!item) return res.redirect('/admin/equipment');
  const images = db.prepare('SELECT * FROM equipment_images WHERE equipment_id = ? ORDER BY sort_order').all(req.params.id);
  const categories = db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY sort_order').all();

  res.render('admin/equipment/form', {
    title: `Edit ${item.name} - Admin`, user: req.user, settings,
    item, images, categories, page: 'equipment'
  });
});

router.post('/equipment/:id', upload.array('images', 10), (req, res) => {
  const db = getDb();
  const data = req.body;
  const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  db.prepare(`UPDATE equipment SET name=?, slug=?, category=?, description=?, short_description=?,
    dimensions=?, weight_lbs=?, capacity_kids=?, age_range=?, setup_time_min=?, power_required=?,
    price_hourly=?, price_4hr=?, price_daily=?, price_weekend=?, price_overnight=?, price_wet=?, deposit_amount=?,
    replacement_cost=?, manufacturer=?, model=?, serial_number=?, purchase_date=?, condition=?,
    status=?, featured=?, sort_order=?, updated_at=datetime('now')
    WHERE id=?`).run(
    data.name, slug, data.category, data.description, data.short_description,
    data.dimensions, data.weight_lbs || null, data.capacity_kids || null, data.age_range,
    data.setup_time_min || 15, data.power_required || '1 standard outlet',
    data.price_hourly || null, data.price_4hr || null, data.price_daily,
    data.price_weekend || null, data.price_overnight || null, data.price_wet || null, data.deposit_amount || 50,
    data.replacement_cost || null, data.manufacturer, data.model, data.serial_number,
    data.purchase_date || null, data.condition || 'excellent', data.status || 'available',
    data.featured ? 1 : 0, data.sort_order || 0, req.params.id
  );

  if (req.files?.length) {
    req.files.forEach((file, i) => {
      db.prepare('INSERT INTO equipment_images (id, equipment_id, image_path, is_primary, sort_order) VALUES (?, ?, ?, ?, ?)')
        .run(uuid(), req.params.id, `/uploads/equipment/${file.filename}`, 0, 99 + i);
    });
  }

  res.redirect('/admin/equipment');
});

// === CUSTOMERS ===
router.get('/customers', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const search = req.query.q;
  let customers;
  if (search) {
    customers = db.prepare(`SELECT * FROM customers WHERE
      first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR phone LIKE ?
      ORDER BY created_at DESC`).all(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  } else {
    customers = db.prepare('SELECT * FROM customers ORDER BY created_at DESC LIMIT 100').all();
  }

  res.render('admin/customers/list', {
    title: 'Customers - Admin', user: req.user, settings, customers, search: search || '', page: 'customers'
  });
});

router.get('/customers/:id', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.redirect('/admin/customers');

  const bookings = db.prepare(`SELECT * FROM bookings WHERE customer_id = ? ORDER BY event_date DESC`).all(req.params.id);
  const payments = db.prepare('SELECT * FROM payments WHERE customer_id = ? ORDER BY created_at DESC').all(req.params.id);
  const comms = db.prepare('SELECT * FROM communications WHERE customer_id = ? ORDER BY sent_at DESC').all(req.params.id);

  res.render('admin/customers/detail', {
    title: `${customer.first_name} ${customer.last_name} - Admin`, user: req.user, settings,
    customer, bookings, payments, comms, page: 'customers'
  });
});

// === CALENDAR ===
router.get('/calendar', (req, res) => {
  const db = getDb();
  const settings = getSettings();

  const bookings = db.prepare(`
    SELECT b.id, b.booking_number, b.event_date, b.event_start_time, b.event_end_time, b.status,
      c.first_name, c.last_name,
      GROUP_CONCAT(bi.item_name, ', ') as items
    FROM bookings b
    JOIN customers c ON c.id = b.customer_id
    LEFT JOIN booking_items bi ON bi.booking_id = b.id
    WHERE b.status NOT IN ('cancelled', 'declined')
    GROUP BY b.id
    ORDER BY b.event_date
  `).all();

  const blocked = db.prepare('SELECT * FROM blocked_dates').all();

  res.render('admin/calendar', {
    title: 'Calendar - Admin', user: req.user, settings, bookings, blocked, page: 'calendar'
  });
});

// === DELIVERY ROUTES ===
router.get('/delivery', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const date = req.query.date || dayjs().format('YYYY-MM-DD');

  const deliveries = db.prepare(`
    SELECT b.*, c.first_name, c.last_name, c.phone,
      GROUP_CONCAT(bi.item_name, ', ') as items
    FROM bookings b
    JOIN customers c ON c.id = b.customer_id
    LEFT JOIN booking_items bi ON bi.booking_id = b.id
    WHERE b.event_date = ? AND b.status NOT IN ('cancelled', 'declined')
    GROUP BY b.id
    ORDER BY b.setup_time, b.event_start_time
  `).all(date);

  res.render('admin/delivery', {
    title: 'Delivery Schedule - Admin', user: req.user, settings, deliveries, date, page: 'delivery'
  });
});

// === REPORTS ===
router.get('/reports', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const period = req.query.period || 'month';

  let dateFilter;
  if (period === 'week') dateFilter = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
  else if (period === 'month') dateFilter = dayjs().subtract(30, 'day').format('YYYY-MM-DD');
  else if (period === 'quarter') dateFilter = dayjs().subtract(90, 'day').format('YYYY-MM-DD');
  else dateFilter = dayjs().subtract(365, 'day').format('YYYY-MM-DD');

  const revenue = db.prepare(`SELECT COALESCE(SUM(total), 0) as total FROM bookings WHERE created_at >= ? AND status != 'cancelled'`).get(dateFilter);
  const bookingCount = db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE created_at >= ? AND status != 'cancelled'`).get(dateFilter);
  const avgTicket = db.prepare(`SELECT COALESCE(AVG(total), 0) as avg FROM bookings WHERE created_at >= ? AND status != 'cancelled'`).get(dateFilter);

  const topItems = db.prepare(`
    SELECT bi.item_name, COUNT(*) as rentals, SUM(bi.total_price) as revenue
    FROM booking_items bi
    JOIN bookings b ON b.id = bi.booking_id
    WHERE b.created_at >= ? AND b.status != 'cancelled'
    GROUP BY bi.item_name ORDER BY rentals DESC LIMIT 10
  `).all(dateFilter);

  const revenueByMonth = db.prepare(`
    SELECT strftime('%Y-%m', event_date) as month, SUM(total) as revenue, COUNT(*) as bookings
    FROM bookings WHERE status != 'cancelled' AND event_date >= date('now', '-12 months')
    GROUP BY month ORDER BY month
  `).all();

  const statusBreakdown = db.prepare(`
    SELECT status, COUNT(*) as c FROM bookings WHERE created_at >= ? GROUP BY status
  `).all(dateFilter);

  res.render('admin/reports', {
    title: 'Reports - Admin', user: req.user, settings,
    revenue: revenue.total, bookingCount: bookingCount.c, avgTicket: avgTicket.avg,
    topItems, revenueByMonth, statusBreakdown, period, page: 'reports'
  });
});

// === SETTINGS ===
router.get('/settings', requireAdmin, (req, res) => {
  const settings = getSettings();
  const db = getDb();
  const users = db.prepare('SELECT id, email, name, role, active, created_at FROM users ORDER BY created_at').all();
  const emailTemplates = db.prepare('SELECT * FROM email_templates ORDER BY name').all();
  const zones = db.prepare('SELECT * FROM delivery_zones ORDER BY delivery_fee').all();
  const codes = db.prepare('SELECT * FROM discount_codes ORDER BY created_at DESC').all();

  res.render('admin/settings', {
    title: 'Settings - Admin', user: req.user, settings, users,
    emailTemplates, zones, codes, page: 'settings'
  });
});

router.post('/settings', requireAdmin, (req, res) => {
  const db = getDb();
  const update = db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?");
  const insert = db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))");

  for (const [key, value] of Object.entries(req.body)) {
    if (key.startsWith('_')) continue;
    const exists = db.prepare('SELECT key FROM settings WHERE key = ?').get(key);
    if (exists) update.run(value, key);
    else insert.run(key, value);
  }

  res.redirect('/admin/settings?saved=1');
});

// === REVIEWS (admin) ===
router.get('/reviews', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const reviews = db.prepare(`
    SELECT r.*, b.booking_number
    FROM reviews r LEFT JOIN bookings b ON b.id = r.booking_id
    ORDER BY r.approved ASC, r.created_at DESC
  `).all();

  res.render('admin/reviews', {
    title: 'Reviews - Admin', user: req.user, settings, reviews, page: 'reviews'
  });
});

router.post('/reviews/:id/approve', (req, res) => {
  getDb().prepare('UPDATE reviews SET approved = 1 WHERE id = ?').run(req.params.id);
  res.redirect('/admin/reviews');
});

router.post('/reviews/:id/respond', (req, res) => {
  getDb().prepare('UPDATE reviews SET response = ? WHERE id = ?').run(req.body.response, req.params.id);
  res.redirect('/admin/reviews');
});

// === COMMUNICATIONS ===
router.get('/communications', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const comms = db.prepare(`
    SELECT cm.*, c.first_name, c.last_name
    FROM communications cm
    LEFT JOIN customers c ON c.id = cm.customer_id
    ORDER BY cm.sent_at DESC LIMIT 100
  `).all();

  res.render('admin/communications', {
    title: 'Communications - Admin', user: req.user, settings, comms, page: 'communications'
  });
});

// === MAINTENANCE LOG ===
router.get('/maintenance', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const logs = db.prepare(`
    SELECT m.*, e.name as equipment_name
    FROM maintenance_log m JOIN equipment e ON e.id = m.equipment_id
    ORDER BY m.performed_at DESC
  `).all();
  const equipment = db.prepare('SELECT id, name FROM equipment ORDER BY name').all();

  res.render('admin/maintenance', {
    title: 'Maintenance Log - Admin', user: req.user, settings, logs, equipment, page: 'maintenance'
  });
});

router.post('/maintenance', (req, res) => {
  const db = getDb();
  const { equipment_id, type, description, cost, next_due } = req.body;
  db.prepare(`INSERT INTO maintenance_log (id, equipment_id, type, description, cost, performed_by, next_due)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(uuid(), equipment_id, type, description, cost || 0, req.user.name, next_due || null);
  res.redirect('/admin/maintenance');
});

// === DELIVERY ZONES CRUD ===
router.get('/settings/zones/new', requireAdmin, (req, res) => {
  const settings = getSettings();
  res.render('admin/zone-form', { title: 'New Delivery Zone - Admin', user: req.user, settings, zone: null, page: 'settings' });
});

router.get('/settings/zones/:id/edit', requireAdmin, (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const zone = db.prepare('SELECT * FROM delivery_zones WHERE id = ?').get(req.params.id);
  if (!zone) return res.redirect('/admin/settings');
  res.render('admin/zone-form', { title: 'Edit Delivery Zone - Admin', user: req.user, settings, zone, page: 'settings' });
});

router.post('/settings/zones', requireAdmin, (req, res) => {
  const db = getDb();
  const { name, zip_codes, delivery_fee, active } = req.body;
  db.prepare('INSERT INTO delivery_zones (id, name, zip_codes, delivery_fee, active) VALUES (?, ?, ?, ?, ?)').run(
    uuid(), name, zip_codes, parseFloat(delivery_fee) || 0, active ? 1 : 0
  );
  res.redirect('/admin/settings');
});

router.post('/settings/zones/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const { name, zip_codes, delivery_fee, active } = req.body;
  db.prepare('UPDATE delivery_zones SET name = ?, zip_codes = ?, delivery_fee = ?, active = ? WHERE id = ?').run(
    name, zip_codes, parseFloat(delivery_fee) || 0, active ? 1 : 0, req.params.id
  );
  res.redirect('/admin/settings');
});

router.post('/settings/zones/:id/delete', requireAdmin, (req, res) => {
  getDb().prepare('DELETE FROM delivery_zones WHERE id = ?').run(req.params.id);
  res.redirect('/admin/settings');
});

// === DISCOUNT CODES CRUD ===
router.get('/settings/codes/new', requireAdmin, (req, res) => {
  const settings = getSettings();
  res.render('admin/code-form', { title: 'New Discount Code - Admin', user: req.user, settings, code: null, page: 'settings' });
});

router.get('/settings/codes/:id/edit', requireAdmin, (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const code = db.prepare('SELECT * FROM discount_codes WHERE id = ?').get(req.params.id);
  if (!code) return res.redirect('/admin/settings');
  res.render('admin/code-form', { title: 'Edit Discount Code - Admin', user: req.user, settings, code, page: 'settings' });
});

router.post('/settings/codes', requireAdmin, (req, res) => {
  const db = getDb();
  const { code, type, value, min_order, max_uses, valid_from, valid_until, active } = req.body;
  db.prepare(`INSERT INTO discount_codes (id, code, type, value, min_order, max_uses, valid_from, valid_until, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    uuid(), code.toUpperCase(), type || 'percent', parseFloat(value) || 0,
    parseFloat(min_order) || 0, max_uses ? parseInt(max_uses) : null,
    valid_from || null, valid_until || null, active ? 1 : 0
  );
  res.redirect('/admin/settings');
});

router.post('/settings/codes/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const { code, type, value, min_order, max_uses, valid_from, valid_until, active } = req.body;
  db.prepare(`UPDATE discount_codes SET code = ?, type = ?, value = ?, min_order = ?, max_uses = ?,
    valid_from = ?, valid_until = ?, active = ? WHERE id = ?`).run(
    code.toUpperCase(), type || 'percent', parseFloat(value) || 0,
    parseFloat(min_order) || 0, max_uses ? parseInt(max_uses) : null,
    valid_from || null, valid_until || null, active ? 1 : 0, req.params.id
  );
  res.redirect('/admin/settings');
});

router.post('/settings/codes/:id/delete', requireAdmin, (req, res) => {
  getDb().prepare('DELETE FROM discount_codes WHERE id = ?').run(req.params.id);
  res.redirect('/admin/settings');
});

router.post('/settings/codes/:id/toggle', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE discount_codes SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END WHERE id = ?').run(req.params.id);
  res.redirect('/admin/settings');
});

// === USERS CRUD ===
router.get('/settings/users/new', requireAdmin, (req, res) => {
  const settings = getSettings();
  res.render('admin/user-form', { title: 'New User - Admin', user: req.user, settings, editUser: null, page: 'settings' });
});

router.get('/settings/users/:id/edit', requireAdmin, (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const editUser = db.prepare('SELECT id, email, name, role, phone, active, created_at FROM users WHERE id = ?').get(req.params.id);
  if (!editUser) return res.redirect('/admin/settings');
  res.render('admin/user-form', { title: 'Edit User - Admin', user: req.user, settings, editUser, page: 'settings' });
});

router.post('/settings/users', requireAdmin, (req, res) => {
  const db = getDb();
  const { email, name, password, role, phone } = req.body;
  if (!email || !name || !password) return res.redirect('/admin/settings/users/new');
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, email, password_hash, name, role, phone) VALUES (?, ?, ?, ?, ?, ?)').run(
    uuid(), email, hash, name, role || 'staff', phone || null
  );
  res.redirect('/admin/settings');
});

router.post('/settings/users/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const { email, name, password, role, phone, active } = req.body;
  if (password && password.trim()) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare("UPDATE users SET email = ?, name = ?, password_hash = ?, role = ?, phone = ?, active = ?, updated_at = datetime('now') WHERE id = ?").run(
      email, name, hash, role || 'staff', phone || null, active ? 1 : 0, req.params.id
    );
  } else {
    db.prepare("UPDATE users SET email = ?, name = ?, role = ?, phone = ?, active = ?, updated_at = datetime('now') WHERE id = ?").run(
      email, name, role || 'staff', phone || null, active ? 1 : 0, req.params.id
    );
  }
  res.redirect('/admin/settings');
});

router.post('/settings/users/:id/delete', requireAdmin, (req, res) => {
  // Deactivate instead of hard delete to preserve audit trail
  getDb().prepare("UPDATE users SET active = 0, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.redirect('/admin/settings');
});

module.exports = router;
