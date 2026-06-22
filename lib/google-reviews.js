// Google Business Profile reviews sync.
// Pulls reviews via the Google My Business API v4 and upserts them into the
// `reviews` table (source='google', approved=1) so the existing homepage +
// /reviews display picks them up. Configured via GOOGLE_REVIEWS_* env vars.

const STAR = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, STAR_RATING_UNSPECIFIED: 0 };

// Review text/names are reviewer-supplied and the templates render them raw,
// so escape HTML here before storing to prevent stored XSS.
function esc(s) {
  if (s == null) return s;
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function configured() {
  return !!(process.env.GOOGLE_REVIEWS_CLIENT_ID && process.env.GOOGLE_REVIEWS_CLIENT_SECRET &&
    process.env.GOOGLE_REVIEWS_REFRESH_TOKEN && process.env.GOOGLE_REVIEWS_ACCOUNT_ID && process.env.GOOGLE_REVIEWS_LOCATION_ID);
}

async function getAccessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_REVIEWS_CLIENT_ID,
      client_secret: process.env.GOOGLE_REVIEWS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REVIEWS_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('token error: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

async function fetchAllReviews() {
  const acct = process.env.GOOGLE_REVIEWS_ACCOUNT_ID;
  const loc = process.env.GOOGLE_REVIEWS_LOCATION_ID;
  const at = await getAccessToken();
  const all = [];
  let pageToken = '';
  for (let i = 0; i < 20; i++) { // safety cap (~1000 reviews)
    const url = `https://mybusiness.googleapis.com/v4/accounts/${acct}/locations/${loc}/reviews?pageSize=50` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + at } });
    const j = await r.json();
    if (j.error) throw new Error('reviews error: ' + JSON.stringify(j.error).slice(0, 200));
    (j.reviews || []).forEach((x) => all.push(x));
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return all;
}

// Fetch from Google and replace all source='google' rows in the reviews table.
async function syncGoogleReviews(db) {
  if (!configured()) throw new Error('Google Reviews not configured (GOOGLE_REVIEWS_* env vars missing)');
  const reviews = await fetchAllReviews();
  const withText = reviews.filter((r) => r.comment && r.comment.trim());
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM reviews WHERE source = 'google'").run();
    const ins = db.prepare(`INSERT INTO reviews
      (id, source, external_id, rating, comment, customer_name, response, approved, featured, created_at)
      VALUES (?, 'google', ?, ?, ?, ?, ?, 1, 0, ?)`);
    for (const r of withText) {
      const rating = STAR[r.starRating] || 5;
      const name = esc((r.reviewer && r.reviewer.displayName) || 'Google Reviewer');
      const reply = esc((r.reviewReply && r.reviewReply.comment) || null);
      const created = r.createTime || new Date().toISOString();
      ins.run('g_' + r.reviewId, r.reviewId, rating, esc(r.comment.trim()), name, reply, created);
    }
  });
  tx();
  return { fetched: reviews.length, stored: withText.length };
}

module.exports = { syncGoogleReviews, fetchAllReviews, getAccessToken, configured };
