// Billing via Lemon Squeezy (Merchant of Record — handles EU/Belgian VAT).
// Dormant until the LEMONSQUEEZY_* env vars are set, so the platform runs free
// of charge without any billing configured.
const crypto = require('crypto');
const https = require('https');

// Plans and their limits. Paid plans map to a Lemon Squeezy *variant* id (from
// your store), supplied via env so you don't hard-code product ids.
// No free hosting — an account must subscribe to a package to create sites.
// Paid plans map to a Lemon Squeezy variant id; price labels are for display
// only (the real charge is configured on the LS product).
const PLANS = {
  free:    { name: 'Free',    maxSites: 0,  variant: null, price: '' },
  starter: { name: 'Starter', maxSites: 5,  variant: process.env.LS_VARIANT_STARTER || null, price: process.env.LS_PRICE_STARTER || '€5/mo' },
  pro:     { name: 'Pro',     maxSites: 25, variant: process.env.LS_VARIANT_PRO || null, price: process.env.LS_PRICE_PRO || '€15/mo' },
};

function configured() { return !!(process.env.LEMONSQUEEZY_API_KEY && process.env.LEMONSQUEEZY_STORE_ID); }
function limits(planKey) { return PLANS[planKey] || PLANS.free; }
function planByVariant(vid) {
  for (const [k, p] of Object.entries(PLANS)) if (p.variant && String(p.variant) === String(vid)) return k;
  return null;
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

// Create a hosted checkout for a plan, tagged with the user id so the webhook
// can link the resulting subscription back to the account.
async function createCheckout(user, planKey) {
  if (!configured()) throw new Error('Billing is not configured on this server');
  const plan = PLANS[planKey];
  if (!plan || !plan.variant) throw new Error('That plan is not available for purchase');
  const r = await lsApi('POST', '/checkouts', {
    data: {
      type: 'checkouts',
      attributes: { checkout_data: { email: user.email, custom: { user_id: String(user.id) } } },
      relationships: {
        store: { data: { type: 'stores', id: String(process.env.LEMONSQUEEZY_STORE_ID) } },
        variant: { data: { type: 'variants', id: String(plan.variant) } },
      },
    },
  });
  return r.data.attributes.url;
}

module.exports = { PLANS, configured, limits, planByVariant, verifyWebhook, createCheckout };
