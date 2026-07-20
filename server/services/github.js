// Thin GitHub REST client used for account connections: validate a token,
// list the user's repositories (public + private), and auto-create deploy
// webhooks. Uses Node's global fetch; no dependencies.
const API = 'https://api.github.com';

async function gh(token, path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      // token is optional — public repos work unauthenticated (rate-limited)
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: 'application/vnd.github+json',
      'User-Agent': 'HostingPlatform',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
  });
  return res;
}

// Latest commit on a branch → { sha, message } or null. Works with or
// without a token (public repos).
async function getLatestCommit(token, fullName, branch) {
  const res = await gh(token, `/repos/${fullName}/commits/${encodeURIComponent(branch)}`);
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const e = new Error('GitHub API rate limit reached'); e.rateLimited = true; throw e;
  }
  if (!res.ok) return null;
  const c = await res.json();
  return { sha: c.sha, message: c.commit?.message || '' };
}

// Returns { login, name } or throws with a friendly message.
async function getUser(token) {
  let res;
  try { res = await gh(token, '/user'); }
  catch (e) { throw new Error(`Could not reach GitHub: ${e.message}`); }
  if (res.status === 401) throw new Error('GitHub rejected that token (invalid or expired)');
  if (!res.ok) throw new Error(`GitHub error ${res.status}`);
  const u = await res.json();
  return { login: u.login, name: u.name || u.login };
}

// All repos the token can see, newest first. Paginates up to 300.
async function listRepos(token) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const res = await gh(token, `/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page=${page}`);
    if (!res.ok) {
      if (res.status === 401) throw new Error('GitHub token invalid or expired');
      throw new Error(`GitHub error ${res.status}`);
    }
    const batch = await res.json();
    for (const r of batch) {
      out.push({
        full_name: r.full_name,
        clone_url: r.clone_url,
        private: !!r.private,
        default_branch: r.default_branch || 'main',
        updated_at: r.updated_at,
        fork: !!r.fork,
      });
    }
    if (batch.length < 100) break;
  }
  return out;
}

// Best-effort: create a push webhook. Returns { created } or { created:false, reason }.
async function createWebhook(token, fullName, url, secret) {
  try {
    // avoid duplicates: check existing hooks for the same URL
    const existing = await gh(token, `/repos/${fullName}/hooks`);
    if (existing.ok) {
      const hooks = await existing.json();
      if (hooks.some(h => h.config?.url === url)) return { created: false, reason: 'webhook already present' };
    }
    const res = await gh(token, `/repos/${fullName}/hooks`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'web', active: true, events: ['push'],
        config: { url, content_type: 'json', secret, insecure_ssl: '0' },
      }),
    });
    if (res.status === 201) return { created: true };
    if (res.status === 404) return { created: false, reason: 'no admin rights on the repo (or wrong name)' };
    const body = await res.json().catch(() => ({}));
    return { created: false, reason: body.message || `GitHub error ${res.status}` };
  } catch (e) {
    return { created: false, reason: e.message };
  }
}

// Post a commit status (the ✓/✗ shown next to a commit on GitHub).
// state: pending | success | failure | error
async function setCommitStatus(token, fullName, sha, state, description, targetUrl) {
  try {
    const res = await gh(token, `/repos/${fullName}/statuses/${sha}`, {
      method: 'POST',
      body: JSON.stringify({
        state,
        context: 'Hosting / deploy',
        description: (description || '').slice(0, 140),
        target_url: targetUrl || undefined,
      }),
    });
    return { ok: res.status === 201 };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Create a GitHub Deployment (shows up in the repo's Environments panel).
// Returns the deployment id or null.
async function createDeployment(token, fullName, ref, environment, description) {
  try {
    const res = await gh(token, `/repos/${fullName}/deployments`, {
      method: 'POST',
      body: JSON.stringify({
        ref, environment, description: (description || '').slice(0, 140),
        auto_merge: false, required_contexts: [],
        transient_environment: false, production_environment: true,
      }),
    });
    if (res.status === 201) return (await res.json()).id;
    return null;
  } catch { return null; }
}

// Update a deployment's status: queued | in_progress | success | failure.
// environment_url links to the live site; log_url to the dashboard.
async function setDeploymentStatus(token, fullName, id, state, opts = {}) {
  if (!id) return { ok: false };
  try {
    const res = await gh(token, `/repos/${fullName}/deployments/${id}/statuses`, {
      method: 'POST',
      body: JSON.stringify({
        state,
        environment_url: opts.environment_url || undefined,
        log_url: opts.log_url || undefined,
        description: (opts.description || '').slice(0, 140),
      }),
    });
    return { ok: res.status === 201 };
  } catch (e) { return { ok: false, reason: e.message }; }
}

const repoFullName = (url) => {
  const m = String(url || '').match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  return m ? m[1] : null;
};

module.exports = {
  getUser, listRepos, createWebhook, setCommitStatus, repoFullName, getLatestCommit,
  createDeployment, setDeploymentStatus,
};
