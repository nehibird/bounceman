#!/usr/bin/env node
/**
 * scripts/create-manual-booking.js
 * ---------------------------------
 * Create a back-office booking with custom terms — no deposit / pay-by-check /
 * tax-exempt / discount — using the APP'S OWN pricing helpers so the totals always
 * match the live site. Auto-creates the customer, the booking, its line items, and
 * the rental-agreement contract (so you get a waiver link), and can post the booking
 * card to Slack.
 *
 * Built so a special-case booking (church / school / phone-in) is ONE command instead
 * of hand-written SQL. Especially: an easy, safe entry point for Claude to call.
 *
 * USAGE
 *   node scripts/create-manual-booking.js '<json>'
 *   node scripts/create-manual-booking.js --file /path/to/booking.json
 *   ...add  "dry_run": true  to compute + PREVIEW the booking WITHOUT writing anything.
 *
 * JSON INPUT
 * {
 *   "customer":   { "first_name": "Kenneth", "last_name": "Ostler", "phone": "5804857508", "email": null },
 *   "event_date": "2026-07-24",              // required, YYYY-MM-DD
 *   "event_start_time": "17:30",             // HH:MM (24h)
 *   "event_end_time":   "21:30",
 *   "event_type": "church",                  // optional label
 *   "venue_type": "commercial",              // optional (default residential)
 *   "delivery":   { "address": "1101 W Grand Ave", "city": "Ponca City", "zip": "74601",
 *                   "surface_type": null, "power_available": true, "notes": null },
 *   "items": [                               // ref = equipment id OR slug
 *     { "ref": "blue-crush-water-slide",     "duration": "4hr", "wet": true },
 *     { "ref": "mini-castle-bounce-slide",   "duration": "4hr", "wet": true }
 *   ],
 *   "rental_days": 1,                        // optional (default 1)
 *   "tax_exempt": true,                      // optional
 *   "tax_exempt_cert": "EXE-12345678",       // optional permit # (recorded for verification)
 *   "discount_percent": 10,                  // optional  (OR discount_code)
 *   "discount_code": "CHRISTTHEKING10",      // optional label recorded on the booking
 *   "no_deposit": true,                      // true => $0 deposit, deposit_paid=1, full balance by check
 *   "payment_method": "check",               // optional: check / card / cash
 *   "notes": "Church booking, pay by check.",// internal_notes
 *   "status": "confirmed",                   // optional (default confirmed)
 *   "post_to_slack": true,                   // optional — post the New Booking card
 *   "dry_run": false                         // optional — compute only, no write
 * }
 */

const path = require('path');
const { v4: uuid } = require('uuid');

// --- load input -------------------------------------------------------------
function loadInput() {
  const args = process.argv.slice(2);
  if (args[0] === '--file') return JSON.parse(require('fs').readFileSync(args[1], 'utf8'));
  if (args[0]) return JSON.parse(args[0]);
  throw new Error('No input. Pass a JSON string or --file <path>. See header for shape.');
}

const money = n => '$' + (Math.round(Number(n) * 100) / 100).toFixed(2);
const req = (v, name) => { if (v === undefined || v === null || v === '') throw new Error('Missing required field: ' + name); return v; };

(async () => {
  const input = loadInput();
  const db = require('../db').getDb();
  const H = require('../lib/helpers');
  const settings = H.getSettings();

  // --- validate + resolve items ---
  req(input.event_date, 'event_date');
  if (!Array.isArray(input.items) || !input.items.length) throw new Error('items[] required');
  const days = Math.max(1, parseInt(input.rental_days) || 1);

  const lines = input.items.map(it => {
    const ref = req(it.ref, 'items[].ref');
    const eq = db.prepare('SELECT * FROM equipment WHERE id = ? OR slug = ?').get(ref, ref);
    if (!eq) throw new Error('Equipment not found: ' + ref);
    const duration = it.duration || 'daily';
    const wet = !!it.wet;
    let price;
    try { price = H.priceForBooking(db, eq, { duration, days, wet, date: input.event_date }); }
    catch (e) { price = wet ? H.getPrice(eq, duration) + H.getWetUpcharge(eq) : H.getPrice(eq, duration); }
    return { eq, duration, wet, price: Math.round(price * 100) / 100 };
  });
  const subtotal = Math.round(lines.reduce((s, l) => s + l.price, 0) * 100) / 100;

  // --- delivery fee (resolve by zip unless overridden) ---
  const d = input.delivery || {};
  let delivery_fee = (d.delivery_fee != null) ? Number(d.delivery_fee) : 0;
  if (d.delivery_fee == null && d.zip) {
    try { const zr = await H.resolveDeliveryFee(db, d.zip); if (zr && zr.fee >= 0) delivery_fee = zr.fee; } catch (e) {}
  }
  const surface_fee = Number(input.surface_fee || 0);

  // --- tax + totals (app helper) ---
  const taxExempt = !!input.tax_exempt;
  const pricing = H.calcPricing(settings, subtotal, delivery_fee, d.city || null, taxExempt, surface_fee);

  // --- discount (percent OR labeled code) ---
  let discount_amount = 0, discount_code = input.discount_code || null;
  if (input.discount_percent) discount_amount = Math.round(subtotal * (Number(input.discount_percent) / 100) * 100) / 100;
  else if (input.discount_code) {
    const c = db.prepare('SELECT * FROM discount_codes WHERE code = ? AND active = 1').get(String(input.discount_code).toUpperCase());
    if (c) discount_amount = c.type === 'percent' ? Math.round(subtotal * (c.value / 100) * 100) / 100 : Math.min(c.value, subtotal);
  }

  const total = Math.max(0, Math.round((pricing.total - discount_amount) * 100) / 100);
  const noDeposit = !!input.no_deposit;
  const depositPct = parseFloat(settings.deposit_percent || '50') / 100;
  const deposit_amount = noDeposit ? 0 : Math.floor(total * depositPct * 100) / 100;
  const deposit_paid = noDeposit ? 1 : 0;
  const balance_due = Math.round((total - deposit_amount) * 100) / 100;

  // --- preview ---
  const c = input.customer || {};
  console.log('\n──────── MANUAL BOOKING' + (input.dry_run ? ' (DRY RUN)' : '') + ' ────────');
  console.log('Customer:', c.first_name, c.last_name, '·', c.phone || '(no phone)', '·', c.email || '(no email)');
  console.log('Event:', input.event_date, (input.event_start_time || '') + '–' + (input.event_end_time || ''), '·', input.event_type || '');
  console.log('Deliver:', [d.address, d.city, 'OK', d.zip].filter(Boolean).join(', '));
  lines.forEach(l => console.log('  •', l.eq.name, `(${l.duration}${l.wet ? ', wet' : ''})`, '—', money(l.price)));
  console.log('Subtotal:', money(subtotal), '| Delivery:', money(delivery_fee), '| Surface:', money(surface_fee));
  console.log('Tax:', taxExempt ? '$0.00 (EXEMPT' + (input.tax_exempt_cert ? ' — permit ' + input.tax_exempt_cert : '') + ')' : money(pricing.taxAmount) + ` (${(pricing.taxRate * 100).toFixed(2)}%)`);
  if (discount_amount) console.log('Discount:', '-' + money(discount_amount), discount_code ? '(' + discount_code + ')' : '(' + input.discount_percent + '%)');
  console.log('TOTAL:', money(total), '| Deposit:', money(deposit_amount) + (noDeposit ? ' (deposit_paid=1, pay by ' + (input.payment_method || 'check') + ')' : ''), '| Balance:', money(balance_due));

  if (input.dry_run) { console.log('\nDRY RUN — nothing written.\n'); process.exit(0); }

  // --- dupe guard ---
  if (c.phone) {
    const dupe = db.prepare('SELECT b.booking_number FROM bookings b JOIN customers cu ON cu.id=b.customer_id WHERE cu.phone=? AND b.event_date=? LIMIT 1').get(String(c.phone), input.event_date);
    if (dupe) { console.log('\n⚠️  A booking already exists for this phone + date:', dupe.booking_number, '— aborting to avoid a duplicate.\n'); process.exit(0); }
  }

  // --- write (single transaction) ---
  const bookingId = uuid(), customerId = uuid();
  const bookingNumber = H.generateBookingNumber();
  let contractId = null;

  db.transaction(() => {
    let cust = c.email ? db.prepare('SELECT * FROM customers WHERE email = ?').get(c.email) : null;
    const cid = cust ? cust.id : customerId;
    if (!cust) {
      db.prepare(`INSERT INTO customers (id, first_name, last_name, email, phone, source) VALUES (?,?,?,?,?, 'admin')`)
        .run(customerId, req(c.first_name, 'customer.first_name'), c.last_name || '', c.email || null, c.phone || null);
    }
    if (taxExempt && input.tax_exempt_cert) {
      db.prepare('UPDATE customers SET tax_exempt_cert = ? WHERE id = ?').run(String(input.tax_exempt_cert).trim().slice(0, 100), cid);
    }

    db.prepare(`INSERT INTO bookings (
      id, booking_number, customer_id, status, event_date, event_start_time, event_end_time,
      event_type, venue_type, delivery_address, delivery_city, delivery_state, delivery_zip,
      delivery_notes, surface_type, power_available,
      subtotal, delivery_fee, surface_fee, tax_amount, tax_rate, discount_amount, discount_code,
      total, deposit_amount, deposit_paid, balance_due, damage_waiver_fee,
      payment_status, payment_method, tax_exempt_claimed, internal_notes, source
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      bookingId, bookingNumber, cid, input.status || 'confirmed', input.event_date,
      input.event_start_time || null, input.event_end_time || null,
      input.event_type || null, input.venue_type || 'residential',
      d.address || null, d.city || null, 'OK', d.zip || null, d.notes || null,
      d.surface_type || null, (d.power_available === false ? 0 : 1),
      subtotal, delivery_fee, surface_fee, taxExempt ? 0 : pricing.taxAmount, taxExempt ? 0 : pricing.taxRate,
      discount_amount, discount_code, total, deposit_amount, deposit_paid, balance_due, pricing.damageWaiverFee || 0,
      noDeposit ? 'unpaid' : 'unpaid', input.payment_method || null, taxExempt ? 1 : 0,
      input.notes || null, 'admin'
    );

    for (const l of lines) {
      db.prepare(`INSERT INTO booking_items (id, booking_id, equipment_id, item_name, item_type, quantity, unit_price, total_price, duration_type, rental_days)
        VALUES (?,?,?,?, 'equipment', 1, ?, ?, ?, ?)`).run(uuid(), bookingId, l.eq.id, l.eq.name, l.price, l.price, l.duration, days);
    }

    const template = db.prepare('SELECT * FROM contract_templates WHERE is_default = 1 AND active = 1').get();
    if (template) {
      contractId = uuid();
      const content = template.content
        .replace(/\{\{booking_number\}\}/g, bookingNumber)
        .replace(/\{\{event_date\}\}/g, input.event_date)
        .replace(/\{\{event_start_time\}\}/g, input.event_start_time || '')
        .replace(/\{\{event_end_time\}\}/g, input.event_end_time || '')
        .replace(/\{\{delivery_address\}\}/g, [d.address, d.city, 'OK', d.zip].filter(Boolean).join(', '))
        .replace(/\{\{items_list\}\}/g, lines.map(l => l.eq.name + (l.wet ? ' (wet)' : '')).join(', '))
        .replace(/\{\{total\}\}/g, total.toFixed(2))
        .replace(/\{\{deposit_amount\}\}/g, deposit_amount.toFixed(2))
        .replace(/\{\{customer_name\}\}/g, `${c.first_name || ''} ${c.last_name || ''}`.trim())
        .replace(/\{\{cancellation_hours\}\}/g, settings.cancellation_hours || '48');
      db.prepare('INSERT INTO contracts (id, booking_id, customer_id, template_id, content) VALUES (?,?,?,?,?)').run(contractId, bookingId, cid, template.id, content);
    }
  })();

  console.log('\n✅ CREATED', bookingNumber);
  console.log('   admin : https://bouncemanrentals.com/admin/bookings/' + bookingId);
  if (contractId) console.log('   waiver: https://bouncemanrentals.com/contract/' + contractId);

  // --- optional Slack card ---
  if (input.post_to_slack) {
    try {
      const { notifyNewBooking } = require('../services/notifications');
      const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(booking.customer_id);
      const items = db.prepare('SELECT * FROM booking_items WHERE booking_id = ?').all(bookingId);
      await notifyNewBooking(booking, customer, items);
      console.log('   slack : posted booking card');
    } catch (e) { console.log('   slack : FAILED —', e.message); }
  }
  console.log('');
  process.exit(0);
})().catch(e => { console.error('\n❌ ERROR:', e.message, '\n'); process.exit(1); });
