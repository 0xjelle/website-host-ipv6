// Cloudflare edge integration (DDoS protection).
//
// The platform's own domain and its free per-site subdomains (<slug>.<host>)
// are meant to be put *behind* Cloudflare - the DNS records are "orange-clouded"
// (proxied) in the Cloudflare dashboard, so every visitor hits Cloudflare's edge
// first and Cloudflare's always-on DDoS protection filters the traffic before it
// ever reaches this server. That setup lives in Cloudflare's dashboard, not here.
//
// What *this* module does is make the edge proxy behave correctly once that's on:
// when a request arrives from Cloudflare, the immediate TCP peer is a Cloudflare
// edge IP and the real visitor's address is in the `CF-Connecting-IP` header. We
//   • know Cloudflare's published IP ranges (v4 + v6), refreshable at runtime;
//   • recover the real client IP + scheme - but ONLY when the connection genuinely
//     originates from a Cloudflare address, so a direct attacker can't spoof
//     `CF-Connecting-IP` to forge their source;
//   • count how many requests arrive via Cloudflare vs. directly, so the dashboard
//     can confirm the setup is actually live.
const fs = require('fs');
const path = require('path');
const https = require('https');
const net = require('net');
const config = require('../config');
const { getSetting, setSetting } = require('../db');

// Cloudflare's published edge ranges - www.cloudflare.com/ips-v4 · /ips-v6.
// Bundled so protection works with no outbound call on a fresh install; the
// admin can refresh them from Cloudflare at any time (they change rarely).
const DEFAULT_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const DEFAULT_V6 = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

const rangesFile = path.join(config.dataDir, 'cloudflare-ips.json');

let v4 = DEFAULT_V4.slice();
let v6 = DEFAULT_V6.slice();
let fetchedAt = null;   // ISO string when ranges were last pulled from Cloudflare
let source = 'bundled'; // 'bundled' | 'cloudflare' | 'disk'
let compiled = [];      // precompiled [{ v, prefix, bits }] for the hot path

// live counters (in-memory; reset on restart) so the dashboard can show that
// traffic really is arriving through Cloudflare
let viaCount = 0;
let directCount = 0;
let lastViaAt = null;

// ── IP / CIDR maths (v4 + v6, no dependencies) ──────────────────────

// Parse an address to a BigInt. IPv4 and IPv4-mapped IPv6 (::ffff:1.2.3.4)
// collapse to a 32-bit value so they match the v4 range list; real IPv6
// becomes a 128-bit value. Returns null for anything unparseable.
function parseIp(input) {
  let ip = String(input || '').trim();
  if (!ip) return null;
  const pct = ip.indexOf('%'); if (pct >= 0) ip = ip.slice(0, pct);       // strip zone id
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);        // strip brackets
  const fam = net.isIP(ip);
  if (fam === 4) return { v: v4ToBigInt(ip), bits: 32 };
  if (fam === 6) {
    const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (mapped) return { v: v4ToBigInt(mapped[1]), bits: 32 };
    return { v: v6ToBigInt(ip), bits: 128 };
  }
  return null;
}

function v4ToBigInt(ip) {
  let v = 0n;
  for (const o of ip.split('.')) v = (v << 8n) | BigInt(parseInt(o, 10) & 0xff);
  return v;
}

function v6ToBigInt(ip) {
  // Fold a trailing embedded IPv4 quad (e.g. 64:ff9b::1.2.3.4) into two hextets.
  ip = ip.replace(/(\d{1,3}(?:\.\d{1,3}){3})$/, (quad) => {
    const o = quad.split('.').map(Number);
    return (((o[0] << 8) | o[1]).toString(16)) + ':' + (((o[2] << 8) | o[3]).toString(16));
  });
  const [headStr, tailStr] = ip.includes('::') ? ip.split('::') : [ip, null];
  const head = headStr ? headStr.split(':') : [];
  const tail = tailStr ? tailStr.split(':') : [];
  const full = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  let v = 0n;
  for (const h of full) v = (v << 16n) | BigInt(parseInt(h || '0', 16) & 0xffff);
  return v;
}

function compileCidr(cidr) {
  const [netAddr, prefixStr] = String(cidr).split('/');
  const parsed = parseIp(netAddr);
  const prefix = parseInt(prefixStr, 10);
  if (!parsed || !Number.isInteger(prefix) || prefix < 0 || prefix > parsed.bits) return null;
  return { v: parsed.v, prefix, bits: parsed.bits };
}

function recompile() {
  compiled = [...v4, ...v6].map(compileCidr).filter(Boolean);
}

function inCidr(ipParsed, c) {
  if (!ipParsed || ipParsed.bits !== c.bits) return false;
  const shift = BigInt(c.bits - c.prefix);
  return (ipParsed.v >> shift) === (c.v >> shift);
}

// Is this address inside any Cloudflare range?
function isCloudflareIP(ip) {
  const p = parseIp(ip);
  if (!p) return false;
  for (const c of compiled) if (inCidr(p, c)) return true;
  return false;
}

// ── trust setting ───────────────────────────────────────────────────
// On by default; guarded by the source-IP check regardless, so leaving it on
// is safe even when not behind Cloudflare. Admin can turn it off, and an env
// override (TRUST_CLOUDFLARE=0) forces it off for a deployment.
function trustEnabled() {
  if (String(process.env.TRUST_CLOUDFLARE) === '0') return false;
  return getSetting('cf_trust', '1') !== '0';
}
function setTrust(on) { setSetting('cf_trust', on ? '1' : '0'); }

// ── per-request client info ─────────────────────────────────────────
// Returns the real visitor's { ip, proto, viaCloudflare }. Cached on the req so
// repeated calls (handleRequest + proxyToApp) don't double-count.
function clientInfo(req) {
  if (req._cfInfo) return req._cfInfo;
  const peer = req.socket.remoteAddress || '';
  const encrypted = !!(req.socket && req.socket.encrypted);
  let info;
  if (trustEnabled() && isCloudflareIP(peer)) {
    let proto = encrypted ? 'https' : 'http';
    const visitor = req.headers['cf-visitor'];
    if (visitor) { try { proto = JSON.parse(visitor).scheme || proto; } catch { /* ignore */ } }
    const cfip = String(req.headers['cf-connecting-ip'] || '').trim();
    info = { ip: cfip || firstForwarded(req) || peer, proto, viaCloudflare: true };
    viaCount++; lastViaAt = Date.now();
  } else {
    info = { ip: peer, proto: encrypted ? 'https' : 'http', viaCloudflare: false };
    directCount++;
  }
  req._cfInfo = info;
  return info;
}

// leftmost entry of an existing X-Forwarded-For chain (the original client)
function firstForwarded(req) {
  const xff = req.headers['x-forwarded-for'];
  if (!xff) return null;
  return String(xff).split(',')[0].trim() || null;
}

// ── refresh from Cloudflare ─────────────────────────────────────────
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10_000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url} → HTTP ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 100_000) req.destroy(new Error('response too large')); });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error(`${url} timed out`)));
    req.on('error', reject);
  });
}

const CIDR_V4 = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
const CIDR_V6 = /^[0-9a-f:]+\/\d{1,3}$/i;

async function refreshRanges() {
  const [t4, t6] = await Promise.all([
    fetchText('https://www.cloudflare.com/ips-v4'),
    fetchText('https://www.cloudflare.com/ips-v6'),
  ]);
  const parse = (text, re) => text.split(/\s+/).map(s => s.trim()).filter(s => re.test(s));
  const n4 = parse(t4, CIDR_V4);
  const n6 = parse(t6, CIDR_V6);
  if (!n4.length || !n6.length) throw new Error('Cloudflare returned no usable ranges');
  v4 = n4; v6 = n6; fetchedAt = new Date().toISOString(); source = 'cloudflare';
  recompile();
  try {
    fs.writeFileSync(rangesFile, JSON.stringify({ v4, v6, fetchedAt }, null, 2));
  } catch (e) { console.error('cloudflare: could not persist ranges:', e.message); }
  console.log(`⬡ Cloudflare: refreshed ranges (${v4.length} v4 · ${v6.length} v6)`);
  return { v4count: v4.length, v6count: v6.length, fetchedAt };
}

// ── status for the dashboard ────────────────────────────────────────
function status() {
  return {
    trust: trustEnabled(),
    env_forced_off: String(process.env.TRUST_CLOUDFLARE) === '0',
    v4, v6,
    count: v4.length + v6.length,
    fetched_at: fetchedAt,
    source,
    seen: { via_cloudflare: viaCount, direct: directCount, last_via_at: lastViaAt },
  };
}

// ── boot ────────────────────────────────────────────────────────────
function loadFromDisk() {
  try {
    if (!fs.existsSync(rangesFile)) return false;
    const j = JSON.parse(fs.readFileSync(rangesFile, 'utf8'));
    if (Array.isArray(j.v4) && Array.isArray(j.v6) && j.v4.length && j.v6.length) {
      v4 = j.v4; v6 = j.v6; fetchedAt = j.fetchedAt || null; source = 'disk';
      return true;
    }
  } catch (e) { console.error('cloudflare: could not read cached ranges:', e.message); }
  return false;
}

function start() {
  loadFromDisk();
  recompile();
  // Keep the ranges fresh in the background (best-effort; failures are ignored).
  setInterval(() => { refreshRanges().catch(() => {}); }, 7 * 24 * 3600_000).unref();
}

recompile(); // usable immediately on require, before start()

module.exports = {
  start, isCloudflareIP, clientInfo, refreshRanges, status,
  trustEnabled, setTrust,
};
