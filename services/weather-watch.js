/**
 * Wind watch — texts the owner when a unit that is CURRENTLY OUT is forecast to
 * see dangerous gusts inside the next few hours.
 *
 * Inflatables are the one piece of equipment that fails suddenly and badly in wind.
 * Manufacturer guidance and ASTM F2374 put the "get riders off" line around 25 mph,
 * so that is the default here; it is a settings row so it can be tuned without a
 * deploy. Gusts, not sustained wind, are what actually lift a unit.
 *
 * Deliberately owner-only. This never texts a customer — it is a heads-up so he can
 * call the party himself, which is a judgement call no automation should make.
 */
const { getDb } = require('../db');
const smsService = require('./sms');

const DEFAULT_GUST_MPH = 25;
const LOOKAHEAD_HOURS = 5;
// Re-alerting every hour through one windy afternoon just trains him to ignore it.
// Only speak up again if it gets materially worse than what we already warned about.
const RESHOUT_DELTA_MPH = 5;

const zipCache = new Map();

async function geocodeZip(zip) {
  if (zipCache.has(zip)) return zipCache.get(zip);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch('https://api.zippopotam.us/us/' + zip, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.places || !data.places.length) return null;
    const out = { lat: parseFloat(data.places[0].latitude), lng: parseFloat(data.places[0].longitude) };
    zipCache.set(zip, out);
    return out;
  } catch (e) { return null; }
  finally { clearTimeout(timer); }
}

// Open-Meteo: free, keyless, no account. Returns the worst gust in the window and when.
async function peakGust(lat, lng) {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lng +
    '&hourly=wind_gusts_10m&wind_speed_unit=mph&timezone=America%2FChicago&forecast_days=2';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d.hourly || !d.hourly.time) return null;
    const now = Date.now();
    const until = now + LOOKAHEAD_HOURS * 3600 * 1000;
    let worst = null;
    for (let i = 0; i < d.hourly.time.length; i++) {
      // Open-Meteo returns local (America/Chicago) wall time with no offset; Date parses
      // that as server-local, and the server runs on Central, so these line up.
      const ts = new Date(d.hourly.time[i]).getTime();
      if (ts < now || ts > until) continue;
      const g = d.hourly.wind_gusts_10m[i];
      if (g == null) continue;
      if (!worst || g > worst.gust) worst = { gust: g, at: d.hourly.time[i] };
    }
    return worst;
  } catch (e) { return null; }
  finally { clearTimeout(timer); }
}

function prettyHour(iso) {
  const h = parseInt(String(iso).slice(11, 13), 10);
  if (isNaN(h)) return iso;
  const ampm = h < 12 ? 'am' : 'pm';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return hh + ampm;
}

async function checkWindAlerts() {
  const db = getDb();

  const thrRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('wind_alert_gust_mph');
  const threshold = Math.max(1, parseFloat(thrRow && thrRow.value) || DEFAULT_GUST_MPH);

  // "Out right now" = today falls inside the rental window. A unit dropped off EARLY
  // for tomorrow's party is not covered — there is no delivered_at column to key on.
  const bookings = db.prepare(`
    SELECT b.id, b.booking_number, b.delivery_zip, b.delivery_city, b.event_date,
           c.first_name, c.last_name
    FROM bookings b JOIN customers c ON c.id = b.customer_id
    WHERE b.status IN ('confirmed', 'completed')
      AND date('now','localtime') BETWEEN date(b.event_date)
                                      AND date(COALESCE(NULLIF(b.event_end_date, ''), b.event_date))
  `).all();
  if (!bookings.length) return 0;

  const today = new Date().toISOString().slice(0, 10);
  const hits = [];

  for (const b of bookings) {
    if (!b.delivery_zip) continue;
    const geo = await geocodeZip(String(b.delivery_zip).trim());
    if (!geo) { console.error('[WIND] could not geocode zip', b.delivery_zip, 'for', b.booking_number); continue; }
    const worst = await peakGust(geo.lat, geo.lng);
    if (!worst || worst.gust < threshold) continue;

    const key = 'wind_alert:' + b.booking_number + ':' + today;
    const seen = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    const already = seen ? parseFloat(seen.value) : null;
    if (already != null && worst.gust < already + RESHOUT_DELTA_MPH) continue;

    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, String(Math.round(worst.gust)));

    const who = ((b.first_name || '') + ' ' + (b.last_name || '')).trim() || b.booking_number;
    hits.push('• ' + who + ' (' + (b.delivery_city || '?') + '): gusts to ' +
              Math.round(worst.gust) + ' mph around ' + prettyHour(worst.at));
  }

  if (!hits.length) return 0;

  // One text listing every affected job, not one per booking.
  const body = 'WIND WARNING — gusts over ' + Math.round(threshold) + ' mph forecast in the next ' +
    LOOKAHEAD_HOURS + ' hours where your units are out:\n\n' + hits.join('\n') +
    '\n\nConsider getting riders off and checking anchors.';
  const owner = process.env.OWNER_CELL || '+15806281765';
  try {
    await smsService.sendSms(owner, body);
    console.log('[WIND] alerted owner about ' + hits.length + ' job(s)');
  } catch (e) {
    console.error('[WIND] SMS to owner failed:', e.message);
  }
  return hits.length;
}

module.exports = { checkWindAlerts };
