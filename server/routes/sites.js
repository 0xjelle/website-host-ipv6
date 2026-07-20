const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { db, logActivity } = require('../db');
const { requireAuth } = require('../auth');
const config = require('../config');
const deployer = require('../services/deployer');
const procman = require('../services/procman');
const ipam = require('../services/ipam');
const gh = require('../services/github');
const { decrypt } = require('../crypto');

const repoFullName = (url) => {
  const m = String(url || '').match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  return m ? m[1] : null;
};

// Best-effort webhook creation using the owner's connected GitHub token.
function autoWebhook(site, cb) {
  const full = repoFullName(site.repo_url);
  if (!full) return cb({ created: false, reason: 'not a github.com repo' });
  const u = db.prepare('SELECT github_token FROM users WHERE id = ?').get(site.user_id);
  if (!u?.github_token) return cb({ created: false, reason: 'GitHub account not connected' });
  const url = `http://${config.publicHost}:${config.adminPort}/api/webhooks/github/${site.id}`;
  gh.createWebhook(decrypt(u.github_token), full, url, site.webhook_secret).then(cb).catch(e => cb({ created: false, reason: e.message }));
}

const router = express.Router();
router.use(requireAuth);

function ownSite(req, res) {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) { res.status(404).json({ error: 'Site not found' }); return null; }
  if (site.user_id !== req.user.id && req.user.role !== 'admin') {
    res.status(403).json({ error: 'Not your site' }); return null;
  }
  return site;
}

function nextAppPort() {
  const used = db.prepare('SELECT app_port FROM sites WHERE app_port IS NOT NULL').all().map(r => r.app_port);
  let p = config.appPortBase;
  while (used.includes(p)) p++;
  return p;
}

function publicView(site) {
  const { repo_token, ...rest } = site;
  return {
    ...rest,
    has_repo_token: !!repo_token,
    domains: JSON.parse(site.domains || '[]'),
    env_vars: JSON.parse(site.env_vars || '{}'),
    default_domain: `${site.slug}.${config.siteBaseDomain}`,
    default_url: `http://${site.slug}.${config.siteBaseDomain}${config.proxyPort === 80 ? '' : ':' + config.proxyPort}`,
    webhook_url: `http://${config.publicHost}:${config.adminPort}/api/webhooks/github/${site.id}`,
    process: site.type === 'node' ? procman.status(site.id) : null,
    sftp: { host: config.publicHost, port: config.sftpPort, folder: site.slug },
  };
}

const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

router.get('/', (req, res) => {
  const rows = req.user.role === 'admin' && req.query.all === '1'
    ? db.prepare('SELECT s.*, u.email AS owner_email FROM sites s JOIN users u ON u.id = s.user_id ORDER BY s.id DESC').all()
    : db.prepare('SELECT * FROM sites WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  res.json({ sites: rows.map(publicView) });
});

// Is a site actually serving right now? node: the app responds; static: it's
// live and has files to serve.
function checkHealth(site) {
  return new Promise((resolve) => {
    if (site.status !== 'live') return resolve({ online: false, reason: site.status });
    if (site.type === 'node') {
      const started = Date.now();
      const req = http.get({ host: '127.0.0.1', port: site.app_port, path: '/', timeout: 2000 }, (r) => {
        r.destroy();
        resolve({ online: (r.statusCode || 0) < 500, status: r.statusCode, ms: Date.now() - started });
      });
      req.on('error', () => resolve({ online: false, reason: 'not responding' }));
      req.on('timeout', () => { req.destroy(); resolve({ online: false, reason: 'timeout' }); });
    } else {
      const dir = path.join(siteRoot(site), site.static_dir || '');
      const ok = fs.existsSync(path.join(dir, 'index.html')) || (fs.existsSync(dir) && fs.readdirSync(dir).length > 0);
      resolve({ online: ok, reason: ok ? undefined : 'no files to serve' });
    }
  });
}

// Batch health for the requester's sites (registered before '/:id').
router.get('/health', async (req, res) => {
  const rows = req.user.role === 'admin' && req.query.all === '1'
    ? db.prepare('SELECT * FROM sites').all()
    : db.prepare('SELECT * FROM sites WHERE user_id = ?').all(req.user.id);
  const results = await Promise.all(rows.map(async s => [s.id, await checkHealth(s)]));
  res.json({ health: Object.fromEntries(results) });
});

router.post('/', (req, res) => {
  const { name, type, repo_url, repo_branch, repo_token, domains, static_dir, build_cmd, start_cmd, env_vars } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Site name is required' });
  if (type && !['static', 'node'].includes(type)) return res.status(400).json({ error: 'Type must be static or node' });
  if (repo_url && !/^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+/.test(repo_url)) {
    return res.status(400).json({ error: 'Repository URL must be an https git URL (e.g. https://github.com/user/repo)' });
  }

  let slug = slugify(name);
  if (!slug) slug = 'site';
  let n = 1;
  while (db.prepare('SELECT 1 FROM sites WHERE slug = ?').get(n === 1 ? slug : `${slug}-${n}`)) n++;
  if (n > 1) slug = `${slug}-${n}`;

  const siteType = type || 'static';
  const r = db.prepare(`INSERT INTO sites
    (user_id, name, slug, type, domains, repo_url, repo_branch, repo_token, webhook_secret, static_dir, build_cmd, start_cmd, env_vars, app_port)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      req.user.id, name.trim(), slug, siteType,
      JSON.stringify(Array.isArray(domains) ? domains.filter(Boolean) : []),
      repo_url || null, repo_branch?.trim() || 'main', repo_token || null,
      crypto.randomBytes(24).toString('hex'),
      static_dir?.trim() || '', build_cmd || null, start_cmd || null,
      JSON.stringify(env_vars && typeof env_vars === 'object' ? env_vars : {}),
      siteType === 'node' ? nextAppPort() : null
    );
  ipam.assignToSite(r.lastInsertRowid); // dedicated IPv6 from the pool, if configured
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(r.lastInsertRowid);
  logActivity(req.user.id, 'site.create', `"${site.name}" (${site.type})`);
  if (site.repo_url) {
    deployer.deploy(site.id, 'manual');
  } else {
    // No repo: create the document root and serve it right away (upload / SFTP)
    fs.mkdirSync(path.join(config.sitesDir, String(site.id), 'current'), { recursive: true });
    if (site.type === 'static') db.prepare("UPDATE sites SET status = 'live' WHERE id = ?").run(site.id);
  }

  const respond = (webhook) => res.status(201).json({ site: publicView(site), webhook });
  if (site.repo_url && req.body.auto_webhook !== false) {
    autoWebhook(site, (webhook) => {
      if (webhook.created) logActivity(req.user.id, 'webhook.create', `"${site.name}"`);
      respond(webhook);
    });
  } else respond(null);
});

// Manually (re)create the GitHub webhook via the connected account.
router.post('/:id/webhook', (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  if (!site.repo_url) return res.status(400).json({ error: 'No repository connected' });
  autoWebhook(site, (webhook) => {
    if (webhook.created) logActivity(req.user.id, 'webhook.create', `"${site.name}"`);
    res.json({ webhook });
  });
});

router.get('/:id', (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  const deployments = db.prepare(
    'SELECT id, trigger, commit_sha, commit_msg, status, started_at, finished_at FROM deployments WHERE site_id = ? ORDER BY id DESC LIMIT 20'
  ).all(site.id);
  res.json({ site: publicView(site), deployments });
});

router.patch('/:id', (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  const b = req.body || {};
  const fields = {};
  if (b.name?.trim()) fields.name = b.name.trim();
  if (b.repo_url !== undefined) fields.repo_url = b.repo_url || null;
  if (b.repo_branch?.trim()) fields.repo_branch = b.repo_branch.trim();
  if (b.repo_token !== undefined) fields.repo_token = b.repo_token || null;
  if (b.static_dir !== undefined) fields.static_dir = b.static_dir.trim();
  if (b.build_cmd !== undefined) fields.build_cmd = b.build_cmd || null;
  if (b.start_cmd !== undefined) fields.start_cmd = b.start_cmd || null;
  if (b.auto_deploy !== undefined) fields.auto_deploy = b.auto_deploy ? 1 : 0;
  if (Array.isArray(b.domains)) fields.domains = JSON.stringify(b.domains.map(d => String(d).toLowerCase().trim()).filter(Boolean));
  if (b.env_vars && typeof b.env_vars === 'object') fields.env_vars = JSON.stringify(b.env_vars);
  if (b.type && ['static', 'node'].includes(b.type)) {
    fields.type = b.type;
    if (b.type === 'node' && !site.app_port) fields.app_port = nextAppPort();
  }
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nothing to update' });
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE sites SET ${sets} WHERE id = ?`).run(...Object.values(fields), site.id);
  logActivity(req.user.id, 'site.update', `"${site.name}"`);
  res.json({ site: publicView(db.prepare('SELECT * FROM sites WHERE id = ?').get(site.id)) });
});

router.post('/:id/deploy', async (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  const result = await deployer.deploy(site.id, 'manual');
  if (!result.queued) return res.status(409).json({ error: result.reason });
  res.json(result);
});

router.post('/:id/stop', (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  db.prepare("UPDATE sites SET status = 'stopped' WHERE id = ?").run(site.id);
  procman.stop(site.id);
  logActivity(req.user.id, 'site.stop', `"${site.name}"`);
  res.json({ ok: true });
});

router.post('/:id/start', (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  db.prepare("UPDATE sites SET status = 'live' WHERE id = ?").run(site.id);
  if (site.type === 'node') {
    procman.resetRestarts(site.id);
    procman.start(db.prepare('SELECT * FROM sites WHERE id = ?').get(site.id), config);
  }
  logActivity(req.user.id, 'site.start', `"${site.name}"`);
  res.json({ ok: true });
});

router.get('/:id/logs', (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  res.json({ logs: procman.logs(site.id) });
});

router.get('/:id/health', async (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  res.json(await checkHealth(site));
});

router.get('/:id/deployments/:depId', (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  const dep = db.prepare('SELECT * FROM deployments WHERE id = ? AND site_id = ?').get(req.params.depId, site.id);
  if (!dep) return res.status(404).json({ error: 'Deployment not found' });
  res.json({ deployment: dep });
});

// ── per-site file manager (document root = data/sites/<id>/current) ──
function siteRoot(site) { return path.join(config.sitesDir, String(site.id), 'current'); }
function safePath(site, rel) {
  const root = siteRoot(site);
  const p = path.normalize(path.join(root, rel || ''));
  if (p !== root && !p.startsWith(root + path.sep)) return null;
  return p;
}

router.get('/:id/files', (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  const dir = safePath(site, req.query.path || '');
  if (!dir) return res.status(400).json({ error: 'Invalid path' });
  fs.mkdirSync(siteRoot(site), { recursive: true });
  if (!fs.existsSync(dir)) return res.json({ path: req.query.path || '', entries: [] });
  const entries = fs.readdirSync(dir).map(name => {
    const st = fs.statSync(path.join(dir, name));
    return { name, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
  }).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  res.json({ path: req.query.path || '', root: siteRoot(site), entries });
});

// Upload one file (raw body). ?path=relative/name.html
router.put('/:id/files', express.raw({ type: '*/*', limit: '200mb' }), (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  if (!req.query.path) return res.status(400).json({ error: 'path is required' });
  const dest = safePath(site, req.query.path);
  if (!dest || dest === siteRoot(site)) return res.status(400).json({ error: 'Invalid path' });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.isBuffer(req.body) ? req.body : Buffer.from(''));
  if (site.type === 'static' && ['new', 'failed', 'stopped'].includes(site.status)) {
    db.prepare("UPDATE sites SET status = 'live' WHERE id = ?").run(site.id);
  }
  logActivity(req.user.id, 'site.upload', `"${site.name}" ← ${req.query.path}`);
  res.json({ ok: true });
});

router.post('/:id/files/mkdir', (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  const dir = safePath(site, req.body?.path);
  if (!dir || dir === siteRoot(site)) return res.status(400).json({ error: 'Invalid path' });
  fs.mkdirSync(dir, { recursive: true });
  res.json({ ok: true });
});

router.delete('/:id/files', (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  const target = safePath(site, req.query.path);
  if (!target || target === siteRoot(site)) return res.status(400).json({ error: 'Invalid path' });
  fs.rmSync(target, { recursive: true, force: true });
  logActivity(req.user.id, 'site.delete-file', `"${site.name}" ✕ ${req.query.path}`);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  procman.stop(site.id);
  if (site.ipv6_addr) ipam.removeAddr(site.ipv6_addr);
  db.prepare('DELETE FROM sites WHERE id = ?').run(site.id);
  require('fs').rmSync(require('path').join(config.sitesDir, String(site.id)), { recursive: true, force: true });
  logActivity(req.user.id, 'site.delete', `"${site.name}"`);
  res.json({ ok: true });
});

module.exports = router;
