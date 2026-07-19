const express = require('express');
const { db, logActivity } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const wg = require('../services/wireguard');
const bird = require('../services/bird');
const ipam = require('../services/ipam');

const router = express.Router();
router.use(requireAuth);

function ownPeer(req, res) {
  const peer = db.prepare('SELECT * FROM wg_peers WHERE id = ?').get(req.params.id);
  if (!peer) { res.status(404).json({ error: 'Peer not found' }); return null; }
  if (peer.user_id !== req.user.id && req.user.role !== 'admin') {
    res.status(403).json({ error: 'Not your peer' }); return null;
  }
  return peer;
}

const peerView = (p) => ({
  id: p.id, name: p.name, public_key: p.public_key,
  addr_v4: p.addr_v4, addr_v6: p.addr_v6,
  routed_v6: p.routed_v6, routed_v4: p.routed_v4, asn: p.asn,
  bgp_enabled: !!p.bgp_enabled, bird_custom: p.bird_custom || '',
  enabled: !!p.enabled, created_at: p.created_at, user_id: p.user_id,
});

router.get('/', (req, res) => {
  const s = wg.getSettings();
  const peers = req.user.role === 'admin' && req.query.all === '1'
    ? db.prepare('SELECT p.*, u.email AS owner_email FROM wg_peers p JOIN users u ON u.id = p.user_id ORDER BY p.id').all()
    : db.prepare('SELECT * FROM wg_peers WHERE user_id = ? ORDER BY id').all(req.user.id);
  bird.status((bgp) => res.json({
    server: {
      public_key: s.public_key, endpoint: s.endpoint, listen_port: s.listen_port,
      tunnel_v4: s.tunnel_v4, tunnel_v6: s.tunnel_v6, dns: s.dns,
      server_asn: s.server_asn || '',
      site_v6_pool: s.site_v6_pool || '', site_v6_iface: s.site_v6_iface || '',
    },
    peers: peers.map(p => ({ ...peerView(p), owner_email: p.owner_email })),
    bgp,
  }));
});

router.post('/peers', (req, res) => {
  const { name, routed_v6, routed_v4, asn } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Peer name is required' });
  if (!wg.validCidr(routed_v6, 6)) return res.status(400).json({ error: 'routed_v6 must be a valid IPv6 CIDR, e.g. 2a0e:8f02:f01f::/48' });
  if (!wg.validCidr(routed_v4, 4)) return res.status(400).json({ error: 'routed_v4 must be a valid IPv4 CIDR, e.g. 203.0.113.0/29' });
  if (!wg.validAsn(asn)) return res.status(400).json({ error: 'ASN must look like AS211234 or 211234' });

  const kp = wg.genKeypair();
  const addrs = wg.nextPeerAddrs();
  const r = db.prepare(`INSERT INTO wg_peers
    (user_id, name, private_key, public_key, preshared_key, addr_v4, addr_v6, routed_v6, routed_v4, asn)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, name.trim(), kp.privateKey, kp.publicKey, wg.genPresharedKey(),
      addrs.addr_v4, addrs.addr_v6, routed_v6 || null, routed_v4 || null, asn || null);
  const peer = db.prepare('SELECT * FROM wg_peers WHERE id = ?').get(r.lastInsertRowid);
  logActivity(req.user.id, 'wg.peer.create', `"${peer.name}"${peer.routed_v6 ? ` routing ${peer.routed_v6}` : ''}${peer.asn ? ` (${peer.asn})` : ''}`);
  wg.applyLive((result) => res.status(201).json({ peer: peerView(peer), wireguard: result }));
});

router.get('/peers/:id/config', (req, res) => {
  const peer = ownPeer(req, res);
  if (!peer) return;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="hexahost-${peer.name.replace(/[^a-zA-Z0-9-]/g, '_')}.conf"`);
  res.send(wg.renderClientConf(peer));
});

router.get('/peers/:id/bird', (req, res) => {
  const peer = ownPeer(req, res);
  if (!peer) return;
  const conf = wg.renderBirdConf(peer);
  if (!conf) return res.status(400).json({ error: 'Peer needs both an ASN and a routed IPv6 prefix for a BGP config' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(conf);
});

router.patch('/peers/:id', (req, res) => {
  const peer = ownPeer(req, res);
  if (!peer) return;
  const b = req.body || {};
  if (b.routed_v6 !== undefined && !wg.validCidr(b.routed_v6, 6)) return res.status(400).json({ error: 'Invalid IPv6 CIDR' });
  if (b.routed_v4 !== undefined && !wg.validCidr(b.routed_v4, 4)) return res.status(400).json({ error: 'Invalid IPv4 CIDR' });
  if (b.asn !== undefined && !wg.validAsn(b.asn)) return res.status(400).json({ error: 'Invalid ASN' });
  db.prepare(`UPDATE wg_peers SET
      name = COALESCE(?, name),
      routed_v6 = CASE WHEN ? THEN ? ELSE routed_v6 END,
      routed_v4 = CASE WHEN ? THEN ? ELSE routed_v4 END,
      asn       = CASE WHEN ? THEN ? ELSE asn END,
      enabled   = COALESCE(?, enabled)
    WHERE id = ?`)
    .run(b.name?.trim() || null,
      b.routed_v6 !== undefined ? 1 : 0, b.routed_v6 || null,
      b.routed_v4 !== undefined ? 1 : 0, b.routed_v4 || null,
      b.asn !== undefined ? 1 : 0, b.asn || null,
      b.enabled === undefined ? null : (b.enabled ? 1 : 0),
      peer.id);
  logActivity(req.user.id, 'wg.peer.update', `"${peer.name}"`);
  bird.applyLive(() => {});
  wg.applyLive((result) => res.json({ peer: peerView(db.prepare('SELECT * FROM wg_peers WHERE id = ?').get(peer.id)), wireguard: result }));
});

// Enable/disable the server-side BGP session and upload a custom BIRD
// snippet. Uploads are parse-checked with `bird -p` before being applied.
router.post('/peers/:id/bgp', (req, res) => {
  const peer = ownPeer(req, res);
  if (!peer) return;
  const b = req.body || {};
  const enable = b.bgp_enabled === undefined ? !!peer.bgp_enabled : !!b.bgp_enabled;
  const custom = b.bird_custom === undefined ? (peer.bird_custom || '') : String(b.bird_custom).slice(0, 100_000);

  if (enable && !peer.asn) return res.status(400).json({ error: 'Set an ASN on this peer first (edit the peer)' });
  if (enable && !peer.routed_v6 && !peer.routed_v4) {
    return res.status(400).json({ error: 'Add a routed IPv6 or IPv4 prefix to this peer first — that is what the BGP session will accept' });
  }

  const save = (validation) => {
    db.prepare('UPDATE wg_peers SET bgp_enabled = ?, bird_custom = ? WHERE id = ?')
      .run(enable ? 1 : 0, custom || null, peer.id);
    logActivity(req.user.id, 'wg.bgp.update',
      `"${peer.name}" BGP ${enable ? 'enabled' : 'disabled'}${custom ? ' + custom config' : ''}`);
    bird.applyLive((birdResult) => res.json({
      peer: peerView(db.prepare('SELECT * FROM wg_peers WHERE id = ?').get(peer.id)),
      validation, bird: birdResult,
    }));
  };

  if (custom.trim()) {
    bird.validateCandidate(peer.id, custom, (v) => {
      if (!v.ok) return res.status(400).json({ error: `BIRD config rejected:\n${v.error}` });
      save(v);
    });
  } else save({ ok: true, checked: false });
});

router.get('/bgp/status', (req, res) => {
  bird.status((s) => {
    if (req.user.role !== 'admin') {
      const mine = new Set(db.prepare('SELECT id FROM wg_peers WHERE user_id = ?').all(req.user.id).map(r => String(r.id)));
      s.sessions = Object.fromEntries(Object.entries(s.sessions).filter(([id]) => mine.has(id)));
    }
    res.json(s);
  });
});

router.delete('/peers/:id', (req, res) => {
  const peer = ownPeer(req, res);
  if (!peer) return;
  db.prepare('DELETE FROM wg_peers WHERE id = ?').run(peer.id);
  logActivity(req.user.id, 'wg.peer.delete', `"${peer.name}"`);
  bird.applyLive(() => {});
  wg.applyLive((result) => res.json({ ok: true, wireguard: result }));
});

// ── admin: server settings ──────────────────────────────────────────
router.patch('/server', requireAdmin, (req, res) => {
  const b = req.body || {};
  const s = wg.getSettings();
  const port = b.listen_port !== undefined ? parseInt(b.listen_port, 10) : s.listen_port;
  if (isNaN(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'Invalid listen port' });
  if (b.server_asn !== undefined && !wg.validAsn(b.server_asn)) return res.status(400).json({ error: 'Server ASN must look like AS64512 or 64512' });
  if (b.site_v6_pool !== undefined && b.site_v6_pool !== '') {
    if (!wg.validCidr(b.site_v6_pool, 6)) return res.status(400).json({ error: 'Site IPv6 pool must be a valid IPv6 CIDR, e.g. 2a0e:8f02:f01f:100::/64' });
    if (parseInt(b.site_v6_pool.split('/')[1], 10) > 124) return res.status(400).json({ error: 'Pool prefix must be /124 or larger to hold site addresses' });
  }
  db.prepare('UPDATE wg_settings SET listen_port = ?, endpoint = ?, dns = ?, server_asn = ?, site_v6_pool = ?, site_v6_iface = ? WHERE id = 1')
    .run(port, b.endpoint !== undefined ? b.endpoint : s.endpoint,
      b.dns !== undefined ? b.dns : s.dns,
      b.server_asn !== undefined ? b.server_asn : s.server_asn,
      b.site_v6_pool !== undefined ? b.site_v6_pool : (s.site_v6_pool || ''),
      b.site_v6_iface !== undefined ? b.site_v6_iface : (s.site_v6_iface || ''));
  logActivity(req.user.id, 'wg.server.update', `port ${port}${b.server_asn !== undefined ? `, ASN ${b.server_asn || '(cleared)'}` : ''}${b.site_v6_pool !== undefined ? `, site pool ${b.site_v6_pool || '(cleared)'}` : ''}`);
  const assigned = ipam.backfill(); // give existing sites an address right away
  if (assigned) logActivity(req.user.id, 'site.ipv6', `auto-assigned dedicated IPv6 to ${assigned} existing site(s)`);
  bird.applyLive(() => {});
  wg.applyLive((result) => res.json({ server: wg.getSettings(), wireguard: result, ipv6_assigned: assigned }));
});

router.get('/server/bird-config', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="bird.conf"');
  res.send(bird.renderConf());
});

router.get('/server/config', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="wg0.conf"');
  res.send(wg.renderServerConf());
});

module.exports = router;
