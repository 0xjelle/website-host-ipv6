// Uplink: connect this server OUT to a BGP tunnel provider (BGPTunnel/iFog,
// Route48-style services, or your own upstream). The provider gives you two
// files - a WireGuard client config and a BIRD config. We bring the tunnel
// up as a client (interface "uplink") and merge the useful parts of their
// BIRD config into our managed bird.conf, so the server announces your
// prefix from your ASN and receives your IPv6 space.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');
const { db } = require('../db');
const wgdir = require('./wgdir');

const IFACE = 'uplink';
const wgConfPath = () => wgdir.dataPath(IFACE);
let ifaceArg = IFACE; // what to pass to wg-quick (bare name or full path)

function getState() {
  const s = db.prepare('SELECT uplink_wg, uplink_bird, uplink_enabled FROM wg_settings WHERE id = 1').get() || {};
  return { wg: s.uplink_wg || '', bird: s.uplink_bird || '', enabled: !!s.uplink_enabled };
}

// Prepare the provider WireGuard config so the uplink never hijacks the
// box's default route:
//   1. Table = off  → wg-quick installs no routes (a ::/0 AllowedIPs would
//      otherwise replace the default route and cut the server off).
//   2. Source policy routing → traffic FROM the server's own IPv6 site pool
//      egresses the tunnel (so your announced prefix is reachable both ways),
//      while all other traffic keeps using the normal LAN default. Added as
//      PostUp/PostDown so it's set up and torn down with the interface.
const RT_TABLE = 480;
function sanitizeWgConf(text) {
  const notes = [];
  let t = String(text).replace(/\r\n/g, '\n').trim() + '\n';

  if (!/^\s*Table\s*=/mi.test(t)) {
    t = t.replace(/\[Interface\]/i, '[Interface]\nTable = off');
    notes.push('Added "Table = off" so the tunnel cannot replace the server\'s default route');
  }

  const pool = (db.prepare('SELECT site_v6_pool FROM wg_settings WHERE id = 1').get() || {}).site_v6_pool;
  if (pool && !/PostUp\s*=.*lookup/i.test(t)) {
    const up = `ip -6 rule add from ${pool} lookup ${RT_TABLE} pref ${RT_TABLE}; ip -6 route replace default dev %i table ${RT_TABLE}`;
    const down = `ip -6 rule del from ${pool} lookup ${RT_TABLE} pref ${RT_TABLE}; ip -6 route flush table ${RT_TABLE}`;
    t = t.replace(/\[Interface\]/i, `[Interface]\nPostUp = ${up}\nPostDown = ${down}`);
    notes.push(`Source-routing traffic from your site pool (${pool}) out the tunnel, leaving the box's own default route untouched`);
  }
  return { conf: t, note: notes.join('; ') || null };
}

function writeWgConf() {
  const { wg } = getState();
  if (!wg) return null;
  // Re-apply safety rules (Table=off + source policy routing) on every write.
  // sanitizeWgConf is idempotent, so this upgrades a config stored before the
  // policy-routing fix without needing the operator to re-upload it.
  const { conf } = sanitizeWgConf(wg);
  // Write into /etc/wireguard so wg-quick (AppArmor-confined) can read it.
  const r = wgdir.writeIface(IFACE, conf);
  ifaceArg = r.arg;
  return r.path;
}

function up(cb) {
  const p = writeWgConf();
  if (!p) return cb({ up: false, reason: 'No uplink WireGuard config uploaded yet' });
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    return cb({ up: false, reason: 'Hosting is not running as root, so it cannot manage WireGuard. Start it via the service (sudo systemctl restart hosting) instead of npm start.' });
  }
  // Bring it down first (ignore result) so a re-apply picks up config changes.
  execFile('wg-quick', ['down', ifaceArg], () => {
    execFile('wg-quick', ['up', ifaceArg], (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`;
      if (err && !/already exists/i.test(out)) {
        const reason = err.code === 'ENOENT'
          ? 'wg-quick not available on this server'
          : `wg-quick up failed: ${out.trim().split('\n').pop()}`;
        return cb({ up: false, reason });
      }
      cb({ up: true });
    });
  });
}

function down(cb) {
  if (!fs.existsSync(wgConfPath())) return cb({ down: true });
  execFile('wg-quick', ['down', ifaceArg], (err, stdout, stderr) => {
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
