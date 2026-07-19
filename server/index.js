const express = require('express');
const path = require('path');
const config = require('./config');
const { db } = require('./db');
const procman = require('./services/procman');
const { createProxyServer } = require('./services/proxy');
const wg = require('./services/wireguard');

const app = express();
app.disable('x-powered-by');

// Webhooks need the raw body for signature verification — mount before json()
app.use('/api/webhooks', require('./routes/webhooks'));

app.use(express.json({ limit: '1mb' }));
app.get('/api/health', (req, res) => res.json({ ok: true, name: 'HexaHost', uptime: process.uptime() }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/sites', require('./routes/sites'));
app.use('/api/wireguard', require('./routes/wireguard'));
app.use('/api', require('./routes/admin'));

// Dashboard SPA
app.use(express.static(path.join(config.root, 'public')));
app.get('/{*splat}', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(config.root, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('API error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── boot ────────────────────────────────────────────────────────────
wg.getSettings();                       // ensure server keys exist
wg.syncToDisk();                        // write wg0.conf
require('./services/bird').writeConf(); // write bird.conf (BGP over tunnel)

// Resume node apps that were live before the restart
for (const site of db.prepare("SELECT * FROM sites WHERE type = 'node' AND status = 'live'").all()) {
  console.log(`↻ resuming site #${site.id} "${site.name}"`);
  try { procman.start(site, config); } catch (e) { console.error(`  failed: ${e.message}`); }
}

app.listen(config.adminPort, () => {
  console.log(`⬡ HexaHost dashboard  → http://localhost:${config.adminPort}`);
});

createProxyServer().listen(config.proxyPort, () => {
  console.log(`⬡ HexaHost edge proxy → http://localhost:${config.proxyPort} (routes by Host header)`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
