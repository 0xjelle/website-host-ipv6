// Supervises Node.js site processes: start, stop, restart, log capture.
const { spawn } = require('child_process');
const path = require('path');
const { db, logActivity } = require('../db');

const procs = new Map(); // siteId -> { child, logs: string[], startedAt, restarts }
const MAX_LOG_LINES = 500;

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
  const entry = { child: null, logs: [], startedAt: Date.now(), restarts: procs.get(site.id)?.restarts ?? 0 };
  procs.set(site.id, entry);

  // Never let a bad launch crash the platform: if the working directory is
  // gone (e.g. its files were deleted) there's nothing to run.
  if (!require('fs').existsSync(cwd)) {
    appendLog(entry, `✖ cannot start: working directory is missing (${cwd}). Deploy or upload files first.`);
    db.prepare("UPDATE sites SET status = 'failed', app_pid = NULL WHERE id = ?").run(site.id);
    return entry;
  }

  let child;
  try {
    // Own process group so stop() can take down the whole tree.
    child = spawn('/bin/sh', ['-c', cmdline], { cwd, env, detached: true });
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
    // only fires on real crashes — auto-restart (max 5 rapid restarts).
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
    const pid = entry.child.pid;
    try { process.kill(-pid, 'SIGTERM'); } catch { try { entry.child.kill('SIGTERM'); } catch {} }
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} }, 5000).unref();
    entry.child = null;
  }
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

module.exports = { start, stop, status, logs, resetRestarts, reapStale, siteWorkDir };
