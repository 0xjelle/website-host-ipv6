const express = require('express');
const { db, logActivity } = require('../db');
const { requireAuth } = require('../auth');
const billing = require('../services/billing');

// ── webhook (mounted with express.raw BEFORE express.json, so we can verify
// the signature over the exact bytes Lemon Squeezy sent) ────────────────────
function webhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!billing.verifyWebhook(raw, req.get('X-Signature'))) return res.status(401).json({ error: 'bad signature' });
  let ev;
  try { ev = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'bad json' }); }
  const name = ev.meta && ev.meta.event_name;
  const userId = ev.meta && ev.meta.custom_data && ev.meta.custom_data.user_id;
  const attrs = (ev.data && ev.data.attributes) || {};
  res.json({ ok: true }); // ack fast; do the work after

  if (!userId) return;
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return;

  if (name === 'subscription_created' || name === 'subscription_updated' || name === 'subscription_resumed') {
    const itemId = (attrs.first_subscription_item || {}).id || null;
    db.prepare(`UPDATE users SET plan = 'persite', ls_status = ?, ls_subscription_id = ?, ls_customer_id = ?, ls_item_id = COALESCE(?, ls_item_id), ls_renews_at = ? WHERE id = ?`)
      .run(attrs.status || null, String(ev.data.id || ''), String(attrs.customer_id || ''), itemId ? String(itemId) : null, attrs.renews_at || null, user.id);
    logActivity(user.id, 'billing.subscription', `${name} (${attrs.status})`);
  } else if (name === 'subscription_expired' || name === 'subscription_cancelled') {
    // On cancel, keep access until period end; on expire, drop to free.
    const dropToFree = name === 'subscription_expired';
    db.prepare('UPDATE users SET ls_status = ?, ls_renews_at = ?' + (dropToFree ? ", plan = 'free'" : '') + ' WHERE id = ?')
      .run(attrs.status || (dropToFree ? 'expired' : 'cancelled'), attrs.ends_at || attrs.renews_at || null, user.id);
    logActivity(user.id, 'billing.subscription', `${name}`);
  }
}

// ── authenticated API ───────────────────────────────────────────────
const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const u = db.prepare('SELECT ls_status, ls_renews_at FROM users WHERE id = ?').get(req.user.id);
  const count = db.prepare('SELECT COUNT(*) AS n FROM sites WHERE user_id = ?').get(req.user.id).n;
  res.json({
    configured: billing.configured(),
    subscribed: billing.subscribed(u),
    status: u.ls_status || null, renews_at: u.ls_renews_at || null,
    price_label: billing.PER_SITE.price,
    sites_used: count,
  });
});

router.post('/checkout', async (req, res) => {
  try { res.json({ url: await billing.createCheckout(req.user) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/portal', (req, res) => {
  const u = db.prepare('SELECT ls_customer_id FROM users WHERE id = ?').get(req.user.id);
  if (!u.ls_customer_id) return res.status(400).json({ error: 'No subscription to manage yet' });
  // Lemon Squeezy customer portal is available from the customer object; the
  // simplest reliable path is the "My Orders" portal link they email, so here
  // we just point to the store's billing portal.
  res.json({ url: `https://app.lemonsqueezy.com/my-orders` });
});

module.exports = { router, webhook };
