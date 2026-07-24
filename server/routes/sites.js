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
const cfsaas = require('../services/cfsaas');
const cloudflare = require('../services/cloudflare');
const billing = require('../services/billing');
const dns = require('dns').promises;
const { decrypt } = require('../crypto');

// Has the customer actually added the CNAME yet? True if the hostname CNAMEs to
// our fallback origin, or (CNAME-flattened) resolves to Cloudflare edge IPs.
// Bounded so a slow/again-missing DNS lookup can't hang the request.
async function cnameDetected(hostname, fallbackOrigin) {
  const timeout = (p) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('t')), 3000))]);
  const cnames = await timeout(dns.resolveCname(hostname)).catch(() => []);
  const fo = (fallbackOrigin || '').toLowerCase();
  if (fo && cnames.some(c => c.toLowerCase().replace(/\.$/, '') === fo)) return true;
  const [v6, v4] = await Promise.all([
    timeout(dns.resolve6(hostname)).catch(() => []),
    timeout(dns.resolve4(hostname)).catch(() => []),
  ]);
  return [...v6, ...v4].some(ip => cloudflare.isCloudflareIP(ip));
}

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

function publicView(site, isAdmin = false) {
  const { repo_token, not_found_html, ...rest } = site;
  // Hide the dedicated origin IPv6 from regular users so they can't point AAAA
  // records straight at the origin (bypassing Cloudflare). Admins still see it.
  if (!isAdmin) delete rest.ipv6_addr;
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
  res.json({ sites: rows.map(s => publicView(s, req.user.role === 'admin')) });
});

router.post('/', async (req, res) => {
  const { name, type, repo_url, repo_branch, repo_token, domains, static_dir, build_cmd, start_cmd, env_vars } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Site name is required' });
  if (type && !['static', 'node'].includes(type)) return res.status(400).json({ error: 'Type must be static or node' });
  if (repo_url && !/^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+/.test(repo_url)) {
    return res.status(400).json({ error: 'Repository URL must be an https git URL (e.g. https://github.com/user/repo)' });
  }
  // A custom domain is required for every site.
  const cleanDomains = (Array.isArray(domains) ? domains : []).map(d => String(d || '').trim().toLowerCase()).filter(Boolean);
  if (!cleanDomains.length) return res.status(400).json({ error: 'A custom domain is required' });
  if (!cleanDomains.every(d => /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d))) {
    return res.status(400).json({ error: 'Enter a valid custom domain (e.g. www.example.com)' });
  }
  // Enforce the plan's site limit (only when billing is configured).
  if (billing.configured()) {
    const u = db.prepare('SELECT plan FROM users WHERE id = ?').get(req.user.id);
    const lim = billing.limits(u.plan || 'free');
    const count = db.prepare('SELECT COUNT(*) AS n FROM sites WHERE user_id = ?').get(req.user.id).n;
    if (count >= lim.maxSites) return res.status(402).json({ error: `Your ${lim.name} plan allows ${lim.maxSites} site${lim.maxSites === 1 ? '' : 's'}. Upgrade in Billing to add more.` });
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
      JSON.stringify(cleanDomains),
      repo_url || null, repo_branch?.trim() || 'main', repo_token || null,
      crypto.randomBytes(24).toString('hex'),
      static_dir?.trim() || '', build_cmd || null, start_cmd || null,
      JSON.stringify(env_vars && typeof env_vars === 'object' ? env_vars : {}),
      siteType === 'node' ? nextAppPort() : null
    );
  ipam.assignToSite(r.lastInsertRowid); // dedicated IPv6 from the pool, if configured
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(r.lastInsertRowid);
  logActivity(req.user.id, 'site.create', `"${site.name}" (${site.type})`);
  // Register any custom domains with Cloudflare for SaaS, and return the result
  // so the UI can show the DNS records to add right after creation. Best-effort:
  // a Cloudflare failure never blocks site creation (it's retried on next sync).
  // This resolves instantly when SaaS is disabled or no real domain was given.
  let cf = null;
  try { cf = await cfsaas.syncDomainsForSite(site); }
  catch (e) { cf = { enabled: cfsaas.isEnabled(), error: e.message, hostnames: [] }; }
  if (site.repo_url) {
    deployer.deploy(site.id, 'manual');
  } else {
    // No repo: create the document root and serve it right away (upload / SFTP)
    fs.mkdirSync(path.join(config.sitesDir, String(site.id), 'current'), { recursive: true });
    if (site.type === 'static') db.prepare("UPDATE sites SET status = 'live' WHERE id = ?").run(site.id);
  }

  const respond = (webhook) => res.status(201).json({ site: publicView(site, req.user.role === 'admin'), webhook, cf });
  if (site.repo_url && req.body.auto_webhook !== false) {
    autoWebhook(site, (webhook) => {
      if (webhook.created) logActivity(req.user.id, 'webhook.create', `"${site.name}"`);
      respond(webhook);
    });
  } else respond(null);
});

// Check GitHub for new commits now and deploy if the branch moved.
router.post('/:id/check', async (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  const result = await require('../services/poller').checkSite(site);
  res.json(result);
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
  res.json({ site: publicView(site, req.user.role === 'admin'), deployments });
});

router.patch('/:id', async (req, res) => {
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
  const updated = db.prepare('SELECT * FROM sites WHERE id = ?').get(site.id);
  // When the custom-domain list changed, reconcile it with Cloudflare for SaaS.
  let cf = null;
  if (fields.domains !== undefined && cfsaas.isEnabled()) {
    cf = await cfsaas.syncDomainsForSite(updated).catch(e => ({ enabled: true, error: e.message, hostnames: [] }));
  }
  res.json({ site: publicView(updated, req.user.role === 'admin'), cf });
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
  // "Stop" unpublishes the site from its public custom domains + dedicated
  // IPv6, but keeps it reachable on its free local link. For node apps we keep
  // the process running (starting it if it isn't) so you can still test the
  // site locally before making it live again.
  db.prepare("UPDATE sites SET status = 'stopped' WHERE id = ?").run(site.id);
  if ((site.type === 'node' || procman.useContainers()) && !procman.status(site.id).running) {
    procman.resetRestarts(site.id);
    procman.start(db.prepare('SELECT * FROM sites WHERE id = ?').get(site.id), config);
  }
  logActivity(req.user.id, 'site.stop', `"${site.name}"`);
  res.json({ ok: true });
});

router.post('/:id/start', (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  db.prepare("UPDATE sites SET status = 'live' WHERE id = ?").run(site.id);
  if (site.type === 'node' || procman.useContainers()) {
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
  res.json(await require('../services/health').checkHealth(site));
});

// ── Cloudflare for SaaS: per-site custom-domain routing status ──────
router.get('/:id/domains/cf', async (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  // Bulletproof: always send a response. First reply with the DB-backed data
  // (fast, can't hang), then the client has the CNAME/TXT records immediately;
  // the optional live DNS "is the CNAME added?" check is layered on but capped
  // so it can never leave the request unanswered.
  console.log(`[domains/cf] site ${site.id}: enter`);
  let fallbackOrigin = '';
  let hostnames = [];
  try {
    fallbackOrigin = cfsaas.getConfig().fallbackOrigin;
    hostnames = cfsaas.rowsForSite(site.id).map(cfsaas.view);
  } catch (e) {
    console.error(`[domains/cf] site ${site.id}: config/rows failed: ${e.message}`);
  }
  try {
    await Promise.race([
      Promise.allSettled(hostnames.map(async (h) => {
        h.cname_detected = await cnameDetected(h.hostname, fallbackOrigin).catch(() => false);
      })),
      new Promise((r) => setTimeout(r, 8000)), // hard cap the whole DNS phase
    ]);
  } catch { /* ignore — respond with what we have */ }
  console.log(`[domains/cf] site ${site.id}: responding (${hostnames.length} hostname(s))`);
  res.json({ enabled: cfsaas.isEnabled(), fallback_origin: fallbackOrigin, hostnames });
});

// Force a re-sync (register missing hostnames, refresh their status).
router.post('/:id/domains/cf/sync', async (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  if (!cfsaas.isEnabled()) return res.status(400).json({ error: 'Cloudflare for SaaS is not configured' });
  try {
    await cfsaas.refreshStatuses();
    res.json(await cfsaas.syncDomainsForSite(site));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Custom 404: no API — the edge proxy serves a 404.html straight from the
// site's directory if the site ships one (see services/proxy notFound()).

// ── SSL (Let's Encrypt, DNS-01) ─────────────────────────────────────
const acme = require('../services/acme');

router.get('/:id/ssl', (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  res.json({ available: acme.available(), ...acme.readStatus(site.id), domains_configured: JSON.parse(site.domains || '[]') });
});

router.post('/:id/ssl/request', async (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  const domains = JSON.parse(site.domains || '[]');
  try { res.json(await acme.request(site, domains, req.user.email)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/:id/ssl/verify', async (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  try { res.json(await acme.complete(site)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/:id/ssl', (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  if (req.body.auto_renew !== undefined) acme.setAutoRenew(site.id, !!req.body.auto_renew);
  res.json({ ok: true });
});

router.delete('/:id/ssl', (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  acme.remove(site.id);
  logActivity(req.user.id, 'ssl.remove', `"${site.name}"`);
  res.json({ ok: true });
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

// All file-manager I/O is async (fs.promises) so a large operation — e.g.
// deleting a big node_modules tree — never blocks the event loop and hangs
// the whole server.
const fsp = fs.promises;

router.get('/:id/files', async (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  const dir = safePath(site, req.query.path || '');
  if (!dir) return res.status(400).json({ error: 'Invalid path' });
  try {
    await fsp.mkdir(siteRoot(site), { recursive: true });
    // withFileTypes gives name + is-directory with no per-entry stat; we then
    // stat only files (for size), sequentially, so a huge directory can't
    // exhaust file descriptors or block the event loop.
    const dirents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (dirents === null) return res.json({ path: req.query.path || '', entries: [] });
    const MAX = 2000;
    const entries = [];
    for (const d of dirents.slice(0, MAX)) {
      const isDir = d.isDirectory();
      let size = 0, mtime = 0;
      if (!isDir) {
        try { const st = await fsp.stat(path.join(dir, d.name)); size = st.size; mtime = st.mtimeMs; } catch {}
      }
      entries.push({ name: d.name, dir: isDir, size, mtime });
    }
    entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    res.json({ path: req.query.path || '', root: siteRoot(site), entries, truncated: dirents.length > MAX });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload one file (raw body). ?path=relative/name.html
router.put('/:id/files', express.raw({ type: '*/*', limit: '200mb' }), async (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  if (!req.query.path) return res.status(400).json({ error: 'path is required' });
  const dest = safePath(site, req.query.path);
  if (!dest || dest === siteRoot(site)) return res.status(400).json({ error: 'Invalid path' });
  try {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, Buffer.isBuffer(req.body) ? req.body : Buffer.from(''));
    if (site.type === 'static' && ['new', 'failed', 'stopped'].includes(site.status)) {
      db.prepare("UPDATE sites SET status = 'live' WHERE id = ?").run(site.id);
    }
    logActivity(req.user.id, 'site.upload', `"${site.name}" ← ${req.query.path}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/files/mkdir', async (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  const dir = safePath(site, req.body?.path);
  if (!dir || dir === siteRoot(site)) return res.status(400).json({ error: 'Invalid path' });
  try { await fsp.mkdir(dir, { recursive: true }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/files', async (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  const target = safePath(site, req.query.path);
  if (!target || target === siteRoot(site)) return res.status(400).json({ error: 'Invalid path' });
  try {
    await fsp.rm(target, { recursive: true, force: true });
    logActivity(req.user.id, 'site.delete-file', `"${site.name}" ✕ ${req.query.path}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', (req, res) => {
  const site = ownSite(req, res);
  if (!site) return;
  // Capture Cloudflare hostname ids before the row is gone.
  const cfIds = cfsaas.cfIdsForSite(site.id);
  procman.stop(site.id);
  if (site.ipv6_addr) ipam.removeAddr(site.ipv6_addr);
  db.prepare('DELETE FROM sites WHERE id = ?').run(site.id);
  logActivity(req.user.id, 'site.delete', `"${site.name}"`);
  // Respond immediately — the site is gone from the DB, so it disappears from
  // the UI right away. The heavy cleanup (deleting the site directory, which can
  // hold a huge node_modules tree, plus removing Cloudflare hostnames) runs in
  // the background with async I/O so it never blocks the event loop / the
  // dashboard. (rmSync here used to freeze the whole server for minutes.)
  res.json({ ok: true });
  const dir = path.join(config.sitesDir, String(site.id));
  fs.promises.rm(dir, { recursive: true, force: true })
    .catch((e) => console.error(`site delete: could not remove ${dir}: ${e.message}`));
  cfsaas.deleteIds(cfIds).catch(() => {});
  // Remove the site's dedicated isolation user (best-effort; only exists when
  // running as root with per-site isolation active).
  try { require('child_process').execFile('userdel', [`hsite${site.id}`], () => {}); } catch { /* ignore */ }
});

module.exports = router;
