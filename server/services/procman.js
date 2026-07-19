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
  const child = spawn('/bin/sh', ['-c', cmdline], { cwd, env });
  const entry = { child, logs: [], startedAt: Date.now(), restarts: procs.get(site.id)?.restarts ?? 0 };
  procs.set(site.id, entry);
  appendLog(entry, `▶ starting: ${cmdline} (PORT=${site.app_port})`);

  child.stdout.on('data', d => appendLog(entry, d.toString()));
  child.stderr.on('data', d => appendLog(entry, d.toString()));
  child.on('exit', (code, signal) => {
    appendLog(entry, `■ process exited (code=${code} signal=${signal})`);
    entry.child = null;
    const current = db.prepare('SELECT status FROM sites WHERE id = ?').get(site.id);
    // Auto-restart crashed apps (max 5 rapid restarts), unless deliberately stopped
    if (current && current.status === 'live' && entry.restarts < 5) {
      entry.restarts += 1;
      appendLog(entry, `↻ auto-restarting (attempt ${entry.restarts}/5)`);
      const fresh = db.prepare('SELECT * FROM sites WHERE id = ?').get(site.id);
      setTimeout(() => { if (procs.get(site.id) === entry) start(fresh, config); }, 1500 * entry.restarts);
    } else if (current && current.status === 'live') {
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
    try { entry.child.kill('SIGTERM'); } catch {}
    const child = entry.child;
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref();
    entry.child = null;
  }
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

module.exports = { start, stop, status, logs, resetRestarts, siteWorkDir };
