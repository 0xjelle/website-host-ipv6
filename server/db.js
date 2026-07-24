const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');

const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Multi-tenant hardening: site apps run as their own unprivileged users and
// need to traverse dataDir → sites → <id>, but must NOT be able to read the
// platform's database (customer secrets, tokens, env vars). Make the data dir
// traversable-but-not-listable (0711) and the DB owner-only (0600). SQLite
// creates the -wal/-shm files with the DB's permissions, so setting 0600 on the
// main file before any writes keeps them private too.
try {
  fs.chmodSync(config.dataDir, 0o711);
  fs.chmodSync(config.sitesDir, 0o711);
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.chmodSync(config.dbFile + suffix, 0o600); } catch { /* not present yet */ }
  }
} catch (e) { console.error('db hardening (chmod) failed:', e.message); }

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',        -- 'user' | 'admin'
  suspended     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sites (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL DEFAULT 'static',     -- 'static' | 'node'
  domains        TEXT NOT NULL DEFAULT '[]',         -- JSON array of hostnames
  repo_url       TEXT,
  repo_branch    TEXT NOT NULL DEFAULT 'main',
  repo_token     TEXT,                               -- optional PAT for private repos
  webhook_secret TEXT NOT NULL,
  static_dir     TEXT NOT NULL DEFAULT '',           -- subdir to serve (e.g. dist)
  build_cmd      TEXT,                               -- optional build command
  start_cmd      TEXT,                               -- node apps; default npm start
  env_vars       TEXT NOT NULL DEFAULT '{}',         -- JSON object
  app_port       INTEGER,                            -- internal port for node apps
  status         TEXT NOT NULL DEFAULT 'new',        -- new|deploying|live|stopped|failed
  auto_deploy    INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deployments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  trigger     TEXT NOT NULL DEFAULT 'manual',        -- manual | webhook
  commit_sha  TEXT,
  commit_msg  TEXT,
  status      TEXT NOT NULL DEFAULT 'queued',        -- queued|running|success|failed
  log         TEXT NOT NULL DEFAULT '',
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS wg_settings (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  private_key  TEXT NOT NULL,
  public_key   TEXT NOT NULL,
  listen_port  INTEGER NOT NULL DEFAULT 51820,
  endpoint     TEXT NOT NULL DEFAULT '',
  tunnel_v4    TEXT NOT NULL DEFAULT '10.66.0.1/24',
  tunnel_v6    TEXT NOT NULL DEFAULT 'fd66:6::1/64',
  dns          TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS wg_peers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  private_key   TEXT NOT NULL,
  public_key    TEXT NOT NULL,
  preshared_key TEXT NOT NULL,
  addr_v4       TEXT NOT NULL,                       -- e.g. 10.66.0.7/32
  addr_v6       TEXT NOT NULL,                       -- e.g. fd66:6::7/128
  routed_v6     TEXT,                                -- user's own IPv6 block, e.g. 2a0e:8f02:f01f::/48
  routed_v4     TEXT,                                -- optional extra IPv4 (CIDR)
  asn           TEXT,                                -- user's ASN for BGP announcement
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS certs (
  site_id     INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  domains     TEXT NOT NULL DEFAULT '[]',   -- JSON array covered by the cert
  status      TEXT NOT NULL DEFAULT 'none', -- none|pending|active|failed
  challenge   TEXT NOT NULL DEFAULT '[]',   -- JSON [{name,value}] TXT records to add
  not_after   TEXT,
  issuer      TEXT,
  auto_renew  INTEGER NOT NULL DEFAULT 1,
  last_error  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Generic key/value store for small platform-wide settings that don't warrant
-- their own table (e.g. the Cloudflare "trust proxy" flag, Cloudflare-for-SaaS
-- config: cf_saas_enabled, cf_zone_id, cf_fallback_origin, cf_api_token[enc]).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Cloudflare-for-SaaS custom hostnames: one row per (site, custom domain) that
-- has been registered with Cloudflare so a user's own domain routes through
-- Cloudflare. cf_id is null if the create call failed (retried on next sync).
CREATE TABLE IF NOT EXISTS cf_hostnames (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id      INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  hostname     TEXT NOT NULL,
  cf_id        TEXT,                 -- Cloudflare custom_hostname id
  status       TEXT,                 -- hostname status (pending/active/...)
  ssl_status   TEXT,                 -- ssl.status
  verification TEXT,                 -- JSON: CNAME target + DCV/ownership records
  cname_target TEXT,                 -- fallback origin the user CNAMEs to
  last_error   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(site_id, hostname)
);
`);

// Lightweight migrations for columns added after the initial release
function addColumn(table, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`); } catch { /* exists */ }
}
addColumn('wg_settings', "server_asn TEXT NOT NULL DEFAULT ''");
addColumn('wg_peers', 'bgp_enabled INTEGER NOT NULL DEFAULT 0');
addColumn('wg_peers', 'bird_custom TEXT');
addColumn('wg_settings', "site_v6_pool TEXT NOT NULL DEFAULT ''");   // IPv6 block sites get addresses from
addColumn('wg_settings', "site_v6_iface TEXT NOT NULL DEFAULT ''");  // interface to attach them to (auto if empty)
addColumn('sites', 'ipv6_addr TEXT');
addColumn('sites', 'app_pid INTEGER');
addColumn('wg_settings', 'uplink_wg TEXT');                          // provider WireGuard client config
addColumn('wg_settings', 'uplink_bird TEXT');                        // provider BIRD config (as uploaded)
addColumn('wg_settings', 'uplink_enabled INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'github_token TEXT');   // encrypted account GitHub PAT
addColumn('users', 'github_login TEXT');   // GitHub username for display
addColumn('users', 'totp_secret TEXT');                       // base32 TOTP secret (2FA)
addColumn('users', 'totp_enabled INTEGER NOT NULL DEFAULT 0'); // 2FA active?
addColumn('users', 'totp_backup TEXT');                       // JSON array of sha256(backup code)
addColumn('users', "plan TEXT NOT NULL DEFAULT 'free'");      // billing plan key
// Billing (provider-neutral names so switching provider needs no migration).
addColumn('users', 'bill_status TEXT');            // subscription status (active/past_due/canceled/...)
addColumn('users', 'bill_subscription_id TEXT');   // provider subscription id
addColumn('users', 'bill_customer_id TEXT');       // provider customer id (billing portal)
addColumn('users', 'bill_item_id TEXT');           // subscription item id (per-site quantity)
addColumn('users', 'bill_renews_at TEXT');         // next renewal timestamp
addColumn('users', 'bill_cancel_at_period_end INTEGER NOT NULL DEFAULT 0'); // cancelled but paid until period end
addColumn('sites', 'not_found_html TEXT'); // optional custom 404 page (served by the edge proxy)
addColumn('cf_hostnames', 'ssl_detail TEXT'); // issued-cert details (authority, validity) as JSON

// Short-lived password-reset tokens (store only a SHA-256 hash of the token, so
// a DB leak can't be used to reset anyone's password).
db.exec(`CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);`);

function logActivity(userId, action, detail = '') {
  db.prepare('INSERT INTO activity (user_id, action, detail) VALUES (?, ?, ?)')
    .run(userId, action, detail);
}

function getSetting(key, def = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

module.exports = { db, logActivity, getSetting, setSetting };
