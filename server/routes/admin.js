const express = require('express');
const os = require('os');
const { execFile } = require('child_process');
const { db, logActivity } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const procman = require('../services/procman');

const router = express.Router();
router.use(requireAuth);

// ── overview stats (any signed-in user; scoped to their data) ───────
router.get('/overview', (req, res) => {
  const mine = req.user.role === 'admin' ? '' : 'WHERE user_id = ' + req.user.id;
  const mineD = req.user.role === 'admin' ? '' :
    `WHERE site_id IN (SELECT id FROM sites WHERE user_id = ${req.user.id})`;
  const stats = {
    sites: db.prepare(`SELECT COUNT(*) n FROM sites ${mine}`).get().n,
    liveSites: db.prepare(`SELECT COUNT(*) n FROM sites ${mine ? mine + ' AND' : 'WHERE'} status = 'live'`).get().n,
    deployments: db.prepare(`SELECT COUNT(*) n FROM deployments ${mineD}`).get().n,
    peers: db.prepare(`SELECT COUNT(*) n FROM wg_peers ${mine}`).get().n,
  };
  const recent = db.prepare(`
    SELECT d.id, d.site_id, d.trigger, d.commit_sha, d.commit_msg, d.status, d.started_at, d.finished_at, s.name AS site_name
    FROM deployments d JOIN sites s ON s.id = d.site_id
    ${req.user.role === 'admin' ? '' : 'WHERE s.user_id = ' + req.user.id}
    ORDER BY d.id DESC LIMIT 8`).all();
  res.json({ stats, recent });
});

// ── admin-only endpoints ────────────────────────────────────────────
router.use(requireAdmin);

router.get('/system', (req, res) => {
  const load = os.loadavg();
  const cpus = os.cpus().length;
  execFile('df', ['-k', '--output=size,used', '/'], (err, stdout) => {
    let disk = null;
    if (!err) {
      const line = stdout.trim().split('\n').pop().trim().split(/\s+/).map(Number);
      if (line.length === 2 && line[0] > 0) disk = { totalMB: Math.round(line[0] / 1024), usedMB: Math.round(line[1] / 1024) };
    }
    res.json({
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      node: process.version,
      uptimeSec: Math.floor(process.uptime()),
      systemUptimeSec: Math.floor(os.uptime()),
      cpus,
      load1: load[0], load5: load[1], load15: load[2],
      memTotalMB: Math.round(os.totalmem() / 1048576),
      memUsedMB: Math.round((os.totalmem() - os.freemem()) / 1048576),
      disk,
    });
  });
});

router.get('/users', (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.suspended, u.created_at,
           (SELECT COUNT(*) FROM sites s WHERE s.user_id = u.id) AS site_count,
           (SELECT COUNT(*) FROM wg_peers p WHERE p.user_id = u.id) AS peer_count
    FROM users u ORDER BY u.id`).all();
  res.json({ users });
});

router.patch('/users/:id', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const b = req.body || {};
  if (target.id === req.user.id && (b.role === 'user' || b.suspended)) {
    return res.status(400).json({ error: 'You cannot demote or suspend yourself' });
  }
  if (b.role && !['user', 'admin'].includes(b.role)) return res.status(400).json({ error: 'Invalid role' });
  db.prepare('UPDATE users SET role = COALESCE(?, role), suspended = COALESCE(?, suspended) WHERE id = ?')
    .run(b.role || null, b.suspended === undefined ? null : (b.suspended ? 1 : 0), target.id);
  logActivity(req.user.id, 'admin.user.update', `${target.email} → ${b.role || target.role}${b.suspended !== undefined ? (b.suspended ? ' (suspended)' : ' (unsuspended)') : ''}`);
  res.json({ ok: true });
});

router.delete('/users/:id', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot delete yourself' });
  for (const s of db.prepare('SELECT id FROM sites WHERE user_id = ?').all(target.id)) procman.stop(s.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  logActivity(req.user.id, 'admin.user.delete', target.email);
  res.json({ ok: true });
});

router.get('/activity', (req, res) => {
  const rows = db.prepare(`
    SELECT a.id, a.action, a.detail, a.created_at, u.email AS user_email
    FROM activity a LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.id DESC LIMIT 100`).all();
  res.json({ activity: rows });
});

module.exports = router;
