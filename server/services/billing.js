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

const PER_SITE = {
  price: process.env.STRIPE_PRICE_PERSITE || null,          // Stripe price id (per-unit, recurring)
  label: process.env.BILLING_PRICE_LABEL || '€20 / site / month',
};

function configured() { return !!(process.env.STRIPE_SECRET_KEY && PER_SITE.price); }

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
    subscription_data: { metadata: { user_id: String(user.id) } },
    metadata: { user_id: String(user.id) },
    success_url: `${dashUrl()}/#/billing?checkout=success`,
    cancel_url: `${dashUrl()}/#/billing?checkout=cancelled`,
  });
  return s.url;
}

// Stripe's own customer portal - lets them change card, view invoices, cancel.
async function portalUrl(customerId) {
  if (!configured()) throw new Error('Billing is not configured on this server');
  const s = await api('POST', '/billing_portal/sessions', {
    customer: customerId,
    return_url: `${dashUrl()}/#/billing`,
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

module.exports = { PER_SITE, configured, subscribed, verifyWebhook, createCheckout, portalUrl, setQuantity, getSubscription };
