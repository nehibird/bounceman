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

// Security — HIGH-3: Real CSP, MED-7: HSTS max-age
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://js.stripe.com', 'https://www.googletagmanager.com', 'https://connect.facebook.net', 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://static.cloudflareinsights.com', 'https://www.clarity.ms'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://static.cloudflareinsights.com', 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'data:', 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://static.cloudflareinsights.com', 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
      connectSrc: ["'self'", 'https://api.stripe.com', 'https://www.google-analytics.com', 'https://api.zippopotam.us', 'https://vapi.ai', 'https://cdn.jsdelivr.net'],
      frameSrc: ["'self'", 'https://js.stripe.com'],
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
  const { checkDeliveryReminders } = require('./services/notifications');
  function scheduleReminders() {
    const now = new Date();
    const target = new Date(now);
    target.setUTCHours(14, 0, 0, 0); // 8 AM CT
    if (target <= now) target.setDate(target.getDate() + 1);
    const ms = target - now;
    setTimeout(() => {
      checkDeliveryReminders();
      setInterval(checkDeliveryReminders, 24 * 60 * 60 * 1000);
    }, ms);
    console.log(`[BounceMan] Delivery reminders scheduled for ${target.toISOString()}`);
  }
  // Only the primary (production) instance runs the reminder scheduler. Dev/secondary
  // instances set DISABLE_SCHEDULER=true so they don't fire duplicate reminders, emails,
  // SMS, or Slack notifications to real customers.
  if (process.env.DISABLE_SCHEDULER === 'true') {
    console.log('[BounceMan] Scheduler DISABLED on this instance (DISABLE_SCHEDULER=true) — no reminders/emails/SMS sent from here');
  } else {
    scheduleReminders();
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
});

module.exports = app;
