const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const root = path.join(__dirname, '..');

// Load a local .env file if present (no dependency needed).
// Values are trimmed and unquoted: a trailing space or a wrapping quote pasted
// into a secret used to survive into the value, which then either failed auth
// or made Node reject the HTTP header built from it.
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const rawLine of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    const q = val[0];
    if ((q === '"' || q === "'") && val.length > 1) {
      // Quoted: take the quoted span, ignore anything after it (e.g. a comment).
      const end = val.indexOf(q, 1);
      val = end > 0 ? val.slice(1, end) : val.slice(1);
    } else {
      // Unquoted: a trailing "# ..." is a comment, not part of the value. Only
      // strip when the # follows whitespace, so values containing a # (say a
      // password like a#b) survive intact.
      const c = val.search(/\s#/);
      if (c >= 0) val = val.slice(0, c).trim();
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

const dataDir = path.resolve(root, process.env.DATA_DIR || './data');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'sites'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'wireguard'), { recursive: true });

// Persist an auto-generated JWT secret so sessions survive restarts even
// when the operator hasn't set one explicitly.
let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret === 'change-me-to-a-long-random-string') {
  const secretFile = path.join(dataDir, '.jwt-secret');
  if (fs.existsSync(secretFile)) {
    jwtSecret = fs.readFileSync(secretFile, 'utf8').trim();
  } else {
    jwtSecret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(secretFile, jwtSecret, { mode: 0o600 });
  }
}

module.exports = {
  root,
  dataDir,
  sitesDir: path.join(dataDir, 'sites'),
  wgDir: path.join(dataDir, 'wireguard'),
  dbFile: (() => {
    // migrate a database created under the old product name
    const oldDb = path.join(dataDir, 'hexahost.db');
    const newDb = path.join(dataDir, 'hosting.db');
    if (fs.existsSync(oldDb) && !fs.existsSync(newDb)) {
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(oldDb + suffix)) fs.renameSync(oldDb + suffix, newDb + suffix);
      }
    }
    return newDb;
  })(),
  adminPort: parseInt(process.env.ADMIN_PORT || '3000', 10),
  proxyPort: parseInt(process.env.PROXY_PORT || '8080', 10),
  proxyTlsPort: parseInt(process.env.PROXY_TLS_PORT || '443', 10),
  publicHost: process.env.PUBLIC_HOST || 'localhost',
  // Base domain for the free per-site subdomains. A bare IP can't have a
  // label prefixed (jelle-md.192.168.1.226 resolves to nothing), so fall
  // back to sslip.io wildcard DNS: <slug>.<ip>.sslip.io → <ip>. Override
  // with SITE_BASE_DOMAIN to use your own wildcard domain (*.apps.example).
  siteBaseDomain: (() => {
    if (process.env.SITE_BASE_DOMAIN) return process.env.SITE_BASE_DOMAIN;
    const h = process.env.PUBLIC_HOST || 'localhost';
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) ? `${h}.sslip.io` : h;
  })(),
  appPortBase: parseInt(process.env.APP_PORT_BASE || '20100', 10),
  sftpPort: parseInt(process.env.SFTP_PORT || '2222', 10),
  jwtSecret,
};
