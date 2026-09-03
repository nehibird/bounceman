/* global AbortController */
const { getDb } = require('../db');

function getSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// Aggregate rating + a few real reviews for LocalBusiness JSON-LD (rich-result
// stars). Sourced ONLY from genuine approved reviews shown on /reviews so the
// markup matches the visible page. Cached 5 min; resilient (returns count:0 on
// any failure so the schema simply omits the rating rather than breaking pages).
let _reviewStatsCache = { data: null, at: 0 };
function getReviewStats() {
  const now = Date.now();
  if (_reviewStatsCache.data && (now - _reviewStatsCache.at) < 5 * 60 * 1000) return _reviewStatsCache.data;
  const empty = { count: 0, avg: 0, samples: [] };
  try {
    const db = getDb();
    const agg = db.prepare('SELECT COUNT(*) n, AVG(rating) a FROM reviews WHERE approved = 1 AND rating > 0').get();
    const count = agg && agg.n ? agg.n : 0;
    if (!count) { _reviewStatsCache = { data: empty, at: now }; return empty; }
    const avg = Math.round(agg.a * 10) / 10;
    const samples = db.prepare('SELECT customer_name AS name, rating, comment FROM reviews WHERE approved = 1 AND comment IS NOT NULL AND length(trim(comment)) > 0 ORDER BY featured DESC, created_at DESC LIMIT 3').all();
    const data = { count, avg, samples };
    _reviewStatsCache = { data, at: now };
    return data;
  } catch (e) {
    console.error('[REVIEWS] getReviewStats failed:', e.message);
    return _reviewStatsCache.data || empty;
  }
}

function generateBookingNumber() {
  const prefix = 'BM';
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

function getPrice(eq, duration) {
  // Full-day-only units must never fall through to the 65%-of-daily half-day rate.
  // If one is somehow booked as a half day, it still bills the full day.
  if (duration === '4hr' && eq.full_day_only) return eq.price_daily;
  if (duration === '4hr') return eq.price_4hr || Math.round(eq.price_daily * 0.65 * 100) / 100;
  if (duration === 'overnight') return eq.price_overnight || Math.round(eq.price_daily * 1.15 * 100) / 100;
  // 'daily' and 'multiday' both use price_daily as day-1 base
  return eq.price_daily;
}

function getWetUpcharge(eq) {
  // Wet upcharge removed 2026-07 (conference decision): wet and dry cost the same.
  // Wet/dry stays a selectable option but is informational only — no price delta.
  return 0;
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

// Today's date in Central time as YYYY-MM-DD. The server runs UTC, so
// `new Date().toISOString().slice(0,10)` rolls over to tomorrow at 7 PM CT (6 PM during
// CDT) — which made "is this date in the past?" checks reject the caller's own event date
// for the last few hours of every evening. Always compare calendar dates in CT.
function todayCT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

// The calendar rules the website enforces, in one place so every Sarah channel gets them.
// Returns null when the booking is allowed, otherwise { error, requires_approval? } ready
// to hand back to the model.
//   date      — ISO YYYY-MM-DD
//   duration  — '4hr' | 'daily' | 'overnight'
//   startTime — 'HH:MM' (24h), used for the lead-time calculation
function validateBookingDate(db, date, { duration = 'daily', startTime = '09:00' } = {}) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: `I couldn't lock in that date — could you say it like "July fourth"?` };
  }
  if (date < todayCT()) {
    return { error: `That date has already passed — did you mean a date coming up?` };
  }
  // 1. Sundays are full-day or overnight only — never half day.
  if (dowOf(date) === 0 && duration === '4hr') {
    return { error: `On Sundays we only do full-day or overnight rentals — no half days. Want me to set it up as a full day instead?` };
  }
  // 2. No closed season. We are insured year-round and will book any month — indoor
  //    venues especially. Whether a specific winter date is workable is a weather and
  //    ground-conditions call made per booking, not a blanket four-month refusal.
  // 3. Minimum lead time: under 24h is a rush booking that needs owner approval
  const nowCT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const leadHours = (new Date(`${date}T${startTime}:00`) - nowCT) / 36e5;
  if (leadHours < 24) {
    return {
      requires_approval: true,
      error: `Since that's less than twenty-four hours away, I'll need Nehemiah to approve a rush booking. Let me grab your info and have him call you right back to lock it in.`
    };
  }
  // 4. Globally blocked dates
  try {
    const blocked = db.prepare('SELECT reason FROM blocked_dates WHERE date = ? AND equipment_id IS NULL').get(date);
    if (blocked) return { error: blocked.reason || `Sorry, that date is fully booked. Want to try another day?` };
  } catch (e) { /* table optional */ }
  return null;
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
  let mult = row ? Number(row.multiplier) : 1;
  // Recurring Independence Day surge: +20% on July 2–5 every year (across the board).
  if (date && /^\d{4}-07-0[2-5]$/.test(date)) mult = Math.max(mult, 1.2);
  return mult;
}

// Hard-surface (concrete/asphalt) or indoor setups need sandbag anchoring instead of
// stakes — 10% surcharge on the rental subtotal.
function surfaceSurcharge() {
  // Retired 2026-08-28. Concrete, asphalt and indoor setups are anchored with sandbags
  // instead of stakes, which costs time but not money, and charging 10% extra for it was
  // a needless barrier — especially for schools and churches, who are exactly the
  // customers most likely to want an indoor or paved setup.
  //
  // Kept as a function returning 0 rather than deleted: it is called from /review and
  // /submit and exported for the manual-booking script, and the surface_fee column plus
  // every display of it is guarded on > 0, so one booking that genuinely paid $35
  // (BM-MT3CX8OC-LCH) still shows correctly on its invoice and in admin.
  return 0;
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

// The ride-along rate for a unit, or null when it has none. Mirrors the price_extra_day
// treatment: missing, empty or <= 0 all mean "not set" rather than "free".
function addonRate(eq) {
  if (!eq) return null;
  const raw = eq.price_addon;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return (!isNaN(n) && n > 0) ? n : null;
}

// Decide which items in a cart are charged the ride-along rate.
//
// Rule: the single most expensive item at full price is the ANCHOR and always pays full
// price. Every other item that has a ride-along rate pays that instead. Ties break on id so
// the result is deterministic for a given cart.
//
// The anchor rule is what makes this safe. A cart can never discount its own main unit, and
// a cart holding nothing but ride-along items still pays full price for the priciest one --
// so booking cornhole by itself costs $75, which is the whole point.
function addonPricedIds(db, eqRows, opts = {}) {
  const ids = new Set();
  const priced = [];
  for (const row of (eqRows || [])) {
    // Accept either a bare equipment row (all items share `opts`) or { eq, opts } for carts
    // where each line has its own duration -- the admin booking form works that way.
    const eq = (row && row.eq) ? row.eq : row;
    if (!eq) continue;
    const rowOpts = (row && row.opts) ? row.opts : opts;
    let full = null;
    try { full = priceForBooking(db, eq, { ...rowOpts, wet: false, asAddon: false }); } catch (e) { full = null; }
    priced.push({ eq, full });
  }
  const rated = priced.filter((p) => p.full !== null && !isNaN(p.full));
  if (rated.length <= 1) return ids;
  let anchor = rated[0];
  for (const p of rated) {
    if (p.full > anchor.full || (p.full === anchor.full && String(p.eq.id) < String(anchor.eq.id))) anchor = p;
  }
  for (const p of priced) {
    if (p.eq.id === anchor.eq.id) continue;
    if (addonRate(p.eq) !== null) ids.add(p.eq.id);
  }
  return ids;
}

function priceForBooking(db, eq, { duration, days = 1, wet = false, date = null, ignoreSpecial = false, asAddon = false } = {}) {
  // Ride-along pricing is deliberately flat: no duration tier, no extra-day charge, no demand
  // multiplier. It exists to make attaching an extra frictionless, and floating a $20 item
  // with holiday demand is noise that complicates the quote without earning anything.
  if (asAddon) {
    const flat = addonRate(eq);
    if (flat !== null) return round2(flat + (wet ? getWetUpcharge(eq) : 0));
  }
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

// -- Promo: 3+ items → one extra day free ------------------------------------

// Booking any 3 or more items earns one extra rental day at no charge. Only meaningful
// on multi-day rentals (days >= 2). Returns the dollar value of ONE extra day summed
// across the non-add-on units (add-ons carry no extra-day charge). Used identically by
// the review preview and the authoritative checkout recalc so the shown price == charge.
function freeExtraDayDiscount(db, items, { days = 1, wetSet = null, date = null } = {}) {
  if (!Array.isArray(items) || items.length < 3 || (days || 1) < 2) return 0;
  let value = 0;
  for (const eqId of items) {
    const eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(eqId);
    if (!eq) continue;
    if (eq.category === 'add_ons' || eq.category === 'add-ons') continue;
    const isWet = wetSet ? wetSet.has(eqId) : false;
    try {
      const p2 = priceForBooking(db, eq, { duration: 'daily', days: 2, wet: isWet, date });
      const p1 = priceForBooking(db, eq, { duration: 'daily', days: 1, wet: isWet, date });
      value += Math.max(0, p2 - p1);
    } catch (e) { /* skip items without extra-day pricing */ }
  }
  return Math.round(value * 100) / 100;
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

// Resolve the tax jurisdiction from the delivery ZIP (authoritative USPS city via the
// same geocode used for distance), NOT the customer's free-typed city. A typo'd or
// oddly-formatted city ("Tonkawa, OK") must never silently drop us to the state+county
// fallback rate and under-collect sales tax. Falls back to the typed city (which
// getTaxRate now normalizes) only when the ZIP can't be geocoded to an OK city.
async function resolveTaxCity(zip, typedCity) {
  if (zip) {
    try {
      const dist = await getDistanceFee(zip); // cached; { city, state, ... } or null
      if (dist && dist.city && dist.state === 'OK' && getTaxRate(dist.city) != null) {
        return dist.city;
      }
    } catch (e) { /* fall through to typed city */ }
  }
  return typedCity || null;
}

const { STATE_RATE, COUNTY_RATES, CITY_RATES, CITY_TO_COUNTY } = require('./ok-tax-data');

// State + home-county floor used ONLY when a jurisdiction can't be resolved.
// (Never guess Tonkawa's CITY rate for an unknown place — that over-taxes.)
const TAX_UNRESOLVED_FALLBACK = STATE_RATE + COUNTY_RATES['KAY']; // 5.75%

// Destination combined sales-tax rate for a delivery city. County comes from the
// CITY_TO_COUNTY map; a city with no entry in CITY_RATES simply has no city tax
// (e.g. Nardin = state + county only). Returns null when the jurisdiction can't be
// resolved so the caller can decide (we never silently fall back to Tonkawa's rate).
// Normalize a free-typed city to a CITY_TO_COUNTY key: uppercase, then strip a trailing
// state suffix ("Tonkawa, OK" / "Tonkawa OK" / "Tonkawa, Oklahoma") and stray punctuation/
// whitespace, so a customer's formatting can't drop the tax lookup to the fallback rate.
function normalizeCityKey(city) {
  return String(city || '').toUpperCase().trim()
    .replace(/[.,\s]+(OK|OKLA|OKLAHOMA)$/g, '')
    .replace(/[.,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTaxRate(city) {
  if (!city) return null;
  const key = normalizeCityKey(city);
  const countyName = CITY_TO_COUNTY[key];
  if (!countyName) return null; // unknown jurisdiction — do not guess
  const countyRate = COUNTY_RATES[countyName] || 0;
  const cityRate = CITY_RATES[key] || 0; // missing city rate => no city tax
  return STATE_RATE + countyRate + cityRate;
}

// Same lookup as getTaxRate, but returns the parts. The OkTAP return has to be filed
// with the city and county broken out on form STS-20021, so the report needs the split
// and must not re-implement the city-key normalisation (a second copy would drift).
function taxBreakdown(city) {
  const key = normalizeCityKey(city);
  const countyName = CITY_TO_COUNTY[key] || null;
  if (!countyName) return null; // unknown jurisdiction — do not guess
  const countyRate = COUNTY_RATES[countyName] || 0;
  const cityRate = CITY_RATES[key] || 0; // no entry => that city levies no tax
  return {
    key, countyName, countyRate, cityRate,
    stateRate: STATE_RATE,
    total: STATE_RATE + countyRate + cityRate
  };
}

// taxableDeduction (default 0) is subtracted from the subtotal BEFORE tax is computed,
// so seller discounts (promo codes, the 3+-items free-day promo) correctly reduce the
// taxable base — Oklahoma taxes the discounted price, not the sticker price.
function calcPricing(settings, subtotal, deliveryFee, deliveryCity, taxExempt, surfaceFee = 0, taxableDeduction = 0) {
  if (deliveryFee < 0) { console.warn('calcPricing: negative deliveryFee clamped to 0'); deliveryFee = 0; }
  surfaceFee = parseFloat(surfaceFee) || 0;
  let taxRate = 0;
  if (!taxExempt) {
    const resolved = deliveryCity ? getTaxRate(deliveryCity) : null;
    if (resolved != null) {
      taxRate = resolved;
    } else {
      taxRate = TAX_UNRESOLVED_FALLBACK;
      console.warn('[TAX] Unresolved jurisdiction for city "' + (deliveryCity || '(none)') + '" — applied state+Kay fallback ' + (TAX_UNRESOLVED_FALLBACK * 100).toFixed(3) + '%. Review this booking.');
    }
  }
  const taxableBase = Math.max(0, subtotal - (parseFloat(taxableDeduction) || 0));
  const taxAmount = taxExempt ? 0 : Math.round(taxableBase * taxRate * 100) / 100;
  const damageWaiverFee = parseFloat(settings.damage_waiver_fee || '0');
  const total = subtotal + deliveryFee + surfaceFee + taxAmount + damageWaiverFee;
  // Flat $50 deposit on every booking (conference decision 2026-07). Capped at total
  // for the edge case of a sub-$50 order. Configurable via the deposit_flat setting.
  const depositFlat = parseFloat(settings.deposit_flat || '50');
  const depositAmount = Math.min(depositFlat, total);
  const balanceDue = Math.round((total - depositAmount) * 100) / 100;
  return { taxRate, taxAmount, damageWaiverFee, surfaceFee, total, depositAmount, balanceDue };
}

function fmtDate(d) {
  try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); }
  catch (e) { return d; }
}

// Memorial Day (last Monday of May) and Labor Day (first Monday of September) are
// high-demand holidays we rent FULL DAY ONLY — no half-day, multi-day, or overnight.
// dateStr is 'YYYY-MM-DD'. Keep this in sync with isFullDayOnlyHoliday() in step1-date.ejs.
function isFullDayOnlyDate(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr + 'T12:00:00');
  if (isNaN(d.getTime())) return false;
  const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
  if (m === 8) { // September — Labor Day = first Monday
    const dow1 = new Date(y, 8, 1).getDay();
    return day === 1 + ((1 - dow1 + 7) % 7);
  }
  if (m === 4) { // May — Memorial Day = last Monday
    const lastMayDay = new Date(y, 5, 0).getDate();
    const lastDow = new Date(y, 4, lastMayDay).getDay();
    return day === lastMayDay - ((lastDow - 1 + 7) % 7);
  }
  return false;
}

// The full-day rental window. Delivery is 11 AM, pickup 7 PM. Changed from 9 AM on
// 2026-08-05; it had been 9-7 since the booking flow was written on 2026-04-01.
// Half days (9-1 / 3-7) and overnights (9 AM drop, held through the night) are NOT
// derived from these and still start at 9 — change them deliberately, not by accident.
const FULL_DAY_START = '11:00';
const FULL_DAY_END = '19:00';

// --- Sunday rentals -------------------------------------------------------------
// A Sunday rental runs on a different clock: we usually deliver Saturday evening and
// collect Monday morning, because we don't run Sunday-evening pickups. The customer gets
// the overnight free, which sells well — but only if we say it. Left unsaid, "your rental
// is Sunday" reads as "dropped Sunday morning, gone Sunday night", and the customer plans
// around a window that was never real.
//
// It also rules out unsecured venues. A unit left in a public park from Sunday evening
// until Monday morning is unattended on ground we don't control — that is a theft,
// vandalism and liability problem, not a scheduling one. Backyards, indoor spaces and
// commercial lots can be secured overnight; a park cannot, so Sunday + Park is refused.
function isSundayRental(dateStr) {
  return dowOf(dateStr) === 0;
}

// Venues we will not leave a unit at overnight. Scoped deliberately to Park — the other
// options (Backyard, Indoor, Commercial) are all places a customer can lock up or watch.
function isUnsecuredVenue(venueType) {
  return /park/i.test(String(venueType || ''));
}

// True when this booking needs the Monday-morning pickup message.
function sundayPickupApplies(dateStr) {
  return isSundayRental(dateStr);
}

const SUNDAY_PICKUP_NOTE =
  'Because your rental falls on a Sunday, we usually drop off Saturday evening and pick up Monday morning — so you keep it overnight at no extra charge. Please leave it set up and plugged in overnight if you can, and keep it accessible for our Monday pickup.';

const SUNDAY_PARK_MESSAGE =
  'Sunday rentals are picked up Monday morning, which means the unit sits out overnight — so we are not able to set up at a park or other public space on Sundays. Please choose a backyard, indoor, or commercial location, or pick a Saturday instead. Questions? Call (580) 308-9288.';

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

// Store a US phone as "(555) 123-4567", or leave it alone if it isn't ten digits.
//
// This exists because the booking form's client-side formatter took the FIRST three
// digits as the area code. Someone typing their own number with the country code —
// 15806281767, or +1 580 628 1767 — was silently saved as "(158) 062-8176". It looked
// formatted, the booking completed, the deposit charged, and nobody found out until a
// delivery text bounced sixteen days later, two days before the rental.
//
// normalizePhone() already slices the LAST ten digits, so lookups were never affected —
// only the stored display string, which is what a human reads and dials.
function formatPhoneUS(phone) {
  const raw = String(phone == null ? '' : phone).trim();
  if (!raw) return raw;
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1); // +1 country code
  if (d.length !== 10) return raw;                     // extensions, intl, junk — untouched
  if (d[0] === '0' || d[0] === '1') return raw;        // no US area code starts 0 or 1
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
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
  // Compare CALENDAR DAYS, not instants. `now` carries a time-of-day, so comparing a
  // midnight Date against it made today's own date look past from 00:00 onward — a caller
  // saying today's date got rolled a full year forward. isPast() is date-only.
  const todayStr = fmt(now);
  const isPast = (dt) => fmt(dt) < todayStr;
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
    if (isPast(dt) && !slashMatch[3]) dt.setFullYear(y + 1);
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
      if (isPast(dt) && !monthMatch[3]) dt.setFullYear(y + 1);
      return fmt(dt);
    }
  }

  const ordMatch = s.match(/(\d{1,2})(?:st|nd|rd|th)?$/);
  if (ordMatch) {
    const d = parseInt(ordMatch[1]);
    let dt = new Date(year, month, d);
    if (isPast(dt)) dt = new Date(year, month + 1, d);
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

// HTML-escape untrusted text before interpolating it into admin EJS templates
// that use the `<%- include(..., { body: \`...${esc(x)}...\` }) %>` raw-include
// pattern (no auto-escaping). Prevents stored XSS from customer-supplied text
// (names, addresses, inbound SMS bodies, review comments, etc.).
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Is this number someone who has actually booked with us? Used to exempt real
// customers from the spam auto-blocker. Charlene ($325) and Alexis Evans ($624)
// were both permanently blocked from the business line for calling back about
// their own parties — five calls in 24h was enough, and nothing ever unblocked them.
function isKnownCustomer(db, phone) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return false;
  try {
    const row = db.prepare(`
      SELECT 1 FROM customers c
      WHERE replace(replace(replace(replace(COALESCE(c.phone,''),'(',''),')',''),' ',''),'-','') LIKE '%' || ?
        AND EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = c.id AND b.status NOT IN ('cancelled','declined'))
      LIMIT 1`).get(digits);
    return !!row;
  } catch (e) {
    // Fail OPEN: if we can't tell, don't block. A missed spammer costs pennies;
    // a blocked customer costs a rental and we never find out.
    console.error('[SPAM] isKnownCustomer check failed, not blocking:', e.message);
    return true;
  }
}

// ---- Discount codes ----
// Every path that honors a code (review, submit, Sarah, admin, the AJAX validator)
// goes through these so the rules can't drift apart again — they already had.

// Match with ALL whitespace stripped: "foster care", "FOSTER CARE " and "FosterCare"
// all resolve to the stored FOSTERCARE. Lookups used to be a bare .toUpperCase(),
// so a trailing space off a phone keyboard silently failed to match.
function normalizeCode(raw) {
  return String(raw || '').replace(/\s+/g, '').toUpperCase();
}

// Returns the code row, or null if it doesn't exist / is inactive / is used up.
// max_uses was previously checked ONLY by /api/validate-discount — the booking
// paths queried on `active = 1` alone, so a one-use code worked forever.
function lookupDiscount(db, raw) {
  const code = normalizeCode(raw);
  if (!code) return null;
  const row = db.prepare('SELECT * FROM discount_codes WHERE code = ? AND active = 1').get(code);
  if (!row) return null;
  if (row.max_uses && row.uses_count >= row.max_uses) return null;
  return row;
}

// type 'free' comps the ENTIRE booking — equipment, delivery, surface surcharge and
// tax. percent/fixed only ever come off the subtotal, so even a 100% code left the
// delivery fee and the hard-surface surcharge behind.
function isCompCode(code) { return !!code && code.type === 'free'; }

function discountAmountFor(code, subtotal) {
  if (!code || isCompCode(code)) return 0;   // comps are applied by the caller, not as a subtotal discount
  return code.type === 'percent'
    ? Math.round(subtotal * (code.value / 100) * 100) / 100
    : Math.min(code.value, subtotal);
}

// Burn one use, atomically. The conditional UPDATE is what stops two simultaneous
// submissions from both redeeming a single-use code. Returns true if this caller got it.
function redeemDiscount(db, codeId) {
  return db.prepare(
    'UPDATE discount_codes SET uses_count = uses_count + 1 WHERE id = ? AND (max_uses IS NULL OR uses_count < max_uses)'
  ).run(codeId).changes === 1;
}

module.exports = {
  isKnownCustomer,
  normalizeCode,
  lookupDiscount,
  isCompCode,
  discountAmountFor,
  redeemDiscount,
  getSettings,
  getReviewStats,
  generateBookingNumber,
  getPrice,
  getWetUpcharge,
  getBookedEquipmentIds,
  getDeliveryFee,
  getDistanceFee,
  resolveDeliveryFee,
  resolveTaxCity,
  calcPricing,
  getTaxRate,
  taxBreakdown,
  STATE_RATE,
  fmtDate,
  rentalDays,
  formatRentalPeriod,
  fmtTime12,
  normalizePhone,
  formatPhoneUS,
  resolveDate,
  dowOf,
  isoOffset,
  todayCT,
  validateBookingDate,
  availabilityWindow,
  overnightExtraHoldDate,
  getSaturdayOvernightSpillover,
  priceForBooking,
  addonRate,
  addonPricedIds,
  weekdaySpecialApplies,
  isFullDayOnlyDate,
  FULL_DAY_START,
  FULL_DAY_END,
  isSundayRental,
  isUnsecuredVenue,
  sundayPickupApplies,
  SUNDAY_PICKUP_NOTE,
  SUNDAY_PARK_MESSAGE,
  demandMultiplierFor,
  isBlockedByWetDryRule,
  maxExtraDaysAvailable,
  freeExtraDayDiscount,
  surfaceSurcharge,
  round2,
  addMinutes,
  subtractMinutes,
  esc,
};
