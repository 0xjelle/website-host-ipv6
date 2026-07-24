// Deploy pipeline: git clone/pull → npm install → build → (re)start.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db, logActivity } = require('../db');
const procman = require('./procman');
const gh = require('./github');
const mail = require('./mail');

const escHtml = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

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

// A site's own token wins; otherwise fall back to the owner's connected
// GitHub account token so private repos clone without a per-site token.
function tokenForSite(site) {
  if (site.repo_token) return site.repo_token;
  const u = db.prepare('SELECT github_token FROM users WHERE id = ?').get(site.user_id);
  if (u?.github_token) { try { return require('../crypto').decrypt(u.github_token); } catch {} }
  return null;
}

function authedRepoUrl(site) {
  const token = tokenForSite(site);
  if (!token || !site.repo_url?.startsWith('https://')) return site.repo_url;
  const u = new URL(site.repo_url);
  u.username = 'x-access-token';
  u.password = token;
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
    // never persist credentials embedded in an authenticated clone URL
    log += String(s).replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
    if (log.length > 200_000) log = log.slice(-200_000);
    db.prepare('UPDATE deployments SET log = ? WHERE id = ?').run(log, depId);
  };

  // Report deploy status to GitHub: a commit status (the ✓/✗ next to the
  // commit) AND a Deployment (the repo's Environments panel, like Vercel).
  // Best-effort; needs a token, repo name and a full SHA.
  let fullSha = commit.fullSha || null;
  let deploymentId = null;
  const dashUrl = `http://${config.publicHost}:${config.adminPort}/#/sites/${siteId}`;
  const ghToken = () => tokenForSite(site);
  const ghRepo = () => gh.repoFullName(site.repo_url);

  const siteUrl = () => {
    const domains = JSON.parse(site.domains || '[]');
    if (domains[0]) return `https://${domains[0]}`;
    const port = config.proxyPort === 80 ? '' : `:${config.proxyPort}`;
    return `http://${site.slug}.${config.siteBaseDomain}${port}`;
  };

  const ghStart = async () => {
    const token = ghToken(), full = ghRepo();
    if (!fullSha || !token || !full) return;
    gh.setCommitStatus(token, full, fullSha, 'pending', 'Deploying…', dashUrl);
    deploymentId = await gh.createDeployment(token, full, fullSha, site.name.slice(0, 60) || 'hosting', `Deploy of "${site.name}"`);
    if (deploymentId) gh.setDeploymentStatus(token, full, deploymentId, 'in_progress', { log_url: dashUrl, description: 'Building…' });
  };

  const finish = (ok, msg) => {
    out(`\n${ok ? '✔' : '✖'} ${msg}\n`);
    db.prepare("UPDATE deployments SET status = ?, finished_at = datetime('now') WHERE id = ?")
      .run(ok ? 'success' : 'failed', depId);
    db.prepare('UPDATE sites SET status = ? WHERE id = ?').run(ok ? 'live' : 'failed', siteId);
    logActivity(site.user_id, ok ? 'deploy.success' : 'deploy.failed', `"${site.name}" (${trigger})`);
    if (!ok) {
      try {
        const u = db.prepare('SELECT email FROM users WHERE id = ?').get(site.user_id);
        if (u?.email) mail.send({
          to: u.email,
          subject: `Deploy failed: ${site.name}`,
          text: `Your deployment of "${site.name}" failed: ${msg}\nLogs: ${dashUrl}`,
          html: mail.shell('Deploy failed', `<p>Your deployment of <b>${escHtml(site.name)}</b> failed:</p>
            <p style="color:#b00">${escHtml(msg)}</p><p><a href="${dashUrl}">View the deploy log</a></p>`),
        }).catch(() => {});
      } catch { /* never let notification break deploy */ }
    }
    const token = ghToken(), full = ghRepo();
    if (fullSha && token && full) {
      gh.setCommitStatus(token, full, fullSha, ok ? 'success' : 'failure', msg, ok ? siteUrl() : dashUrl);
      gh.setDeploymentStatus(token, full, deploymentId, ok ? 'success' : 'failure',
        { environment_url: ok ? siteUrl() : undefined, log_url: dashUrl, description: msg });
    }
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
      const revParse = (fmt) => new Promise(res => {
        let s = '';
        const c = spawn('git', ['-C', workDir, 'rev-parse', ...fmt, 'HEAD']);
        c.stdout.on('data', d => s += d.toString());
        c.on('exit', () => res(s.trim()));
        c.on('error', () => res(''));
      });
      const sha = await revParse(['--short']);
      fullSha = (await revParse([])) || fullSha;
      if (sha) {
        out(`   at commit ${sha}\n`);
        db.prepare('UPDATE deployments SET commit_sha = COALESCE(commit_sha, ?) WHERE id = ?').run(sha, depId);
      }
      await ghStart(); // commit status + GitHub Deployment, now that we have the SHA

      const hasPkg = fs.existsSync(path.join(workDir, 'package.json'));
      // Containerised Node apps install & build INSIDE their container (so
      // native modules match the container OS) — skip doing it on the host.
      const containerMode = site.type === 'node' && procman.useContainers();

      // 2. Install dependencies
      if (hasPkg && (site.type === 'node' || site.build_cmd) && !containerMode) {
        out('── Installing dependencies\n');
        const lockfile = fs.existsSync(path.join(workDir, 'package-lock.json'));
        const code = await sh('npm', [lockfile ? 'ci' : 'install', '--no-audit', '--no-fund'], { cwd: workDir }, out);
        if (code) return finish(false, 'npm install failed');
      }

      // 3. Build
      if (site.build_cmd && site.build_cmd.trim() && !containerMode) {
        out(`── Building: ${site.build_cmd}\n`);
        const code = await sh('/bin/sh', ['-c', site.build_cmd], { cwd: workDir, env: JSON.parse(site.env_vars || '{}') }, out);
        if (code) return finish(false, 'build failed');
      }

      // Container mode: clear any host node_modules so the container does a
      // clean install/build for this fresh code on its next start.
      if (containerMode) {
        out('── Dependencies & build run inside the container\n');
        try { fs.rmSync(path.join(workDir, 'node_modules'), { recursive: true, force: true }); } catch { /* ignore */ }
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
      // In container mode, serve the static site from its own nginx container.
      if (procman.useContainers()) {
        procman.start(db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId), config);
      }
      return finish(true, 'deployed — static site is live');
    } catch (err) {
      finish(false, `unexpected error: ${err.message}`);
    }
  })();

  return { queued: true, deploymentId: depId };
}

module.exports = { deploy, isRunning: (id) => running.has(id) };
