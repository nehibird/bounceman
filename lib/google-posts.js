// Google Business Profile "Local Posts" — publish marketing posts to the Google
// listing (Search + Maps). Reuses the same OAuth creds as the reviews sync.
const { getAccessToken } = require('./google-reviews');
const { getBookedEquipmentIds } = require('./helpers');

const PUBLIC_BASE = 'https://bouncemanrentals.com';
const DEFAULT_PHOTO = process.env.GOOGLE_POST_PHOTO_URL || `${PUBLIC_BASE}/assets/images/og-image.jpg`;

function configured() {
  return !!(process.env.GOOGLE_REVIEWS_REFRESH_TOKEN && process.env.GOOGLE_REVIEWS_ACCOUNT_ID && process.env.GOOGLE_REVIEWS_LOCATION_ID);
}

function postsUrl() {
  const a = process.env.GOOGLE_REVIEWS_ACCOUNT_ID;
  const l = process.env.GOOGLE_REVIEWS_LOCATION_ID;
  return `https://mybusiness.googleapis.com/v4/accounts/${a}/locations/${l}/localPosts`;
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function iso(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

// Upcoming Saturday (today if it's already Saturday).
function upcomingSaturday(now) {
  const d = new Date((now || new Date()).getTime());
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
  return d;
}

// Build the weekend-availability post content from real availability (no publish).
function generateWeekendPost(db) {
  const sat = upcomingSaturday(new Date());
  const satISO = iso(sat);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dateLabel = `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][sat.getDay()]}, ${months[sat.getMonth()]} ${sat.getDate()}`;

  const booked = getBookedEquipmentIds(db, satISO, '09:00', '19:00', 'daily');
  const units = db.prepare("SELECT id, name, quantity FROM equipment WHERE status = 'available' AND category != 'add_ons' AND category != 'add-ons' ORDER BY price_daily DESC").all();
  const available = units.filter((u) => ((u.quantity || 1) - (booked.get(u.id) || 0)) > 0).map((u) => u.name);

  let summary;
  if (available.length === 0) {
    summary = `We're booked up this weekend! 🎉 Planning a party? Reserve early — we deliver, set up & pick up FREE across Tonkawa and all of Kay County. Tap Book Now to grab an open date! 🏰`;
  } else {
    const list = available.length <= 3 ? available.join(', ') : `${available.slice(0, 3).join(', ')}, and more`;
    summary = `🎉 Open this weekend — ${dateLabel}! ${list} ready to bounce. FREE delivery, setup & pickup across Tonkawa and Kay County. Tap Book Now to lock in your date! 🏰💦`;
  }
  return {
    summary,
    topicType: 'STANDARD',
    callToAction: { actionType: 'BOOK', url: `${PUBLIC_BASE}/booking` },
    photoUrl: DEFAULT_PHOTO,
    meta: { date: satISO, dateLabel, available },
  };
}

async function createLocalPost(content) {
  if (!configured()) throw new Error('Google Posts not configured (GOOGLE_REVIEWS_* missing)');
  const at = await getAccessToken();
  const body = {
    languageCode: 'en-US',
    summary: content.summary,
    topicType: content.topicType || 'STANDARD',
  };
  if (content.callToAction) body.callToAction = content.callToAction;
  if (content.photoUrl) body.media = [{ mediaFormat: 'PHOTO', sourceUrl: content.photoUrl }];

  let r = await fetch(postsUrl(), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // If the photo is rejected, retry once without media so the post still goes out.
  if (r.status === 400 && body.media) {
    delete body.media;
    r = await fetch(postsUrl(), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  const j = await r.json();
  if (r.status >= 300) throw new Error(`localPosts ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

// Generate + publish the weekend post, with a once-a-week dedup guard via settings.
async function publishWeekendPost(db, { force = false } = {}) {
  const lastRow = db.prepare("SELECT value FROM settings WHERE key = 'google_last_post_date'").get();
  const last = lastRow ? lastRow.value : null;
  const todayISO = iso(new Date());
  if (!force && last) {
    const days = (new Date(todayISO) - new Date(last)) / 86400000;
    if (days < 6) return { skipped: true, reason: `last post ${last} (<6 days ago)` };
  }
  const content = generateWeekendPost(db);
  const result = await createLocalPost(content);
  db.prepare("INSERT INTO settings (key, value) VALUES ('google_last_post_date', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(todayISO);
  return { posted: true, name: result.name, summary: content.summary };
}

async function listLocalPosts() {
  const at = await getAccessToken();
  const r = await fetch(postsUrl() + '?pageSize=20', { headers: { Authorization: 'Bearer ' + at } });
  return r.json();
}

module.exports = { configured, generateWeekendPost, createLocalPost, publishWeekendPost, listLocalPosts, upcomingSaturday };
