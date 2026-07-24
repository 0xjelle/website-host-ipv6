// Cloudflare Turnstile (CAPTCHA) verification. Enforced on login/register only
// when both keys are set — otherwise auth works normally, so it can never lock
// you out just because it's unconfigured.
const https = require('https');

function configured() { return !!(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY); }
function siteKey() { return process.env.TURNSTILE_SITE_KEY || null; }

function verify(token, ip) {
  return new Promise((resolve) => {
    if (!configured()) return resolve(true);   // not enforced
    if (!token) return resolve(false);
    const params = { secret: process.env.TURNSTILE_SECRET_KEY, response: String(token) };
    if (ip) params.remoteip = ip;
    const body = new URLSearchParams(params).toString();
    const req = https.request({
      host: 'challenges.cloudflare.com', path: '/turnstile/v0/siteverify', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10_000,
    }, (r) => {
      let b = ''; r.on('data', d => b += d);
      r.on('end', () => { try { resolve(!!JSON.parse(b).success); } catch { resolve(false); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.write(body); req.end();
  });
}

module.exports = { configured, siteKey, verify };
