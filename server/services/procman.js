// Supervises Node.js site processes: start, stop, restart, log capture.
const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { db, logActivity } = require('../db');

const procs = new Map(); // siteId -> { child, logs: string[], startedAt, restarts }
const MAX_LOG_LINES = 500;

// Multi-tenant isolation: each site's Node app runs as its own dedicated,
// unprivileged system user (hsite<id>) that owns only that site's files. This
// stops one tenant from reading another tenant's files/secrets or the
// platform's data. Best-effort - requires the platform to run as root with
// useradd available; otherwise we fall back to running as the platform user.
function siteUnixUser(siteId) {
  if (!(process.getuid && process.getuid() === 0)) return null;
  const name = `hsite${siteId}`;
  try {
    let uid;
    try { uid = parseInt(execFileSync('id', ['-u', name], { stdio: ['ignore', 'pipe', 'ignore'] }).toString(), 10); }
    catch {
      execFileSync('useradd', ['-r', '-M', name], { stdio: 'ignore' });
      uid = parseInt(execFileSync('id', ['-u', name]).toString(), 10);
    }
    const gid = parseInt(execFileSync('id', ['-g', name]).toString(), 10);
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
    return { uid, gid, name };
  } catch { return null; }
}

function appendLog(entry, line) {
  for (const l of line.split('\n')) {
    if (!l.trim()) continue;
    entry.logs.push(`[${new Date().toISOString()}] ${l}`);
  }
  if (entry.logs.length > MAX_LOG_LINES) entry.logs.splice(0, entry.logs.length - MAX_LOG_LINES);
}

function siteWorkDir(site, config) {
  return path.join(config.sitesDir, String(site.id), 'current');
}

// ── container runtime (opt-in, stronger isolation) ──────────────────
let _docker; // cached availability
function dockerBin() {
  if (_docker !== undefined) return _docker;
  try { execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: ['ignore', 'pipe', 'ignore'] }); _docker = 'docker'; }
  catch { _docker = null; }
  return _docker;
}
// Containerise each site when USE_CONTAINERS=1 and Docker is actually usable.
function useContainers() { return process.env.USE_CONTAINERS === '1' && !!dockerBin(); }

// Static sites normally have no port; give them one when they're containerised.
function ensureAppPort(site, config) {
  if (site.app_port) return site.app_port;
  const used = new Set(db.prepare('SELECT app_port FROM sites WHERE app_port IS NOT NULL').all().map(r => r.app_port));
  let p = config.appPortBase;
  while (used.has(p)) p++;
  db.prepare('UPDATE sites SET app_port = ? WHERE id = ?').run(p, site.id);
  site.app_port = p;
  return p;
}

// Serve a static site from its own nginx container (mounted read-only). Same
// isolation/limits as node apps; the edge proxy routes to it, falling back to
// serving files directly if the container isn't up.
function startStaticContainer(site, config, cwd, entry) {
  const name = `hsite${site.id}`;
  const port = ensureAppPort(site, config);
  const sub = String(site.static_dir || '').replace(/\.\.+/g, '').replace(/^\/+/, '');
  const docroot = '/site' + (sub ? '/' + sub : '');
  const conf = `server {
  listen ${port};
  server_name _;
  root ${docroot};
  index index.html;
  location / { try_files $uri $uri/ /index.html; }
  error_page 404 /404.html;
}
`;
  const confPath = path.join(config.sitesDir, String(site.id), 'nginx.conf');
  try { fs.writeFileSync(confPath, conf); }
  catch (e) { appendLog(entry, `✖ nginx config write failed: ${e.message}`); db.prepare("UPDATE sites SET status = 'failed' WHERE id = ?").run(site.id); return entry; }
  const mem = process.env.SITE_MEM || '256m';
  const cpus = process.env.SITE_CPUS || '1';
  const args = ['run', '-d', '--name', name, '--restart', 'unless-stopped',
    '--memory', mem, '--cpus', cpus, '--pids-limit', '256',
    '-v', `${cwd}:/site:ro`, '-v', `${confPath}:/etc/nginx/conf.d/default.conf:ro`,
    '-p', `127.0.0.1:${port}:${port}`, 'nginx:alpine'];
  try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch { /* none */ }
  try { execFileSync('docker', args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { appendLog(entry, `✖ static container failed: ${String(e.stderr || e.message || '').trim()}`); db.prepare("UPDATE sites SET status = 'failed' WHERE id = ?").run(site.id); return entry; }
  entry.container = true;
  appendLog(entry, `🐳 static site in container ${name} (nginx:alpine · :${port})`);
  const follower = spawn('docker', ['logs', '-f', '--tail', '200', name]);
  entry.child = follower;
  follower.stdout.on('data', d => appendLog(entry, d.toString()));
  follower.stderr.on('data', d => appendLog(entry, d.toString()));
  follower.on('error', () => {});
  follower.on('exit', () => { if (procs.get(site.id) === entry) entry.child = null; });
  return entry;
}

// Run a site's Node app inside its own Docker container: private filesystem +
// network, CPU/memory caps. Deps are installed and the app built inside the
// container so native modules match. The container name is hsite<id>.
function startInContainer(site, cwd, entry) {
  const name = `hsite${site.id}`;
  const startCmd = site.start_cmd && site.start_cmd.trim() ? site.start_cmd : 'npm start';
  const build = site.build_cmd && site.build_cmd.trim() ? site.build_cmd : null;
  // Install (and build) only when node_modules is absent - the deployer clears
  // it on each deploy, so a fresh deploy reinstalls while a plain restart skips.
  const inner = 'set -e; if [ -f package.json ] && [ ! -d node_modules ]; then npm install --omit=dev'
    + (build ? ` && ${build}` : '') + '; fi; exec ' + startCmd;
  const mem = process.env.SITE_MEM || '512m';
  const cpus = process.env.SITE_CPUS || '1';
  const args = ['run', '-d', '--name', name, '--restart', 'unless-stopped',
    '--memory', mem, '--cpus', cpus, '--pids-limit', '512',
    '-v', `${cwd}:/app`, '-w', '/app',
    '-p', `127.0.0.1:${site.app_port}:${site.app_port}`,
    '-e', 'NODE_ENV=production', '-e', `PORT=${site.app_port}`];
  for (const [k, v] of Object.entries(JSON.parse(site.env_vars || '{}'))) args.push('-e', `${k}=${String(v)}`);
  args.push('node:22', 'sh', '-c', inner);

  try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch { /* none */ }
  try {
    execFileSync('docker', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    appendLog(entry, `✖ container failed to start: ${String(e.stderr || e.message || '').trim()}`);
    db.prepare("UPDATE sites SET status = 'failed', app_pid = NULL WHERE id = ?").run(site.id);
    return entry;
  }
  entry.container = true;
  db.prepare('UPDATE sites SET app_pid = NULL WHERE id = ?').run(site.id);
  appendLog(entry, `🐳 running in container ${name} (node:22 · mem ${mem} · cpus ${cpus})`);
  // Follow container logs into the runtime-logs buffer. Its lifetime tracks the
  // container; Docker's restart policy supervises the app, so we don't re-launch.
  const follower = spawn('docker', ['logs', '-f', '--tail', '500', name]);
  entry.child = follower;
  follower.stdout.on('data', d => appendLog(entry, d.toString()));
  follower.stderr.on('data', d => appendLog(entry, d.toString()));
  follower.on('error', () => {});
  follower.on('exit', () => { if (procs.get(site.id) === entry) entry.child = null; });
  return entry;
}

function start(site, config) {
  stop(site.id);
  const cwd = siteWorkDir(site, config);
  const cmdline = site.start_cmd && site.start_cmd.trim() ? site.start_cmd : 'npm start --silent';
  const env = {
    ...process.env,
    ...JSON.parse(site.env_vars || '{}'),
    PORT: String(site.app_port),
    NODE_ENV: 'production',
  };
  const entry = { child: null, logs: [], startedAt: Date.now(), restarts: procs.get(site.id)?.restarts ?? 0, container: false };
  procs.set(site.id, entry);

  // Never let a bad launch crash the platform: if the working directory is
  // gone (e.g. its files were deleted) there's nothing to run.
  if (!fs.existsSync(cwd)) {
    appendLog(entry, `✖ cannot start: working directory is missing (${cwd}). Deploy or upload files first.`);
    db.prepare("UPDATE sites SET status = 'failed', app_pid = NULL WHERE id = ?").run(site.id);
    return entry;
  }

  // Strongest isolation: run in a container when enabled. Static sites get an
  // nginx container; node apps get a node container.
  if (useContainers()) {
    return site.type === 'static' ? startStaticContainer(site, config, cwd, entry) : startInContainer(site, cwd, entry);
  }

  // Otherwise: hand the site its own user and make it own its files, then run the
  // process as that user. If any of that fails, fall back to the platform user
  // rather than leaving the app unable to read its files.
  const siteRoot = path.join(config.sitesDir, String(site.id));
  let owner = siteUnixUser(site.id);
  if (owner) {
    try {
      // -R every start: a redeploy/SFTP writes files as root, and the app (the
      // site user) must own them to read/write. Bounded - start isn't frequent.
      execFileSync('chown', ['-R', `${owner.uid}:${owner.gid}`, siteRoot]);
      fs.chmodSync(siteRoot, 0o750); // other tenants can't traverse in
      env.HOME = siteRoot;
    } catch (e) {
      appendLog(entry, `⚠ isolation setup failed (${e.message}); running as the platform user`);
      owner = null;
    }
  }
  const spawnOpts = { cwd, env, detached: true };
  if (owner) { spawnOpts.uid = owner.uid; spawnOpts.gid = owner.gid; }

  let child;
  try {
    // Own process group so stop() can take down the whole tree.
    child = spawn('/bin/sh', ['-c', cmdline], spawnOpts);
    if (owner) appendLog(entry, `🔒 running isolated as ${owner.name} (uid ${owner.uid})`);
  } catch (e) {
    appendLog(entry, `✖ failed to launch: ${e.message}`);
    db.prepare("UPDATE sites SET status = 'failed', app_pid = NULL WHERE id = ?").run(site.id);
    return entry;
  }
  entry.child = child;
  db.prepare('UPDATE sites SET app_pid = ? WHERE id = ?').run(child.pid || null, site.id);
  appendLog(entry, `▶ starting: ${cmdline} (PORT=${site.app_port})`);

  // Without this, a spawn error (bad cwd, missing shell) is thrown as an
  // uncaught exception and crashes the whole server.
  child.on('error', (err) => {
    appendLog(entry, `✖ process error: ${err.message}`);
    entry.child = null;
    db.prepare("UPDATE sites SET status = 'failed', app_pid = NULL WHERE id = ?").run(site.id);
  });
  child.stdout.on('data', d => appendLog(entry, d.toString()));
  child.stderr.on('data', d => appendLog(entry, d.toString()));
  child.on('exit', (code, signal) => {
    appendLog(entry, `■ process exited (code=${code} signal=${signal})`);
    entry.child = null;
    const current = db.prepare('SELECT status FROM sites WHERE id = ?').get(site.id);
    // 'live' apps are public; 'stopped' apps still run locally for testing.
    // Both are supervised. A deliberate stop() detaches this listener, so this
    // only fires on real crashes - auto-restart (max 5 rapid restarts).
    const supervised = current && (current.status === 'live' || current.status === 'stopped');
    if (supervised && entry.restarts < 5) {
      entry.restarts += 1;
      appendLog(entry, `↻ auto-restarting (attempt ${entry.restarts}/5)`);
      const fresh = db.prepare('SELECT * FROM sites WHERE id = ?').get(site.id);
      setTimeout(() => { if (procs.get(site.id) === entry) start(fresh, config); }, 1500 * entry.restarts);
    } else if (supervised) {
      db.prepare("UPDATE sites SET status = 'failed' WHERE id = ?").run(site.id);
      logActivity(site.user_id, 'site.crashed', `Site "${site.name}" crashed repeatedly and was marked failed`);
    }
  });
  return entry;
}

function stop(siteId) {
  const entry = procs.get(siteId);
  if (entry?.child) {
    entry.child.removeAllListeners('exit');
    if (entry.container) {
      try { entry.child.kill(); } catch { /* the log follower */ }
    } else {
      const pid = entry.child.pid;
      try { process.kill(-pid, 'SIGTERM'); } catch { try { entry.child.kill('SIGTERM'); } catch {} }
      setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} }, 5000).unref();
    }
    entry.child = null;
  }
  // Remove any container for this site - ASYNC (fire-and-forget): a synchronous
  // `docker rm -f` on a running container blocks the whole event loop for
  // seconds and made site deletion hang. start() re-removes synchronously right
  // before `docker run`, so nothing races on this. No-op without Docker.
  if (dockerBin()) execFile('docker', ['rm', '-f', `hsite${siteId}`], () => {});
  db.prepare('UPDATE sites SET app_pid = NULL WHERE id = ?').run(siteId);
}

// Kill a process group left over from a previous platform run (boot cleanup)
function reapStale(site) {
  if (!site.app_pid) return;
  try { process.kill(-site.app_pid, 'SIGKILL'); } catch {}
  db.prepare('UPDATE sites SET app_pid = NULL WHERE id = ?').run(site.id);
}

function status(siteId) {
  const entry = procs.get(siteId);
  return {
    running: !!entry?.child,
    uptimeSec: entry?.child ? Math.floor((Date.now() - entry.startedAt) / 1000) : 0,
    restarts: entry?.restarts ?? 0,
  };
}

function logs(siteId) {
  return procs.get(siteId)?.logs ?? [];
}

function resetRestarts(siteId) {
  const entry = procs.get(siteId);
  if (entry) entry.restarts = 0;
}

module.exports = { start, stop, status, logs, resetRestarts, reapStale, siteWorkDir, useContainers };
