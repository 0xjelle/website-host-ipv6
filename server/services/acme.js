// Let's Encrypt (ACME) certificates via the DNS-01 challenge - works for a
// server with no inbound reachability (behind NAT). Two-step manual flow:
//   1. request() creates the order and returns the _acme-challenge TXT
//      records the operator must add to their DNS.
//   2. complete() (after the TXT records exist) answers the challenge,
//      finalizes the order and stores the certificate.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { db, logActivity } = require('../db');

let acme;
try { acme = require('acme-client'); } catch { acme = null; }
const mail = require('./mail');

const acmeDir = path.join(config.dataDir, 'acme');
const certsDir = path.join(config.dataDir, 'certs');
fs.mkdirSync(acmeDir, { recursive: true });
fs.mkdirSync(certsDir, { recursive: true });

const staging = process.env.SSL_STAGING === '1';
const pending = new Map(); // siteId -> { client, order, items:[{domain,challenge,authz}], keyPem, csr, domains }

function available() { return !!acme; }

async function accountKey() {
  const p = path.join(acmeDir, 'account.key');
  if (fs.existsSync(p)) return fs.readFileSync(p);
  const key = await acme.crypto.createPrivateKey();
  fs.writeFileSync(p, key, { mode: 0o600 });
  return key;
}

async function makeClient() {
  const client = new acme.Client({
    directoryUrl: staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production,
    accountKey: await accountKey(),
  });
  return client;
}

function certPaths(siteId) {
  const dir = path.join(certsDir, String(siteId));
  return { dir, cert: path.join(dir, 'fullchain.pem'), key: path.join(dir, 'privkey.pem') };
}

function readStatus(siteId) {
  const row = db.prepare('SELECT * FROM certs WHERE site_id = ?').get(siteId) || { status: 'none' };
  const { cert } = certPaths(siteId);
  let not_after = row.not_after || null;
  if (row.status === 'active' && fs.existsSync(cert)) {
    try { not_after = new Date(new crypto.X509Certificate(fs.readFileSync(cert)).validTo).toISOString(); } catch {}
  }
  const daysLeft = not_after ? Math.round((new Date(not_after) - Date.now()) / 86400000) : null;
  return {
    status: row.status || 'none',
    domains: JSON.parse(row.domains || '[]'),
    challenge: JSON.parse(row.challenge || '[]'),
    not_after, daysLeft,
    issuer: row.issuer || null,
    auto_renew: row.auto_renew === undefined ? true : !!row.auto_renew,
    last_error: row.last_error || null,
    staging,
  };
}

function upsert(siteId, fields) {
  const cur = db.prepare('SELECT site_id FROM certs WHERE site_id = ?').get(siteId);
  if (!cur) db.prepare('INSERT INTO certs (site_id) VALUES (?)').run(siteId);
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE certs SET ${sets}, updated_at = datetime('now') WHERE site_id = ?`).run(...Object.values(fields), siteId);
}

// Step 1 - create the order and return the TXT records to add.
async function request(site, domains, email) {
  if (!acme) throw new Error('acme-client is not installed on this server');
  if (!domains.length) throw new Error('Add at least one custom domain to the site first');
  for (const d of domains) {
    if (/\.sslip\.io$/i.test(d) || /^\d{1,3}(\.\d+){3}$/.test(d)) {
      throw new Error(`Certificates require a real domain you control - "${d}" is not eligible`);
    }
  }
  const client = await makeClient();
  await client.createAccount({ termsOfServiceAgreed: true, contact: email ? [`mailto:${email}`] : [] });

  const [keyPem, csr] = await acme.crypto.createCsr({ commonName: domains[0], altNames: domains });
  const order = await client.createOrder({ identifiers: domains.map(value => ({ type: 'dns', value })) });
  const authorizations = await client.getAuthorizations(order);

  const items = [];
  const txt = [];
  for (const authz of authorizations) {
    const challenge = authz.challenges.find(c => c.type === 'dns-01');
    if (!challenge) throw new Error('DNS-01 challenge not offered for ' + authz.identifier.value);
    const value = await client.getChallengeKeyAuthorization(challenge);
    items.push({ domain: authz.identifier.value, challenge, authz });
    txt.push({ name: `_acme-challenge.${authz.identifier.value}`, value });
  }

  pending.set(site.id, { client, order, items, keyPem, csr, domains });
  upsert(site.id, { domains: JSON.stringify(domains), status: 'pending', challenge: JSON.stringify(txt), last_error: null });
  logActivity(site.user_id, 'ssl.request', `"${site.name}" ${domains.join(', ')}${staging ? ' (staging)' : ''}`);
  return { challenge: txt, staging };
}

// Step 2 - after the TXT records exist, answer the challenge and issue.
async function complete(site) {
  if (!acme) throw new Error('acme-client is not installed on this server');
  const p = pending.get(site.id);
  if (!p) throw new Error('No pending certificate request - start a new one');
  try {
    for (const it of p.items) {
      await p.client.completeChallenge(it.challenge);
      await p.client.waitForValidStatus(it.challenge);
    }
    await p.client.finalizeOrder(p.order, p.csr);
    const cert = await p.client.getCertificate(p.order);
    const { dir, cert: certFile, key: keyFile } = certPaths(site.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(certFile, cert, { mode: 0o644 });
    fs.writeFileSync(keyFile, p.keyPem, { mode: 0o600 });
    const x = new crypto.X509Certificate(cert);
    upsert(site.id, {
      status: 'active', challenge: '[]',
      not_after: new Date(x.validTo).toISOString(),
      issuer: staging ? "Let's Encrypt (staging)" : "Let's Encrypt",
      last_error: null,
    });
    pending.delete(site.id);
    logActivity(site.user_id, 'ssl.issued', `"${site.name}" until ${new Date(x.validTo).toISOString().slice(0, 10)}`);
    try { require('./proxy').reloadCerts(); } catch {}
    return { ok: true, not_after: new Date(x.validTo).toISOString() };
  } catch (e) {
    upsert(site.id, { status: 'failed', last_error: e.message });
    throw new Error(`Certificate issuance failed: ${e.message} (are the TXT records visible? DNS can take a few minutes)`);
  }
}

function remove(siteId) {
  const { dir } = certPaths(siteId);
  fs.rmSync(dir, { recursive: true, force: true });
  db.prepare('DELETE FROM certs WHERE site_id = ?').run(siteId);
  pending.delete(siteId);
  try { require('./proxy').reloadCerts(); } catch {}
}

// All active certs, for the proxy's SNI store: [{ siteId, domains, cert, key }]
function activeCerts() {
  const out = [];
  for (const row of db.prepare("SELECT * FROM certs WHERE status = 'active'").all()) {
    const { cert, key } = certPaths(row.site_id);
    if (fs.existsSync(cert) && fs.existsSync(key)) {
      out.push({ siteId: row.site_id, domains: JSON.parse(row.domains || '[]'), cert: fs.readFileSync(cert), key: fs.readFileSync(key) });
    }
  }
  return out;
}

// Auto-renew: for active certs within 30 days of expiry with auto-renew on,
// re-stage the DNS-01 challenge so fresh TXT records are ready in the
// dashboard. (The existing cert keeps serving until the new one is issued.)
// Fully hands-off renewal isn't possible with manual DNS, so we surface the
// new records and log that action is needed.
async function checkRenewals() {
  if (!acme) return;
  for (const row of db.prepare("SELECT * FROM certs WHERE status = 'active' AND auto_renew = 1").all()) {
    const st = readStatus(row.site_id);
    if (st.daysLeft === null || st.daysLeft > 30) continue;
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(row.site_id);
    if (!site) continue;
    const user = db.prepare('SELECT email FROM users WHERE id = ?').get(site.user_id);
    try {
      await request(site, JSON.parse(site.domains || '[]'), user?.email);
      logActivity(site.user_id, 'ssl.renew.staged', `"${site.name}" expires in ${st.daysLeft}d - new TXT records ready to verify`);
      const dash = `http://${config.publicHost}:${config.adminPort}/#/sites/${site.id}`;
      if (user?.email) mail.send({
        to: user.email,
        subject: `Certificate expiring for ${site.name} (${st.daysLeft}d)`,
        text: `The certificate for "${site.name}" expires in ${st.daysLeft} days. New DNS TXT records are staged - add them and click Verify: ${dash}`,
        html: mail.shell('Certificate expiring soon', `<p>The Let's Encrypt certificate for <b>${String(site.name).replace(/[&<>]/g, '')}</b> expires in <b>${st.daysLeft} days</b>.</p>
          <p>New DNS TXT records are staged. <a href="${dash}">Open the SSL tab</a>, add them, then click <b>Verify &amp; issue</b>.</p>`),
      }).catch(() => {});
    } catch (e) {
      upsert(row.site_id, { last_error: `auto-renew: ${e.message}` });
    }
  }
}

function startRenewals() {
  if (!acme) return;
  setTimeout(checkRenewals, 60_000).unref();          // shortly after boot
  setInterval(checkRenewals, 12 * 3600_000).unref();  // twice a day
}

module.exports = {
  available, request, complete, remove, readStatus, activeCerts, certsDir, checkRenewals, startRenewals,
  setAutoRenew: (siteId, on) => upsert(siteId, { auto_renew: on ? 1 : 0 }),
};
