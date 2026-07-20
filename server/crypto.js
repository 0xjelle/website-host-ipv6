// Small helper to encrypt secrets at rest (account GitHub tokens) using a
// key derived from the JWT secret. Backward compatible: decrypt() returns
// plaintext untouched if it doesn't carry the v1: envelope.
const crypto = require('crypto');
const config = require('./config');

const key = crypto.createHash('sha256').update(String(config.jwtSecret)).digest();

function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decrypt(blob) {
  if (!blob) return null;
  if (!String(blob).startsWith('v1:')) return blob; // legacy plaintext
  try {
    const raw = Buffer.from(String(blob).slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt };
