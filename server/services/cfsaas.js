// Cloudflare for SaaS — route users' OWN custom domains through Cloudflare.
//
// The platform operator owns one Cloudflare zone with "Cloudflare for SaaS"
// enabled and a "fallback origin" pointing (proxied) at this server. For every
// custom domain a user adds to a site, we register a Cloudflare *custom
// hostname* via the API; Cloudflare then issues the certificate, filters DDoS,
// and forwards to the fallback origin. The user's only step is a single CNAME
// from their domain to the fallback origin — because that target is
// Cloudflare-proxied, their traffic goes through Cloudflare by construction.
//
// This server's edge proxy already routes by Host header, so once Cloudflare
// forwards `Host: their-domain.com` the request lands on the right site with no
// further change.
const https = require('https');
const { db, getSetting, setSetting } = require('../db');
const { encrypt, decrypt } = require('../crypto');

const API_HOST = 'api.cloudflare.com';
const API_BASE = '/client/v4';

// ── config (persisted in the settings KV table; token encrypted at rest) ────
function getConfig() {
  return {
    enabled: getSetting('cf_saas_enabled', '0') === '1',
    zoneId: getSetting('cf_zone_id', '') || '',
    fallbackOrigin: getSetting('cf_fallback_origin', '') || '',
    token: decrypt(getSetting('cf_api_token', '')) || '',
  };
}

function hasToken() { return !!getSetting('cf_api_token', ''); }

// Fully usable only when enabled AND a token + zone are present.
function isEnabled() {
  const c = getConfig();
  return c.enabled && !!c.token && !!c.zoneId;
}

function saveConfig(fields) {
  if (fields.enabled !== undefined) setSetting('cf_saas_enabled', fields.enabled ? '1' : '0');
  if (fields.zoneId !== undefined) setSetting('cf_zone_id', String(fields.zoneId).trim());
  if (fields.fallbackOrigin !== undefined) setSetting('cf_fallback_origin', String(fields.fallbackOrigin).trim().toLowerCase());
  if (fields.token !== undefined) {
    const t = String(fields.token).trim();
    setSetting('cf_api_token', t ? encrypt(t) : null); // empty string clears it
  }
}

// ── raw API helper ──────────────────────────────────────────────────
function api(method, path, body, tokenOverride) {
  const tok = tokenOverride || getConfig().token;
  return new Promise((resolve, reject) => {
    if (!tok) return reject(new Error('No Cloudflare API token configured'));
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: API_HOST, path: API_BASE + path, method,
      headers: {
        Authorization: `Bearer ${tok}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: 15_000,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; if (buf.length > 1_000_000) req.destroy(new Error('response too large')); });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(buf); } catch { return reject(new Error(`Cloudflare returned non-JSON (HTTP ${res.statusCode})`)); }
        if (!json.success) {
          const msg = (json.errors || []).map(e => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.statusCode}`;
          return reject(new Error(msg));
        }
        resolve(json.result);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Cloudflare API timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Validate a token + zone (used by the "Test" button). Returns the zone name.
async function testConfig(token, zoneId) {
  if (!zoneId) throw new Error('Zone ID is required');
  const zone = await api('GET', `/zones/${zoneId}`, null, token);
  return { zone_name: zone.name, zone_status: zone.status };
}

// ── fallback origin (where all custom hostnames route) ──────────────
function setFallbackOrigin(origin) {
  const { zoneId } = getConfig();
  return api('PUT', `/zones/${zoneId}/custom_hostnames/fallback_origin`, { origin });
}
function getFallbackOrigin() {
  const { zoneId } = getConfig();
  return api('GET', `/zones/${zoneId}/custom_hostnames/fallback_origin`);
}

// ── custom hostnames ────────────────────────────────────────────────
function createHostname(hostname) {
  const { zoneId } = getConfig();
  return api('POST', `/zones/${zoneId}/custom_hostnames`, {
    hostname,
    ssl: { method: 'txt', type: 'dv', settings: { min_tls_version: '1.0' } },
  });
}
function getHostname(cfId) {
  const { zoneId } = getConfig();
  return api('GET', `/zones/${zoneId}/custom_hostnames/${cfId}`);
}
function deleteHostname(cfId) {
  const { zoneId } = getConfig();
  return api('DELETE', `/zones/${zoneId}/custom_hostnames/${cfId}`);
}

// Pull the records a user must add out of a Cloudflare custom-hostname result:
// the CNAME target, the ownership-verification record, and the SSL DCV record(s).
function extractVerification(result) {
  const out = { cname_target: getConfig().fallbackOrigin || null, ownership: null, ssl_records: [] };
  if (result.ownership_verification && result.ownership_verification.name) {
    out.ownership = {
      type: result.ownership_verification.type || 'txt',
      name: result.ownership_verification.name,
      value: result.ownership_verification.value,
    };
  }
  const ssl = result.ssl || {};
  if (Array.isArray(ssl.validation_records)) {
    for (const r of ssl.validation_records) {
      if (r.txt_name && r.txt_value) out.ssl_records.push({ type: 'txt', name: r.txt_name, value: r.txt_value });
    }
  } else if (ssl.txt_name && ssl.txt_value) {
    out.ssl_records.push({ type: 'txt', name: ssl.txt_name, value: ssl.txt_value });
  }
  return out;
}

// ── DB persistence ──────────────────────────────────────────────────
function saveHostname(siteId, hostname, result, err) {
  db.prepare(`INSERT INTO cf_hostnames
      (site_id, hostname, cf_id, status, ssl_status, verification, cname_target, last_error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(site_id, hostname) DO UPDATE SET
      cf_id        = COALESCE(excluded.cf_id, cf_hostnames.cf_id),
      status       = excluded.status,
      ssl_status   = excluded.ssl_status,
      verification = COALESCE(excluded.verification, cf_hostnames.verification),
      cname_target = excluded.cname_target,
      last_error   = excluded.last_error,
      updated_at   = datetime('now')`)
    .run(
      siteId, hostname,
      result?.id || null,
      result?.status || null,
      result?.ssl?.status || null,
      result ? JSON.stringify(extractVerification(result)) : null,
      getConfig().fallbackOrigin || null,
      err || null,
    );
}

function rowsForSite(siteId) {
  return db.prepare('SELECT * FROM cf_hostnames WHERE site_id = ? ORDER BY hostname').all(siteId);
}

function view(row) {
  let verification = null;
  try { verification = row.verification ? JSON.parse(row.verification) : null; } catch { /* ignore */ }
  return {
    hostname: row.hostname,
    cf_id: row.cf_id,
    status: row.status,
    ssl_status: row.ssl_status,
    active: row.status === 'active' && row.ssl_status === 'active',
    cname_target: row.cname_target,
    verification,
    last_error: row.last_error,
    updated_at: row.updated_at,
  };
}

// Only real, delegatable domains are eligible (not the free sslip/IP forms).
function isRealDomain(h) {
  h = String(h || '').toLowerCase();
  return !!h && h.includes('.') && !/^\d{1,3}(\.\d{1,3}){3}$/.test(h) && !/\.sslip\.io$/.test(h);
}

// ── sync a site's domains with Cloudflare ───────────────────────────
// Creates custom hostnames for newly-added domains, deletes them for removed
// ones. Best-effort per domain: a failure is recorded (last_error) and retried
// on the next sync rather than throwing.
async function syncDomainsForSite(site) {
  if (!isEnabled()) return { enabled: false, hostnames: [] };
  const desired = JSON.parse(site.domains || '[]').map(d => String(d).toLowerCase().trim()).filter(isRealDomain);
  const desiredSet = new Set(desired);
  const existing = rowsForSite(site.id);
  const byName = new Map(existing.map(r => [r.hostname, r]));

  // remove hostnames no longer on the site
  for (const row of existing) {
    if (desiredSet.has(row.hostname)) continue;
    if (row.cf_id) { try { await deleteHostname(row.cf_id); } catch (e) { console.error(`cfsaas: delete ${row.hostname}: ${e.message}`); } }
    db.prepare('DELETE FROM cf_hostnames WHERE id = ?').run(row.id);
  }

  // create hostnames that are new, or retry ones whose create previously failed
  for (const host of desired) {
    const row = byName.get(host);
    if (row && row.cf_id) continue; // already registered
    try {
      const result = await createHostname(host);
      saveHostname(site.id, host, result, null);
    } catch (e) {
      saveHostname(site.id, host, null, e.message);
    }
  }
  return { enabled: true, hostnames: rowsForSite(site.id).map(view) };
}

// Cloudflare custom-hostname ids for a site (captured before deleting the site,
// so the rows can be cleaned up on Cloudflare's side afterwards).
function cfIdsForSite(siteId) {
  return db.prepare('SELECT cf_id FROM cf_hostnames WHERE site_id = ? AND cf_id IS NOT NULL').all(siteId).map(r => r.cf_id);
}
async function deleteIds(cfIds) {
  if (!isEnabled()) return;
  for (const id of cfIds || []) {
    try { await deleteHostname(id); } catch (e) { console.error(`cfsaas: cleanup ${id}: ${e.message}`); }
  }
}

// Poll Cloudflare for hostnames that aren't fully active yet and update status.
async function refreshStatuses() {
  if (!isEnabled()) return;
  const rows = db.prepare("SELECT * FROM cf_hostnames WHERE cf_id IS NOT NULL AND (status IS NULL OR status != 'active' OR ssl_status IS NULL OR ssl_status != 'active')").all();
  for (const row of rows) {
    try {
      const result = await getHostname(row.cf_id);
      saveHostname(row.site_id, row.hostname, result, null);
    } catch (e) {
      db.prepare("UPDATE cf_hostnames SET last_error = ?, updated_at = datetime('now') WHERE id = ?").run(e.message, row.id);
    }
  }
}

// All hostnames across the platform (admin overview).
function allHostnames() {
  const rows = db.prepare(`SELECT c.*, s.name AS site_name, s.slug AS site_slug
    FROM cf_hostnames c JOIN sites s ON s.id = c.site_id ORDER BY c.hostname`).all();
  return rows.map(r => ({ ...view(r), site_id: r.site_id, site_name: r.site_name, site_slug: r.site_slug }));
}

function start() {
  // Poll pending hostnames a little after boot and every 5 minutes.
  setTimeout(() => { refreshStatuses().catch(() => {}); }, 30_000).unref();
  setInterval(() => { refreshStatuses().catch(() => {}); }, 5 * 60_000).unref();
}

module.exports = {
  getConfig, hasToken, isEnabled, saveConfig, testConfig,
  setFallbackOrigin, getFallbackOrigin,
  syncDomainsForSite, rowsForSite, view, allHostnames,
  cfIdsForSite, deleteIds, refreshStatuses, isRealDomain, start,
};
