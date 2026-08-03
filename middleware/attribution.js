'use strict';

/**
 * Ad attribution capture.
 *
 * We were spending ~$60/month across Google and Meta with no way to tell whether it
 * produced a booking: `gclid`, `fbclid` and `utm_*` appeared nowhere in the app, and
 * `bookings.source` was never written by any booking path.
 *
 * This drops a first-party cookie on first touch and hands it back at booking time.
 * The app uses cookie-parser and has no session store, so a cookie is the mechanism.
 */

const COOKIE = 'bm_attrib';
const MAX_AGE_DAYS = 90;

/**
 * FIRST-TOUCH attribution: once a click ID is recorded we never overwrite it.
 * Someone who clicks the ad, leaves, and comes back a week later by typing the URL
 * should still credit the ad — that visit is the ad's doing. Flip this one constant
 * to switch the whole app to last-touch; do not scatter the decision.
 */
const ATTRIBUTION_MODEL = 'first-touch';

const PARAMS = ['gclid', 'fbclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

function parseCookie(raw) {
  if (!raw) return null;
  // cookie-parser has normally decoded this already; decodeURIComponent is a no-op on
  // plain JSON, and the second attempt covers any legacy double-encoded cookie still
  // in a returning visitor's browser from before that was fixed.
  for (const candidate of [raw, (() => { try { return decodeURIComponent(raw); } catch { return null; } })()]) {
    if (!candidate) continue;
    try {
      const o = JSON.parse(candidate);
      if (o && typeof o === 'object') return o;
    } catch {}
  }
  return null;
}

const clean = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(Array.isArray(v) ? v[0] : v).trim();
  return s ? s.slice(0, 512) : null;   // cap: click IDs are long, but not unbounded
};

/**
 * Collapse the detail into the single value reporting groups by, so a channel
 * breakdown stays a one-column GROUP BY.
 */
function deriveSource(a) {
  if (!a) return 'direct';
  const medium = (a.utm_medium || '').toLowerCase();
  const utmSrc = (a.utm_source || '').toLowerCase();
  const paid = medium === 'cpc' || medium === 'ppc' || medium === 'paid' || medium === 'paid_social';

  if (a.gclid) return 'google_cpc';
  if (a.fbclid) return 'facebook_cpc';
  if (utmSrc.includes('google')) return paid ? 'google_cpc' : 'google_organic';
  if (utmSrc.includes('facebook') || utmSrc.includes('instagram') || utmSrc === 'fb' || utmSrc === 'ig') {
    return paid ? 'facebook_cpc' : 'facebook_organic';
  }
  if (utmSrc) return utmSrc.replace(/[^a-z0-9_]/g, '_').slice(0, 40);

  const ref = (a.referrer || '').toLowerCase();
  if (ref) {
    if (ref.includes('google.')) return 'google_organic';
    if (ref.includes('facebook.') || ref.includes('instagram.')) return 'facebook_organic';
    if (ref.includes('bing.') || ref.includes('duckduckgo.') || ref.includes('yahoo.')) return 'search_organic';
    try {
      const host = new URL(a.referrer).hostname.replace(/^www\./, '');
      if (host && !host.includes('bouncemanrentals.com')) return 'referral';
    } catch {}
  }
  return 'direct';
}

/**
 * Mounted before the public routes. Only touches GETs for real pages — no point
 * setting cookies on asset or API traffic.
 */
function attributionMiddleware(req, res, next) {
  try {
    if (req.method !== 'GET') return next();
    const p = req.path || '';
    if (p.startsWith('/api/') || p.startsWith('/admin') || p.startsWith('/assets/') ||
        p.startsWith('/uploads/') || p === '/favicon.ico' || p === '/robots.txt' ||
        p === '/sitemap.xml' || p === '/llms.txt' || /\.[a-z0-9]{2,4}$/i.test(p)) {
      return next();
    }

    const existing = parseCookie(req.cookies && req.cookies[COOKIE]);
    const incoming = {};
    let hasIncoming = false;
    for (const k of PARAMS) {
      const v = clean(req.query && req.query[k]);
      if (v) { incoming[k] = v; hasIncoming = true; }
    }

    // Nothing new and already tracked — leave it alone.
    if (!hasIncoming && existing) return next();

    // First-touch: an existing click ID outranks anything arriving now.
    if (existing && ATTRIBUTION_MODEL === 'first-touch' && (existing.gclid || existing.fbclid)) {
      return next();
    }

    const record = Object.assign({
      gclid: null, fbclid: null, utm_source: null, utm_medium: null,
      utm_campaign: null, utm_term: null, utm_content: null,
      landing_page: (req.originalUrl || p).slice(0, 512),
      referrer: clean(req.get && req.get('referer')),
      first_seen_at: new Date().toISOString(),
    }, existing || {}, incoming);

    // A returning visitor keeps their original landing page and timestamp.
    if (existing) {
      record.landing_page = existing.landing_page || record.landing_page;
      record.first_seen_at = existing.first_seen_at || record.first_seen_at;
      record.referrer = existing.referrer || record.referrer;
    }

    // Express URL-encodes cookie values itself; encoding here too produced a
    // double-encoded value (%257B). Hand it the raw JSON and let Express do it once.
    res.cookie(COOKIE, JSON.stringify(record), {
      httpOnly: false,                 // readable by client-side tags if we ever need it
      sameSite: 'lax',                 // must survive the click in from Google/Meta
      secure: process.env.NODE_ENV === 'production',
      maxAge: MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
      path: '/',
    });
    req._bmAttrib = record;
  } catch (e) {
    // Attribution is bookkeeping. It must never be able to break a page load.
    console.error('[ATTRIB] capture failed:', e.message);
  }
  next();
}

/**
 * Read back at booking time. Always returns a full object with a usable `source`,
 * so no booking path can silently produce an empty one.
 */
function readAttribution(req) {
  let a = null;
  try {
    a = (req && req._bmAttrib) || parseCookie(req && req.cookies && req.cookies[COOKIE]);
  } catch {}
  return {
    gclid: (a && a.gclid) || null,
    fbclid: (a && a.fbclid) || null,
    utm_source: (a && a.utm_source) || null,
    utm_medium: (a && a.utm_medium) || null,
    utm_campaign: (a && a.utm_campaign) || null,
    utm_term: (a && a.utm_term) || null,
    utm_content: (a && a.utm_content) || null,
    landing_page: (a && a.landing_page) || null,
    referrer: (a && a.referrer) || null,
    first_seen_at: (a && a.first_seen_at) || null,
    source: deriveSource(a),
  };
}

/** Column order shared by every INSERT, so the five booking paths can't drift. */
const ATTRIB_COLUMNS = [
  'source', 'attrib_gclid', 'attrib_fbclid', 'attrib_utm_source', 'attrib_utm_medium',
  'attrib_utm_campaign', 'attrib_utm_term', 'attrib_utm_content',
  'attrib_landing_page', 'attrib_referrer', 'attrib_first_seen_at',
];

/** Values in ATTRIB_COLUMNS order. Pass a source override for non-web paths. */
function attribValues(a, sourceOverride) {
  return [
    sourceOverride || a.source, a.gclid, a.fbclid, a.utm_source, a.utm_medium,
    a.utm_campaign, a.utm_term, a.utm_content, a.landing_page, a.referrer, a.first_seen_at,
  ];
}

/** For paths with no web session at all (phone, admin, CLI). */
function emptyAttribution(source) {
  return {
    gclid: null, fbclid: null, utm_source: null, utm_medium: null, utm_campaign: null,
    utm_term: null, utm_content: null, landing_page: null, referrer: null,
    first_seen_at: new Date().toISOString(), source: source || 'direct',
  };
}

module.exports = {
  attributionMiddleware, readAttribution, deriveSource, emptyAttribution,
  ATTRIB_COLUMNS, attribValues, COOKIE, ATTRIBUTION_MODEL,
};
