// Uplink: connect this server OUT to a BGP tunnel provider (BGPTunnel/iFog,
// Route48-style services, or your own upstream). The provider gives you two
// files — a WireGuard client config and a BIRD config. We bring the tunnel
// up as a client (interface "uplink") and merge the useful parts of their
// BIRD config into our managed bird.conf, so the server announces your
// prefix from your ASN and receives your IPv6 space.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');
const { db } = require('../db');

const IFACE = 'uplink';
const wgConfPath = () => path.join(config.wgDir, `${IFACE}.conf`);

function getState() {
  const s = db.prepare('SELECT uplink_wg, uplink_bird, uplink_enabled FROM wg_settings WHERE id = 1').get() || {};
  return { wg: s.uplink_wg || '', bird: s.uplink_bird || '', enabled: !!s.uplink_enabled };
}

// Safety: a provider config with AllowedIPs = ::/0 or 0.0.0.0/0 and no
// Table setting would let wg-quick replace the server's default route and
// cut it off. Routes should come from BIRD, so pin Table = off.
function sanitizeWgConf(text) {
  let t = String(text).replace(/\r\n/g, '\n').trim() + '\n';
  let note = null;
  if (!/^\s*Table\s*=/mi.test(t) && /^\s*AllowedIPs\s*=.*(::\/0|0\.0\.0\.0\/0)/mi.test(t)) {
    t = t.replace(/\[Interface\]/i, '[Interface]\nTable = off');
    note = 'Added "Table = off" so the tunnel cannot hijack the server\'s default route (BIRD manages routing instead)';
  }
  return { conf: t, note };
}

function writeWgConf() {
  const { wg } = getState();
  if (!wg) return null;
  // Recreate from scratch: a stale file from a previous (possibly
  // non-root) run can carry ownership/permissions that break wg-quick.
  try { fs.unlinkSync(wgConfPath()); } catch {}
  fs.writeFileSync(wgConfPath(), wg, { mode: 0o600 });
  return wgConfPath();
}

function up(cb) {
  const p = writeWgConf();
  if (!p) return cb({ up: false, reason: 'No uplink WireGuard config uploaded yet' });
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    return cb({ up: false, reason: 'Hosting is not running as root, so it cannot manage WireGuard. Start it via the service (sudo systemctl restart hosting) instead of npm start.' });
  }
  execFile('wg-quick', ['up', p], (err, stdout, stderr) => {
    const out = `${stdout || ''}${stderr || ''}`;
    if (err && !/already exists/i.test(out)) {
      const reason = err.code === 'ENOENT'
        ? 'wg-quick not available on this server'
        : `wg-quick up failed: ${out.trim().split('\n').pop()}`;
      return cb({ up: false, reason });
    }
    cb({ up: true });
  });
}

function down(cb) {
  const p = wgConfPath();
  if (!fs.existsSync(p)) return cb({ down: true });
  execFile('wg-quick', ['down', p], (err, stdout, stderr) => {
    const out = `${stdout || ''}${stderr || ''}`;
    if (err && !/is not a WireGuard interface|does not exist/i.test(out) && err.code !== 'ENOENT') {
      return cb({ down: false, reason: out.trim().split('\n').pop() });
    }
    cb({ down: true });
  });
}

function status(cb) {
  execFile('wg', ['show', IFACE], (err, stdout) => {
    if (err) return cb({ up: false });
    const handshake = (stdout.match(/latest handshake:\s*(.+)/) || [])[1] || null;
    const endpoint = (stdout.match(/endpoint:\s*(.+)/) || [])[1] || null;
    const transfer = (stdout.match(/transfer:\s*(.+)/) || [])[1] || null;
    cb({ up: true, handshake, endpoint, transfer });
  });
}

// Bring the tunnel up on boot if configured + enabled (best effort)
function applyBoot() {
  const { wg, enabled } = getState();
  if (wg) writeWgConf();
  if (wg && enabled) up((r) => { if (!r.up) console.log(`uplink: ${r.reason}`); });
}

module.exports = { IFACE, getState, sanitizeWgConf, writeWgConf, up, down, status, applyBoot, wgConfPath };
