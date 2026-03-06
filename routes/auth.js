const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'bounceman-secret-change-me';
const JWT_EXPIRY = '24h';

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

// Login POST
router.post('/login', (req, res) => {
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

  res.cookie('token', token, {
    httpOnly: true,
    secure: false, // Enable when HTTPS is configured
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
