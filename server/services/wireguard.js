// WireGuard management: native Curve25519 keygen (node:crypto), peer IP
// allocation, server/client config generation, BIRD2 BGP snippets, and
// best-effort live application via `wg`/`wg-quick` when available.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');
const { db } = require('../db');
const wgdir = require('./wgdir');

// ── keys ────────────────────────────────────────────────────────────
function genKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey: priv.toString('base64'), publicKey: pub.toString('base64') };
}
const genPresharedKey = () => crypto.randomBytes(32).toString('base64');

// ── settings ────────────────────────────────────────────────────────
function getSettings() {
  let s = db.prepare('SELECT * FROM wg_settings WHERE id = 1').get();
  if (!s) {
    const kp = genKeypair();
    db.prepare(`INSERT INTO wg_settings (id, private_key, public_key, endpoint)
                VALUES (1, ?, ?, ?)`).run(kp.privateKey, kp.publicKey, config.publicHost);
    s = db.prepare('SELECT * FROM wg_settings WHERE id = 1').get();
  }
  return s;
}

// ── IP allocation inside the tunnel subnets ─────────────────────────
function nextPeerAddrs() {
  const used = db.prepare('SELECT addr_v4 FROM wg_peers').all()
    .map(p => parseInt(p.addr_v4.split('.')[3], 10))
    .filter(n => !isNaN(n));
  let host = 2;
  while (used.includes(host)) host++;
  if (host > 254) throw new Error('Tunnel subnet exhausted (253 peers max)');
  const s = getSettings();
  const v4base = s.tunnel_v4.split('/')[0].split('.').slice(0, 3).join('.');
  const v6base = s.tunnel_v6.split('/')[0].replace(/::.*$/, '::');
  return { addr_v4: `${v4base}.${host}/32`, addr_v6: `${v6base}${host.toString(16)}/128` };
}

// ── validation ──────────────────────────────────────────────────────
function validCidr(value, family) {
  if (!value) return true;
  const [addr, len] = value.split('/');
  if (!len || isNaN(parseInt(len, 10))) return false;
  const bits = parseInt(len, 10);
  try {
    if (family === 6) {
      if (!/^[0-9a-fA-F:]+$/.test(addr) || !addr.includes(':')) return false;
      return bits >= 1 && bits <= 128;
    }
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) return false;
    if (addr.split('.').some(o => parseInt(o, 10) > 255)) return false;
    return bits >= 1 && bits <= 32;
  } catch { return false; }
}
const validAsn = (v) => !v || /^(AS)?\d{1,10}$/i.test(v);

// ── config rendering ────────────────────────────────────────────────
function renderServerConf() {
  const s = getSettings();
  const peers = db.prepare('SELECT * FROM wg_peers WHERE enabled = 1').all();
  let conf = `# Hosting WireGuard server config - generated ${new Date().toISOString()}
[Interface]
PrivateKey = ${s.private_key}
Address = ${s.tunnel_v4}, ${s.tunnel_v6}
ListenPort = ${s.listen_port}
# Enable forwarding so routed prefixes work:
PostUp = sysctl -w net.ipv4.ip_forward=1 net.ipv6.conf.all.forwarding=1
`;
  for (const p of peers) {
    const allowed = [p.addr_v4, p.addr_v6];
    if (p.routed_v4) allowed.push(p.routed_v4);
    if (p.routed_v6) allowed.push(p.routed_v6);
    conf += `
[Peer]
# ${p.name} (peer #${p.id})${p.asn ? ` - ${p.asn.toUpperCase().startsWith('AS') ? p.asn.toUpperCase() : 'AS' + p.asn}` : ''}
PublicKey = ${p.public_key}
PresharedKey = ${p.preshared_key}
AllowedIPs = ${allowed.join(', ')}
`;
  }
  return conf;
}

function renderClientConf(peer) {
  const s = getSettings();
  const addresses = [peer.addr_v4, peer.addr_v6];
  if (peer.routed_v6) addresses.push(peer.routed_v6);
  if (peer.routed_v4) addresses.push(peer.routed_v4);
  const serverV4 = s.tunnel_v4.split('/')[0];
  const serverV6 = s.tunnel_v6.split('/')[0];
  return `# Hosting WireGuard - peer "${peer.name}"
[Interface]
PrivateKey = ${peer.private_key}
Address = ${addresses.join(', ')}
${s.dns ? `DNS = ${s.dns}\n` : ''}
[Peer]
PublicKey = ${s.public_key}
PresharedKey = ${peer.preshared_key}
Endpoint = ${s.endpoint || config.publicHost}:${s.listen_port}
# Route the tunnel subnets through the VPN. Change to 0.0.0.0/0, ::/0
# if you want ALL traffic through the tunnel.
AllowedIPs = ${serverV4}/24, ${serverV6}/64
PersistentKeepalive = 25
`;
}

function renderBirdConf(peer) {
  if (!peer.asn || !(peer.routed_v6 || peer.routed_v4)) return null;
  const s = getSettings();
  const asn = peer.asn.toUpperCase().replace(/^AS/, '');
  const serverAsn = String(s.server_asn || '').toUpperCase().replace(/^AS/, '');
  const peerV6 = peer.addr_v6.split('/')[0];
  const peerV4 = peer.addr_v4.split('/')[0];
  const serverV6 = s.tunnel_v6.split('/')[0];
  const serverV4 = s.tunnel_v4.split('/')[0];
  let conf = `# BIRD2 config - YOUR side of the Hosting tunnel (the WireGuard client).
# Announces ${[peer.routed_v6, peer.routed_v4].filter(Boolean).join(' + ')} from AS${asn}
# to the Hosting server${serverAsn ? ` (AS${serverAsn})` : ''} over the tunnel.
# Bring the WireGuard tunnel up first, then: bird -c this-file.conf

router id ${peerV4};
log syslog all;

protocol device { }
`;
  if (peer.routed_v6) conf += `
protocol static announce_v6 {
  ipv6;
  route ${peer.routed_v6} unreachable;   # originate your prefix
}

protocol bgp hosting_v6 {
  local ${peerV6} as ${asn};
  neighbor ${serverV6} as ${serverAsn || '<SERVER_ASN - ask your admin to set it>'};
  hold time 90;
  ipv6 {
    import none;
    export where source = RTS_STATIC;    # only announce your own prefix
  };
}
`;
  if (peer.routed_v4) conf += `
protocol static announce_v4 {
  ipv4;
  route ${peer.routed_v4} unreachable;
}

protocol bgp hosting_v4 {
  local ${peerV4} as ${asn};
  neighbor ${serverV4} as ${serverAsn || '<SERVER_ASN - ask your admin to set it>'};
  hold time 90;
  ipv4 {
    import none;
    export where source = RTS_STATIC;
  };
}
`;
  return conf;
}

// ── best-effort live application ────────────────────────────────────
function wgConfPath() { return wgdir.dataPath('wg0'); }
let wg0Arg = 'wg0'; // bare name (/etc/wireguard) or full path fallback

function syncToDisk() {
  const conf = renderServerConf();
  const r = wgdir.writeIface('wg0', conf);
  wg0Arg = r.arg;
  return r.path;
}

function applyLive(cb) {
  const confPath = syncToDisk();
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    return cb({ applied: false, reason: 'config written to disk; not running as root so it was not applied live (use the systemd service)', confPath });
  }
  execFile('wg-quick', ['strip', wg0Arg], (err, stripped) => {
    if (err) return cb({ applied: false, reason: 'wg-quick not available - config written to disk only', confPath });
    const tmp = path.join(config.wgDir, 'wg0.stripped.conf');
    fs.writeFileSync(tmp, stripped, { mode: 0o600 });
    execFile('wg', ['syncconf', 'wg0', tmp], (err2) => {
      if (err2) return cb({ applied: false, reason: `wg syncconf failed (is interface wg0 up?): ${err2.message}`, confPath });
      cb({ applied: true, confPath });
    });
  });
}

module.exports = {
  genKeypair, genPresharedKey, getSettings, nextPeerAddrs,
  validCidr, validAsn,
  renderServerConf, renderClientConf, renderBirdConf,
  syncToDisk, applyLive,
};
