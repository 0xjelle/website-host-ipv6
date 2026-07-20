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

// Extract the mergeable parts of a provider BIRD config (BGPTunnel/iFog
// etc.): keep protocol bgp/static, filters, functions, templates and
// defines; drop router id, log, device/kernel/direct protocols, which our
// managed config already provides and would clash on.
function extractUplinkBird(text) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const kept = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    while (i < n && /\s/.test(src[i])) i++;
    if (i >= n) break;
    if (src[i] === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    const start = i;
    let depth = 0, inStr = false, closed = false;
    while (i < n && !closed) {
      const c = src[i];
      if (inStr) { if (c === '"') inStr = false; i++; continue; }
      if (c === '"') { inStr = true; i++; continue; }
      if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          i++;
          while (i < n && /\s/.test(src[i])) i++;
          if (src[i] === ';') i++;
          closed = true;
          continue;
        }
      } else if (c === ';' && depth === 0) { i++; closed = true; continue; }
      i++;
    }
    const stmt = src.slice(start, i).trim();
    if (/^(protocol\s+(bgp|static)\b|filter\b|function\b|template\s+bgp\b|define\b)/.test(stmt)) kept.push(stmt);
  }
  return kept.join('\n\n');
}

const uplinkConfPath = () => path.join(birdDir, 'uplink.conf');

function uplinkSettings() {
  const s = db.prepare('SELECT uplink_bird, uplink_enabled FROM wg_settings WHERE id = 1').get() || {};
  return { bird: s.uplink_bird || '', enabled: !!s.uplink_enabled };
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

# NB: kernel export is OFF on purpose. Importing a full-table uplink feed
# and pushing it into the Linux routing table hijacks the server's default
# route and knocks it off the network. We only need to ORIGINATE prefixes
# (that happens on the BGP session's export filter); routing to WireGuard
# peers is already handled by each tunnel's AllowedIPs. Egress for your own
# site prefixes via an uplink is done with source policy routing on the
# WireGuard interface, not by installing the DFZ here.
protocol kernel kernel6 {
  ipv6 { export none; };
}
protocol kernel kernel4 {
  ipv4 { export none; };
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

  const uplink = uplinkSettings();
  if (uplink.enabled && uplink.bird.trim()) {
    conf += `\n# ── uplink: provider BGP tunnel (announce your prefix upstream) ──\ninclude "${uplinkConfPath()}";\n`;
  }
  return conf;
}

function writeConf() {
  const uplink = uplinkSettings();
  if (uplink.bird.trim()) {
    fs.writeFileSync(uplinkConfPath(),
      `# extracted from the provider's BIRD config — managed by Hosting\n${extractUplinkBird(uplink.bird)}\n`,
      { mode: 0o644 });
  } else if (fs.existsSync(uplinkConfPath())) {
    fs.unlinkSync(uplinkConfPath());
  }
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

// Parse-check a candidate uplink BIRD config (extracted, inside the full
// generated config) with `bird -p` before accepting it.
function validateUplink(birdText, cb) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-uplink-'));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  try {
    const extracted = extractUplinkBird(birdText);
    if (!extracted.trim()) {
      cleanup();
      return cb({ ok: false, checked: false, error: 'No usable BGP/static/filter sections found in that config' });
    }
    const candidateUplink = path.join(tmp, 'uplink.conf');
    fs.writeFileSync(candidateUplink, extracted + '\n');
    let conf = renderConf();
    // point (or add) the uplink include at the candidate
    if (conf.includes(uplinkConfPath())) conf = conf.replace(uplinkConfPath(), candidateUplink);
    else conf += `\ninclude "${candidateUplink}";\n`;
    const candidateConf = path.join(tmp, 'bird.conf');
    fs.writeFileSync(candidateConf, conf);
    execFile('bird', ['-p', '-c', candidateConf], (err, stdout, stderr) => {
      cleanup();
      if (!err) return cb({ ok: true, checked: true, extracted });
      if (err.code === 'ENOENT') return cb({ ok: true, checked: false, extracted, note: 'bird binary not found — config accepted without parse check' });
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

// Live session status: peer sessions keyed by id, plus uplink (provider)
// BGP protocols — any BGP protocol that isn't one of our hx_peer sessions.
function status(cb) {
  execFile('birdc', ['show', 'protocols'], (err, stdout) => {
    if (err) return cb({ available: false, sessions: {}, uplink: [] });
    const sessions = {};
    const uplink = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/^(\S+)\s+BGP\s+\S+\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
      if (!m) continue;
      const [, name, state, , info] = m;
      const peer = name.match(/^hx_peer(\d+)_v([46])$/);
      if (peer) {
        sessions[peer[1]] = sessions[peer[1]] || {};
        sessions[peer[1]]['v' + peer[2]] = { state, info: (info || '').trim() };
      } else {
        uplink.push({ name, state, info: (info || '').trim() });
      }
    }
    cb({ available: true, sessions, uplink });
  });
}

module.exports = { renderConf, writeConf, validateCandidate, validateUplink, applyLive, status, extractUplinkBird, birdDir };
