// Billing via Stripe, pay-per-site: one subscription to a per-unit recurring
// price whose quantity is kept equal to the account's number of sites.
//
// Stripe Tax (automatic_tax) is enabled on checkout so the correct EU/Belgian
// VAT is calculated and collected. NOTE: unlike a merchant-of-record provider,
// Stripe does not remit that VAT for you - you are the seller of record and
// must register (e.g. VAT OSS) and file it yourself.
//
// Dormant until the STRIPE_* env vars are set, so the platform runs free of
// charge with no billing configured.
const crypto = require('crypto');
const https = require('https');
const config = require('../config');
const { getSetting, setSetting } = require('../db');

const PER_SITE = {
  price: process.env.STRIPE_PRICE_PERSITE || null,          // Stripe price id (per-unit, recurring)
  label: process.env.BILLING_PRICE_LABEL || '€20 / site / month',
};

// Every subscription is billed on the same calendar day (default the 1st), so
// invoicing is predictable instead of falling on each customer's signup date.
const ANCHOR_DAY = Math.min(28, Math.max(1, parseInt(process.env.BILLING_ANCHOR_DAY || '1', 10) || 1));

function configured() { return !!(process.env.STRIPE_SECRET_KEY && PER_SITE.price); }

// Next occurrence of the anchor day, 00:00 UTC, strictly in the future. Capped
// at day 28 so it exists in every month (Stripe then keeps month-end behaviour
// consistent for later cycles).
function nextAnchor(now = Date.now()) {
  const d = new Date(now);
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  let ts = Date.UTC(y, m, ANCHOR_DAY);
  if (ts <= now) { m += 1; if (m > 11) { m = 0; y += 1; } ts = Date.UTC(y, m, ANCHOR_DAY); }
  return Math.floor(ts / 1000);
}

// Live while the subscription is usable. 'canceled' is excluded: Stripe keeps a
// cancel-at-period-end subscription 'active' until it actually ends, and only
// moves it to 'canceled' once over - at which point access should stop.
function subscribed(user) {
  return !!(user && user.bill_subscription_id && ['active', 'trialing', 'past_due'].includes(user.bill_status));
}

// ── Stripe API (form-encoded, no dependency) ────────────────────────
// Flattens nested objects/arrays into Stripe's bracket syntax:
//   { a: { b: 1 } }  ->  a[b]=1        [{ price: 'p' }] -> 0[price]=p
function encode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') encode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

function api(method, path, params) {
  return new Promise((resolve, reject) => {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return reject(new Error('Stripe is not configured'));
    const body = params ? encode(params).join('&') : null;
    const req = https.request({
      host: 'api.stripe.com', path: '/v1' + path, method,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': '2024-06-20',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
      timeout: 20_000,
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(buf); } catch { return reject(new Error(`Stripe returned non-JSON (HTTP ${res.statusCode})`)); }
        if (json.error) return reject(new Error(json.error.message || json.error.type || 'Stripe error'));
        if (res.statusCode >= 400) return reject(new Error(`Stripe HTTP ${res.statusCode}`));
        resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Stripe timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── webhook signature (Stripe-Signature: t=…,v1=…) ──────────────────
function verifyWebhook(rawBody, header, toleranceSec = 300) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const parts = {};
  for (const kv of String(header).split(',')) {
    const [k, v] = kv.split('=');
    if (k === 'v1') (parts.v1 = parts.v1 || []).push(v);
    else if (k) parts[k.trim()] = v;
  }
  if (!parts.t || !parts.v1) return false;
  // Reject stale timestamps so a captured request can't be replayed.
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(parts.t)) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret)
    .update(`${parts.t}.${rawBody.toString('utf8')}`).digest('hex');
  const exp = Buffer.from(expected);
  return parts.v1.some((sig) => {
    const got = Buffer.from(String(sig));
    return got.length === exp.length && crypto.timingSafeEqual(got, exp);
  });
}

// ── operations ──────────────────────────────────────────────────────
const dashUrl = () => `http://${config.publicHost}:${config.adminPort}`;

// Hosted Checkout for the per-site subscription. The user id rides along in
// metadata (on the session AND the subscription) so webhooks can link back.
async function createCheckout(user) {
  if (!configured()) throw new Error('Billing is not configured on this server');
  const s = await api('POST', '/checkout/sessions', {
    mode: 'subscription',
    line_items: { 0: { price: PER_SITE.price, quantity: 1 } },
    client_reference_id: String(user.id),
    customer_email: user.email,
    allow_promotion_codes: 'true',
    automatic_tax: { enabled: 'true' },       // Stripe Tax: charge the right VAT
    tax_id_collection: { enabled: 'true' },   // let business customers enter a VAT id
    subscription_data: {
      metadata: { user_id: String(user.id) },
      // Bill everyone on the same calendar day. The partial stretch between
      // signing up and that day is charged pro rata, so nobody gets free days
      // and nobody pays twice for the same period.
      billing_cycle_anchor: nextAnchor(),
      proration_behavior: 'create_prorations',
    },
    metadata: { user_id: String(user.id) },
    success_url: `${dashUrl()}/#/billing?checkout=success`,
    cancel_url: `${dashUrl()}/#/billing?checkout=cancelled`,
  });
  return s.url;
}

// Portal configuration, created once and cached. The important bit is
// subscription_cancel.mode = at_period_end: cancelling keeps the subscription
// (and the customer's sites) alive until the paid period runs out, instead of
// killing hosting the moment they click cancel.
async function portalConfigId() {
  const cached = getSetting('stripe_portal_config', '') || '';
  if (cached) return cached;
  const cfg = await api('POST', '/billing_portal/configurations', {
    business_profile: { headline: 'Manage your hosting subscription' },
    features: {
      invoice_history: { enabled: 'true' },
      payment_method_update: { enabled: 'true' },
      // Address/tax id must stay editable for Stripe Tax to charge correct VAT.
      customer_update: { enabled: 'true', allowed_updates: { 0: 'address', 1: 'tax_id', 2: 'email', 3: 'name' } },
      subscription_cancel: { enabled: 'true', mode: 'at_period_end' },
    },
  });
  setSetting('stripe_portal_config', cfg.id);
  return cfg.id;
}

// Stripe's own customer portal - change card, view invoices, cancel.
async function portalUrl(customerId) {
  if (!configured()) throw new Error('Billing is not configured on this server');
  let configuration = null;
  // Never let a config problem block access to the portal; Stripe falls back to
  // the account's default configuration when none is given.
  try { configuration = await portalConfigId(); }
  catch (e) { console.error('billing: portal configuration failed, using account default:', e.message); }
  const s = await api('POST', '/billing_portal/sessions', {
    customer: customerId,
    return_url: `${dashUrl()}/#/billing`,
    ...(configuration ? { configuration } : {}),
  });
  return s.url;
}

// Keep the subscription quantity equal to the account's site count (min 1).
// Prorations mean adding/removing a site is billed fairly mid-cycle.
async function setQuantity(itemId, quantity) {
  if (!configured() || !itemId) return;
  await api('POST', `/subscription_items/${itemId}`, {
    quantity: Math.max(1, Number(quantity) || 1),
    proration_behavior: 'create_prorations',
  });
}

// Fetch a subscription (used to resolve the item id after checkout).
function getSubscription(id) { return api('GET', `/subscriptions/${id}`); }

module.exports = { PER_SITE, ANCHOR_DAY, configured, subscribed, verifyWebhook, createCheckout, portalUrl, setQuantity, getSubscription, nextAnchor };
