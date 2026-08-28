const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const db = require('./db');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const bookingRoutes = require('./routes/booking');
const webhookRoutes = require('./routes/webhooks');
const eventRoutes = require('./routes/event');
const sarahRoutes = require('./routes/sarah');
const callsRouter = require('./routes/calls');
const bankRoutes = require('./routes/bank');

const cookieParser = require('cookie-parser');
const app = express();
const PORT = process.env.PORT || 3200;

// Make the HTML-escape helper available inside every EJS template (in scope via
// app.locals, same as other bare locals like `settings`) without touching every
// render() call. CRITICAL for admin views that interpolate user-controlled text
// (customer fields, inbound SMS bodies, review comments) via `<%- %>` + template
// literals, which do not auto-escape.
app.locals.esc = require('./lib/helpers').esc;
// Live review aggregate for LocalBusiness JSON-LD (rich-result stars). Exposed
// as a callable local so the shared layout can emit real, current numbers.
app.locals.getReviewStats = require('./lib/helpers').getReviewStats;

// Cloudflare Turnstile site key for the lead-capture popup. Empty (e.g. on the
// sandbox) means the widget isn't rendered and /api/lead skips verification.
app.locals.TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';

// Flag the booking flow so the shared layout can drop the footer's outbound
// social links there — nothing on a checkout page should lead off-site.
app.use((req, res, next) => {
  // Pages where the customer is transacting, not browsing. Marketing furniture is
  // suppressed on all of them. The coupon is position:fixed at z-index 99999 and goes
  // full-bleed under 520px, so on a phone it sat on top of the equipment grid and the
  // signature pad and swallowed the taps — Playwright's actionability check named it
  // outright: "<img popup-art-v2.webp> from <div id=bml-root> subtree intercepts
  // pointer events". A $10-off advert must never outrank the button that takes the money.
  res.locals.isBookingFlow = /^\/(booking|contract|event|delivery|service-areas)(\/|$)/.test(req.path);
  next();
});

// Security — HIGH-3: Real CSP, MED-7: HSTS max-age
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://js.stripe.com', 'https://www.googletagmanager.com', 'https://www.googleadservices.com', 'https://connect.facebook.net', 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://static.cloudflareinsights.com', 'https://www.clarity.ms', 'https://cdn.plaid.com', 'https://challenges.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://static.cloudflareinsights.com', 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'data:', 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://static.cloudflareinsights.com', 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
      connectSrc: ["'self'", 'https://api.stripe.com', 'https://www.google-analytics.com', 'https://region1.google-analytics.com', 'https://www.googletagmanager.com', 'https://www.google.com', 'https://google.com', 'https://www.googleadservices.com', 'https://googleads.g.doubleclick.net', 'https://www.facebook.com', 'https://connect.facebook.net', 'https://api.zippopotam.us', 'https://vapi.ai', 'https://cdn.jsdelivr.net', 'https://cdn.plaid.com', 'https://production.plaid.com'],
      frameSrc: ["'self'", 'https://js.stripe.com', 'https://cdn.plaid.com', 'https://www.facebook.com', 'https://td.doubleclick.net', 'https://challenges.cloudflare.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'", 'https://checkout.stripe.com'],
      scriptSrcAttr: ["'none'"],
      upgradeInsecureRequests: null,

    }
  },
  hsts: process.env.HTTPS_ONLY === 'true' ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  crossOriginEmbedderPolicy: false
}));
// HIGH-2: Restrict CORS origin — no wildcard in production
app.use(cors({ origin: process.env.CORS_ORIGIN || 'https://bouncemanrentals.com' }));

// Trust proxy — required behind nginx so rate limiter sees real client IPs
app.set('trust proxy', 1);


// Rate limiting — only on public-facing endpoints, not server-to-server calls
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for authenticated server-to-server routes
    return req.path.startsWith('/sarah') || req.path.startsWith('/webhooks');
  }
});
app.use('/api/', limiter);

// Body parsing — webhooks need raw body
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use('/event/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());

// Ad attribution — must sit above the public routes so the click ID is banked before
// anything renders. Cookie-based because there is no session store. Never throws.
app.use(require('./middleware/attribution').attributionMiddleware);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static assets
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public'))); // serve /favicon.ico, /apple-touch-icon.png, etc. at root

// Routes
app.use('/', publicRoutes);
app.use('/auth', authRoutes);
app.use('/booking', bookingRoutes);
app.use('/admin', adminRoutes);

app.use('/api/sarah', sarahRoutes);
 app.use('/api/messenger', require('./routes/messenger'));
app.use('/api/call', callsRouter);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/bank', bankRoutes);
app.use('/api', apiRoutes);
app.use('/event', eventRoutes);

// 404 catch-all (must be after all routes, before error handler)
app.use((req, res) => {
  const settings = require('./lib/helpers').getSettings();
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).render('public/404', {
    title: 'Page Not Found - Bounce Man',
    settings,
    page: '404'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  const status = err.status || 500;
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ error: err.message });
  }
  const settings = require('./lib/helpers').getSettings();
  res.status(status).render('public/404', {
    title: 'Error - Bounce Man',
    settings,
    page: 'error'
  });
});

// Initialize DB and start
db.initialize();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BounceMan] Server running on port ${PORT}`);
  console.log(`[BounceMan] Admin: http://localhost:${PORT}/admin`);
  console.log(`[BounceMan] Public: http://localhost:${PORT}`);

  // Daily delivery reminder check — runs at 8 AM CT (14:00 UTC)
  const { checkDeliveryReminders, sendTodayBrief, deliveryWatchdog, sendHazardChecks } = require('./services/notifications');
  function scheduleReminders() {
    // HOURLY, with a catch-up shortly after boot — not a single daily setTimeout.
    //
    // The old version scheduled one timer at startup for 14:00 UTC. Any restart after
    // that hour pushed it to the following day and skipped that day's run entirely, and
    // every deploy restarts the container. Combined with the reminder query only looking
    // at a single date, a booking could miss its one and only chance permanently — which
    // is what happened on 2026-08-11.
    //
    // Both jobs are idempotent (reminder flags per booking/event_date; the brief keys off
    // a settings row per day), so running them every hour is safe and means a booking
    // created at any hour is picked up within one, instead of never.
    const runReminders = () => {
      Promise.resolve(checkDeliveryReminders()).catch((e) => console.error('[REMINDER] run failed:', e.message));
      Promise.resolve(sendTodayBrief()).catch((e) => console.error('[BRIEF] run failed:', e.message));
      // Runs LAST and independently: it exists precisely for the case where the two
      // above believe they succeeded but nothing reached Slack.
      Promise.resolve(deliveryWatchdog()).catch((e) => console.error('[WATCHDOG] run failed:', e.message));
    };
    // Every 15 minutes, not hourly. The interval inherits whatever minute the container
    // last booted at, so an hourly tick would drift the 5 PM brief anywhere across the
    // hour (a boot at 10:26 sends it at 5:26). At 15 minutes it lands by 5:15 at worst,
    // and the extra sweeps cost two indexed queries that no-op once the flags are set.
    setTimeout(() => { runReminders(); setInterval(runReminders, 15 * 60 * 1000); }, 45 * 1000);
    // Hazard checks run HOURLY, not with the daily reminder. It's a safety text and
    // it has to reach short-notice bookings too, so it can't wait for one fixed hour
    // a day — a restart past that hour used to skip the run entirely. The
    // hazard_check_sent flag makes repeat runs a no-op, and the job self-gates to
    // daytime Central. First pass 90s after boot so it also acts as a catch-up.
    const runHazards = () => sendHazardChecks().catch((e) => console.error('[HAZARD] run failed:', e.message));
    setTimeout(() => { runHazards(); setInterval(runHazards, 60 * 60 * 1000); }, 90 * 1000);

    // Wind watch: texts the owner when a unit that is currently OUT is forecast to see
    // gusts over the threshold within the next few hours. Hourly is the right cadence —
    // a 5-hour lookahead checked every hour never leaves a gap, and the per-booking
    // dedupe keeps one windy afternoon down to a single text.
    const { checkWindAlerts } = require('./services/weather-watch');
    const runWindWatch = () => checkWindAlerts().catch((e) => console.error('[WIND] run failed:', e.message));
    setTimeout(() => { runWindWatch(); setInterval(runWindWatch, 60 * 60 * 1000); }, 120 * 1000);

    console.log('[BounceMan] Delivery reminders + 5 PM night-before brief: every 15 min (catch-up 45s after boot); hazard checks + wind watch hourly');
  }
  // Only the primary (production) instance runs the reminder scheduler. Dev/secondary
  // instances set DISABLE_SCHEDULER=true so they don't fire duplicate reminders, emails,
  // SMS, or Slack notifications to real customers.
  if (process.env.DISABLE_SCHEDULER === 'true') {
    console.log('[BounceMan] Scheduler DISABLED on this instance (DISABLE_SCHEDULER=true) — no reminders/emails/SMS sent from here');
  } else {
    scheduleReminders();
    // Auto-release abandoned unpaid holds so they stop reserving inventory: reminder at
    // 10 min, release at 30 min. Runs every 5 min (first pass 60s after boot) — at the
    // old 20-min cadence a 30-minute hold would not actually expire until 40-50 min.
    const { releaseExpiredHolds } = require('./services/scheduler');
    const runHoldRelease = () => releaseExpiredHolds().catch((e) => console.error('[HOLD] run failed:', e.message));
    setTimeout(() => { runHoldRelease(); setInterval(runHoldRelease, 5 * 60 * 1000); }, 60 * 1000);
    console.log('[BounceMan] Hold auto-release scheduled (every 5 min; remind 10 min, release 30 min)');
  }

  // Google Business Profile reviews — sync on startup + daily.
  // Safe on any instance: read-only pull from Google, writes only the local reviews table.
  const googleReviews = require('./lib/google-reviews');
  if (googleReviews.configured()) {
    const runReviewSync = () => googleReviews.syncGoogleReviews(db.getDb())
      .then((r) => console.log(`[BounceMan] Google reviews synced: ${r.stored} shown / ${r.fetched} total`))
      .catch((e) => console.error('[BounceMan] Google reviews sync failed:', e.message));
    setTimeout(runReviewSync, 8000);
    setInterval(runReviewSync, 24 * 60 * 60 * 1000);
  } else {
    console.log('[BounceMan] Google reviews sync skipped (GOOGLE_REVIEWS_* not configured)');
  }

  // Google Posts — auto-publish the weekend's availability every Thursday ~10 AM CT.
  // PRODUCTION ONLY: gated on DISABLE_SCHEDULER so the dev instance never posts to the live listing.
  if (process.env.DISABLE_SCHEDULER !== 'true') {
    const googlePosts = require('./lib/google-posts');
    if (googlePosts.configured()) {
      const runWeekendPost = () => googlePosts.publishWeekendPost(db.getDb(), {})
        .then((r) => console.log('[BounceMan] Google weekend post:', JSON.stringify(r)))
        .catch((e) => console.error('[BounceMan] Google weekend post failed:', e.message));
      const scheduleWeekendPost = () => {
        const now = new Date();
        const target = new Date(now);
        target.setUTCHours(15, 0, 0, 0); // ~10 AM CT
        while (target.getUTCDay() !== 4 || target <= now) target.setUTCDate(target.getUTCDate() + 1); // next Thursday
        setTimeout(() => { runWeekendPost(); setInterval(runWeekendPost, 7 * 24 * 60 * 60 * 1000); }, target - now);
        console.log(`[BounceMan] Google weekend post scheduled for ${target.toISOString()}`);
      };
      scheduleWeekendPost();
    }
  }
});

module.exports = app;
