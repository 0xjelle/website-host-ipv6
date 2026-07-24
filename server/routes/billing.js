const express = require('express');
const { db, logActivity } = require('../db');
const { requireAuth } = require('../auth');
const billing = require('../services/billing');

// ── webhook (mounted with express.raw BEFORE express.json, so the signature can
// be verified over the exact bytes Stripe sent) ─────────────────────────────
function webhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!billing.verifyWebhook(raw, req.get('Stripe-Signature'))) {
    return res.status(400).json({ error: 'bad signature' });
  }
  let ev;
  try { ev = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'bad json' }); }
  res.json({ received: true }); // ack fast; Stripe retries on non-2xx
  handle(ev).catch((e) => console.error(`billing webhook ${ev.type}:`, e.message));
}

// Resolve the local user for an event: prefer explicit metadata, fall back to
// the Stripe customer id we already stored.
function findUser(obj) {
  const uid = (obj.metadata && obj.metadata.user_id) || obj.client_reference_id;
  if (uid) {
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(uid);
    if (u) return u;
  }
  const cust = typeof obj.customer === 'string' ? obj.customer : null;
  if (cust) return db.prepare('SELECT id FROM users WHERE bill_customer_id = ?').get(cust) || null;
  return null;
}

const iso = (unix) => (unix ? new Date(unix * 1000).toISOString() : null);

function saveSubscription(userId, sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  db.prepare(`UPDATE users SET plan = 'persite', bill_status = ?, bill_subscription_id = ?,
      bill_customer_id = COALESCE(?, bill_customer_id), bill_item_id = COALESCE(?, bill_item_id),
      bill_renews_at = ?, bill_cancel_at_period_end = ? WHERE id = ?`)
    .run(sub.status || null, sub.id || null,
      typeof sub.customer === 'string' ? sub.customer : null,
      item ? item.id : null,
      // When cancelling at period end Stripe keeps status 'active' and sets
      // cancel_at_period_end; cancel_at is when hosting actually stops.
      iso(sub.cancel_at || sub.current_period_end),
      sub.cancel_at_period_end ? 1 : 0, userId);
}

async function handle(ev) {
  const obj = (ev.data && ev.data.object) || {};

  if (ev.type === 'checkout.session.completed') {
    const user = findUser(obj);
    if (!user || !obj.subscription) return;
    // The session doesn't carry the subscription item id, so fetch the
    // subscription to get it (needed for per-site quantity updates).
    const sub = await billing.getSubscription(
      typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id);
    saveSubscription(user.id, sub);
    // Bill for the sites they already have.
    const n = db.prepare('SELECT COUNT(*) AS n FROM sites WHERE user_id = ?').get(user.id).n;
    const item = sub.items && sub.items.data && sub.items.data[0];
    if (item && n > 1) await billing.setQuantity(item.id, n).catch(() => {});
    logActivity(user.id, 'billing.subscribed', `stripe ${sub.status}`);
    return;
  }

  if (ev.type === 'customer.subscription.created' || ev.type === 'customer.subscription.updated') {
    const user = findUser(obj);
    if (!user) return;
    saveSubscription(user.id, obj);
    logActivity(user.id, 'billing.subscription', `${ev.type} (${obj.status})`);
    return;
  }

  // Fires when the period actually runs out (not when the customer clicks
  // cancel) - that's the point access should stop.
  if (ev.type === 'customer.subscription.deleted') {
    const user = findUser(obj);
    if (!user) return;
    db.prepare("UPDATE users SET plan = 'free', bill_status = 'canceled', bill_cancel_at_period_end = 0, bill_renews_at = ? WHERE id = ?")
      .run(iso(obj.ended_at || obj.current_period_end), user.id);
    logActivity(user.id, 'billing.subscription', 'ended (period over)');
    return;
  }

  if (ev.type === 'invoice.payment_failed') {
    const user = findUser(obj);
    if (user) logActivity(user.id, 'billing.payment_failed', obj.number || '');
  }
}

// ── authenticated API ───────────────────────────────────────────────
const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const u = db.prepare(`SELECT bill_status, bill_renews_at, bill_subscription_id, bill_customer_id,
    bill_cancel_at_period_end FROM users WHERE id = ?`).get(req.user.id);
  const count = db.prepare('SELECT COUNT(*) AS n FROM sites WHERE user_id = ?').get(req.user.id).n;
  res.json({
    configured: billing.configured(),
    subscribed: billing.subscribed(u),
    has_customer: !!u.bill_customer_id,
    status: u.bill_status || null,
    renews_at: u.bill_renews_at || null,
    cancelling: !!u.bill_cancel_at_period_end,
    anchor_day: billing.ANCHOR_DAY,
    price_label: billing.PER_SITE.label,
    sites_used: count,
  });
});

router.post('/checkout', async (req, res) => {
  try { res.json({ url: await billing.createCheckout(req.user) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/portal', async (req, res) => {
  const u = db.prepare('SELECT bill_customer_id FROM users WHERE id = ?').get(req.user.id);
  if (!u.bill_customer_id) return res.status(400).json({ error: 'No subscription to manage yet' });
  try { res.json({ url: await billing.portalUrl(u.bill_customer_id) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

module.exports = { router, webhook };
