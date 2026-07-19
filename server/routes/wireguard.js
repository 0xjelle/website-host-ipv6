const express = require('express');
const { db, logActivity } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const wg = require('../services/wireguard');

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
  enabled: !!p.enabled, created_at: p.created_at, user_id: p.user_id,
});

router.get('/', (req, res) => {
  const s = wg.getSettings();
  const peers = req.user.role === 'admin' && req.query.all === '1'
    ? db.prepare('SELECT p.*, u.email AS owner_email FROM wg_peers p JOIN users u ON u.id = p.user_id ORDER BY p.id').all()
    : db.prepare('SELECT * FROM wg_peers WHERE user_id = ? ORDER BY id').all(req.user.id);
  res.json({
    server: {
      public_key: s.public_key, endpoint: s.endpoint, listen_port: s.listen_port,
      tunnel_v4: s.tunnel_v4, tunnel_v6: s.tunnel_v6, dns: s.dns,
    },
    peers: peers.map(p => ({ ...peerView(p), owner_email: p.owner_email })),
  });
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
  wg.applyLive((result) => res.json({ peer: peerView(db.prepare('SELECT * FROM wg_peers WHERE id = ?').get(peer.id)), wireguard: result }));
});

router.delete('/peers/:id', (req, res) => {
  const peer = ownPeer(req, res);
  if (!peer) return;
  db.prepare('DELETE FROM wg_peers WHERE id = ?').run(peer.id);
  logActivity(req.user.id, 'wg.peer.delete', `"${peer.name}"`);
  wg.applyLive((result) => res.json({ ok: true, wireguard: result }));
});

// ── admin: server settings ──────────────────────────────────────────
router.patch('/server', requireAdmin, (req, res) => {
  const b = req.body || {};
  const s = wg.getSettings();
  const port = b.listen_port !== undefined ? parseInt(b.listen_port, 10) : s.listen_port;
  if (isNaN(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'Invalid listen port' });
  db.prepare('UPDATE wg_settings SET listen_port = ?, endpoint = ?, dns = ? WHERE id = 1')
    .run(port, b.endpoint !== undefined ? b.endpoint : s.endpoint, b.dns !== undefined ? b.dns : s.dns);
  logActivity(req.user.id, 'wg.server.update', `port ${port}`);
  wg.applyLive((result) => res.json({ server: wg.getSettings(), wireguard: result }));
});

router.get('/server/config', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="wg0.conf"');
  res.send(wg.renderServerConf());
});

module.exports = router;
