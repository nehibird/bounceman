/* global AbortController */
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
  // 'daily' and 'multiday' both use price_daily as day-1 base
  return eq.price_daily;
}

function getWetUpcharge(eq) {
  const v = eq.price_wet;
  return (v !== null && v !== undefined && v !== '') ? Number(v) : 20;
}

function dowOf(dateStr) {
  if (!dateStr) return -1;
  return new Date(`${dateStr}T12:00:00`).getDay();
}

function isoOffset(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  return fmt(d);
}

function availabilityWindow(date, duration, startTime, endTime) {
  if (duration === 'overnight') return { start: '09:00', end: '23:59:59' };
  if (dowOf(date) === 0) return { start: '00:00', end: '23:59:59' };
  return { start: startTime, end: endTime };
}

function overnightExtraHoldDate(date, duration) {
  if (duration === 'overnight' && dowOf(date) === 6) return isoOffset(date, 1);
  return null;
}

function getSaturdayOvernightSpillover(db, date) {
  const ids = new Set();
  if (dowOf(date) !== 0) return ids;
  const sat = isoOffset(date, -1);
  const rows = db.prepare(`
    SELECT DISTINCT bi.equipment_id FROM bookings b
    JOIN booking_items bi ON bi.booking_id = b.id
    WHERE b.event_date = ? AND bi.duration_type = 'overnight'
      AND b.status NOT IN ('cancelled', 'declined')
  `).all(sat);
  rows.forEach(r => ids.add(r.equipment_id));
  return ids;
}

// -- Demand Pricing -----------------------------------------------------------

function demandMultiplierFor(db, date) {
  const row = db.prepare(`
    SELECT multiplier FROM demand_dates
    WHERE active = 1 AND date_start <= ? AND date_end >= ?
    ORDER BY multiplier DESC
    LIMIT 1
  `).get(date, date);
  return row ? Number(row.multiplier) : 1;
}

// -- Central Pricer ----------------------------------------------------------

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Weekday special (e.g. "Last Month of Summer"): on qualifying weekdays within a
// configured window, a single-day FULL-DAY rental is billed at the unit's HALF-DAY
// (4hr) rate. Driven by settings so it can be toggled/rescheduled without a deploy:
//   weekday_special_active = '1', weekday_special_start/end = 'YYYY-MM-DD',
//   weekday_special_days   = '1,2,3,4,5'  (JS getDay: 0=Sun..6=Sat)
function weekdaySpecialApplies(db, date) {
  if (!db || !date) return false;
  try {
    const g = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : null; };
    if (g('weekday_special_active') !== '1') return false;
    const start = g('weekday_special_start'); if (start && date < start) return false;
    const end = g('weekday_special_end'); if (end && date > end) return false;
    const daysRaw = g('weekday_special_days') || '1,2,3,4,5';
    const allowed = daysRaw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    return allowed.includes(dowOf(date));
  } catch (e) { return false; }
}

function priceForBooking(db, eq, { duration, days = 1, wet = false, date = null, ignoreSpecial = false } = {}) {
  const effectiveDuration = duration === 'multiday' ? 'daily' : duration;
  let base = getPrice(eq, effectiveDuration);

  // Weekday special: single-day full-day booking on a qualifying weekday gets the half-day rate.
  if (!ignoreSpecial && effectiveDuration === 'daily' && (days || 1) <= 1 && date && weekdaySpecialApplies(db, date)) {
    base = getPrice(eq, '4hr');
  }

  const extraDays = Math.max(0, (days || 1) - 1);

  let extraRate = 0;
  if (extraDays > 0) {
    // M-6: treat missing OR <=0 rate as "not set" — no unit should silently give free extra days
    const perUnitRaw = (eq.price_extra_day !== null && eq.price_extra_day !== undefined && eq.price_extra_day !== '')
      ? Number(eq.price_extra_day)
      : null;
    const perUnitRate = (perUnitRaw !== null && perUnitRaw > 0) ? perUnitRaw : null;

    const settingsRate = db
      ? (() => {
          const s = db.prepare("SELECT value FROM settings WHERE key = 'extra_day_price'").get();
          if (!s || s.value === null || s.value === undefined || s.value === '') return null;
          const n = Number(s.value);
          return (isNaN(n) || n <= 0) ? null : n;
        })()
      : null;

    if (perUnitRate !== null) {
      extraRate = perUnitRate;
    } else if (settingsRate !== null) {
      extraRate = settingsRate;
    } else {
      throw new Error(`priceForBooking: no extra_day_price for "${eq.name}", extraDays=${extraDays}`);
    }
  }

  const rentalBase = base + extraDays * extraRate;
  const demandMult = date ? demandMultiplierFor(db, date) : 1;
  const wetFee = wet ? getWetUpcharge(eq) : 0;

  return round2(rentalBase * demandMult + wetFee);
}

// -- Time helpers ------------------------------------------------------------

function addMinutes(timeStr, minutes) {
  const [h, m] = timeStr.split(':').map(Number);
  const totalMin = h * 60 + m + minutes;
  const clampedMin = Math.min(totalMin, 23 * 60 + 59);
  const rh = Math.floor(clampedMin / 60);
  const rm = clampedMin % 60;
  return `${String(rh).padStart(2,'0')}:${String(rm).padStart(2,'0')}`;
}

function subtractMinutes(timeStr, minutes) {
  const [h, m] = timeStr.split(':').map(Number);
  const totalMin = Math.max(0, h * 60 + m - minutes);
  const rh = Math.floor(totalMin / 60);
  const rm = totalMin % 60;
  return `${String(rh).padStart(2,'0')}:${String(rm).padStart(2,'0')}`;
}

// -- Buffer-Aware Availability -----------------------------------------------

function getBookedEquipmentIds(db, date, startTime, endTime, duration) {
  const counts = new Map();
  if (!date) return counts;

  const settings = getSettings();
  const bufferMin = Number(settings.buffer_min || 120);

  const win = availabilityWindow(date, duration, startTime, endTime);

  const activeBookings = db.prepare(`
    SELECT DISTINCT b.id, b.event_date, b.event_end_date, b.event_start_time, b.event_end_time,
           bi.equipment_id, bi.duration_type, bi.quantity
    FROM bookings b
    JOIN booking_items bi ON bi.booking_id = b.id
    WHERE b.status NOT IN ('cancelled', 'declined')
      AND (
        b.event_date = ?
        OR (b.event_end_date IS NOT NULL AND b.event_date <= ? AND b.event_end_date >= ?)
      )
      AND bi.equipment_id IS NOT NULL
  `).all(date, date, date);

  for (const row of activeBookings) {
    const existingWin = availabilityWindow(
      row.event_date, row.duration_type, row.event_start_time, row.event_end_time
    );

    const isMultiday = row.event_end_date && row.event_end_date !== row.event_date;
    const isIntermediateDay = isMultiday && row.event_date !== date && row.event_end_date !== date;

    let existStart, existEnd;
    if (isIntermediateDay) {
      existStart = '00:00';
      existEnd = '23:59:59';
    } else {
      existStart = existingWin.start;
      existEnd = existingWin.end;
    }

    const bufferedStart = subtractMinutes(existStart, bufferMin);
    const bufferedEnd = addMinutes(existEnd, bufferMin);

    if (win.start && win.end) {
      if (bufferedStart < win.end && bufferedEnd > win.start) {
        const qty = row.quantity || 1;
        counts.set(row.equipment_id, (counts.get(row.equipment_id) || 0) + qty);
      }
    } else {
      const qty = row.quantity || 1;
      counts.set(row.equipment_id, (counts.get(row.equipment_id) || 0) + qty);
    }
  }

  const blocked = db.prepare('SELECT equipment_id FROM blocked_dates WHERE date = ? AND equipment_id IS NOT NULL').all(date);
  blocked.forEach(r => counts.set(r.equipment_id, 999));

  getSaturdayOvernightSpillover(db, date).forEach(id => counts.set(id, 999));

  return counts;
}

// -- Wet->Dry Block ----------------------------------------------------------

function isBlockedByWetDryRule(db, equipmentId, requestDate, requestStart, wetOption) {
  if (wetOption) return false;

  const settings = getSettings();
  const wetdryHours = Number(settings.wetdry_hours || 48);

  const reqDt = new Date(`${requestDate}T${requestStart}:00`);
  const thresholdDt = new Date(reqDt.getTime() - wetdryHours * 60 * 60 * 1000);

  const wetBookings = db.prepare(`
    SELECT b.event_date, b.event_end_date, b.event_end_time
    FROM bookings b
    JOIN booking_items bi ON bi.booking_id = b.id
    WHERE bi.equipment_id = ?
      AND bi.wet_option = 1
      AND b.status NOT IN ('cancelled', 'declined')
  `).all(equipmentId);

  for (const wb of wetBookings) {
    const endDate = wb.event_end_date || wb.event_date;
    const endDt = new Date(`${endDate}T${wb.event_end_time}:00`);
    if (endDt >= thresholdDt && endDt <= reqDt) {
      return true;
    }
  }
  return false;
}

// -- Max Extra Days Available ------------------------------------------------

function maxExtraDaysAvailable(db, eqId, date, qty) {
  qty = qty || 1;
  const eq = db.prepare('SELECT quantity FROM equipment WHERE id = ?').get(eqId);
  const totalQty = eq ? (eq.quantity || 1) : 1;

  let extraDays = 0;
  let checkDate = isoOffset(date, 1);

  for (let i = 0; i < 30; i++) {
    const blocked = db.prepare('SELECT id FROM blocked_dates WHERE date = ? AND (equipment_id IS NULL OR equipment_id = ?)').get(checkDate, eqId);
    if (blocked) break;

    const bookedCounts = getBookedEquipmentIds(db, checkDate, '00:00', '23:59:59', 'daily');
    const bookedQty = bookedCounts.get(eqId) || 0;

    if (bookedQty + qty > totalQty) break;

    extraDays++;
    checkDate = isoOffset(checkDate, 1);
  }

  return extraDays;
}

// -- Existing unchanged helpers ----------------------------------------------

function getDeliveryFee(db, zip) {
  if (!zip) return { fee: 0, zone: 'No ZIP provided' };
  const zone = db.prepare("SELECT * FROM delivery_zones WHERE active = 1 AND (',' || zip_codes || ',') LIKE ?")
    .get(`%,${zip},%`);
  if (zone) return { fee: zone.delivery_fee, zone: zone.name };
  return { fee: -1, zone: 'Out of area' };
}

const HOME_LAT = 36.6781;
const HOME_LNG = -97.3103;

const distanceCache = new Map(); // zip -> {miles, roundTripMiles, fee, city, state}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 3959;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function getDistanceFee(zip) {
  if (distanceCache.has(zip)) return distanceCache.get(zip);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${zip}`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (data['country abbreviation'] !== 'US' || !data.places || !data.places.length) return null;
    const lat = parseFloat(data.places[0].latitude);
    const lng = parseFloat(data.places[0].longitude);
    const miles = Math.round(haversine(HOME_LAT, HOME_LNG, lat, lng));
    const roundTripMiles = miles * 2;
    // $1.50/mile, and a 1.5x trip factor because every rental is really TWO round
    // trips (drive out to drop off, then out again to pick up). 1x only covered the
    // drop-off; 1.5x recovers the bulk of that second (pickup) trip without overcharging.
    const DELIVERY_RATE_PER_MILE = 1.5;
    const DELIVERY_TRIP_FACTOR = 1.5;
    const fee = Math.round(roundTripMiles * DELIVERY_RATE_PER_MILE * DELIVERY_TRIP_FACTOR);
    const result = { miles, roundTripMiles, fee, city: data.places[0]['place name'], state: data.places[0]['state abbreviation'] };
    distanceCache.set(zip, result);
    return result;
  } catch(e) { return null; }
  finally { clearTimeout(timer); }
}

async function resolveDeliveryFee(db, zip) {
  if (!zip) return { fee: 0, zone: 'No ZIP provided' };
  const z = getDeliveryFee(db, zip);
  if (z.fee >= 0) return { fee: z.fee, zone: z.zone };
  const dist = await getDistanceFee(zip);
  if (dist) {
    // Safety net: any town within ~25 road miles (<=20 straight-line) is FREE,
    // even if its ZIP was never added to the Kay County zone list.
    if (dist.miles <= 20) return { fee: 0, zone: `Free (within ${dist.miles} mi)`, miles: dist.miles, city: dist.city, state: dist.state };
    const fee = Math.max(120, dist.fee); // $120 per-mile floor
    return { fee, zone: `Distance (${dist.miles} mi)`, miles: dist.miles, city: dist.city, state: dist.state };
  }
  return { fee: 150, zone: 'Out of area (estimate)' }; // geocode-failure default
}

const { STATE_RATE, COUNTY_RATES, CITY_RATES, CITY_TO_COUNTY } = require('./ok-tax-data');

function getTaxRate(city) {
  if (!city) return STATE_RATE + COUNTY_RATES['KAY'] + CITY_RATES['TONKAWA'];
  const key = city.toUpperCase().trim();
  const cityRate = CITY_RATES[key];
  if (cityRate !== undefined) {
    const countyName = CITY_TO_COUNTY[key];
    const countyRate = countyName ? (COUNTY_RATES[countyName] || 0) : COUNTY_RATES['KAY'];
    return STATE_RATE + countyRate + cityRate;
  }
  return STATE_RATE + COUNTY_RATES['KAY'] + CITY_RATES['TONKAWA'];
}

function calcPricing(settings, subtotal, deliveryFee, deliveryCity, taxExempt) {
  if (deliveryFee < 0) { console.warn('calcPricing: negative deliveryFee clamped to 0'); deliveryFee = 0; }
  const taxRate = taxExempt ? 0 : (deliveryCity ? getTaxRate(deliveryCity) : parseFloat(settings.tax_rate || '0.1025'));
  const taxAmount = taxExempt ? 0 : Math.round(subtotal * taxRate * 100) / 100;
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

// Number of rental days for a booking (1 for a single-day booking).
// Multi-day is inferred from event_end_date vs event_date.
function rentalDays(booking) {
  if (!booking) return 1;
  const start = booking.event_date;
  const end = booking.event_end_date;
  if (!start || !end || end === start) return 1;
  try {
    const d1 = new Date(start + 'T12:00:00');
    const d2 = new Date(end + 'T12:00:00');
    const diff = Math.round((d2 - d1) / 86400000);
    return diff >= 1 ? diff + 1 : 1;
  } catch (e) { return 1; }
}

// Human-readable rental period. Single-day → just the date. Multi-day →
// a date range plus a day count, e.g. "Friday, July 31 – Saturday, August 1, 2026 (2-Day Rental)".
// opts.style: 'long' (default, full weekday/month names) or 'short' ("Jul 31 – Aug 1, 2026 · 2 days").
function formatRentalPeriod(booking, opts = {}) {
  const style = opts.style || 'long';
  const days = rentalDays(booking);
  const start = booking && booking.event_date;
  if (!start) return '';
  if (days <= 1) return fmtDate(start);
  const end = booking.event_end_date;
  try {
    if (style === 'short') {
      const s = new Date(start + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const e = new Date(end + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      return `${s} – ${e} · ${days} days`;
    }
    const s = new Date(start + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const e = new Date(end + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    return `${s} – ${e} (${days}-Day Rental)`;
  } catch (err) {
    return fmtDate(start);
  }
}

// "09:00" -> "9:00 AM". Pass-through if already formatted or empty.
function fmtTime12(t) {
  if (!t) return '';
  const m = String(t).match(/^(\d{1,2}):?(\d{2})?/);
  if (!m) return t;
  let h = parseInt(m[1], 10);
  const min = m[2] || '00';
  if (isNaN(h)) return t;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${min} ${ampm}`;
}

function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, '').slice(-10);
}

function resolveDate(input) {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  s = s.replace(/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday),?\s+(?=\S)/, "");
  s = s.replace(/^(?:the\s+)?(\w[\w-]*)\s+of\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/i, (_, day, month) => `${month.toLowerCase()} ${day.toLowerCase()}`);
  s = s.replace(/\b20\s+(first|one)\b/, 'twenty-first');
  s = s.replace(/\b20\s+(second|two)\b/, 'twenty-second');
  s = s.replace(/\b20\s+(third|three)\b/, 'twenty-third');
  s = s.replace(/\b20\s+(fourth|four)\b/, 'twenty-fourth');
  s = s.replace(/\b20\s+(fifth|five)\b/, 'twenty-fifth');
  s = s.replace(/\b20\s+(sixth|six)\b/, 'twenty-sixth');
  s = s.replace(/\b20\s+(seventh|seven)\b/, 'twenty-seventh');
  s = s.replace(/\b20\s+(eighth|eight)\b/, 'twenty-eighth');
  s = s.replace(/\b20\s+(ninth|nine)\b/, 'twenty-ninth');
  s = s.replace(/\b30\s+(first|one)\b/, 'thirty-first');
  s = s.replace(/\btwenty\s+(first|one)\b/g, 'twenty-first');
  s = s.replace(/\btwenty\s+(second|two)\b/g, 'twenty-second');
  s = s.replace(/\btwenty\s+(third|three)\b/g, 'twenty-third');
  s = s.replace(/\btwenty\s+(fourth|four)\b/g, 'twenty-fourth');
  s = s.replace(/\btwenty\s+(fifth|five)\b/g, 'twenty-fifth');
  s = s.replace(/\btwenty\s+(sixth|six)\b/g, 'twenty-sixth');
  s = s.replace(/\btwenty\s+(seventh|seven)\b/g, 'twenty-seventh');
  s = s.replace(/\btwenty\s+(eighth|eight)\b/g, 'twenty-eighth');
  s = s.replace(/\btwenty\s+(ninth|nine)\b/g, 'twenty-ninth');
  s = s.replace(/\bthirty\s+(first|one)\b/g, 'thirty-first');
  s = s.replace(/^the\s+(\d{1,2})(?:st|nd|rd|th)?$/, '$1');

  const ordinalWords = {
    'first':1,'second':2,'third':3,'fourth':4,'fifth':5,'sixth':6,'seventh':7,'eighth':8,'ninth':9,'tenth':10,
    'eleventh':11,'twelfth':12,'thirteenth':13,'fourteenth':14,'fifteenth':15,'sixteenth':16,'seventeenth':17,
    'eighteenth':18,'nineteenth':19,'twentieth':20,'twenty-first':21,'twenty-second':22,'twenty-third':23,
    'twenty-fourth':24,'twenty-fifth':25,'twenty-sixth':26,'twenty-seventh':27,'twenty-eighth':28,
    'twenty-ninth':29,'thirtieth':30,'thirty-first':31,
    'twentyfirst':21,'twentysecond':22,'twentythird':23,'twentyfourth':24,'twentyfifth':25,
    'twentysixth':26,'twentyseventh':27,'twentyeighth':28,'twentyninth':29
  };
  const sorted = Object.entries(ordinalWords).sort((a, b) => b[0].length - a[0].length);
  for (const [word, num] of sorted) {
    if (s.includes(word)) s = s.replace(word, String(num));
  }

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  const dow = now.getDay();

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const slashMatch = s.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (slashMatch) {
    const m = parseInt(slashMatch[1]) - 1;
    const d = parseInt(slashMatch[2]);
    let y = slashMatch[3] ? parseInt(slashMatch[3]) : year;
    if (y < 100) y += 2000;
    const dt = new Date(y, m, d);
    if (dt < now && !slashMatch[3]) dt.setFullYear(y + 1);
    return fmt(dt);
  }

  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const stripped = s.replace(/^(this |next |coming )/, '');
  const dayIdx = days.indexOf(stripped);
  if (dayIdx !== -1) {
    let diff = dayIdx - dow;
    if (diff <= 0) diff += 7;
    if (s.includes('next') && diff <= 7) diff += 7;
    return fmt(new Date(year, month, day + diff));
  }

  if (s === 'tomorrow') return fmt(new Date(year, month, day + 1));
  if (s === 'today') return fmt(now);

  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const monthMatch = s.match(/^(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?/);
  if (monthMatch) {
    const mi = months.indexOf(monthMatch[1]);
    if (mi !== -1) {
      const d = parseInt(monthMatch[2]);
      const y = monthMatch[3] ? parseInt(monthMatch[3]) : year;
      const dt = new Date(y, mi, d);
      if (dt < now && !monthMatch[3]) dt.setFullYear(y + 1);
      return fmt(dt);
    }
  }

  const ordMatch = s.match(/(\d{1,2})(?:st|nd|rd|th)?$/);
  if (ordMatch) {
    const d = parseInt(ordMatch[1]);
    let dt = new Date(year, month, d);
    if (dt < now) dt = new Date(year, month + 1, d);
    return fmt(dt);
  }

  return null;
}

function fmt(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = {
  getSettings,
  generateBookingNumber,
  getPrice,
  getWetUpcharge,
  getBookedEquipmentIds,
  getDeliveryFee,
  getDistanceFee,
  resolveDeliveryFee,
  calcPricing,
  getTaxRate,
  fmtDate,
  rentalDays,
  formatRentalPeriod,
  fmtTime12,
  normalizePhone,
  resolveDate,
  dowOf,
  isoOffset,
  availabilityWindow,
  overnightExtraHoldDate,
  getSaturdayOvernightSpillover,
  priceForBooking,
  weekdaySpecialApplies,
  demandMultiplierFor,
  isBlockedByWetDryRule,
  maxExtraDaysAvailable,
  round2,
  addMinutes,
  subtractMinutes,
};
