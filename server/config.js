const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const root = path.join(__dirname, '..');

// Load a local .env file if present (no dependency needed)
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
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
  dbFile: path.join(dataDir, 'hexahost.db'),
  adminPort: parseInt(process.env.ADMIN_PORT || '3000', 10),
  proxyPort: parseInt(process.env.PROXY_PORT || '8080', 10),
  publicHost: process.env.PUBLIC_HOST || 'localhost',
  appPortBase: parseInt(process.env.APP_PORT_BASE || '20100', 10),
  jwtSecret,
};
