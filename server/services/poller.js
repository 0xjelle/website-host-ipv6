// Polls GitHub for new commits and auto-deploys - the pull-based counterpart
// to webhooks, for servers GitHub can't reach (behind NAT / private IP).
// Every interval, each auto-deploy site's configured branch is checked; if
// its head commit differs from what's currently checked out, a deploy runs.
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { db, logActivity } = require('../db');
const gh = require('./github');
const deployer = require('./deployer');
const { decrypt } = require('../crypto');

const INTERVAL = Math.max(30, parseInt(process.env.POLL_INTERVAL_SEC || '120', 10)) * 1000;
let rateLimitedUntil = 0;

function tokenForSite(site) {
  if (site.repo_token) return site.repo_token;
  const u = db.prepare('SELECT github_token FROM users WHERE id = ?').get(site.user_id);
  if (u?.github_token) { try { return decrypt(u.github_token); } catch {} }
  return null;
}

function currentSha(siteId) {
  return new Promise((resolve) => {
    const wd = path.join(config.sitesDir, String(siteId), 'current');
    if (!fs.existsSync(path.join(wd, '.git'))) return resolve(null);
    let s = '';
    const c = execFile('git', ['-C', wd, 'rev-parse', 'HEAD'], (err) => resolve(err ? null : s.trim()));
    c.stdout.on('data', d => s += d.toString());
  });
}

// Check one site now; deploy if the remote head differs. Returns a summary.
async function checkSite(site) {
  if (!site.repo_url || !site.auto_deploy) return { skipped: 'auto-deploy off or no repo' };
  if (deployer.isRunning(site.id)) return { skipped: 'deploy in progress' };
  const full = gh.repoFullName(site.repo_url);
  if (!full) return { skipped: 'not a github repo' };

  let latest;
  try { latest = await gh.getLatestCommit(tokenForSite(site), full, site.repo_branch); }
  catch (e) {
    if (e.rateLimited) { rateLimitedUntil = Date.now() + 10 * 60_000; return { error: 'rate limited' }; }
    return { error: e.message };
  }
  if (!latest?.sha) return { error: 'could not read latest commit (private repo without a token?)' };

  const local = await currentSha(site.id);
  if (local && local === latest.sha) return { upToDate: true, sha: latest.sha.slice(0, 7) };

  logActivity(site.user_id, 'deploy.poll', `"${site.name}" new commit ${latest.sha.slice(0, 7)} on ${site.repo_branch}`);
  deployer.deploy(site.id, 'push', { sha: latest.sha.slice(0, 7), message: latest.message, fullSha: latest.sha });
  return { deploying: true, sha: latest.sha.slice(0, 7) };
}

async function tick() {
  if (Date.now() < rateLimitedUntil) return;
  const sites = db.prepare("SELECT * FROM sites WHERE auto_deploy = 1 AND repo_url IS NOT NULL").all();
  for (const site of sites) {
    try { await checkSite(site); } catch { /* keep going */ }
  }
}

function start() {
  console.log(`⬡ Hosting auto-deploy → polling GitHub every ${INTERVAL / 1000}s for pushes`);
  setTimeout(tick, 8000);          // first pass shortly after boot
  setInterval(tick, INTERVAL).unref();
}

module.exports = { start, checkSite };
