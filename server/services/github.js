// Thin GitHub REST client used for account connections: validate a token,
// list the user's repositories (public + private), and auto-create deploy
// webhooks. Uses Node's global fetch; no dependencies.
const API = 'https://api.github.com';

async function gh(token, path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'HostingPlatform',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
  });
  return res;
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

module.exports = { getUser, listRepos, createWebhook };
