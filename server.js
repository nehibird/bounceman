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
app.use('/api', apiRoutes);
app.use('/api/webhooks', webhookRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  const status = err.status || 500;
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ error: err.message });
  }
  res.status(status).render('error', {
    title: 'Error',
    message: err.message,
    status
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
