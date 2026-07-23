// Host-header reverse proxy: routes public traffic to static files or the
// internal port of a Node.js site. Zero-dependency (node:http only).
const http = require('http');
const https = require('https');
const tls = require('tls');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db } = require('../db');
const procman = require('./procman');
const { normalizeV6 } = require('./ipam');
const metrics = require('./metrics');
const cloudflare = require('./cloudflare');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wasm': 'application/wasm', '.xml': 'application/xml',
  '.map': 'application/json',
};

// Match an incoming request to a site, reporting *how* it matched:
//   'free'   — the free per-site link (<slug>.<base>, e.g. <slug>.<ip>.sslip.io,
//              or <slug>.<publicHost>)
//   'custom' — a user-added custom domain
//   'ipv6'   — the site's dedicated IPv6 address (connected-to address or Host)
// The route matters for stopped sites: a stopped site stays reachable on its
// free local link, but drops off its public custom domains + dedicated IPv6.
function matchSite(req) {
  const sites = db.prepare("SELECT * FROM sites WHERE status IN ('live','deploying','stopped')").all();

  // 1. dedicated IPv6: match the address the client actually connected to
  const local = normalizeV6(req.socket.localAddress);
  if (local) {
    for (const site of sites) {
      if (site.ipv6_addr && normalizeV6(site.ipv6_addr) === local) return { site, route: 'ipv6' };
    }
  }

  // 2. Host header (custom domains + free <slug>.<host> subdomains)
  const host = req.headers.host;
  if (!host) return null;
  // "[2a0e::1]:8080" → "2a0e::1", "example.com:8080" → "example.com"
  const bracket = host.match(/^\[([^\]]+)\]/);
  const hostname = (bracket ? bracket[1] : host.split(':')[0]).toLowerCase();
  const base = config.siteBaseDomain.toLowerCase();
  const pub = config.publicHost.toLowerCase();
  for (const site of sites) {
    const domains = JSON.parse(site.domains || '[]');
    if (domains.some(d => d.toLowerCase() === hostname)) return { site, route: 'custom' };
    if (hostname === `${site.slug}.${base}`) return { site, route: 'free' };
    if (hostname === `${site.slug}.${pub}`) return { site, route: 'free' };
    if (site.ipv6_addr && normalizeV6(hostname) === normalizeV6(site.ipv6_addr)) return { site, route: 'ipv6' };
  }
  return null;
}

// Should this match be served? Live/deploying sites serve on any route. A
// stopped site stays reachable only on its free local link (so you can still
// open its <slug>.<ip>.sslip.io URL), while its public custom domains and
// dedicated IPv6 go dark.
function isServable(match) {
  if (!match) return false;
  if (match.site.status !== 'stopped') return true;
  return match.route === 'free';
}

// Back-compat helper: the site that would actually be served for this request.
function findSite(req) {
  const match = matchSite(req);
  return isServable(match) ? match.site : null;
}

// When someone hits the bare host (the IP/domain root with no site match),
// show a small index of sites with working links instead of a 404.
function isBareHost(req) {
  const host = (req.headers.host || '').split(':')[0].replace(/^\[|\]$/g, '').toLowerCase();
  return host === config.publicHost.toLowerCase()
      || host === config.siteBaseDomain.toLowerCase()
      || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
      || host === 'localhost';
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function siteIndexPage(res) {
  const portSuffix = config.proxyPort === 80 ? '' : `:${config.proxyPort}`;
  const sites = db.prepare("SELECT * FROM sites WHERE status IN ('live','deploying','stopped') ORDER BY name").all();
  const rows = sites.map(s => {
    const url = `http://${s.slug}.${config.siteBaseDomain}${portSuffix}`;
    const tag = s.status === 'stopped' ? ' <span class="tag">stopped</span>' : '';
    return `<li><a href="${esc(url)}">${esc(s.name)}</a>${tag} <span class="u">${esc(url)}</span></li>`;
  }).join('') || '<li class="empty">No sites yet.</li>';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Hosting · sites</title>
<style>body{margin:0;min-height:100vh;background:#0b0e14;color:#e6e9f0;
font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center}
.wrap{width:100%;max-width:640px;padding:2rem}h1{font-size:1.4rem;display:flex;gap:.5rem;align-items:center}
.hex{background:linear-gradient(135deg,#7c6cff,#38d0ff);-webkit-background-clip:text;background-clip:text;color:transparent}
ul{list-style:none;padding:0;margin:1.5rem 0 0}li{padding:.8rem 1rem;border:1px solid #242c3d;border-radius:10px;
margin-bottom:.6rem;display:flex;justify-content:space-between;align-items:center;gap:1rem}
a{color:#38d0ff;text-decoration:none;font-weight:600}a:hover{text-decoration:underline}
.u{color:#626c80;font-size:.8rem;font-family:ui-monospace,monospace}.empty{color:#626c80;justify-content:center}
.tag{color:#f0b429;border:1px solid #3a2b12;background:#2a1e0c;border-radius:999px;padding:.05rem .5rem;font-size:.7rem;font-weight:600;margin-right:auto}
.sub{color:#8b93a7;font-size:.9rem;margin-top:.3rem}</style></head>
<body><div class="wrap"><h1><span class="hex">⬡</span> Hosting</h1>
<div class="sub">Sites served from this server:</div><ul>${rows}</ul></div></body></html>`);
}

function errorPage(res, code, title, message) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${code} · Hosting</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:system-ui,sans-serif;background:#0b0e14;color:#e6e9f0}
.card{text-align:center;padding:3rem}h1{font-size:4rem;margin:0;background:linear-gradient(135deg,#7c6cff,#38d0ff);
-webkit-background-clip:text;background-clip:text;color:transparent}p{color:#8b93a7}</style></head>
<body><div class="card"><h1>${code}</h1><h2>${title}</h2><p>${message}</p></div></body></html>`);
}

function serveStatic(site, req, res) {
  const workDir = path.join(procman.siteWorkDir(site, config), site.static_dir || '');
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch { return errorPage(res, 400, 'Bad request', 'Malformed URL.'); }

  let filePath = path.normalize(path.join(workDir, urlPath));
  if (!filePath.startsWith(path.normalize(workDir))) {
    return errorPage(res, 403, 'Forbidden', 'Path traversal is not allowed.');
  }
  let stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  if (stat?.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  }
  if (!stat) {
    // SPA fallback: serve root index.html for extension-less paths
    if (!path.extname(urlPath)) {
      const fallback = path.join(workDir, 'index.html');
      if (fs.existsSync(fallback)) { filePath = fallback; stat = fs.statSync(fallback); }
    }
    if (!stat) return errorPage(res, 404, 'Not found', 'This page does not exist on this site.');
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  if (req.method === 'HEAD') return res.end();
  metrics.bytes(site.id, stat.size);
  fs.createReadStream(filePath).pipe(res);
}

function proxyToApp(site, req, res) {
  // Behind Cloudflare the immediate peer is a Cloudflare edge IP; recover the
  // real visitor address + scheme so the site's app sees the true client.
  const cf = cloudflare.clientInfo(req);
  const opts = {
    host: '127.0.0.1',
    port: site.app_port,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      'x-forwarded-for': cf.ip,
      'x-forwarded-proto': cf.proto,
      'x-forwarded-host': req.headers.host || '',
    },
  };
  const upstream = http.request(opts, (ur) => {
    res.writeHead(ur.statusCode || 502, ur.headers);
    let n = 0;
    ur.on('data', (d) => { n += d.length; });
    ur.on('end', () => metrics.bytes(site.id, n));
    ur.pipe(res);
  });
  upstream.on('error', () => {
    errorPage(res, 502, 'App unavailable', 'The application is starting up or has crashed. Try again shortly.');
  });
  req.pipe(upstream);
}

function handleRequest(req, res) {
  cloudflare.clientInfo(req); // recover real client IP + tally Cloudflare vs. direct
  const match = matchSite(req);
  if (!isServable(match)) {
    if (isBareHost(req)) return siteIndexPage(res);
    return errorPage(res, 404, 'No site here', `No site is configured for <b>${(req.headers.host || 'this host').split(':')[0]}</b>.`);
  }
  const { site } = match;
  // Stopped sites are served exactly like live ones on their free local link
  // (node apps keep running so you can test them; static files serve from
  // disk) — isServable() has already kept them off their public routes.
  metrics.hit(site.id);
  if (site.type === 'node') return proxyToApp(site, req, res);
  return serveStatic(site, req, res);
}

function handleUpgrade(req, socket) {
  const match = matchSite(req);
  if (!isServable(match) || match.site.type !== 'node') return socket.destroy();
  const site = match.site;
  const cf = cloudflare.clientInfo(req);
  const upstream = http.request({
    host: '127.0.0.1', port: site.app_port, path: req.url, method: req.method,
    headers: { ...req.headers, 'x-forwarded-for': cf.ip, 'x-forwarded-proto': cf.proto, 'x-forwarded-host': req.headers.host || '' },
  });
  upstream.on('upgrade', (ur, upSocket, upHead) => {
    let head = `HTTP/1.1 101 Switching Protocols\r\n`;
    for (let i = 0; i < ur.rawHeaders.length; i += 2) head += `${ur.rawHeaders[i]}: ${ur.rawHeaders[i + 1]}\r\n`;
    socket.write(head + '\r\n');
    if (upHead?.length) socket.write(upHead);
    upSocket.pipe(socket); socket.pipe(upSocket);
    socket.on('error', () => upSocket.destroy());
    upSocket.on('error', () => socket.destroy());
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
}

// ── TLS cert store (SNI) ────────────────────────────────────────────
const contexts = new Map(); // hostname -> tls.SecureContext
let defaultContext = null;

function ensureDefaultCert() {
  const dir = path.join(config.dataDir, 'certs', '_default');
  const crt = path.join(dir, 'default.crt'), key = path.join(dir, 'default.key');
  if (!fs.existsSync(crt) || !fs.existsSync(key)) {
    fs.mkdirSync(dir, { recursive: true });
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
        '-subj', '/CN=hosting.local', '-keyout', key, '-out', crt], { stdio: 'ignore' });
    } catch { return null; }
  }
  return { crt, key };
}

function reloadCerts() {
  contexts.clear();
  let acme;
  try { acme = require('./acme'); } catch { return; }
  for (const c of acme.activeCerts()) {
    try {
      const ctx = tls.createSecureContext({ cert: c.cert, key: c.key });
      for (const d of c.domains) contexts.set(d.toLowerCase(), ctx);
    } catch (e) { console.error('cert load failed:', e.message); }
  }
  console.log(`⬡ TLS: loaded certificates for ${contexts.size} domain(s)`);
}

function createTlsProxyServer() {
  const def = ensureDefaultCert();
  if (!def) { console.log('TLS disabled (openssl unavailable for the default cert)'); return null; }
  reloadCerts();
  const server = https.createServer({
    cert: fs.readFileSync(def.crt),
    key: fs.readFileSync(def.key),
    SNICallback: (servername, cb) => cb(null, contexts.get((servername || '').toLowerCase()) || undefined),
  }, handleRequest);
  server.on('upgrade', handleUpgrade);
  return server;
}

function createProxyServer() {
  const server = http.createServer(handleRequest);
  server.on('upgrade', handleUpgrade);
  return server;
}

module.exports = { createProxyServer, createTlsProxyServer, reloadCerts, findSite };
