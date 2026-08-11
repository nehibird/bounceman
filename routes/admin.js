const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const plaidSync = require('../lib/plaid-sync');
const { requireAuth, requireAdmin } = require('./auth');
const multer = require('multer');
const path = require('path');
const { v4: uuid } = require('uuid');
const dayjs = require('dayjs');
const { taxBreakdown, STATE_RATE: OK_STATE_RATE } = require('../lib/helpers');
const bcrypt = require('bcryptjs');
const vapiSvc = require('../services/vapi');
const googleAds = require('../services/google-ads');
const facebookAds = require('../services/facebook-ads');


// File upload config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'equipment');
    require('fs').mkdirSync(dir, { recursive: true, mode: 0o755 });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuid()}${ext}`);
  }
});
// MED-6: Validate both file extension and MIME type for uploads
const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  const extOk = /jpeg|jpg|png|webp|gif/.test(path.extname(file.originalname).toLowerCase());
  const mimeOk = allowedMimes.includes(file.mimetype);
  cb(null, extOk && mimeOk);
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
router.get('/', async (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const today = dayjs().format('YYYY-MM-DD');
  const weekAgo = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
  const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');

  const stats = {
    todayBookings: db.prepare('SELECT COUNT(*) as c FROM bookings WHERE event_date = ?').get(today).c,
    weekBookings: db.prepare('SELECT COUNT(*) as c FROM bookings WHERE created_at >= ?').get(weekAgo).c,
    monthRevenue: db.prepare("SELECT COALESCE(SUM(total), 0) as r FROM bookings WHERE created_at >= ? AND status != 'cancelled'").get(monthStart).r,
    pendingBookings: db.prepare("SELECT COUNT(*) as c FROM bookings WHERE status = 'pending'").get().c,
    totalCustomers: db.prepare('SELECT COUNT(*) as c FROM customers').get().c,
    totalEquipment: db.prepare('SELECT COUNT(*) as c FROM equipment').get().c,
    unsignedContracts: db.prepare('SELECT COUNT(*) as c FROM contracts WHERE signed = 0').get().c,
    pendingReviews: db.prepare('SELECT COUNT(*) as c FROM reviews WHERE approved = 0').get().c
  };

  const upcoming = db.prepare(`
    SELECT b.*, c.first_name, c.last_name, c.phone
    FROM bookings b JOIN customers c ON c.id = b.customer_id
    WHERE b.event_date >= ? AND b.status NOT IN ('cancelled', 'declined')
    ORDER BY b.event_date, b.event_start_time LIMIT 10
  `).all(today);

  const recentActivity = db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 15').all();

  // Financial analytics
  //
  // Four different things get conflated if you are not careful, so they are named
  // apart here: BOOKED (every live booking incl. future), EARNED (events that have
  // actually happened), COLLECTED (money that reached the payments ledger), and
  // BANKED (what the bank says). Only EARNED belongs in a profit or recovery figure.
  const totalRevenue = db.prepare("SELECT COALESCE(SUM(total), 0) as r FROM bookings WHERE status NOT IN ('cancelled', 'declined')").get().r;

  // Revenue for events that have already happened. Without the date bound, money for
  // next month's parties counted as "earned" and flattered every downstream number.
  const earnedRevenue = db.prepare(`SELECT COALESCE(SUM(total), 0) as r FROM bookings
    WHERE status NOT IN ('cancelled', 'declined') AND date(event_date) <= date('now','localtime')`).get().r;
  // Sales tax is the state's money, not income. Strip it from the numerator and strip
  // remittances from the denominator so the recovery ratio compares like with like.
  const earnedNetOfTax = db.prepare(`SELECT COALESCE(SUM(total - COALESCE(tax_amount,0)), 0) as r FROM bookings
    WHERE status NOT IN ('cancelled', 'declined') AND date(event_date) <= date('now','localtime')`).get().r;

  // Collected = the payments ledger, net of refunds. Derived from booking columns this
  // missed refunds entirely (nothing writes them back) and the deposit_paid gate hid
  // any booking paid in cash through the admin form.
  const cashCollected = db.prepare(`SELECT COALESCE(SUM(p.amount - COALESCE(p.refund_amount, 0)), 0) as r
    FROM payments p JOIN bookings b ON b.id = p.booking_id
    WHERE p.status = 'completed' AND b.status NOT IN ('cancelled', 'declined')`).get().r;
  const balanceOwed = db.prepare("SELECT COALESCE(SUM(balance_due), 0) as r FROM bookings WHERE status NOT IN ('cancelled', 'declined')").get().r;
  const totalExpenses = db.prepare('SELECT COALESCE(SUM(amount), 0) as t FROM expenses').get().t;
  // NULL-safe: a bare <> would silently drop uncategorised rows in SQLite.
  const operatingExpenses = db.prepare("SELECT COALESCE(SUM(amount), 0) as t FROM expenses WHERE category IS NULL OR category <> 'taxes'").get().t;
  const reimburseOwed = db.prepare('SELECT COALESCE(SUM(amount), 0) as t FROM expenses WHERE reimbursable = 1 AND reimbursed = 0').get().t;

  // --- Sales tax held for Oklahoma -------------------------------------------
  // OkTAP files on an EVENT-month basis, so tax becomes payable once the event has
  // happened. Remittances arrive as expenses with category='taxes' — the nightly bank
  // sync auto-tags anything matching OKLAHOMATAXPMTS — so this figure falls on its own
  // once a payment clears. Nothing to remember to do.
  const taxCollectedDelivered = db.prepare(`SELECT COALESCE(SUM(COALESCE(tax_amount,0)), 0) as t FROM bookings
    WHERE status NOT IN ('cancelled', 'declined') AND date(event_date) <= date('now','localtime')`).get().t;
  const taxRemitted = db.prepare("SELECT COALESCE(SUM(amount), 0) as t FROM expenses WHERE category = 'taxes'").get().t;
  const taxOwed = Math.round((taxCollectedDelivered - taxRemitted) * 100) / 100;
  // Collected on bookings whose event has not happened — not payable yet, but still
  // not his money. Shown separately so the two are never confused.
  const taxNotYetDue = db.prepare(`SELECT COALESCE(SUM(COALESCE(tax_amount,0)), 0) as t FROM bookings
    WHERE status NOT IN ('cancelled', 'declined') AND date(event_date) > date('now','localtime')`).get().t;

  const netPosition = earnedNetOfTax - operatingExpenses;
  const recoveryPct = operatingExpenses > 0 ? (earnedNetOfTax / operatingExpenses * 100) : 0;
  const avgTicketRow = db.prepare("SELECT COALESCE(AVG(total), 350) as a FROM bookings WHERE status NOT IN ('cancelled', 'declined') AND total > 0").get();
  const avgTicket = avgTicketRow.a || 350;
  const bookingsToBreakEven = netPosition >= 0 ? 0 : Math.ceil(Math.abs(netPosition) / avgTicket);

  // The three headline tiles must reconcile. A booking created with a pre-seeded
  // balance_due but no payment used to put money in BOOKED and in neither of the
  // other two, and nothing said so.
  //
  // Overpayments are NOT an imbalance: a customer who hands over $358.94 against a
  // $349.57 booking has genuinely paid that, and we keep it. Netting them out means
  // the banner only fires on real drift — a refund that never came off the booking,
  // or a deposit credited to a booking nobody paid for.
  const overpaid = db.prepare(`
    SELECT COALESCE(SUM(MAX(0, paid - b.total)), 0) AS o FROM (
      SELECT b2.id, b2.total,
             (SELECT COALESCE(SUM(p.amount - COALESCE(p.refund_amount,0)),0)
                FROM payments p WHERE p.booking_id = b2.id AND p.status = 'completed') AS paid
      FROM bookings b2 WHERE b2.status NOT IN ('cancelled','declined') AND b2.balance_due <= 0
    ) b`).get().o;
  const booksGap = Math.round((totalRevenue - cashCollected - balanceOwed + overpaid) * 100) / 100;
  const pipeline = db.prepare("SELECT COALESCE(SUM(total), 0) as r, COUNT(*) as c FROM bookings WHERE event_date > ? AND status IN ('confirmed', 'pending')").get(today);
  const creditCardDebt = parseFloat(settings.credit_card_debt || '0');

  // Live break-even projection by booking pace (stable vs. lumpy one-time capital like equipment/insurance).
  // remaining deficit -> # more bookings at the recent avg ticket -> calendar time at the recent booking pace,
  // stretched for the ~5-month OK off-season (~6.5 active months/yr).
  const deficit = Math.max(0, operatingExpenses - earnedNetOfTax);
  // Bounded at BOTH ends. Open-ended, this swept in every future booking, so "recent
  // pace" was an all-time average wearing a recency label — it could not detect a
  // slowdown, and future bookings counted twice (shrinking the deficit AND inflating
  // the pace that pays it off). total > 0 keeps comped bookings out of the average so
  // this and bookingsToBreakEven stop disagreeing.
  const bk120 = db.prepare(`SELECT COUNT(*) as c, COALESCE(SUM(total),0) as r FROM bookings
    WHERE status NOT IN ('cancelled','declined') AND total > 0
      AND event_date >= ? AND date(event_date) <= date('now','localtime')`).get(dayjs().subtract(120, 'day').format('YYYY-MM-DD'));
  const bookingsPerMonth = bk120.c / 4;
  const recentTicket = bk120.c > 0 ? bk120.r / bk120.c : avgTicket;
  let breakEven;
  if (deficit <= 0) breakEven = { status: 'reached' };
  else if (bookingsPerMonth > 0 && recentTicket > 0) {
    const bookingsNeeded = Math.ceil(deficit / recentTicket);
    const calMonths = Math.round((bookingsNeeded / bookingsPerMonth) * (12 / 6.5));
    breakEven = { status: 'projected', months: calMonths, date: dayjs().add(calMonths, 'month').format('MMM YYYY'), bookingsNeeded };
  } else breakEven = { status: 'building' };

  // Monthly revenue — last 6 months
  const sixMonthsAgo = dayjs().subtract(5, 'month').startOf('month').format('YYYY-MM-DD');
  const rawMonthly = db.prepare(`
    SELECT strftime('%Y-%m', event_date) as month, COALESCE(SUM(total), 0) as revenue
    FROM bookings WHERE status NOT IN ('cancelled', 'declined') AND event_date >= ?
    GROUP BY month ORDER BY month
  `).all(sixMonthsAgo);
  const monthlyMap = Object.fromEntries(rawMonthly.map(r => [r.month, r.revenue]));
  const monthlyRevenue = [];
  for (let i = 5; i >= 0; i--) {
    const key = dayjs().subtract(i, 'month').format('YYYY-MM');
    const lbl = dayjs().subtract(i, 'month').format('MMM YY');
    monthlyRevenue.push({ month: key, label: lbl, revenue: monthlyMap[key] || 0 });
  }

  // Equipment utilization
  const equipmentUtil = db.prepare(`
    SELECT e.name, COUNT(DISTINCT bi.booking_id) as bookings, COALESCE(SUM(bi.total_price), 0) as revenue
    FROM equipment e
    LEFT JOIN booking_items bi ON bi.equipment_id = e.id
    LEFT JOIN bookings b ON b.id = bi.booking_id AND b.status NOT IN ('cancelled', 'declined')
    GROUP BY e.id ORDER BY bookings DESC LIMIT 8
  `).all();

  const bankAccounts = db.prepare('SELECT * FROM bank_accounts ORDER BY sort_order, name').all();

  let stripePayouts = null;
  try { stripePayouts = await require('../services/stripe').getPayoutSummary(); } catch (e) { console.error('[DASH] stripe payouts failed:', e.message); }

  // Total cash position: liquid bank balances (excluding credit lines) + money on the way
  // from Stripe. Prefer `available` over `current` — a pending debit is already spent, and
  // at these balances the difference decides whether something bounces.
  const bankCash = (bankAccounts || []).filter((a) => a.type !== 'credit')
    .reduce((s, a) => s + (parseFloat(a.available != null ? a.available : a.balance) || 0), 0);
  const stripeIncoming = stripePayouts ? stripePayouts.pendingCents / 100 : 0;
  const cardDebt = (bankAccounts || []).filter((a) => a.type === 'credit').reduce((s, a) => s + (parseFloat(a.balance) || 0), 0);
  // What is actually his: cash on hand, less the state's money sitting in the same account.
  // taxNotYetDue is subtracted too — spending it only means being short next month.
  const safeToSpend = Math.round((bankCash - taxOwed - taxNotYetDue) * 100) / 100;
  const finance = {
    bankCash, stripeIncoming, cardDebt,
    cashPosition: bankCash + stripeIncoming,
    netLiquid: Math.round((bankCash + stripeIncoming - cardDebt) * 100) / 100,
    safeToSpend
  };

  res.render('admin/dashboard', {
    title: 'Dashboard - Bounce Man Admin',
    user: req.user, settings, stats, upcoming, recentActivity, page: 'dashboard',
    analytics: {
      totalRevenue, earnedRevenue, earnedNetOfTax, cashCollected, balanceOwed,
      totalExpenses, operatingExpenses, netPosition, recoveryPct, avgTicket,
      bookingsToBreakEven, pipeline, creditCardDebt, reimburseOwed, breakEven,
      taxOwed, taxNotYetDue, taxCollectedDelivered, taxRemitted, booksGap, overpaid
    },
    monthlyRevenue, equipmentUtil, bankAccounts, stripePayouts, finance
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

router.get('/bookings/new', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const equipment = db.prepare("SELECT * FROM equipment WHERE status = 'available' ORDER BY sort_order").all();
  res.render('admin/bookings/new', {
    title: 'New Booking - Admin', user: req.user, settings, equipment, page: 'bookings'
  });
});

router.post('/bookings/create', async (req, res) => {
  const db = getDb();
  const { v4: uuid } = require('uuid');
  const helpersLib = require('../lib/helpers');
  const { generateBookingNumber, getBookedEquipmentIds, isBlockedByWetDryRule, priceForBooking, isoOffset, calcPricing, resolveDeliveryFee, getPrice, getWetUpcharge } = helpersLib;
  const data = req.body;

  const equipIds = Array.isArray(data.equipment_ids) ? data.equipment_ids : (data.equipment_ids ? [data.equipment_ids] : []);
  if (!data.event_date || !equipIds.length) {
    return res.status(400).render('admin/bookings/new', {
      title: 'New Booking - Admin', user: req.user, settings: getSettings(),
      equipment: db.prepare("SELECT * FROM equipment WHERE status = 'available' ORDER BY sort_order").all(),
      error: 'Event date and at least one equipment item are required.', page: 'bookings'
    });
  }

  const rentalDays = Math.min(30, Math.max(1, parseInt(data.rental_days) || 1));
  const eventEndDate = rentalDays > 1
    ? (data.event_end_date || isoOffset(data.event_date, rentalDays - 1))
    : null;

  // Normalize overnight window so an admin-created overnight occupies all of day 1
  // (9 AM drop-off, held through the night; 9 AM next-day pickup is display-only).
  const adminHasOvernight = equipIds.some(id => (data['duration_' + id] || 'daily') === 'overnight');
  if (adminHasOvernight) {
    data.event_start_time = '09:00';
    data.event_end_time = '23:59';
  }

  const checkStart = data.event_start_time || '11:00';
  const checkEnd = data.event_end_time || '19:00';

  // ── Availability guard (pre-check, read-only) ────────────────────────────
  let bookingConflict = null;
  for (const eqId of equipIds) {
    const eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(eqId);
    if (!eq) continue;
    const durationType = data['duration_' + eqId] || 'daily';
    // Day 1
    const bookedCounts = getBookedEquipmentIds(db, data.event_date, checkStart, checkEnd, durationType);
    const totalQty = eq.quantity || 1;
    if ((bookedCounts.get(eqId) || 0) >= totalQty) {
      bookingConflict = `${eq.name} is already booked on ${data.event_date} at that time.`;
      break;
    }
    // Wet/dry rule
    const isWet = (data['wet_' + eqId] === '1');
    if (!isWet && isBlockedByWetDryRule(db, eqId, data.event_date, checkStart, false)) {
      bookingConflict = `${eq.name} cannot be booked dry within 48h of a wet rental.`;
      break;
    }
    // Extra days for multiday
    for (let d = 1; d < rentalDays; d++) {
      const extraDate = isoOffset(data.event_date, d);
      const extraCounts = getBookedEquipmentIds(db, extraDate, '00:00', '23:59:59', 'daily');
      if ((extraCounts.get(eqId) || 0) >= totalQty) {
        bookingConflict = `${eq.name} is not available on day ${d+1} (${extraDate}) of this ${rentalDays}-day rental.`;
        break;
      }
    }
    if (bookingConflict) break;
  }

  if (bookingConflict) {
    return res.render('admin/bookings/new', {
      title: 'New Booking - Admin', user: req.user, settings: getSettings(),
      equipment: db.prepare("SELECT * FROM equipment WHERE status = 'available' ORDER BY sort_order").all(),
      error: bookingConflict, page: 'bookings', formData: data
    });
  }

  // ── Reprice using priceForBooking ──────────────────────────────────────────
  let subtotal = 0;
  const lineItemsForInsert = [];
  for (const eqId of equipIds) {
    const eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(eqId);
    if (!eq) continue;
    const durationType = data['duration_' + eqId] || 'daily';
    const isWet = (data['wet_' + eqId] === '1');
    let unitPrice;
    try {
      unitPrice = priceForBooking(db, eq, { duration: durationType, days: rentalDays, wet: isWet, date: data.event_date });
    } catch(e) {
      const basePrice = getPrice(eq, durationType);
      unitPrice = isWet ? basePrice + getWetUpcharge(eq) : basePrice;
    }
    subtotal += unitPrice;
    lineItemsForInsert.push({ eqId, eq, durationType, isWet, unitPrice });
  }

  // Delivery
  const deliveryZip = data.delivery_zip || null;
  let delivery_fee = parseFloat(data.delivery_fee || 0);
  // Recalc if zip provided and no manual override
  if (deliveryZip && !data.delivery_fee_override) {
    try {
      const zr = await resolveDeliveryFee(db, deliveryZip);
      if (zr.fee >= 0) delivery_fee = zr.fee;
    } catch(e) {}
  }

  // Discount (canonical order — compute but don't subtract from subtotal)
  const adminHelpers = require('../lib/helpers');
  const adminDiscountRow = adminHelpers.lookupDiscount(db, data.discount_code);
  const adminIsComp = adminHelpers.isCompCode(adminDiscountRow);
  // Comp zeroes the taxable base; percent/fixed come off the subtotal only.
  let discount_amount = adminIsComp ? subtotal : adminHelpers.discountAmountFor(adminDiscountRow, subtotal);

  // Tax + totals (canonical: tax on undiscounted subtotal, discount off final total)
  const taxExempt = data.tax_exempt_claimed === '1';
  const settings = getSettings();
  const pricing = calcPricing(settings, subtotal, delivery_fee, data.delivery_city || null, taxExempt);
  const { taxRate: tax_rate, taxAmount: tax_amount, damageWaiverFee: damage_waiver_fee } = pricing;
  let total = Math.round((pricing.total - discount_amount) * 100) / 100;
  // Comp: delivery survives a subtotal discount, so zero the whole thing and record
  // the full comped value as the discount for the books.
  if (adminIsComp) { discount_amount = pricing.total; total = 0; }
  const deposit_amount = Math.min(parseFloat(settings.deposit_flat || '50'), total);  // flat $50 deposit
  const balance_due = Math.round((total - deposit_amount) * 100) / 100;
  if (adminDiscountRow) adminHelpers.redeemDiscount(db, adminDiscountRow.id);

  // H-2: Customer upsert + all INSERTs in ONE transaction to prevent TOCTOU double-booking race
  let bookingId, bookingNumber;
  db.transaction(() => {
    // Re-check availability inside the write transaction (TOCTOU guard)
    for (const eqId of equipIds) {
      const eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(eqId);
      if (!eq) continue;
      const durationType = data['duration_' + eqId] || 'daily';
      const bookedCounts = getBookedEquipmentIds(db, data.event_date, checkStart, checkEnd, durationType);
      const totalQty = eq.quantity || 1;
      if ((bookedCounts.get(eqId) || 0) >= totalQty) throw new Error(`double-booking: ${eq.name}`);
      for (let d = 1; d < rentalDays; d++) {
        const extraDate = isoOffset(data.event_date, d);
        const extraCounts = getBookedEquipmentIds(db, extraDate, '00:00', '23:59:59', 'daily');
        if ((extraCounts.get(eqId) || 0) >= totalQty) throw new Error(`double-booking day ${d+1}: ${eq.name}`);
      }
    }

    // Create or find customer
    bookingId = uuid();
    bookingNumber = generateBookingNumber();
    let customer = null;
    if (data.email) {
      customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(data.email);
    }
    if (!customer) {
      const customerId = uuid();
      db.prepare(`INSERT INTO customers (id, first_name, last_name, email, phone, source)
        VALUES (?, ?, ?, ?, ?, 'admin')`).run(
        customerId, data.first_name, data.last_name, data.email || null, adminHelpers.formatPhoneUS(data.phone) || null
      );
      customer = { id: customerId };
    }

    db.prepare(`INSERT INTO bookings (id, booking_number, customer_id, status, event_date, event_end_date,
      event_start_time, event_end_time, event_type, surface_type,
      delivery_address, delivery_city, delivery_state, delivery_zip,
      subtotal, delivery_fee, discount_amount, tax_amount, tax_rate, damage_waiver_fee,
      total, deposit_amount, balance_due, payment_status, internal_notes, source,
      created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', datetime('now'), datetime('now'))`).run(
      bookingId, bookingNumber, customer.id, data.status || 'confirmed',
      data.event_date, eventEndDate,
      data.event_start_time || null, data.event_end_time || null,
      data.event_type || null, data.surface_type || null,
      data.delivery_address || null, data.delivery_city || null,
      data.delivery_state || 'OK', deliveryZip,
      subtotal, delivery_fee, discount_amount, tax_amount, tax_rate, damage_waiver_fee,
      total, deposit_amount, balance_due,
      data.payment_status || 'unpaid', data.internal_notes || null
    );

    // Add booking items
    for (const item of lineItemsForInsert) {
      db.prepare(`INSERT INTO booking_items (id, booking_id, equipment_id, item_name, item_type, quantity, unit_price, total_price, duration_type, rental_days)
        VALUES (?, ?, ?, ?, 'equipment', 1, ?, ?, ?, ?)`).run(
        uuid(), bookingId, item.eqId, item.eq.name, item.unitPrice, item.unitPrice, item.durationType, rentalDays
      );
    }
  })();

  console.log('[ADMIN] Booking created:', bookingNumber, 'for', data.first_name, data.last_name);
  res.redirect('/admin/bookings/' + bookingId);
});

router.get('/bookings/:id', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const booking = db.prepare('SELECT b.*, c.*, b.id as id FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.id = ?').get(req.params.id);
  if (!booking) return res.redirect('/admin/bookings');

  const items = db.prepare(`SELECT bi.*, e.category,
    (SELECT image_path FROM equipment_images WHERE equipment_id = bi.equipment_id AND is_primary = 1 LIMIT 1) as image
    FROM booking_items bi LEFT JOIN equipment e ON e.id = bi.equipment_id WHERE bi.booking_id = ?`).all(req.params.id);
  const payments = db.prepare('SELECT * FROM payments WHERE booking_id = ? ORDER BY created_at DESC').all(req.params.id);
  // Calculate amount paid from payments
  const amountPaid = payments.reduce((sum, p) => sum + (p.status === 'completed' ? p.amount : 0), 0);
  booking.amount_paid = amountPaid;
  const contract = db.prepare('SELECT * FROM contracts WHERE booking_id = ?').get(req.params.id);
  const comms = db.prepare('SELECT * FROM communications WHERE booking_id = ? ORDER BY sent_at DESC').all(req.params.id);

  res.render('admin/bookings/detail', {
    title: `Booking ${booking.booking_number} - Admin`, user: req.user, settings,
    booking, items, payments, contract, comms, page: 'bookings'
  });
});

router.get('/bookings/:id/contract', (req, res) => {
  const db = getDb();
  const contract = db.prepare('SELECT id FROM contracts WHERE booking_id = ?').get(req.params.id);
  if (!contract) return res.redirect('/admin/bookings/' + req.params.id);
  res.redirect('/contract/' + contract.id);
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

// Record manual payment (cash, check, card on delivery)
router.post('/bookings/:id/payment', (req, res) => {
  const db = getDb();
  const { amount, payment_method, notes } = req.body;
  const bookingId = req.params.id;

  // Get booking and customer
  const booking = db.prepare('SELECT b.*, c.first_name, c.last_name, c.email, c.id as cust_id FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.id = ?').get(bookingId);
  if (!booking) return res.redirect('/admin/bookings?error=Booking+not+found');

  const paymentAmount = parseFloat(amount) || 0;
  if (paymentAmount <= 0) return res.redirect('/admin/bookings/' + bookingId + '?error=Invalid+amount');

  // Create payment record
  const paymentId = require('crypto').randomUUID();
  db.prepare("INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, status, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))").run(
    paymentId, bookingId, booking.cust_id, paymentAmount, 'charge', payment_method || 'cash', 'completed', notes || null
  );

  // Calculate new balance
  const totalPaid = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE booking_id = ? AND status = 'completed'").get(bookingId).total;
  const newBalance = Math.max(0, parseFloat(booking.total) - totalPaid);
  const newStatus = newBalance <= 0 ? 'paid' : (totalPaid > 0 ? 'partial' : 'unpaid');

  // Update booking
  db.prepare("UPDATE bookings SET balance_due = ?, payment_status = ?, updated_at = datetime('now') WHERE id = ?").run(newBalance, newStatus, bookingId);

  // Send Slack notification
  const slack = require('../services/notifications');
  if (slack.sendSlackMessage) {
    slack.sendSlackMessage({
      text: ':white_check_mark: *Payment Recorded* - ' + booking.booking_number,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: ':white_check_mark: *Payment Recorded*\n*' + booking.first_name + ' ' + booking.last_name + '* - ' + booking.booking_number } },
        { type: 'section', fields: [
          { type: 'mrkdwn', text: '*Amount:*\n$' + paymentAmount.toFixed(2) },
          { type: 'mrkdwn', text: '*Method:*\n' + (payment_method || 'cash') },
          { type: 'mrkdwn', text: '*New Balance:*\n$' + newBalance.toFixed(2) },
          { type: 'mrkdwn', text: '*Status:*\n' + newStatus }
        ]}
      ]
    }).catch(e => console.error('[SLACK] Payment notification failed:', e.message));
  }

  // Send the booking confirmation if it never went out (covers manually/fully-paid bookings
  // that bypass the Stripe deposit-checkout webhook). Guarded + non-blocking.
  if (!booking.confirmation_email_sent && booking.email && totalPaid > 0) {
    const emailService = require('../services/email');
    const items = db.prepare('SELECT * FROM booking_items WHERE booking_id = ?').all(bookingId);
    let contractId = null;
    try { const ct = db.prepare('SELECT id FROM contracts WHERE booking_id = ?').get(bookingId); if (ct) contractId = ct.id; } catch (e) { /* no contracts table */ }
    const fresh = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    emailService.sendBookingConfirmation(fresh, { first_name: booking.first_name, last_name: booking.last_name, email: booking.email }, items, contractId)
      .then(() => db.prepare('UPDATE bookings SET confirmation_email_sent = 1 WHERE id = ?').run(bookingId))
      .catch(e => console.error('[EMAIL] Admin-payment confirmation failed:', e.message));
  }

  console.log('[PAYMENT] Recorded $' + paymentAmount.toFixed(2) + ' ' + payment_method + ' for ' + booking.booking_number);
  res.redirect('/admin/bookings/' + bookingId + '?success=Payment+recorded');
});


// Bulk delete bookings
router.post('/api/bookings/bulk-delete', (req, res) => {
  const db = getDb();
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.json({ success: false, error: 'No bookings selected' });
  }
  let deleted = 0;
  const del = db.transaction((bookingIds) => {
    for (const id of bookingIds) {
      db.prepare('DELETE FROM booking_items WHERE booking_id = ?').run(id);
      db.prepare('DELETE FROM payments WHERE booking_id = ?').run(id);
      db.prepare('DELETE FROM contracts WHERE booking_id = ?').run(id);
      db.prepare('DELETE FROM communications WHERE booking_id = ?').run(id);
      db.prepare('DELETE FROM reviews WHERE booking_id = ?').run(id);
      db.prepare('DELETE FROM delivery_route_stops WHERE booking_id = ?').run(id);
      db.prepare('DELETE FROM bookings WHERE id = ?').run(id);
      deleted++;
    }
  });
  try {
    del(ids);
    console.log('[ADMIN] Bulk deleted', deleted, 'bookings');
    res.json({ success: true, deleted });
  } catch (e) {
    console.error('[ADMIN] Bulk delete error:', e.message);
    res.json({ success: false, error: e.message });
  }
});


// Bulk delete customers (only those without bookings)
router.post('/api/customers/bulk-delete', (req, res) => {
  const db = getDb();
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.json({ success: false, error: 'No customers selected' });
  }

  // Check for customers with bookings
  const hasBookings = [];
  for (const id of ids) {
    const count = db.prepare('SELECT COUNT(*) as count FROM bookings WHERE customer_id = ?').get(id).count;
    if (count > 0) {
      const cust = db.prepare('SELECT first_name, last_name FROM customers WHERE id = ?').get(id);
      hasBookings.push(cust ? cust.first_name + ' ' + cust.last_name : id);
    }
  }
  if (hasBookings.length > 0) {
    return res.json({ success: false, error: 'Cannot delete customers with bookings: ' + hasBookings.join(', ') });
  }

  let deleted = 0;
  const del = db.transaction((customerIds) => {
    for (const id of customerIds) {
      db.prepare('DELETE FROM payments WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM communications WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM customers WHERE id = ?').run(id);
      deleted++;
    }
  });
  try {
    del(ids);
    console.log('[ADMIN] Bulk deleted', deleted, 'customers');
    res.json({ success: true, deleted });
  } catch (e) {
    console.error('[ADMIN] Customer bulk delete error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

router.post('/bookings/:id/delete', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  try {
    db.prepare('DELETE FROM booking_items WHERE booking_id = ?').run(id);
    db.prepare('DELETE FROM payments WHERE booking_id = ?').run(id);
    db.prepare('DELETE FROM contracts WHERE booking_id = ?').run(id);
    db.prepare('DELETE FROM communications WHERE booking_id = ?').run(id);
    db.prepare('DELETE FROM reviews WHERE booking_id = ?').run(id);
    db.prepare('DELETE FROM delivery_route_stops WHERE booking_id = ?').run(id);
    db.prepare('DELETE FROM bookings WHERE id = ?').run(id);
    console.log('[ADMIN] Booking deleted:', id);
  } catch (e) {
    console.error('[ADMIN] Delete booking error:', e.message);
  }
  res.redirect('/admin/bookings');
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

  // Validate price_extra_day is required
  if (!data.price_extra_day || parseFloat(data.price_extra_day) <= 0) {
    const categories = db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY sort_order').all();
    return res.status(422).render('admin/equipment/form', {
      title: 'Add Equipment - Admin', user: req.user, settings: getSettings(), categories,
      item: { ...data }, images: [], page: 'equipment',
      formError: 'Extra Day Price is required and must be greater than $0.'
    });
  }

  const itemId = uuid();
  const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  db.prepare(`INSERT INTO equipment (id, name, slug, category, description, short_description,
    dimensions, weight_lbs, capacity_kids, age_range, setup_time_min, power_required,
    price_hourly, price_4hr, price_daily, price_weekend, price_overnight, price_wet, price_extra_day, deposit_amount,
    replacement_cost, manufacturer, model, serial_number, purchase_date, condition, status, featured, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    itemId, data.name, slug, data.category, data.description, data.short_description,
    data.dimensions, data.weight_lbs || null, data.capacity_kids || null, data.age_range,
    data.setup_time_min || 15, data.power_required || '1 standard outlet',
    data.price_hourly || null, data.price_4hr || null, data.price_daily,
    data.price_weekend || null, data.price_overnight || null, data.price_wet || null,
    parseFloat(data.price_extra_day), data.deposit_amount || 50,
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

  // Validate price_extra_day is required
  if (!data.price_extra_day || parseFloat(data.price_extra_day) <= 0) {
    const item = db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id) || { ...data, id: req.params.id };
    const images = db.prepare('SELECT * FROM equipment_images WHERE equipment_id = ? ORDER BY sort_order').all(req.params.id);
    const categories = db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY sort_order').all();
    return res.status(422).render('admin/equipment/form', {
      title: `Edit Equipment - Admin`, user: req.user, settings: getSettings(),
      item: { ...item, ...data }, images, categories, page: 'equipment',
      formError: 'Extra Day Price is required and must be greater than $0.'
    });
  }

  const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  db.prepare(`UPDATE equipment SET name=?, slug=?, category=?, description=?, short_description=?,
    dimensions=?, weight_lbs=?, capacity_kids=?, age_range=?, setup_time_min=?, power_required=?,
    price_hourly=?, price_4hr=?, price_daily=?, price_weekend=?, price_overnight=?, price_wet=?, price_extra_day=?, deposit_amount=?,
    replacement_cost=?, manufacturer=?, model=?, serial_number=?, purchase_date=?, condition=?,
    status=?, featured=?, sort_order=?, updated_at=datetime('now')
    WHERE id=?`).run(
    data.name, slug, data.category, data.description, data.short_description,
    data.dimensions, data.weight_lbs || null, data.capacity_kids || null, data.age_range,
    data.setup_time_min || 15, data.power_required || '1 standard outlet',
    data.price_hourly || null, data.price_4hr || null, data.price_daily,
    data.price_weekend || null, data.price_overnight || null, data.price_wet || null,
    parseFloat(data.price_extra_day), data.deposit_amount || 50,
    data.replacement_cost || null, data.manufacturer, data.model, data.serial_number,
    data.purchase_date || null, data.condition || 'excellent', data.status || 'available',
    data.featured ? 1 : 0, data.sort_order || 0, req.params.id
  );

  if (req.files?.length) {
    const existingCount = db.prepare('SELECT COUNT(*) as c FROM equipment_images WHERE equipment_id = ?').get(req.params.id).c;
    req.files.forEach((file, i) => {
      // Fix permissions so nginx/Docker can serve the file
      try { require('fs').chmodSync(file.path, 0o644); } catch {}
      const isPrimary = (existingCount === 0 && i === 0) ? 1 : 0;
      db.prepare('INSERT INTO equipment_images (id, equipment_id, image_path, is_primary, sort_order) VALUES (?, ?, ?, ?, ?)')
        .run(uuid(), req.params.id, `/uploads/equipment/${file.filename}`, isPrimary, existingCount + i);
    });
  }

  res.redirect('/admin/equipment/' + req.params.id + '/edit');
});


// Set image as primary/featured
router.get('/equipment/image/:imgId/set-primary', (req, res) => {
  const db = getDb();
  const img = db.prepare('SELECT * FROM equipment_images WHERE id = ?').get(req.params.imgId);
  if (!img) return res.redirect('/admin/equipment');

  // Clear all primary flags for this equipment, then set the selected one
  db.prepare('UPDATE equipment_images SET is_primary = 0 WHERE equipment_id = ?').run(img.equipment_id);
  db.prepare('UPDATE equipment_images SET is_primary = 1 WHERE id = ?').run(req.params.imgId);

  res.redirect('/admin/equipment/' + img.equipment_id + '/edit');
});

// Delete image
router.get('/equipment/image/:imgId/delete', (req, res) => {
  const db = getDb();
  const img = db.prepare('SELECT * FROM equipment_images WHERE id = ?').get(req.params.imgId);
  if (!img) return res.redirect('/admin/equipment');

  const equipmentId = img.equipment_id;
  db.prepare('DELETE FROM equipment_images WHERE id = ?').run(req.params.imgId);

  // If we deleted the primary, make the first remaining image primary
  if (img.is_primary) {
    const next = db.prepare('SELECT id FROM equipment_images WHERE equipment_id = ? ORDER BY sort_order LIMIT 1').get(equipmentId);
    if (next) db.prepare('UPDATE equipment_images SET is_primary = 1 WHERE id = ?').run(next.id);
  }

  // Try to delete the file from disk
  try {
    const filePath = path.join(__dirname, '..', img.image_path.startsWith('/uploads') ? img.image_path : 'public' + img.image_path);
    require('fs').unlinkSync(filePath);
  } catch { /* file may not exist or be in Docker volume */ }

  res.redirect('/admin/equipment/' + equipmentId + '/edit');
});

// Delete equipment item
router.post('/equipment/:id/delete', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  try {
    // Delete related images first
    const images = db.prepare('SELECT image_path FROM equipment_images WHERE equipment_id = ?').all(id);
    db.prepare('DELETE FROM equipment_images WHERE equipment_id = ?').run(id);
    // Delete booking items referencing this equipment
    db.prepare('DELETE FROM booking_items WHERE equipment_id = ?').run(id);
    // Delete maintenance logs
    db.prepare('DELETE FROM maintenance_log WHERE equipment_id = ?').run(id);
    // Delete the equipment itself
    db.prepare('DELETE FROM equipment WHERE id = ?').run(id);
    console.log('[ADMIN] Equipment deleted:', id);
    // Try to delete image files
    images.forEach(img => {
      try {
        const filePath = require('path').join(__dirname, '..', img.image_path.startsWith('/uploads') ? img.image_path : 'public' + img.image_path);
        require('fs').unlinkSync(filePath);
      } catch { /* ignore */ }
    });
  } catch (e) {
    console.error('[ADMIN] Delete equipment error:', e.message);
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

  const bookings = db.prepare('SELECT * FROM bookings WHERE customer_id = ? ORDER BY event_date DESC').all(req.params.id);
  const payments = db.prepare('SELECT * FROM payments WHERE customer_id = ? ORDER BY created_at DESC').all(req.params.id);
  const comms = db.prepare('SELECT * FROM communications WHERE customer_id = ? ORDER BY sent_at DESC').all(req.params.id);

  res.render('admin/customers/detail', {
    title: `${customer.first_name} ${customer.last_name} - Admin`, user: req.user, settings,
    customer, bookings, payments, comms, page: 'customers', error: req.query.error
  });
});

router.post('/customers/:id/tax-exempt', (req, res) => {
  const db = getDb();
  const { tax_exempt, tax_exempt_cert } = req.body;
  // Only touch a field the form actually submitted. This used to NULL an existing
  // exemption certificate on any save that didn't happen to include the input —
  // and a lost certificate turns an exempt sale into an unbacked one, where the
  // burden of proof is on us (OAC 710:65-1-4(a)).
  if (typeof tax_exempt_cert !== 'undefined') {
    db.prepare("UPDATE customers SET tax_exempt_cert = ?, updated_at = datetime('now') WHERE id = ?")
      .run(String(tax_exempt_cert).trim() || null, req.params.id);
  }
  if (typeof tax_exempt !== 'undefined') {
    db.prepare("UPDATE customers SET tax_exempt = ?, updated_at = datetime('now') WHERE id = ?")
      .run([].concat(tax_exempt).includes('1') ? 1 : 0, req.params.id);
  }
  console.log('[ADMIN] Tax exempt updated for customer:', req.params.id, 'exempt:', tax_exempt);
  res.redirect('/admin/customers/' + req.params.id);
});

// Append a timestamped internal note to the customer record.
router.post('/customers/:id/notes', (req, res) => {
  const db = getDb();
  const note = (req.body.note || '').trim();
  if (note) {
    const cust = db.prepare('SELECT notes FROM customers WHERE id = ?').get(req.params.id);
    const stamp = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
    const appended = (cust && cust.notes ? cust.notes + '\n\n' : '') + '[' + stamp + '] ' + note;
    db.prepare("UPDATE customers SET notes = ?, updated_at = datetime('now') WHERE id = ?").run(appended, req.params.id);
  }
  res.redirect('/admin/customers/' + req.params.id);
});

router.post('/customers/:id/delete', (req, res) => {
  const db = getDb();
  const id = req.params.id;

  // Protect customer data - don't delete if they have bookings
  const bookingCount = db.prepare('SELECT COUNT(*) as count FROM bookings WHERE customer_id = ?').get(id).count;
  if (bookingCount > 0) {
    console.log('[ADMIN] Cannot delete customer with', bookingCount, 'active bookings:', id);
    return res.redirect('/admin/customers/' + id + '?error=has_bookings');
  }

  // No bookings - safe to delete customer and their communications/payments
  db.prepare('DELETE FROM payments WHERE customer_id = ?').run(id);
  db.prepare('DELETE FROM communications WHERE customer_id = ?').run(id);
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  console.log('[ADMIN] Customer deleted:', id);
  res.redirect('/admin/customers');
});
// === CALENDAR ===
router.get('/calendar', (req, res) => {
  const db = getDb();
  const settings = getSettings();

  const bookings = db.prepare(`
    SELECT b.id, b.booking_number, b.event_date, b.event_end_date, b.event_start_time, b.event_end_time, b.status,
      c.first_name, c.last_name,
      MAX(bi.rental_days) as rental_days,
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

  const revenue = db.prepare('SELECT COALESCE(SUM(total), 0) as total FROM bookings WHERE created_at >= ? AND status != \'cancelled\'').get(dateFilter);
  const bookingCount = db.prepare('SELECT COUNT(*) as c FROM bookings WHERE created_at >= ? AND status != \'cancelled\'').get(dateFilter);
  const avgTicket = db.prepare('SELECT COALESCE(AVG(total), 0) as avg FROM bookings WHERE created_at >= ? AND status != \'cancelled\'').get(dateFilter);

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

  // B9: sales tax collected, bucketed by EVENT month (the correct OkTAP remittance basis).
  const taxByMonth = db.prepare(`
    SELECT strftime('%Y-%m', event_date) as month,
           COALESCE(SUM(tax_amount),0) as tax, COALESCE(SUM(total),0) as total, COUNT(*) as bookings
    FROM bookings
    WHERE status NOT IN ('cancelled','declined') AND tax_amount IS NOT NULL
      AND date(event_date) IS NOT NULL AND date(event_date) >= date('now','-18 months')
    GROUP BY month ORDER BY month DESC
  `).all();
  // Tax collected on bookings whose event hasn't happened yet (collected, not yet due).
  const taxCollectedFuture = db.prepare(`
    SELECT COALESCE(SUM(tax_amount),0) as tax FROM bookings
    WHERE status NOT IN ('cancelled','declined') AND event_date > date('now')
  `).get().tax;

  // B8: exemptions — flag any claim not backed by a certificate on file.
  // Prefer the certificate recorded against THIS sale; fall back to the customer's.
  // Also carry the 90-day documentation clock: under OAC 710:65-7-6(c)(2) the vendor
  // must hold the certificate within 90 days of the sale, or the sale is taxable and
  // the burden of proof sits with us.
  const exemptions = db.prepare(`
    SELECT b.booking_number, c.first_name, c.last_name,
           COALESCE(NULLIF(TRIM(b.tax_exempt_cert),''), c.tax_exempt_cert) AS tax_exempt_cert,
           b.total, b.tax_amount, b.event_date, b.status,
           CAST(julianday(date(b.event_date,'+90 day')) - julianday(date('now','localtime')) AS INTEGER) AS days_left,
           date(b.event_date,'+90 day') AS docs_due
    FROM bookings b JOIN customers c ON c.id = b.customer_id
    WHERE b.tax_exempt_claimed = 1 AND b.status NOT IN ('cancelled','declined')
    ORDER BY b.event_date DESC
  `).all();

  // === OkTAP return worksheet ==================================================
  // Everything needed to fill in form STS-20002-C plus the STS-20021 city/county
  // supplement for one filing period, so it is not reassembled by hand each month.
  //
  // The current form is STS-20002-C. STS-20002-A is superseded ("for Filing Returns
  // Prior to August 1, 2024") and its line numbers are shifted by one — filing on the
  // old form puts the city/county total into the State Tax box.
  const filingMonth = /^\d{4}-\d{2}$/.test(req.query.month || '')
    ? req.query.month
    : dayjs().subtract(1, 'month').format('YYYY-MM');

  const okReturn = (() => {
    const rows = db.prepare(`
      SELECT b.booking_number, b.event_date, b.delivery_city,
             b.subtotal, b.discount_amount, b.delivery_fee, b.surface_fee, b.damage_waiver_fee,
             b.tax_amount, b.total, b.tax_exempt_claimed,
             c.first_name, c.last_name, c.tax_exempt_cert
      FROM bookings b LEFT JOIN customers c ON c.id = b.customer_id
      WHERE b.status NOT IN ('cancelled','declined')
        AND strftime('%Y-%m', b.event_date) = ?
      ORDER BY b.event_date
    `).all(filingMonth);

    const byCity = {};
    let totalSales = 0, exemptSales = 0, deliveryExcluded = 0, taxCollected = 0, taxableSales = 0;
    const lines = [];

    for (const r of rows) {
      // Gross receipts on the return exclude the tax itself.
      const gross = (r.total || 0) - (r.tax_amount || 0);
      // Separately-stated delivery is EXCLUDED from the tax base (OAC 710:65-19-70(b)),
      // but it IS part of gross receipts — so it goes in Line 1 and comes back out on
      // Schedule J, which is how Line 1 reconciles down to Line 5.
      const delivery = r.delivery_fee || 0;
      const base = (r.subtotal || 0) - (r.discount_amount || 0) + (r.surface_fee || 0) + (r.damage_waiver_fee || 0);
      const exempt = r.tax_exempt_claimed === 1;
      const city = (taxBreakdown(r.delivery_city) || {}).key || ((r.delivery_city || '').trim().toUpperCase() || '(NO CITY ON BOOKING)');

      totalSales += gross;
      deliveryExcluded += delivery;
      taxCollected += (r.tax_amount || 0);
      if (exempt) exemptSales += base;
      else { taxableSales += base; byCity[city] = (byCity[city] || 0) + base; }

      // What the CURRENT rate table says this sale should have carried. Surfaces any
      // booking whose stored tax no longer matches the jurisdiction it was sold into.
      const bd = taxBreakdown(r.delivery_city);
      const liveRate = exempt ? 0 : (bd ? bd.total : 0);
      const shouldBe = Math.round(base * liveRate * 100) / 100;
      lines.push({
        booking_number: r.booking_number, event_date: r.event_date,
        who: ((r.first_name || '') + ' ' + (r.last_name || '')).trim() || '—',
        city: r.delivery_city || '', base, delivery, exempt,
        cert: r.tax_exempt_cert || '', taxCharged: r.tax_amount || 0, shouldBe,
        mismatch: Math.abs(shouldBe - (r.tax_amount || 0)) > 0.01,
        unresolved: !exempt && bd == null
      });
    }

    const stateTax = Math.round(taxableSales * OK_STATE_RATE * 100) / 100;

    // City lines for STS-20021.
    const jurisdictions = Object.entries(byCity).map(([city, base]) => {
      const bd = taxBreakdown(city);
      const rate = bd ? bd.cityRate : 0;
      return { city, base: Math.round(base * 100) / 100, rate, tax: Math.round(base * rate * 100) / 100,
               county: bd ? bd.countyName : null, resolved: !!bd };
    }).sort((a, b) => b.base - a.base);

    // County lines are billed on the whole taxable base for that county, not per city.
    const countyBase = {};
    for (const j of jurisdictions) if (j.county) countyBase[j.county] = (countyBase[j.county] || 0) + j.base;
    const counties = Object.entries(countyBase).map(([county, base]) => {
      // Every city in a county shares the county rate, so take it from any member city.
      const member = jurisdictions.find(j => j.county === county);
      const rate = member ? (taxBreakdown(member.city) || {}).countyRate || 0 : 0;
      return { county, base: Math.round(base * 100) / 100, rate, tax: Math.round(base * rate * 100) / 100 };
    }).sort((a, b) => b.base - a.base);

    const localTax = Math.round((jurisdictions.reduce((s, j) => s + j.tax, 0)
      + counties.reduce((s, c) => s + c.tax, 0)) * 100) / 100;
    const totalDue = Math.round((stateTax + localTax) * 100) / 100;

    return {
      month: filingMonth, bookings: rows.length,
      totalSales: Math.round(totalSales * 100) / 100,
      exemptSales: Math.round(exemptSales * 100) / 100,
      deliveryExcluded: Math.round(deliveryExcluded * 100) / 100,
      taxableSales: Math.round(taxableSales * 100) / 100,
      stateTax, jurisdictions, counties, localTax, totalDue,
      taxCollected: Math.round(taxCollected * 100) / 100,
      outOfPocket: Math.round((totalDue - taxCollected) * 100) / 100,
      lines
    };
  })();

  // Only offer periods that actually have bookings.
  const filingMonths = db.prepare(`SELECT DISTINCT strftime('%Y-%m', event_date) m FROM bookings
    WHERE status NOT IN ('cancelled','declined') AND event_date IS NOT NULL
    ORDER BY m DESC`).all().map(r => r.m).filter(Boolean);

  res.render('admin/reports', {
    title: 'Reports - Admin', user: req.user, settings,
    revenue: revenue.total, bookingCount: bookingCount.c, avgTicket: avgTicket.avg,
    topItems, revenueByMonth, statusBreakdown, period, page: 'reports',
    taxByMonth, taxCollectedFuture, exemptions, okReturn, filingMonths
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

router.post('/reviews/:id/delete', (req, res) => {
  getDb().prepare('DELETE FROM reviews WHERE id = ?').run(req.params.id);
  console.log('[ADMIN] Review deleted:', req.params.id);
  res.redirect('/admin/reviews');
});

// === COMMUNICATIONS ===
router.get('/communications', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const activeType = req.query.type || '';
  const sql = `
    SELECT cm.*, c.first_name, c.last_name
    FROM communications cm
    LEFT JOIN customers c ON c.id = cm.customer_id
    ${activeType ? 'WHERE cm.type = ?' : ''}
    ORDER BY cm.sent_at DESC LIMIT 100
  `;
  const comms = activeType ? db.prepare(sql).all(activeType) : db.prepare(sql).all();

  res.render('admin/communications', {
    title: 'Communications - Admin', user: req.user, settings, comms, activeType, page: 'communications'
  });
});

router.post('/communications/:id/delete', (req, res) => {
  getDb().prepare('DELETE FROM communications WHERE id = ?').run(req.params.id);
  res.redirect('/admin/communications');
});

router.post('/communications/:id/bot-pause', (req, res) => {
  getDb().prepare('UPDATE communications SET bot_paused = 1 WHERE id = ?').run(req.params.id);
  res.redirect('/admin/communications');
});

router.post('/communications/:id/bot-resume', (req, res) => {
  getDb().prepare('UPDATE communications SET bot_paused = 0 WHERE id = ?').run(req.params.id);
  res.redirect('/admin/communications');
});

// Call log + click-to-call back (uses /api/call/dial)
//
// call_log is the inbound spam-gate log (one row per attempt: number, status, time).
// The substance of a call — Vapi id, duration, summary, recording — is only written to
// activity_log as 'sarah_call_completed'. The two tables have no shared key
// (call_log.vapi_call_id actually holds a Twilio CallSid), so completed-call detail is
// attached here by matching on caller number within a time window; each completed
// record is consumed at most once so redials don't all inherit the same conversation.
router.get('/calls', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const calls = db.prepare("SELECT * FROM call_log ORDER BY called_at DESC LIMIT 200").all();
  const customers = db.prepare("SELECT first_name, last_name, phone FROM customers WHERE phone IS NOT NULL AND phone != ''").all();
  const byPhone = {};
  customers.forEach(c => { const d = String(c.phone).replace(/\D/g, '').slice(-10); if (d.length === 10) byPhone[d] = ((c.first_name || '') + ' ' + (c.last_name || '')).trim(); });

  const completed = db.prepare("SELECT entity_id, details, created_at FROM activity_log WHERE action = 'sarah_call_completed' ORDER BY created_at DESC LIMIT 400").all()
    .map(r => { let d = {}; try { d = JSON.parse(r.details || '{}'); } catch { d = {}; } return { vapiCallId: r.entity_id, at: r.created_at, digits: String(d.caller || '').replace(/\D/g, '').slice(-10), durationSec: d.duration_sec, endedReason: d.ended_reason, summary: d.summary, used: false }; });

  const MATCH_WINDOW_MS = 2 * 60 * 60 * 1000; // a report lands within ~2h of the gate row
  const ts = (v) => { const t = Date.parse(String(v).replace(' ', 'T') + 'Z'); return Number.isNaN(t) ? null : t; };

  calls.forEach(cl => {
    const d = String(cl.caller_number || '').replace(/\D/g, '').slice(-10);
    cl.customer_name = byPhone[d] || '';
    try { cl.when = new Date(String(cl.called_at).replace(' ', 'T') + 'Z').toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT'; } catch { cl.when = cl.called_at; }

    const start = ts(cl.called_at);
    if (start != null && d.length === 10) {
      // Nearest unused report for this number that ended after the call started.
      let best = null;
      for (const c of completed) {
        if (c.used || c.digits !== d) continue;
        const end = ts(c.at);
        if (end == null || end < start || end - start > MATCH_WINDOW_MS) continue;
        if (!best || ts(c.at) < ts(best.at)) best = c;
      }
      if (best) {
        best.used = true;
        cl.vapi_call_id_real = best.vapiCallId;
        cl.duration = vapiSvc.formatDuration(best.durationSec != null ? best.durationSec : null);
        cl.ended_reason = best.endedReason || '';
        cl.summary = best.summary || '';
      }
    }
  });
  res.render('admin/calls', { title: 'Calls - Admin', user: req.user, settings, calls, page: 'calls' });
});

// Call detail — audio player + transcript + summary + call back.
// :id is the Vapi call id (the 019f… uuid stored in activity_log.entity_id).
router.get('/calls/:id', async (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const vapiCallId = req.params.id;

  // Cached copy from the end-of-call webhook, so the page still renders if Vapi is down.
  const row = db.prepare("SELECT entity_id, details, created_at FROM activity_log WHERE action = 'sarah_call_completed' AND entity_id = ? ORDER BY created_at DESC LIMIT 1").get(vapiCallId);
  let cached = {};
  if (row) { try { cached = JSON.parse(row.details || '{}'); } catch { cached = {}; } }

  let call = null;
  let vapiError = null;
  try {
    call = vapiSvc.normalizeCall(await vapiSvc.getCall(vapiCallId));
  } catch (e) {
    vapiError = e.message;
    console.error('[ADMIN CALLS] Vapi lookup failed for', vapiCallId, '-', e.message);
  }

  if (!call && !row) return res.status(404).render('admin/call-detail', {
    title: 'Call - Admin', user: req.user, settings, page: 'calls',
    vapiCallId, call: null, vapiError, customerName: '', when: '', notFound: true
  });

  // Merge: live Vapi data wins, cached webhook values fill the gaps.
  const merged = {
    id: vapiCallId,
    caller: (call && call.caller) || cached.caller || null,
    durationSec: (call && call.durationSec != null) ? call.durationSec : (cached.duration_sec != null ? cached.duration_sec : null),
    endedReason: (call && call.endedReason) || cached.ended_reason || 'unknown',
    cost: (call && call.cost != null) ? call.cost : null,
    summary: (call && call.summary) || cached.summary || null,
    transcript: (call && call.transcript) || null,
    successEvaluation: call ? call.successEvaluation : null,
    hasRecording: call ? call.hasRecording : !!cached.recording_url,
    startedAt: call ? call.startedAt : null
  };
  merged.duration = vapiSvc.formatDuration(merged.durationSec);

  const digits = String(merged.caller || '').replace(/\D/g, '').slice(-10);
  const cust = digits.length === 10
    ? db.prepare("SELECT first_name, last_name FROM customers WHERE replace(replace(replace(replace(phone,'-',''),' ',''),'(',''),')','') LIKE ? LIMIT 1").get('%' + digits)
    : null;
  const customerName = cust ? ((cust.first_name || '') + ' ' + (cust.last_name || '')).trim() : '';

  let when = '';
  const stamp = merged.startedAt || (row ? new Date(String(row.created_at).replace(' ', 'T') + 'Z') : null);
  if (stamp) { try { when = stamp.toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }) + ' CT'; } catch { when = String(stamp); } }

  res.render('admin/call-detail', {
    title: 'Call ' + (merged.caller || vapiCallId) + ' - Admin',
    user: req.user, settings, page: 'calls',
    vapiCallId, call: merged, vapiError, customerName, when, notFound: false
  });
});

// Recording proxy — Vapi's stored recording URL points at a private bucket and 400s.
// Redirect to a freshly minted presigned URL (they expire ~30 min after minting, so this
// must be resolved per click and can never be baked into a Slack card).
router.get('/calls/:id/recording', async (req, res) => {
  try {
    const url = await vapiSvc.getRecordingUrl(req.params.id);
    if (!url) return res.status(404).send('No recording available for this call.');
    res.redirect(302, url);
  } catch (e) {
    console.error('[ADMIN CALLS] recording lookup failed for', req.params.id, '-', e.message);
    res.status(502).send('Could not fetch the recording from Vapi: ' + e.message);
  }
});

// SMS chat — threads grouped by number
router.get('/messages', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const msgs = db.prepare("SELECT * FROM communications WHERE type='sms' ORDER BY sent_at ASC").all();
  const customers = db.prepare("SELECT first_name, last_name, phone FROM customers WHERE phone IS NOT NULL AND phone != ''").all();
  const nameByDigits = {};
  customers.forEach(c => { const d = String(c.phone).replace(/\D/g, '').slice(-10); if (d.length === 10) nameByDigits[d] = ((c.first_name || '') + ' ' + (c.last_name || '')).trim(); });
  const fmtCT = (t) => { try { return new Date(String(t).replace(' ', 'T') + 'Z').toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT'; } catch { return t; } };
  const tmap = {};
  msgs.forEach(m => {
    const num = m.recipient || 'unknown';
    if (!tmap[num]) tmap[num] = { number: num, name: nameByDigits[num.replace(/\D/g, '').slice(-10)] || '', messages: [], last: m.sent_at };
    tmap[num].messages.push({ direction: m.direction, body: m.body, when: fmtCT(m.sent_at) });
    tmap[num].last = m.sent_at;
  });
  const threads = Object.values(tmap).sort((a, b) => String(b.last || '').localeCompare(String(a.last || '')));
  const fmtPhone = (n) => { const d = String(n || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : (n || ''); };
  threads.forEach(t => { t.display = fmtPhone(t.number); });
  const active = req.query.to || (threads[0] && threads[0].number) || '';
  const activeThread = threads.find(t => t.number === active) || null;
  if (activeThread) activeThread.display = fmtPhone(activeThread.number);
  const sarahSms = require('../services/sarah-sms');
  res.render('admin/messages', { title: 'Messages - Admin', user: req.user, settings, threads, activeThread, active, explicitSelection: !!req.query.to, page: 'messages', sarahEnabled: sarahSms.isEnabled(), threadPaused: activeThread ? sarahSms.isThreadPaused(activeThread.number) : false });
});

router.post('/messages/send', async (req, res) => {
  const { to, body } = req.body;
  if (!to || !body) return res.redirect('/admin/messages');
  try { await require('../services/sms').sendSms(to, body); } catch (e) { console.error('[MSG SEND] failed:', e.message); }
  try { require('../services/sarah-sms').pauseThread(to); } catch (e) { /* */ }
  res.redirect('/admin/messages?to=' + encodeURIComponent(to));
});

router.post('/sarah-sms/toggle', (req, res) => {
  const sarahSms = require('../services/sarah-sms');
  sarahSms.setEnabled(!sarahSms.isEnabled());
  res.redirect(req.get('referer') || '/admin/messages');
});

router.post('/messages/pause', (req, res) => {
  try { require('../services/sarah-sms').pauseThread(req.body.to); } catch (e) { /* */ }
  res.redirect('/admin/messages?to=' + encodeURIComponent(req.body.to || ''));
});

router.post('/messages/resume', (req, res) => {
  try { require('../services/sarah-sms').resumeThread(req.body.to); } catch (e) { /* */ }
  res.redirect('/admin/messages?to=' + encodeURIComponent(req.body.to || ''));
});

router.post('/messages/delete', (req, res) => {
  try { getDb().prepare("DELETE FROM communications WHERE type='sms' AND recipient = ?").run(req.body.to); } catch (e) { console.error('[MSG DELETE]', e.message); }
  res.redirect('/admin/messages');
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

// ==================== WALK-UP EVENTS ====================

// List all events
router.get('/events', requireAuth, (req, res) => {
  const db = getDb();
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
  const events = db.prepare(`SELECT e.*,
    (SELECT COUNT(*) FROM walk_up_registrations r WHERE r.event_id = e.id AND r.payment_status = 'completed') as reg_count,
    (SELECT COALESCE(SUM(r.kid_count), 0) FROM walk_up_registrations r WHERE r.event_id = e.id AND r.payment_status = 'completed') as total_kids,
    (SELECT COALESCE(SUM(r.amount_paid), 0) FROM walk_up_registrations r WHERE r.event_id = e.id AND r.payment_status = 'completed') as total_revenue
    FROM walk_up_events e ORDER BY e.event_date DESC`).all();

  res.render('admin/events', { title: 'Walk-Up Events', settings, events, page: 'events', user: req.user });
});

// Create event
router.post('/events', requireAuth, (req, res) => {
  const { name, event_date, location, price_per_kid } = req.body;
  const db = getDb();
  db.prepare('INSERT INTO walk_up_events (id, name, event_date, location, price_per_kid, active) VALUES (?, ?, ?, ?, ?, 1)')
    .run(uuid(), name, event_date, location || '', parseFloat(price_per_kid || 15));
  res.redirect('/admin/events');
});

// Edit event (name, date, location, price)
router.post('/events/:id/edit', requireAuth, (req, res) => {
  const { name, event_date, location, price_per_kid } = req.body;
  const db = getDb();
  db.prepare('UPDATE walk_up_events SET name = ?, event_date = ?, location = ?, price_per_kid = ? WHERE id = ?')
    .run(name, event_date, location || '', parseFloat(price_per_kid || 0), req.params.id);
  res.redirect('/admin/events');
});

// Toggle event active/inactive
router.post('/events/:id/toggle', requireAuth, (req, res) => {
  const db = getDb();
  const event = db.prepare('SELECT active FROM walk_up_events WHERE id = ?').get(req.params.id);
  if (event) {
    db.prepare('UPDATE walk_up_events SET active = ? WHERE id = ?').run(event.active ? 0 : 1, req.params.id);
  }
  res.redirect('/admin/events');
});

// Delete event
router.post('/events/:id/delete', requireAuth, (req, res) => {
  const db = getDb();
  const regCount = db.prepare('SELECT COUNT(*) as cnt FROM walk_up_registrations WHERE event_id = ?').get(req.params.id);
  if (regCount.cnt > 0) {
    return res.redirect('/admin/events?error=has_registrations');
  }
  db.prepare('DELETE FROM walk_up_events WHERE id = ?').run(req.params.id);
  res.redirect('/admin/events');
});

// Delete selected registrations
router.post('/events/:id/registrations/delete', requireAuth, (req, res) => {
  const db = getDb();
  const ids = [].concat(req.body.ids || []);
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare('DELETE FROM walk_up_registrations WHERE id IN (' + placeholders + ') AND event_id = ?').run(...ids, req.params.id);
  }
  res.redirect('/admin/events/' + req.params.id);
});

// Event detail with registrations
router.get('/events/:id', requireAuth, (req, res) => {
  const db = getDb();
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
  const event = db.prepare('SELECT * FROM walk_up_events WHERE id = ?').get(req.params.id);
  if (!event) return res.redirect('/admin/events');

  const registrations = db.prepare(`SELECT * FROM walk_up_registrations
    WHERE event_id = ? ORDER BY created_at DESC`).all(req.params.id);

  const stats = db.prepare(`SELECT
    COUNT(*) as registrations,
    COALESCE(SUM(kid_count), 0) as kids,
    COALESCE(SUM(amount_paid), 0) as revenue
    FROM walk_up_registrations
    WHERE event_id = ? AND payment_status = 'completed'`).get(req.params.id);

  res.render('admin/event-detail', { title: event.name, settings, event, registrations, stats, page: 'events', user: req.user });
});


// ==================== AD MANAGEMENT ====================

/**
 * Which bookings each channel produced, over the last N days.
 *
 * This is the number that decides whether either platform keeps its budget. It reads
 * `bookings.source`, written on every booking path since 2026-08-03 by
 * middleware/attribution.js. Rows created before that carry 'unknown_pre_tracking' and
 * are reported separately rather than being folded into a channel they'd flatter.
 */
function bookingsBySource(db, since) {
  return db.prepare(`
    SELECT ifnull(nullif(source, ''), 'unset') AS src,
           COUNT(*)                 AS bookings,
           ROUND(SUM(total), 2)     AS revenue
    FROM bookings
    WHERE date(created_at) >= ?
      AND status != 'cancelled'
    GROUP BY src
    ORDER BY revenue DESC, bookings DESC
  `).all(since);
}

/** Cutoff before which no booking has real attribution — see the migration. */
const ATTRIBUTION_START = '2026-08-03';

/**
 * Resolve a requested lookback into the window we can honestly report on.
 *
 * Spend and bookings MUST cover the same days. Asking for 30 days a week after
 * tracking went live would otherwise put 30 days of spend against 3 days of
 * attributed bookings and make every channel look worthless. Clamp to the day
 * attribution started and say so.
 */
function attributionWindow(days) {
  const until = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  const requested = fmt(new Date(until.getTime() - days * 86400000));
  const since = requested < ATTRIBUTION_START ? ATTRIBUTION_START : requested;
  return { since, until: fmt(until), requested, clamped: since !== requested, days };
}

// GET /admin/ads — Main ad dashboard
router.get('/ads', requireAdmin, (req, res) => {
  const db = getDb();
  const settings = getSettings();

  const campaigns = db.prepare('SELECT * FROM ad_campaigns ORDER BY created_at DESC').all();
  const rules = db.prepare('SELECT * FROM ad_rules ORDER BY created_at ASC').all();

  // ad_performance is only populated by the internal sync, which has never run — using
  // it for the headline numbers showed $0.00 / 0 bookings on a page whose whole job is
  // reporting spend. Live spend comes from the platforms via /api/ads/attribution;
  // the booking side is local and renders immediately.
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
  const win = attributionWindow(days);
  const sources = bookingsBySource(db, win.since);
  const paid = sources.filter(r => r.src === 'google_cpc' || r.src === 'facebook_cpc');

  res.render('admin/ads-dashboard', {
    title: 'Ad Management',
    settings,
    campaigns,
    rules,
    days,
    win,
    sources,
    attributionStart: ATTRIBUTION_START,
    stats: {
      totalBookings: sources.reduce((a, r) => a + r.bookings, 0),
      totalRevenue: sources.reduce((a, r) => a + (r.revenue || 0), 0).toFixed(2),
      paidBookings: paid.reduce((a, r) => a + r.bookings, 0),
      paidRevenue: paid.reduce((a, r) => a + (r.revenue || 0), 0).toFixed(2),
    },
    page: 'ads',
    user: req.user
  });
});

/**
 * GET /admin/api/ads/attribution?days=30
 * Joins live platform spend to locally attributed bookings. Loaded asynchronously by
 * the dashboard so a slow or broken ads API never blocks the page.
 */
router.get('/api/ads/attribution', requireAdmin, async (req, res) => {
  const db = getDb();
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
  const win = attributionWindow(days);

  const sources = bookingsBySource(db, win.since);
  const bySrc = Object.fromEntries(sources.map(r => [r.src, r]));

  // Fire both platforms in parallel; either one failing must not lose the other.
  const [google, facebook] = await Promise.all([
    googleAds.getAccountSpend(win.since, win.until).catch(e => ({ error: e.message })),
    facebookAds.getAccountSpend(win.since, win.until).catch(e => ({ error: e.message })),
  ]);

  const channel = (label, src, live) => {
    const b = bySrc[src] || { bookings: 0, revenue: 0 };
    const spend = live && !live.error ? live.spend : null;
    return {
      channel: label,
      source: src,
      spend: spend === null ? null : Number(spend.toFixed(2)),
      clicks: live && !live.error ? live.clicks : null,
      impressions: live && !live.error ? live.impressions : null,
      bookings: b.bookings,
      revenue: Number((b.revenue || 0).toFixed(2)),
      // Null, not zero: "we spent money and got nothing" and "we know nothing" are
      // different answers and must not render the same.
      costPerBooking: spend !== null && b.bookings > 0 ? Number((spend / b.bookings).toFixed(2)) : null,
      roas: spend ? Number(((b.revenue || 0) / spend).toFixed(2)) : null,
      error: (live && live.error) || null,
    };
  };

  res.json({
    days,
    since: win.since,
    until: win.until,
    requestedSince: win.requested,
    clamped: win.clamped,
    attributionStart: ATTRIBUTION_START,
    channels: [
      channel('Google Ads', 'google_cpc', google),
      channel('Meta Ads', 'facebook_cpc', facebook),
    ],
    sources,
  });
});

// GET /admin/ads/google
router.get('/ads/google', requireAdmin, (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const campaigns = db.prepare("SELECT * FROM ad_campaigns WHERE platform = 'google' ORDER BY created_at DESC").all();
  const config = Object.fromEntries(
    db.prepare("SELECT key, value FROM ad_config WHERE platform = 'google'").all().map(r => [r.key, r.value])
  );
  res.render('admin/ads-google', { title: 'Google Ads Manager', settings, campaigns, config, page: 'ads', user: req.user });
});

// GET /admin/ads/facebook
router.get('/ads/facebook', requireAdmin, (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const campaigns = db.prepare("SELECT * FROM ad_campaigns WHERE platform = 'facebook' ORDER BY created_at DESC").all();
  const config = Object.fromEntries(
    db.prepare("SELECT key, value FROM ad_config WHERE platform = 'facebook'").all().map(r => [r.key, r.value])
  );
  res.render('admin/ads-facebook', { title: 'Facebook Ads Manager', settings, campaigns, config, page: 'ads', user: req.user });
});

// GET /admin/ads/rules
router.get('/ads/rules', requireAdmin, (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const rules = db.prepare('SELECT * FROM ad_rules ORDER BY created_at ASC').all();
  res.render('admin/ads-rules', { title: 'Ad Rules', settings, rules, page: 'ads', user: req.user });
});

// GET /admin/ads/reports
router.get('/ads/reports', requireAdmin, (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const { from, to, platform } = req.query;
  const where = [];
  const params = [];
  if (from) { where.push('p.date >= ?'); params.push(from); }
  if (to) { where.push('p.date <= ?'); params.push(to); }
  if (platform && platform !== 'all') { where.push('c.platform = ?'); params.push(platform); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT p.*, c.name as campaign_name, c.platform
    FROM ad_performance p
    LEFT JOIN ad_campaigns c ON c.id = p.campaign_id
    ${whereSql}
    ORDER BY p.date DESC LIMIT 200
  `).all(...params);
  res.render('admin/ads-reports', { title: 'Ad Reports', settings, rows, page: 'ads', user: req.user, filter: { from: from || '', to: to || '', platform: platform || 'all' } });
});

// --- JSON API ---

// GET /admin/api/ads/dashboard
router.get('/api/ads/dashboard', requireAdmin, (req, res) => {
  const db = getDb();
  const campaigns = db.prepare('SELECT * FROM ad_campaigns ORDER BY created_at DESC').all();
  const perf = db.prepare('SELECT COALESCE(SUM(spend),0) as spend, COALESCE(SUM(conversions),0) as conversions, COALESCE(SUM(clicks),0) as clicks, COALESCE(SUM(impressions),0) as impressions FROM ad_performance').get();
  res.json({ campaigns, stats: perf });
});

// GET /admin/api/ads/campaigns
router.get('/api/ads/campaigns', requireAdmin, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM ad_campaigns ORDER BY created_at DESC').all());
});

// POST /admin/api/ads/campaigns
router.post('/api/ads/campaigns', requireAdmin, (req, res) => {
  const db = getDb();
  const id = uuid();
  const { platform, name, daily_budget, target_keywords, target_audience, start_date, end_date } = req.body;
  if (!platform || !name) return res.status(400).json({ error: 'platform and name required' });
  db.prepare(`INSERT INTO ad_campaigns (id, platform, name, daily_budget, target_keywords, target_audience, start_date, end_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'paused')`)
    .run(id, platform, name, parseFloat(daily_budget || 5), target_keywords || null, target_audience || null, start_date || null, end_date || null);
  res.json({ success: true, id });
});

// PATCH /admin/api/ads/campaigns/:id
router.patch('/api/ads/campaigns/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const { name, status, daily_budget, target_keywords, target_audience, start_date, end_date } = req.body;
  db.prepare(`UPDATE ad_campaigns SET name=COALESCE(?,name), status=COALESCE(?,status), daily_budget=COALESCE(?,daily_budget),
    target_keywords=COALESCE(?,target_keywords), target_audience=COALESCE(?,target_audience),
    start_date=COALESCE(?,start_date), end_date=COALESCE(?,end_date), updated_at=datetime('now')
    WHERE id=?`)
    .run(name||null, status||null, daily_budget ? parseFloat(daily_budget) : null,
      target_keywords||null, target_audience||null, start_date||null, end_date||null, req.params.id);
  res.json({ success: true });
});

// DELETE /admin/api/ads/campaigns/:id
router.delete('/api/ads/campaigns/:id', requireAdmin, (req, res) => {
  getDb().prepare('DELETE FROM ad_campaigns WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// GET /admin/api/ads/performance
router.get('/api/ads/performance', requireAdmin, (req, res) => {
  const db = getDb();
  const { campaign_id, from, to } = req.query;
  let q = 'SELECT p.*, c.name as campaign_name, c.platform FROM ad_performance p LEFT JOIN ad_campaigns c ON c.id = p.campaign_id WHERE 1=1';
  const params = [];
  if (campaign_id) { q += ' AND p.campaign_id = ?'; params.push(campaign_id); }
  if (from) { q += ' AND p.date >= ?'; params.push(from); }
  if (to) { q += ' AND p.date <= ?'; params.push(to); }
  q += ' ORDER BY p.date DESC LIMIT 500';
  res.json(db.prepare(q).all(...params));
});

// PATCH /admin/api/ads/rules/:id — toggle enabled
router.patch('/api/ads/rules/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const rule = db.prepare('SELECT id, enabled FROM ad_rules WHERE id = ?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  const newEnabled = req.body.enabled !== undefined ? (req.body.enabled ? 1 : 0) : (rule.enabled ? 0 : 1);
  db.prepare('UPDATE ad_rules SET enabled = ? WHERE id = ?').run(newEnabled, req.params.id);
  res.json({ success: true, enabled: newEnabled });
});


// ── Google OAuth ─────────────────────────────────────────────────────────────

// GET /admin/ads/google/connect — start OAuth flow
router.get('/ads/google/connect', requireAdmin, (req, res) => {
  try {
    const url = googleAds.getAuthUrl();
    res.redirect(url);
  } catch (e) {
    console.error('[GOOGLE ADS] getAuthUrl error:', e.message);
    res.redirect('/admin/ads/google?error=' + encodeURIComponent(e.message));
  }
});


// ── Google API routes ─────────────────────────────────────────────────────────

// GET /admin/api/ads/google/status
router.get('/api/ads/google/status', requireAdmin, async (req, res) => {
  try {
    const connected = googleAds.isConnected();
    res.json({ connected });
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

// GET /admin/api/ads/google/campaigns
router.get('/api/ads/google/campaigns', requireAdmin, async (req, res) => {
  try {
    if (!googleAds.isConnected()) return res.json({ campaigns: [], connected: false });
    const campaigns = await googleAds.getCampaigns();
    res.json({ campaigns, connected: true });
  } catch (e) {
    console.error('[GOOGLE ADS] getCampaigns error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// POST /admin/api/ads/google/campaigns
router.post('/api/ads/google/campaigns', requireAdmin, async (req, res) => {
  try {
    const result = await googleAds.createCampaign(req.body);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PATCH /admin/api/ads/google/campaigns/:id
router.patch('/api/ads/google/campaigns/:id', requireAdmin, async (req, res) => {
  try {
    const { status, budget } = req.body;
    const results = {};
    if (status) results.status = await googleAds.updateCampaignStatus(req.params.id, status);
    if (budget) results.budget = await googleAds.updateCampaignBudget(req.params.id, budget);
    res.json({ success: true, results });
  } catch (e) {
    console.error('[GOOGLE ADS] update campaign error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── Facebook API routes ───────────────────────────────────────────────────────

// GET /admin/api/ads/facebook/status
router.get('/api/ads/facebook/status', requireAdmin, async (req, res) => {
  try {
    const [connected, tokenInfo] = await Promise.all([facebookAds.isConnected(), facebookAds.getTokenInfo()]);
    res.json({ connected, token_info: tokenInfo });
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

// GET /admin/api/ads/facebook/campaigns
router.get('/api/ads/facebook/campaigns', requireAdmin, async (req, res) => {
  try {
    const campaigns = await facebookAds.getCampaigns();
    res.json({ campaigns, connected: true });
  } catch (e) {
    console.error('[FB ADS] getCampaigns error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// POST /admin/api/ads/facebook/campaigns
router.post('/api/ads/facebook/campaigns', requireAdmin, async (req, res) => {
  try {
    const result = await facebookAds.createCampaign(req.body);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[FB ADS] createCampaign error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// PATCH /admin/api/ads/facebook/campaigns/:id
router.patch('/api/ads/facebook/campaigns/:id', requireAdmin, async (req, res) => {
  try {
    const { status, budget } = req.body;
    const results = {};
    if (status) results.status = await facebookAds.updateCampaignStatus(req.params.id, status);
    if (budget) results.budget = await facebookAds.updateCampaignBudget(req.params.id, budget);
    res.json({ success: true, results });
  } catch (e) {
    console.error('[FB ADS] update campaign error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// POST /admin/api/ads/facebook/pixel/event
router.post('/api/ads/facebook/pixel/event', requireAdmin, async (req, res) => {
  try {
    const { event_name, event_data, user_data } = req.body;
    if (!event_name) return res.status(400).json({ error: 'event_name required' });
    const result = await facebookAds.sendPixelEvent(event_name, event_data || {}, user_data || {});
    res.json({ success: true, result });
  } catch (e) {
    console.error('[FB PIXEL] manual event error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ─── Expenses ────────────────────────────────────────────────────────────────

router.get('/expenses', (req, res) => {
  const db = getDb();
  const settings = getSettings();
  const { category, year } = req.query;

  let query = 'SELECT * FROM expenses';
  const params = [];
  const conditions = [];

  if (category) { conditions.push('category = ?'); params.push(category); }
  if (year) { conditions.push("strftime('%Y', date) = ?"); params.push(year); }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY date DESC';

  const expenses = db.prepare(query).all(...params);

  const totals = db.prepare(`
    SELECT category, SUM(amount) as total FROM expenses GROUP BY category ORDER BY total DESC
  `).all();

  const grandTotal = db.prepare('SELECT COALESCE(SUM(amount),0) as t FROM expenses').get().t;

  const thisMonthStart = dayjs().startOf('month').format('YYYY-MM-DD');
  const monthTotal = db.prepare(
    'SELECT COALESCE(SUM(amount),0) as t FROM expenses WHERE date >= ?'
  ).get(thisMonthStart).t;

  const years = db.prepare(
    "SELECT DISTINCT strftime('%Y', date) as y FROM expenses ORDER BY y DESC"
  ).all().map(r => r.y);

  const totalRevenue = db.prepare("SELECT COALESCE(SUM(total), 0) as r FROM bookings WHERE status NOT IN ('cancelled', 'declined')").get().r;

  // Reimbursement tracking: owner-paid business costs awaiting / done reimbursement from the BounceMan account
  const reimburseOwed = db.prepare('SELECT COALESCE(SUM(amount),0) as t FROM expenses WHERE reimbursable = 1 AND reimbursed = 0').get().t;
  const reimburseDone = db.prepare('SELECT COALESCE(SUM(amount),0) as t FROM expenses WHERE reimbursable = 1 AND reimbursed = 1').get().t;

  res.render('admin/expenses', { title: 'Expenses - Admin', user: req.user, settings, expenses, totals, grandTotal, monthTotal, totalRevenue, years, reimburseOwed, reimburseDone, filter: { category, year }, page: 'expenses' });
});

// Toggle whether a reimbursable expense has been reimbursed
router.post('/expenses/:id/reimburse', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT reimbursed FROM expenses WHERE id = ?').get(req.params.id);
  if (row) {
    const now = row.reimbursed ? 0 : 1;
    db.prepare('UPDATE expenses SET reimbursable = 1, reimbursed = ?, reimbursed_date = ? WHERE id = ?')
      .run(now, now ? dayjs().format('YYYY-MM-DD') : null, req.params.id);
  }
  res.redirect('/admin/expenses');
});

router.post('/expenses', (req, res) => {
  const db = getDb();
  const { date, category, vendor, description, amount, payment_method, notes } = req.body;
  if (!date || !category || !description || !amount) return res.redirect('/admin/expenses?error=missing');
  db.prepare(`INSERT INTO expenses (id, date, category, vendor, description, amount, payment_method, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(uuid(), date, category, vendor || null, description, parseFloat(amount), payment_method || 'card', notes || null);
  res.redirect('/admin/expenses');
});

router.post('/expenses/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
  res.redirect('/admin/expenses');
});

router.post('/expenses/:id/edit', (req, res) => {
  const db = getDb();
  const { date, category, vendor, description, amount, payment_method, notes } = req.body;
  db.prepare('UPDATE expenses SET date=?, category=?, vendor=?, description=?, amount=?, payment_method=?, notes=? WHERE id=?')
    .run(date, category, vendor || null, description, parseFloat(amount), payment_method || 'card', notes || null, req.params.id);
  res.redirect('/admin/expenses');
});

// === BANKS (Plaid) ===
router.get('/banks', (req, res) => {
  const db = getDb();
  const items = db.prepare('SELECT * FROM plaid_items ORDER BY institution_name').all();
  res.render('admin/banks', { title: 'Connected Banks - Bounce Man Admin', user: req.user, settings: getSettings(), items, page: 'banks' });
});
router.post('/banks/link-token', async (req, res) => {
  try { res.json({ link_token: await plaidSync.createLinkToken((req.user && req.user.id) || 'owner') }); }
  catch (e) { res.json({ error: e.message }); }
});
router.post('/banks/exchange', async (req, res) => {
  try { res.json(await plaidSync.exchangeAndStore(req.body.public_token)); }
  catch (e) { res.json({ error: e.message }); }
});
router.post('/banks/sync', async (req, res) => {
  try { res.json(await plaidSync.syncAll()); }
  catch (e) { res.json({ error: e.message }); }
});

module.exports = router;


// POST credit card debt update from dashboard
router.post('/settings/credit-card-debt', requireAdmin, (req, res) => {
  const db = getDb();
  const amount = parseFloat(req.body.amount || 0).toFixed(2);
  const exists = db.prepare('SELECT key FROM settings WHERE key = ?').get('credit_card_debt');
  if (exists) db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(amount, 'credit_card_debt');
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('credit_card_debt', amount);
  res.redirect('/admin');
});
