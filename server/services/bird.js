// Server-side BGP over the WireGuard tunnel, powered by BIRD2.
//
// Hosting renders a bird.conf with one BGP session per BGP-enabled peer
// (neighbor = the peer's tunnel address, over wg0). Import filters only
// accept the prefixes registered for that peer, and accepted routes are
// exported to the kernel so traffic follows the announcement. Peers can
// upload a custom BIRD snippet which is parse-checked with `bird -p`
// before it is included.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const config = require('../config');
const { db } = require('./../db');
const wg = require('./wireguard');

const birdDir = path.join(config.dataDir, 'bird');
fs.mkdirSync(birdDir, { recursive: true });

const asnDigits = (asn) => String(asn || '').toUpperCase().replace(/^AS/, '');
const customPath = (peerId) => path.join(birdDir, `peer_${peerId}_custom.conf`);

function bgpPeers() {
  return db.prepare('SELECT * FROM wg_peers WHERE enabled = 1 AND bgp_enabled = 1').all()
    .filter(p => p.asn && (p.routed_v6 || p.routed_v4));
}

function renderConf() {
  const s = wg.getSettings();
  const serverAsn = asnDigits(s.server_asn);
  const routerId = s.tunnel_v4.split('/')[0];
  const serverV6 = s.tunnel_v6.split('/')[0];
  const serverV4 = s.tunnel_v4.split('/')[0];

  let conf = `# Hosting BIRD2 config — generated ${new Date().toISOString()}
# BGP sessions run over the WireGuard tunnel (wg0).
router id ${routerId};
log syslog all;

protocol device { }

protocol kernel kernel6 {
  ipv6 { export where source = RTS_BGP; };
}
protocol kernel kernel4 {
  ipv4 { export where source = RTS_BGP; };
}
`;

  if (!serverAsn) {
    conf += '\n# Server ASN is not set — no BGP sessions are configured.\n'
          + '# Set it in the dashboard: Network / VPN → Server settings.\n';
  }

  for (const p of bgpPeers()) {
    if (!serverAsn) break;
    const peerAsn = asnDigits(p.asn);
    const peerV6 = p.addr_v6.split('/')[0];
    const peerV4 = p.addr_v4.split('/')[0];
    conf += `
# ── peer #${p.id} "${p.name}" (AS${peerAsn}) ────────────────────
`;
    if (p.routed_v6) {
      conf += `filter hx_peer${p.id}_in_v6 {
  if net ~ [ ${p.routed_v6}+ ] then accept;
  reject;
}
protocol bgp hx_peer${p.id}_v6 {
  description "Hosting peer ${p.id}: ${p.name.replace(/"/g, "'")} (v6)";
  local ${serverV6} as ${serverAsn};
  neighbor ${peerV6} as ${peerAsn};
  hold time 90;
  ipv6 { import filter hx_peer${p.id}_in_v6; export none; };
}
`;
    }
    if (p.routed_v4) {
      conf += `filter hx_peer${p.id}_in_v4 {
  if net ~ [ ${p.routed_v4}+ ] then accept;
  reject;
}
protocol bgp hx_peer${p.id}_v4 {
  description "Hosting peer ${p.id}: ${p.name.replace(/"/g, "'")} (v4)";
  local ${serverV4} as ${serverAsn};
  neighbor ${peerV4} as ${peerAsn};
  hold time 90;
  ipv4 { import filter hx_peer${p.id}_in_v4; export none; };
}
`;
    }
    if (p.bird_custom && p.bird_custom.trim()) {
      conf += `include "${customPath(p.id)}";\n`;
    }
  }
  return conf;
}

function writeConf() {
  // (re)write custom snippets, drop stale ones
  const wanted = new Set();
  for (const p of bgpPeers()) {
    if (p.bird_custom && p.bird_custom.trim()) {
      fs.writeFileSync(customPath(p.id), p.bird_custom, { mode: 0o644 });
      wanted.add(path.basename(customPath(p.id)));
    }
  }
  for (const f of fs.readdirSync(birdDir)) {
    if (/^peer_\d+_custom\.conf$/.test(f) && !wanted.has(f)) fs.unlinkSync(path.join(birdDir, f));
  }
  const confPath = path.join(birdDir, 'bird.conf');
  fs.writeFileSync(confPath, renderConf(), { mode: 0o644 });
  return confPath;
}

// Parse-check a candidate custom snippet (with the full generated config
// around it) using `bird -p` before accepting it.
function validateCandidate(peerId, customText, cb) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-bird-'));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  try {
    const peer = db.prepare('SELECT * FROM wg_peers WHERE id = ?').get(peerId);
    const candidateCustom = path.join(tmp, `peer_${peerId}_custom.conf`);
    fs.writeFileSync(candidateCustom, customText || '# empty');
    // render the real conf but point this peer's include at the candidate
    let conf = renderConf();
    if (peer && !(peer.bgp_enabled && peer.bird_custom)) {
      // peer not yet included — append the candidate include so it gets parsed
      conf += `\ninclude "${candidateCustom}";\n`;
    } else {
      conf = conf.replace(customPath(peerId), candidateCustom);
    }
    const candidateConf = path.join(tmp, 'bird.conf');
    fs.writeFileSync(candidateConf, conf);
    execFile('bird', ['-p', '-c', candidateConf], (err, stdout, stderr) => {
      cleanup();
      if (!err) return cb({ ok: true, checked: true });
      if (err.code === 'ENOENT') return cb({ ok: true, checked: false, note: 'bird binary not found — config accepted without parse check' });
      cb({ ok: false, checked: true, error: (stderr || stdout || err.message).trim().split('\n').slice(-4).join('\n') });
    });
  } catch (e) {
    cleanup();
    cb({ ok: false, checked: false, error: e.message });
  }
}

// Apply the current config to a running BIRD via birdc, best effort.
function applyLive(cb) {
  const confPath = writeConf();
  execFile('birdc', ['configure'], (err, stdout, stderr) => {
    if (err) {
      const reason = err.code === 'ENOENT'
        ? 'birdc not available — config written to disk only'
        : `birdc configure failed: ${(stderr || stdout || err.message).trim().split('\n').pop()}`;
      return cb({ applied: false, reason, confPath });
    }
    cb({ applied: /Reconfigured|Reconfiguration in progress/i.test(stdout), confPath, output: stdout.trim().split('\n').pop() });
  });
}

// Live session status: { [peerId]: { v6: {state, info}, v4: {...} } }
function status(cb) {
  execFile('birdc', ['show', 'protocols'], (err, stdout) => {
    if (err) return cb({ available: false, sessions: {} });
    const sessions = {};
    for (const line of stdout.split('\n')) {
      const m = line.match(/^hx_peer(\d+)_v([46])\s+BGP\s+\S+\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
      if (!m) continue;
      const [, id, fam, state, , info] = m;
      sessions[id] = sessions[id] || {};
      sessions[id]['v' + fam] = { state, info: (info || '').trim() };
    }
    cb({ available: true, sessions });
  });
}

module.exports = { renderConf, writeConf, validateCandidate, applyLive, status, birdDir };
