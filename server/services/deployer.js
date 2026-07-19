// Deploy pipeline: git clone/pull → npm install → build → (re)start.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db, logActivity } = require('../db');
const procman = require('./procman');

const running = new Set(); // site ids with an in-flight deploy

function sh(cmd, args, opts, onOutput) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, env: { ...process.env, ...opts?.env } });
    child.stdout.on('data', d => onOutput(d.toString()));
    child.stderr.on('data', d => onOutput(d.toString()));
    child.on('error', err => { onOutput(`error: ${err.message}\n`); resolve(1); });
    child.on('exit', code => resolve(code ?? 1));
  });
}

function authedRepoUrl(site) {
  if (!site.repo_token || !site.repo_url?.startsWith('https://')) return site.repo_url;
  const u = new URL(site.repo_url);
  u.username = 'x-access-token';
  u.password = site.repo_token;
  return u.toString();
}

async function deploy(siteId, trigger = 'manual', commit = {}) {
  if (running.has(siteId)) return { queued: false, reason: 'A deployment is already running for this site' };
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  if (!site) return { queued: false, reason: 'Site not found' };
  if (!site.repo_url) return { queued: false, reason: 'No repository connected' };

  running.add(siteId);
  const dep = db.prepare(
    'INSERT INTO deployments (site_id, trigger, commit_sha, commit_msg, status) VALUES (?, ?, ?, ?, ?)'
  ).run(siteId, trigger, commit.sha || null, commit.message || null, 'running');
  const depId = dep.lastInsertRowid;
  db.prepare("UPDATE sites SET status = 'deploying' WHERE id = ?").run(siteId);

  let log = '';
  const out = (s) => {
    log += s;
    if (log.length > 200_000) log = log.slice(-200_000);
    db.prepare('UPDATE deployments SET log = ? WHERE id = ?').run(log, depId);
  };

  const finish = (ok, msg) => {
    out(`\n${ok ? '✔' : '✖'} ${msg}\n`);
    db.prepare("UPDATE deployments SET status = ?, finished_at = datetime('now') WHERE id = ?")
      .run(ok ? 'success' : 'failed', depId);
    db.prepare('UPDATE sites SET status = ? WHERE id = ?').run(ok ? 'live' : 'failed', siteId);
    logActivity(site.user_id, ok ? 'deploy.success' : 'deploy.failed', `"${site.name}" (${trigger})`);
    running.delete(siteId);
  };

  (async () => {
    try {
      const siteDir = path.join(config.sitesDir, String(siteId));
      const workDir = path.join(siteDir, 'current');
      fs.mkdirSync(siteDir, { recursive: true });
      const url = authedRepoUrl(site);
      const gitEnv = { GIT_TERMINAL_PROMPT: '0' };

      // 1. Fetch code
      if (fs.existsSync(path.join(workDir, '.git'))) {
        out(`── Pulling ${site.repo_url} (${site.repo_branch})\n`);
        if (await sh('git', ['-C', workDir, 'remote', 'set-url', 'origin', url], { env: gitEnv }, out)) return finish(false, 'git remote update failed');
        if (await sh('git', ['-C', workDir, 'fetch', 'origin', site.repo_branch], { env: gitEnv }, out)) return finish(false, 'git fetch failed');
        if (await sh('git', ['-C', workDir, 'reset', '--hard', `origin/${site.repo_branch}`], { env: gitEnv }, out)) return finish(false, 'git reset failed');
      } else {
        out(`── Cloning ${site.repo_url} (${site.repo_branch})\n`);
        fs.rmSync(workDir, { recursive: true, force: true });
        if (await sh('git', ['clone', '--depth', '1', '--branch', site.repo_branch, url, workDir], { env: gitEnv }, out)) {
          return finish(false, 'git clone failed — check the URL, branch and access token');
        }
      }
      const sha = await new Promise(res => {
        let s = '';
        const c = spawn('git', ['-C', workDir, 'rev-parse', '--short', 'HEAD']);
        c.stdout.on('data', d => s += d.toString());
        c.on('exit', () => res(s.trim()));
        c.on('error', () => res(''));
      });
      if (sha) {
        out(`   at commit ${sha}\n`);
        db.prepare('UPDATE deployments SET commit_sha = COALESCE(commit_sha, ?) WHERE id = ?').run(sha, depId);
      }

      const hasPkg = fs.existsSync(path.join(workDir, 'package.json'));

      // 2. Install dependencies
      if (hasPkg && (site.type === 'node' || site.build_cmd)) {
        out('── Installing dependencies\n');
        const lockfile = fs.existsSync(path.join(workDir, 'package-lock.json'));
        const code = await sh('npm', [lockfile ? 'ci' : 'install', '--no-audit', '--no-fund'], { cwd: workDir }, out);
        if (code) return finish(false, 'npm install failed');
      }

      // 3. Build
      if (site.build_cmd && site.build_cmd.trim()) {
        out(`── Building: ${site.build_cmd}\n`);
        const code = await sh('/bin/sh', ['-c', site.build_cmd], { cwd: workDir, env: JSON.parse(site.env_vars || '{}') }, out);
        if (code) return finish(false, 'build failed');
      }

      // 4. Start / go live
      if (site.type === 'node') {
        out('── Starting application\n');
        procman.resetRestarts(siteId);
        db.prepare("UPDATE sites SET status = 'live' WHERE id = ?").run(siteId);
        const fresh = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
        procman.start(fresh, config);
        return finish(true, `deployed — app running on internal port ${site.app_port}`);
      }
      const serveDir = path.join(workDir, site.static_dir || '');
      if (!fs.existsSync(serveDir)) return finish(false, `static directory "${site.static_dir}" not found in repo`);
      return finish(true, 'deployed — static site is live');
    } catch (err) {
      finish(false, `unexpected error: ${err.message}`);
    }
  })();

  return { queued: true, deploymentId: depId };
}

module.exports = { deploy, isRunning: (id) => running.has(id) };
