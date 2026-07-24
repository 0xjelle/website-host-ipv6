// Account-level GitHub connection: store one token per user (encrypted),
// browse their repos, and use it to clone private repos + auto-create
// webhooks - so repositories never need to be public.
const express = require('express');
const { db, logActivity } = require('../db');
const { requireAuth } = require('../auth');
const { encrypt, decrypt } = require('../crypto');
const gh = require('../services/github');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const u = db.prepare('SELECT github_login, github_token FROM users WHERE id = ?').get(req.user.id);
  res.json({ connected: !!u?.github_token, login: u?.github_login || null });
});

router.post('/', async (req, res) => {
  const token = (req.body?.token || '').trim();
  if (!token) return res.status(400).json({ error: 'A GitHub token is required' });
  try {
    const me = await gh.getUser(token);
    db.prepare('UPDATE users SET github_token = ?, github_login = ? WHERE id = ?')
      .run(encrypt(token), me.login, req.user.id);
    logActivity(req.user.id, 'github.connect', `as ${me.login}`);
    res.json({ connected: true, login: me.login });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/', (req, res) => {
  db.prepare('UPDATE users SET github_token = NULL, github_login = NULL WHERE id = ?').run(req.user.id);
  logActivity(req.user.id, 'github.disconnect', '');
  res.json({ ok: true });
});

router.get('/repos', async (req, res) => {
  const u = db.prepare('SELECT github_token FROM users WHERE id = ?').get(req.user.id);
  if (!u?.github_token) return res.status(400).json({ error: 'Connect your GitHub account first' });
  try {
    res.json({ repos: await gh.listRepos(decrypt(u.github_token)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
