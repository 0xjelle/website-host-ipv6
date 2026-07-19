const express = require('express');
const bcrypt = require('bcryptjs');
const { db, logActivity } = require('../db');
const { signToken, requireAuth } = require('../auth');

const router = express.Router();

const cookieOpts = 'HttpOnly; Path=/; Max-Age=604800; SameSite=Lax';

router.post('/register', (req, res) => {
  const { email, name, password } = req.body || {};
  if (!email || !name || !password) return res.status(400).json({ error: 'email, name and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });

  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const role = count === 0 ? 'admin' : 'user'; // first account becomes admin
  try {
    const hash = bcrypt.hashSync(password, 10);
    const r = db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(email.toLowerCase(), name, hash, role);
    const user = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(r.lastInsertRowid);
    logActivity(user.id, 'user.register', `${user.email}${role === 'admin' ? ' (first user → admin)' : ''}`);
    const token = signToken(user);
    res.setHeader('Set-Cookie', `hexatoken=${token}; ${cookieOpts}`);
    res.json({ user, token, firstUser: role === 'admin' });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'An account with that email already exists' });
    throw e;
  }
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase());
  if (!row || !bcrypt.compareSync(password || '', row.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (row.suspended) return res.status(403).json({ error: 'This account is suspended' });
  const user = { id: row.id, email: row.email, name: row.name, role: row.role };
  logActivity(user.id, 'user.login', user.email);
  const token = signToken(user);
  res.setHeader('Set-Cookie', `hexatoken=${token}; ${cookieOpts}`);
  res.json({ user, token });
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'hexatoken=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const setup = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  res.json({ user: req.user, setup });
});

router.get('/setup-state', (req, res) => {
  res.json({ hasUsers: db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0 });
});

module.exports = router;
