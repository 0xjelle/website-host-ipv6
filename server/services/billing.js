// Billing via Lemon Squeezy (Merchant of Record — handles EU/Belgian VAT).
// Dormant until the LEMONSQUEEZY_* env vars are set, so the platform runs free
// of charge without any billing configured.
const crypto = require('crypto');
const https = require('https');

// Plans and their limits. Paid plans map to a Lemon Squeezy *variant* id (from
// your store), supplied via env so you don't hard-code product ids.
// Pay-per-site: one subscription to a per-unit "seat" variant whose quantity is
// kept equal to the account's number of sites. Price label is display-only —
// the real per-site charge is configured on the Lemon Squeezy product.
const PER_SITE = {
  variant: process.env.LS_VARIANT_PERSITE || null,
  price: process.env.LS_PRICE_PERSITE || '€20 / site / month',
};

// Requires the per-site variant too, so nothing is enforced until it's set.
function configured() { return !!(process.env.LEMONSQUEEZY_API_KEY && process.env.LEMONSQUEEZY_STORE_ID && PER_SITE.variant); }

// A user counts as subscribed while the subscription is live (cancelled stays
// usable until it actually expires).
function subscribed(user) {
  return !!(user && user.ls_subscription_id && ['active', 'on_trial', 'past_due', 'cancelled'].includes(user.ls_status));
}

// Verify a webhook's HMAC-SHA256 signature over the raw request body.
function verifyWebhook(rawBody, signature) {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(signature))); } catch { return false; }
}

function lsApi(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: 'api.lemonsqueezy.com', path: '/v1' + path, method,
      headers: {
        Authorization: `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`,
        'Content-Type': 'application/vnd.api+json', Accept: 'application/vnd.api+json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      }, timeout: 15_000,
    }, (res) => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => {
        let j; try { j = JSON.parse(b); } catch { return reject(new Error(`Lemon Squeezy returned non-JSON (HTTP ${res.statusCode})`)); }
        if (res.statusCode >= 400) return reject(new Error((j.errors && j.errors[0] && j.errors[0].detail) || `Lemon Squeezy HTTP ${res.statusCode}`));
        resolve(j);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Lemon Squeezy timed out')));
    req.on('error', reject);
    if (data) req.write(data); req.end();
  });
}

// Hosted checkout for the per-site subscription, tagged with the user id so the
// webhook links the subscription back to the account.
async function createCheckout(user) {
  if (!configured()) throw new Error('Billing is not configured on this server');
  const r = await lsApi('POST', '/checkouts', {
    data: {
      type: 'checkouts',
      attributes: { checkout_data: { email: user.email, custom: { user_id: String(user.id) } } },
      relationships: {
        store: { data: { type: 'stores', id: String(process.env.LEMONSQUEEZY_STORE_ID) } },
        variant: { data: { type: 'variants', id: String(PER_SITE.variant) } },
      },
    },
  });
  return r.data.attributes.url;
}

// Keep the subscription quantity equal to the account's site count (min 1).
async function setQuantity(itemId, quantity) {
  if (!configured() || !itemId) return;
  const qty = Math.max(1, Number(quantity) || 1);
  await lsApi('PATCH', `/subscription-items/${itemId}`, {
    data: { type: 'subscription-items', id: String(itemId), attributes: { quantity: qty } },
  });
}

module.exports = { PER_SITE, configured, subscribed, verifyWebhook, createCheckout, setQuantity };
