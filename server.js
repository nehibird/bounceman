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

const cookieParser = require('cookie-parser');
const app = express();
const PORT = process.env.PORT || 3200;

// Security
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline styles from template
  crossOriginEmbedderPolicy: false
}));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

// Body parsing — webhooks need raw body
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use('/event/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static assets
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/', publicRoutes);
app.use('/auth', authRoutes);
app.use('/booking', bookingRoutes);
app.use('/admin', adminRoutes);
app.use('/api/sarah', sarahRoutes);
app.use('/api/webhooks', webhookRoutes);
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
});

module.exports = app;
