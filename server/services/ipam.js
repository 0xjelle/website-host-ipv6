// IPv6 address management for sites: hands each site a dedicated address
// out of the admin-configured pool (a chunk of the operator's IPv6 block
// that is routed to this server), attaches it to a network interface, and
// lets the edge proxy route by destination address.
const { execFile } = require('child_process');
const { db, logActivity } = require('../db');

// ── address math ────────────────────────────────────────────────────
function normalizeV6(addr) {
  if (!addr) return null;
  let a = String(addr).toLowerCase().split('%')[0].replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  if (!a.includes(':')) {
    // plain IPv4 — valid dotted quad or nothing
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(a) && a.split('.').every(o => +o <= 255) ? a : null;
  }
  const [l, r = ''] = a.split('::');
  const head = l ? l.split(':') : [];
  const tail = r ? r.split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (a.includes('::') && fill < 0) return null;
  const groups = a.includes('::')
    ? [...head, ...Array(Math.max(fill, 0)).fill('0'), ...tail]
    : head;
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map(g => g.padStart(4, '0')).join(':');
}

const v6ToBig = (norm) => norm.split(':').reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n);

function bigToV6(b) {
  const groups = [];
  for (let i = 0; i < 8; i++) { groups.unshift((b & 0xffffn).toString(16)); b >>= 16n; }
  // compress the first longest run of zero groups
  const s = groups.join(':');
  const runs = s.match(/(?:^|:)0(?::0)+(?::|$)/g) || [];
  if (!runs.length) return s;
  const longest = runs.sort((x, y) => y.length - x.length)[0];
  return s.replace(longest, '::');
}

// ── pool ────────────────────────────────────────────────────────────
function getPool() {
  const s = db.prepare('SELECT site_v6_pool, site_v6_iface FROM wg_settings WHERE id = 1').get();
  if (!s?.site_v6_pool) return null;
  const [prefix, bitsStr] = s.site_v6_pool.split('/');
  const bits = parseInt(bitsStr, 10);
  const norm = normalizeV6(prefix);
  if (!norm || isNaN(bits) || bits < 1 || bits > 124) return null;
  const base = (v6ToBig(norm) >> BigInt(128 - bits)) << BigInt(128 - bits);
  return { cidr: s.site_v6_pool, base, bits, size: 1n << BigInt(128 - bits), iface: s.site_v6_iface || '' };
}

function nextAddr() {
  const pool = getPool();
  if (!pool) return null;
  const used = new Set(
    db.prepare('SELECT ipv6_addr FROM sites WHERE ipv6_addr IS NOT NULL').all()
      .map(r => normalizeV6(r.ipv6_addr)).filter(Boolean)
  );
  for (let n = 1n; n < pool.size && n < 65536n; n++) { // ::1 upward, cap the scan
    const candidate = bigToV6(pool.base + n);
    if (!used.has(normalizeV6(candidate))) return candidate;
  }
  return null;
}

// ── interface plumbing (best effort) ────────────────────────────────
function detectIface(cb) {
  const pool = getPool();
  if (pool?.iface) return cb(pool.iface);
  execFile('ip', ['-6', 'route', 'show', 'default'], (err, out) => {
    let m = !err && out.match(/\bdev\s+(\S+)/);
    if (m) return cb(m[1]);
    execFile('ip', ['route', 'show', 'default'], (err2, out2) => {
      m = !err2 && out2.match(/\bdev\s+(\S+)/);
      cb(m ? m[1] : 'lo');
    });
  });
}

function applyAddr(addr, cb = () => {}) {
  detectIface((iface) => {
    execFile('ip', ['-6', 'addr', 'replace', `${addr}/128`, 'dev', iface], (err) => {
      cb(err ? { applied: false, reason: `ip addr failed on ${iface}: ${err.message.split('\n')[0]}` } : { applied: true, iface });
    });
  });
}

function removeAddr(addr) {
  if (!addr) return;
  detectIface((iface) => execFile('ip', ['-6', 'addr', 'del', `${addr}/128`, 'dev', iface], () => {}));
}

// ── site assignment ─────────────────────────────────────────────────
function assignToSite(siteId) {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  if (!site || site.ipv6_addr) return site?.ipv6_addr || null;
  const addr = nextAddr();
  if (!addr) return null;
  db.prepare('UPDATE sites SET ipv6_addr = ? WHERE id = ?').run(addr, siteId);
  applyAddr(addr);
  logActivity(site.user_id, 'site.ipv6', `"${site.name}" got dedicated IPv6 ${addr}`);
  return addr;
}

// Give every address-less site an IPv6 (called when the pool is set/changed)
function backfill() {
  if (!getPool()) return 0;
  let n = 0;
  for (const s of db.prepare('SELECT id FROM sites WHERE ipv6_addr IS NULL').all()) {
    if (assignToSite(s.id)) n++;
  }
  return n;
}

// Re-attach all assigned addresses (on boot)
function applyAll() {
  for (const s of db.prepare('SELECT ipv6_addr FROM sites WHERE ipv6_addr IS NOT NULL').all()) {
    applyAddr(s.ipv6_addr);
  }
}

module.exports = { normalizeV6, getPool, nextAddr, assignToSite, backfill, applyAll, applyAddr, removeAddr };
