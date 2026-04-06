const { getDb } = require('../db');

function getSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function generateBookingNumber() {
  const prefix = 'BM';
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

function getPrice(eq, duration) {
  if (duration === '4hr') return eq.price_4hr || Math.round(eq.price_daily * 0.65 * 100) / 100;
  if (duration === 'overnight') return eq.price_overnight || Math.round(eq.price_daily * 1.15 * 100) / 100;
  return eq.price_daily;
}

function getBookedEquipmentIds(db, date) {
  const ids = new Set();
  if (!date) return ids;

  const booked = db.prepare(`
    SELECT DISTINCT bi.equipment_id FROM bookings b
    JOIN booking_items bi ON bi.booking_id = b.id
    WHERE b.event_date = ? AND b.status NOT IN ('cancelled', 'declined')
  `).all(date);
  booked.forEach(r => ids.add(r.equipment_id));

  const blocked = db.prepare('SELECT equipment_id FROM blocked_dates WHERE date = ? AND equipment_id IS NOT NULL').all(date);
  blocked.forEach(r => ids.add(r.equipment_id));

  return ids;
}

function getDeliveryFee(db, zip) {
  if (!zip) return { fee: 0, zone: 'No ZIP provided' };
  const zone = db.prepare("SELECT * FROM delivery_zones WHERE active = 1 AND (',' || zip_codes || ',') LIKE ?")
    .get(`%,${zip},%`);
  if (zone) return { fee: zone.delivery_fee, zone: zone.name };
  return { fee: 100, zone: 'Out of area' };
}

function calcPricing(settings, subtotal, deliveryFee) {
  const taxRate = parseFloat(settings.tax_rate || '0.085');
  const taxAmount = Math.round(subtotal * taxRate * 100) / 100;
  const damageWaiverFee = parseFloat(settings.damage_waiver_fee || '0');
  const total = subtotal + deliveryFee + taxAmount + damageWaiverFee;
  const depositPercent = parseFloat(settings.deposit_percent || '50') / 100;
  const depositAmount = Math.floor(total * depositPercent * 100) / 100;
  const balanceDue = Math.round((total - depositAmount) * 100) / 100;
  return { taxRate, taxAmount, damageWaiverFee, total, depositAmount, balanceDue };
}

function fmtDate(d) {
  try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); }
  catch (e) { return d; }
}

function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, '').slice(-10);
}

module.exports = { getSettings, generateBookingNumber, getPrice, getBookedEquipmentIds, getDeliveryFee, calcPricing, fmtDate, normalizePhone };
