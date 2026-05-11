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

function getBookedEquipmentIds(db, date, startTime, endTime) {
  const counts = new Map();
  if (!date) return counts;

  let booked;
  if (startTime && endTime) {
    booked = db.prepare(`
      SELECT bi.equipment_id, COUNT(*) as cnt FROM bookings b
      JOIN booking_items bi ON bi.booking_id = b.id
      WHERE b.event_date = ? AND b.status NOT IN ('cancelled', 'declined')
        AND b.event_start_time < ? AND b.event_end_time > ?
      GROUP BY bi.equipment_id
    `).all(date, endTime, startTime);
  } else {
    booked = db.prepare(`
      SELECT bi.equipment_id, COUNT(*) as cnt FROM bookings b
      JOIN booking_items bi ON bi.booking_id = b.id
      WHERE b.event_date = ? AND b.status NOT IN ('cancelled', 'declined')
      GROUP BY bi.equipment_id
    `).all(date);
  }
  booked.forEach(r => counts.set(r.equipment_id, (counts.get(r.equipment_id) || 0) + r.cnt));

  const blocked = db.prepare('SELECT equipment_id FROM blocked_dates WHERE date = ? AND equipment_id IS NOT NULL').all(date);
  blocked.forEach(r => counts.set(r.equipment_id, 999));

  return counts;
}

function getDeliveryFee(db, zip) {
  if (!zip) return { fee: 0, zone: 'No ZIP provided' };
  const zone = db.prepare("SELECT * FROM delivery_zones WHERE active = 1 AND (',' || zip_codes || ',') LIKE ?")
    .get(`%,${zip},%`);
  if (zone) return { fee: zone.delivery_fee, zone: zone.name };
  return { fee: -1, zone: 'Out of area' };
}

// Tonkawa, OK coordinates
const HOME_LAT = 36.6781;
const HOME_LNG = -97.3103;

function haversine(lat1, lon1, lat2, lon2) {
  const R = 3959; // miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function getDistanceFee(zip) {
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${zip}`);
    if (!res.ok) return null;
    const data = await res.json();
    const lat = parseFloat(data.places[0].latitude);
    const lng = parseFloat(data.places[0].longitude);
    const miles = Math.round(haversine(HOME_LAT, HOME_LNG, lat, lng));
    const roundTripMiles = miles * 2;
    const fee = Math.round(roundTripMiles * 1.5);
    return { miles, roundTripMiles, fee, city: data.places[0]['place name'], state: data.places[0]['state abbreviation'] };
  } catch(e) { return null; }
}

// Oklahoma sales tax lookup
// Source: Oklahoma Tax Commission "Rates and Codes" Q1 2026
// Total = State (4.5%) + County + City
const { STATE_RATE, COUNTY_RATES, CITY_RATES, CITY_TO_COUNTY } = require('./ok-tax-data');

function getTaxRate(city) {
  if (!city) return STATE_RATE + COUNTY_RATES['KAY'] + CITY_RATES['TONKAWA']; // default to home base
  const key = city.toUpperCase().trim();

  const cityRate = CITY_RATES[key];
  if (cityRate !== undefined) {
    const countyName = CITY_TO_COUNTY[key];
    const countyRate = countyName ? (COUNTY_RATES[countyName] || 0) : COUNTY_RATES['KAY'];
    return STATE_RATE + countyRate + cityRate;
  }

  // City not in table — fall back to Tonkawa rate
  return STATE_RATE + COUNTY_RATES['KAY'] + CITY_RATES['TONKAWA'];
}

function calcPricing(settings, subtotal, deliveryFee, deliveryCity, taxExempt) {
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

function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, '').slice(-10);
}

function resolveDate(input) {
  if (!input) return null;
  let s = input.trim().toLowerCase();

  // Normalize STT artifacts: Deepgram often hears "twenty-third" as "20 third", etc.
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
  // "the 23rd" → "23"
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
  // Replace longest matches first (twenty-first before first)
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

module.exports = { getSettings, generateBookingNumber, getPrice, getBookedEquipmentIds, getDeliveryFee, getDistanceFee, calcPricing, getTaxRate, fmtDate, normalizePhone, resolveDate };
