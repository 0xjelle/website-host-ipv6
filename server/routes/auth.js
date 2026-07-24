const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, logActivity } = require('../db');
const { signToken, requireAuth } = require('../auth');
const config = require('../config');
const mail = require('../services/mail');

const router = express.Router();

const cookieOpts = 'HttpOnly; Path=/; Max-Age=604800; SameSite=Lax';
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

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
    res.setHeader('Set-Cookie', `hostingtoken=${token}; ${cookieOpts}`);
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
  res.setHeader('Set-Cookie', `hostingtoken=${token}; ${cookieOpts}`);
  res.json({ user, token });
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'hostingtoken=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const setup = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  res.json({ user: req.user, setup });
});

router.get('/setup-state', (req, res) => {
  res.json({ hasUsers: db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0 });
});

// ── password reset ──────────────────────────────────────────────────
// Request a reset link. Always returns ok (never reveal whether the email
// exists). Emails a one-hour link when the account exists and mail is set up.
router.post('/forgot', async (req, res) => {
  const email = String((req.body || {}).email || '').toLowerCase().trim();
  res.json({ ok: true, mail_configured: mail.configured() });
  if (!email) return;
  const user = db.prepare('SELECT id, email FROM users WHERE email = ? AND suspended = 0').get(email);
  if (!user) return;
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
  db.prepare("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))")
    .run(sha256(token), user.id);
  const base = `http://${config.publicHost}:${config.adminPort}`;
  const link = `${base}/#/reset/${token}`;
  logActivity(user.id, 'user.reset.request', user.email);
  mail.send({
    to: user.email,
    subject: 'Reset your Hosting password',
    text: `Reset your password (valid 1 hour): ${link}`,
    html: mail.shell('Reset your password', `<p>Click the link below to choose a new password. It expires in one hour.</p>
      <p><a href="${link}" style="display:inline-block;background:#5b8def;color:#fff;padding:.6rem 1rem;border-radius:8px;text-decoration:none">Reset password</a></p>
      <p style="color:#888;font-size:12px">If you didn't request this, ignore this email.</p>`),
  }).catch(() => {});
});

// Complete a reset with the token + new password.
router.post('/reset', (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token and new password are required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const row = db.prepare("SELECT * FROM password_resets WHERE token_hash = ? AND expires_at > datetime('now')").get(sha256(token));
  if (!row) return res.status(400).json({ error: 'This reset link is invalid or has expired' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(password), 10), row.user_id);
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(row.user_id);
  logActivity(row.user_id, 'user.reset.complete', '');
  res.json({ ok: true });
});

module.exports = router;
