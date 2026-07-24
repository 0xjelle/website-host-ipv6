const express = require('express');
const path = require('path');
const config = require('./config');
const { db } = require('./db');
const procman = require('./services/procman');
const { createProxyServer } = require('./services/proxy');
const wg = require('./services/wireguard');

const app = express();
app.disable('x-powered-by');

// Webhooks need the raw body for signature verification - mount before json()
app.use('/api/webhooks', require('./routes/webhooks'));
app.post('/api/billing/webhook', express.raw({ type: '*/*' }), require('./routes/billing').webhook);

app.use(express.json({ limit: '1mb' }));
app.get('/api/health', (req, res) => res.json({ ok: true, name: 'Hosting', uptime: process.uptime() }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/sites', require('./routes/sites'));
app.use('/api/wireguard', require('./routes/wireguard'));
app.use('/api/github', require('./routes/github'));
app.use('/api/certs', require('./routes/certs'));
app.use('/api/cloudflare', require('./routes/cloudflare'));
app.use('/api/billing', require('./routes/billing').router);
app.use('/api/status', require('./routes/status')); // public - no auth
app.use('/api', require('./routes/admin'));

// Public status + legal pages
app.get('/status', (req, res) => res.sendFile(path.join(config.root, 'public', 'status.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(config.root, 'public', 'terms.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(config.root, 'public', 'privacy.html')));

// Dashboard SPA. Serve the HTML/JS with no-cache so a deploy is picked up
// immediately - otherwise a stale app.js (in the browser or a CDN in front)
// keeps running old frontend code after an update.
app.use(express.static(path.join(config.root, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(html|js)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  },
}));
app.get('/{*splat}', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(config.root, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('API error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── boot ────────────────────────────────────────────────────────────
wg.getSettings();                        // ensure server keys exist
wg.syncToDisk();                         // write wg0.conf
require('./services/bird').writeConf();  // write bird.conf (BGP over tunnel)
require('./services/ipam').applyAll();   // re-attach site IPv6 addresses + the Cloudflare fallback origin
require('./services/uplink').applyBoot(); // reconnect provider BGP tunnel if configured
require('./services/metrics').start();    // system + traffic sampling for charts
require('./services/sftp').start();       // built-in SFTP server for file uploads
require('./services/poller').start();     // poll GitHub for pushes (auto-deploy behind NAT)
require('./services/acme').startRenewals(); // stage SSL renewals before expiry
require('./services/cloudflare').start();   // load Cloudflare edge IP ranges (real client IP behind CF)
require('./services/cfsaas').start();       // poll Cloudflare-for-SaaS custom hostname statuses
// Validate the Stripe price/product up front so a misconfiguration shows in the
// log at boot instead of failing when a customer clicks Subscribe.
(() => {
  const b = require('./services/billing');
  if (!b.configured()) return;
  b.resolvePrice()
    .then((p) => console.log(`⬡ Billing: Stripe ready (per-site price ${p}, billed on day ${b.ANCHOR_DAY})`))
    .catch((e) => console.error(`⚠ Billing misconfigured: ${e.message}\n   ${b.keyInfo()}`));
})();

// Resume apps that were running before the restart (reaping any process groups
// a previous platform run left behind so ports are free). Stopped apps keep
// running locally for testing, so they're resumed too. In container mode static
// sites are containerised as well, so resume them too; otherwise only node.
const resumeStatic = procman.useContainers();
const resumeRows = db.prepare(
  `SELECT * FROM sites WHERE status IN ('live','stopped') AND (type = 'node'${resumeStatic ? " OR type = 'static'" : ''})`
).all();
for (const site of resumeRows) {
  console.log(`↻ resuming site #${site.id} "${site.name}"`);
  procman.reapStale(site);
  try { procman.start(site, config); } catch (e) { console.error(`  failed: ${e.message}`); }
}

app.listen(config.adminPort, () => {
  console.log(`⬡ Hosting dashboard  → http://localhost:${config.adminPort}`);
});

createProxyServer().listen(config.proxyPort, () => {
  console.log(`⬡ Hosting edge proxy → http://localhost:${config.proxyPort} (routes by Host header)`);
});

const tlsServer = require('./services/proxy').createTlsProxyServer();
if (tlsServer) {
  tlsServer.on('error', (e) => console.error(`TLS proxy error: ${e.message}`));
  tlsServer.listen(config.proxyTlsPort, () => {
    console.log(`⬡ Hosting TLS proxy  → https://localhost:${config.proxyTlsPort} (SNI, Let's Encrypt)`);
  });
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// Safety net: a stray error in a background task (a site's process, a tunnel
// hook, an API call) must never take the whole dashboard down. Log and keep
// serving rather than crash-looping.
process.on('uncaughtException', (err) => console.error('uncaughtException (kept running):', err.stack || err.message));
process.on('unhandledRejection', (reason) => console.error('unhandledRejection (kept running):', reason));
