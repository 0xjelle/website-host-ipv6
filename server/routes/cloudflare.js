const express = require('express');
const { logActivity } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const config = require('../config');
const cf = require('../services/cloudflare');
const saas = require('../services/cfsaas');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// A bare IP or an .sslip.io address can't be put behind Cloudflare - Cloudflare
// only proxies real domains. Surface that so the dashboard can warn the admin.
function looksLikeRealDomain(h) {
  h = String(h || '').toLowerCase();
  return !!h && h !== 'localhost' && h.includes('.')
    && !/^\d{1,3}(\.\d{1,3}){3}$/.test(h) && !/\.sslip\.io$/.test(h);
}

router.get('/', (req, res) => {
  res.json({
    ...cf.status(),
    public_host: config.publicHost,
    site_base_domain: config.siteBaseDomain,
    host_is_real_domain: looksLikeRealDomain(config.publicHost),
    base_is_real_domain: looksLikeRealDomain(config.siteBaseDomain),
    proxy_port: config.proxyPort,
    tls_port: config.proxyTlsPort,
  });
});

router.patch('/', (req, res) => {
  if (req.body && req.body.trust !== undefined) {
    cf.setTrust(!!req.body.trust);
    logActivity(req.user.id, 'cloudflare.trust', req.body.trust ? 'enabled' : 'disabled');
  }
  res.json(cf.status());
});

router.post('/refresh', async (req, res) => {
  try {
    const r = await cf.refreshRanges();
    logActivity(req.user.id, 'cloudflare.refresh', `${r.v4count} v4 · ${r.v6count} v6 ranges`);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(502).json({ error: `Could not refresh from Cloudflare: ${e.message}` });
  }
});

// ── Cloudflare for SaaS (users' own custom domains) ─────────────────
router.get('/saas', (req, res) => {
  const c = saas.getConfig();
  res.json({
    enabled: c.enabled,
    zone_id: c.zoneId,
    account_id: c.accountId,
    origin_ip: c.originIp,
    fallback_origin: c.fallbackOrigin,
    has_token: saas.hasToken(),
    hostnames: saas.allHostnames(),
  });
});

router.patch('/saas', async (req, res) => {
  const b = req.body || {};
  saas.saveConfig({
    enabled: b.enabled,
    zoneId: b.zone_id,
    accountId: b.account_id,
    originIp: b.origin_ip,
    fallbackOrigin: b.fallback_origin,
    token: b.token, // undefined = leave, '' = clear, value = set (encrypted)
  });
  logActivity(req.user.id, 'cloudflare.saas.config', `enabled=${saas.isEnabled()}`);
  // Best-effort: create/update the proxied fallback-origin DNS record, then
  // point Cloudflare's fallback origin at it. Each step reports its own note so
  // a partial failure is visible without blocking the save.
  const notes = [];
  const c = saas.getConfig();
  if (c.enabled && c.token && c.zoneId && c.fallbackOrigin) {
    if (c.originIp) {
      try { const r = await saas.ensureFallbackOriginRecord(); if (r.ok) notes.push(`Fallback-origin DNS record ${r.action} (${r.type}, proxied).`); }
      catch (e) { notes.push(`Could not create the fallback-origin DNS record: ${e.message}`); }
    } else {
      notes.push('Tip: set the origin IP so the proxied fallback-origin DNS record can be created automatically.');
    }
    try { await saas.setFallbackOrigin(c.fallbackOrigin); }
    catch (e) { notes.push(`Setting the fallback origin failed: ${e.message}`); }
  }
  res.json({ ok: true, note: notes.join(' ') || null, enabled: saas.isEnabled() });
});

router.post('/saas/test', async (req, res) => {
  const b = req.body || {};
  try {
    // Use the posted token if present, else the stored one.
    const token = b.token && String(b.token).trim() ? String(b.token).trim() : saas.getConfig().token;
    const r = await saas.testConfig(token, b.zone_id || saas.getConfig().zoneId, b.account_id || saas.getConfig().accountId);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/saas/refresh', async (req, res) => {
  try { await saas.refreshStatuses(); res.json({ ok: true, hostnames: saas.allHostnames() }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

module.exports = router;
