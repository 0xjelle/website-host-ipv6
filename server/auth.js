const jwt = require('jsonwebtoken');
const config = require('./config');
const { db } = require('./db');

function signToken(user) {
  return jwt.sign({ uid: user.id }, config.jwtSecret, { expiresIn: '7d' });
}

function getTokenFromReq(req) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  const cookie = req.headers.cookie;
  if (cookie) {
    const m = cookie.match(/(?:^|;\s*)hostingtoken=([^;]+)/);
    if (m) return m[1];
  }
  return null;
}

function requireAuth(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = db.prepare('SELECT id, email, name, role, suspended, created_at FROM users WHERE id = ?').get(payload.uid);
    if (!user) return res.status(401).json({ error: 'Account no longer exists' });
    if (user.suspended) return res.status(403).json({ error: 'Account suspended' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

module.exports = { signToken, requireAuth, requireAdmin };
