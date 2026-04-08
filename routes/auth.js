const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../db');

// LOW-1: Require JWT_SECRET from environment — no insecure default
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('[SECURITY] JWT_SECRET environment variable is required');
const JWT_EXPIRY = '24h';

// HIGH-5: Rate limiter for login endpoint
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per 15 min
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: false
});

// Middleware to check auth
function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
    return res.redirect('/auth/login');
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Invalid token' });
    res.redirect('/auth/login');
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Login page
router.get('/login', (req, res) => {
  res.render('admin/login', { title: 'Admin Login', error: null });
});

// Login POST — HIGH-5: rate limited
router.post('/login', loginLimiter, (req, res) => {
  const { email, password } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('admin/login', { title: 'Admin Login', error: 'Invalid email or password' });
  }

  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );

  // HIGH-1: secure cookie in production
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || false,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  });

  res.redirect('/admin');
});

// Logout
router.get('/logout', (req, res) => {
  res.clearCookie('token');
  res.redirect('/auth/login');
});

module.exports = router;
module.exports.requireAuth = requireAuth;
module.exports.requireAdmin = requireAdmin;
