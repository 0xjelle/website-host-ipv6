// RFC 6238 TOTP + RFC 4648 base32, dependency-free (node:crypto). Used for
// optional two-factor auth on accounts.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function randomSecret(bytes = 20) {
  const buf = crypto.randomBytes(bytes);
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function b32decode(s) {
  const clean = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of clean) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[off] & 0x7f) << 24) | ((hmac[off + 1] & 0xff) << 16) | ((hmac[off + 2] & 0xff) << 8) | (hmac[off + 3] & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

// Accept a 6-digit code within ±1 time-step (30s) to tolerate clock drift.
function verify(secret, token, window = 1) {
  const t = String(token || '').trim();
  if (!secret || !/^\d{6}$/.test(t)) return false;
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let e = -window; e <= window; e++) if (hotp(secret, step + e) === t) return true;
  return false;
}

function otpauthURL(secret, label, issuer = 'Hosting') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&period=30&digits=6`;
}

module.exports = { randomSecret, verify, otpauthURL };
