// Transactional email via Resend (https, no dependency). When RESEND_API_KEY
// isn't set it logs and no-ops, so the platform runs fine without email — the
// features that use it (password reset, notifications) just stay dormant.
const https = require('https');

function configured() { return !!process.env.RESEND_API_KEY; }
function from() { return process.env.MAIL_FROM || 'Hosting <onboarding@resend.dev>'; }

// Wrap body copy in a minimal, client-safe HTML shell.
function shell(title, bodyHtml) {
  return `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
    <h2 style="font-weight:600">${title}</h2>${bodyHtml}
    <p style="color:#888;font-size:12px;margin-top:2rem">Sent by your Hosting platform.</p></div>`;
}

function send({ to, subject, html, text }) {
  return new Promise((resolve) => {
    if (!configured()) { console.log(`mail: skipped (no RESEND_API_KEY) — "${subject}" → ${to}`); return resolve(false); }
    const payload = JSON.stringify({ from: from(), to: Array.isArray(to) ? to : [to], subject, html, text });
    const req = https.request({
      host: 'api.resend.com', path: '/emails', method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15_000,
    }, (r) => {
      let b = ''; r.on('data', d => b += d);
      r.on('end', () => {
        if (r.statusCode >= 200 && r.statusCode < 300) return resolve(true);
        console.error(`mail: Resend HTTP ${r.statusCode}: ${b.slice(0, 300)}`);
        resolve(false);
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', (e) => { console.error('mail: send failed:', e.message); resolve(false); });
    req.write(payload); req.end();
  });
}

module.exports = { send, configured, shell };
