const Database = require('better-sqlite3');
const config = require('./config');

const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

function logActivity(userId, action, detail = '') {
  db.prepare('INSERT INTO activity (user_id, action, detail) VALUES (?, ?, ?)')
    .run(userId, action, detail);
}

module.exports = { db, logActivity };
