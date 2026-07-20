/* Hosting console — hash-routed SPA, no build step. */
(() => {
  const $app = document.getElementById('app');
  let me = null;

  // ── helpers ─────────────────────────────────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content; };

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...opts,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }
  const oops = (e) => toast(e.message || String(e), 'err');

  function copy(text, label = 'Copied') {
    navigator.clipboard?.writeText(text).then(() => toast(label, 'ok')).catch(() => toast('Copy failed — select manually', 'err'));
  }
  window._copy = copy;

  const fmtDate = (s) => s ? new Date(s.includes('T') ? s : s + 'Z').toLocaleString() : '—';
  const ago = (s) => {
    if (!s) return '—';
    const sec = Math.floor((Date.now() - new Date(s.includes('T') ? s : s + 'Z')) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  };
  const uptimeStr = (sec) => {
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
    return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
  };
  const pill = (status) => `<span class="pill ${esc(status)}"><span class="dot"></span>${esc(status)}</span>`;

  function modal(html) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal">${html}</div>`;
    back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
    return back;
  }

  // ── charts (SVG, no deps) ───────────────────────────────────────
  const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Smooth single-series line/area chart with crosshair tooltip.
  function lineChart(el, points, { color = 'var(--accent)', unit = '', maxY = null, label = '' } = {}) {
    if (!points || points.length < 2) {
      el.innerHTML = `<div class="chart-empty">No data yet — collecting…</div>`;
      return;
    }
    const W = 640, H = 160, PL = 34, PB = 18, PT = 8, PR = 6;
    const xs = points.map(p => p.t), ys = points.map(p => p.v);
    const x0 = xs[0], x1 = xs[xs.length - 1];
    const yMax = Math.max(maxY ?? 0, Math.max(...ys) * 1.15, 1);
    const X = (t) => PL + (t - x0) / (x1 - x0 || 1) * (W - PL - PR);
    const Y = (v) => PT + (1 - v / yMax) * (H - PT - PB);
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
    const area = `${path}L${X(x1).toFixed(1)},${Y(0)}L${X(x0).toFixed(1)},${Y(0)}Z`;
    const gridY = [0.5, 1].map(f => yMax * f);
    el.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="${esc(label)}">
        ${gridY.map(v => `<line x1="${PL}" y1="${Y(v)}" x2="${W - PR}" y2="${Y(v)}" class="grid"/>
          <text x="${PL - 6}" y="${Y(v) + 3}" class="axis" text-anchor="end">${v >= 10 ? Math.round(v) : v.toFixed(1)}</text>`).join('')}
        <line x1="${PL}" y1="${Y(0)}" x2="${W - PR}" y2="${Y(0)}" class="grid base"/>
        <text x="${PL}" y="${H - 4}" class="axis">${fmtTime(x0)}</text>
        <text x="${W - PR}" y="${H - 4}" class="axis" text-anchor="end">${fmtTime(x1)}</text>
        <path d="${area}" fill="${color}" opacity="0.08"/>
        <path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
        <line class="xhair" y1="${PT}" y2="${Y(0)}" style="display:none"/>
        <circle class="dot" r="3.5" fill="${color}" stroke="var(--panel)" stroke-width="2" style="display:none"/>
      </svg>
      <div class="chart-tip" style="display:none"></div>`;
    const svg = el.querySelector('svg'), tip = el.querySelector('.chart-tip');
    const xhair = svg.querySelector('.xhair'), dot = svg.querySelector('.dot');
    svg.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const t = x0 + ((e.clientX - r.left) / r.width * W - PL) / (W - PL - PR) * (x1 - x0);
      let best = points[0];
      for (const p of points) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      xhair.setAttribute('x1', X(best.t)); xhair.setAttribute('x2', X(best.t));
      dot.setAttribute('cx', X(best.t)); dot.setAttribute('cy', Y(best.v));
      xhair.style.display = dot.style.display = '';
      tip.style.display = '';
      tip.textContent = `${fmtTime(best.t)} · ${best.v}${unit}`;
      const px = (X(best.t) / W) * r.width;
      tip.style.left = Math.min(Math.max(px, 40), r.width - 60) + 'px';
    });
    svg.addEventListener('mouseleave', () => { xhair.style.display = dot.style.display = tip.style.display = 'none'; });
  }

  // Stacked bar chart for deployments/day (status colors + legend).
  function deployBars(el, days) {
    if (!days.length || days.every(d => !d.success && !d.failed)) {
      el.innerHTML = `<div class="chart-empty">No deployments in the last 14 days.</div>`;
      return;
    }
    const W = 640, H = 160, PL = 26, PB = 20, PT = 8, PR = 6;
    const max = Math.max(...days.map(d => d.success + d.failed), 1);
    const bw = (W - PL - PR) / days.length;
    const Y = (v) => PT + (1 - v / max) * (H - PT - PB);
    const bars = days.map((d, i) => {
      const x = PL + i * bw + bw * 0.18, w = bw * 0.64;
      const hS = (H - PT - PB) * d.success / max, hF = (H - PT - PB) * d.failed / max;
      let y = H - PB;
      let out = '';
      if (d.success) { y -= hS; out += `<rect x="${x}" y="${y}" width="${w}" height="${Math.max(hS - 1, 1)}" rx="3" fill="var(--good)" opacity=".85"/>`; }
      if (d.failed) { y -= hF + (d.success ? 2 : 0); out += `<rect x="${x}" y="${y}" width="${w}" height="${Math.max(hF - 1, 1)}" rx="3" fill="var(--bad)" opacity=".85"/>`; }
      return `<g class="bar" data-i="${i}">${out}<rect x="${PL + i * bw}" y="${PT}" width="${bw}" height="${H - PT - PB}" fill="transparent"/></g>`;
    }).join('');
    el.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <line x1="${PL}" y1="${Y(max)}" x2="${W - PR}" y2="${Y(max)}" class="grid"/>
        <text x="${PL - 5}" y="${Y(max) + 3}" class="axis" text-anchor="end">${max}</text>
        <line x1="${PL}" y1="${H - PB}" x2="${W - PR}" y2="${H - PB}" class="grid base"/>
        <text x="${PL}" y="${H - 5}" class="axis">${esc(days[0].label.slice(5))}</text>
        <text x="${W - PR}" y="${H - 5}" class="axis" text-anchor="end">${esc(days[days.length - 1].label.slice(5))}</text>
        ${bars}
      </svg>
      <div class="chart-legend">
        <span><span class="swatch" style="background:var(--good)"></span>success</span>
        <span><span class="swatch" style="background:var(--bad)"></span>failed</span>
      </div>
      <div class="chart-tip" style="display:none"></div>`;
    const tip = el.querySelector('.chart-tip'), svg = el.querySelector('svg');
    svg.querySelectorAll('.bar').forEach(g => {
      g.addEventListener('mousemove', (e) => {
        const d = days[+g.dataset.i];
        const r = svg.getBoundingClientRect();
        tip.style.display = '';
        tip.textContent = `${d.label.slice(5)} · ${d.success} ok${d.failed ? ` · ${d.failed} failed` : ''}`;
        tip.style.left = Math.min(Math.max(e.clientX - r.left, 50), r.width - 60) + 'px';
      });
      g.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    });
  }

  // Fold API deploy rows into a continuous 14-day series
  function deployDays(rows) {
    const by = {};
    for (const r of rows) { by[r.day] = by[r.day] || { success: 0, failed: 0 }; by[r.day][r.status === 'success' ? 'success' : 'failed'] += r.n; }
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      days.push({ label: d, success: by[d]?.success || 0, failed: by[d]?.failed || 0 });
    }
    return days;
  }

  // ── auth screens ────────────────────────────────────────────────
  function renderAuth(hasUsers) {
    let mode = hasUsers ? 'login' : 'register';
    const draw = () => {
      $app.innerHTML = `
      <div class="auth-wrap"><div class="auth-card">
        <div class="logo"><span class="hex">⬡</span> Hosting</div>
        ${mode === 'register' && !hasUsers ? `<div class="first-user-banner" style="margin-top:1.2rem">✨ You're the first user — this account becomes the <b>administrator</b>.</div>` : ''}
        <h1>${mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
        <p class="sub">${mode === 'login' ? 'Sign in to your hosting console.' : 'Host sites, connect GitHub, tunnel your IPv6 space.'}</p>
        <form id="authform">
          ${mode === 'register' ? `<label class="field"><span class="lbl">Name</span><input type="text" name="name" required placeholder="Jelle"></label>` : ''}
          <label class="field"><span class="lbl">Email</span><input type="email" name="email" required placeholder="you@example.com"></label>
          <label class="field"><span class="lbl">Password</span><input type="password" name="password" required minlength="${mode === 'register' ? 8 : 1}" placeholder="••••••••"></label>
          <button class="btn primary block" type="submit">${mode === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>
        <p class="sub" style="margin-top:1.1rem;text-align:center">
          ${mode === 'login' ? `No account yet? <a href="#" id="swap">Register</a>` : `Already registered? <a href="#" id="swap">Sign in</a>`}
        </p>
      </div></div>`;
      document.getElementById('swap')?.addEventListener('click', (e) => { e.preventDefault(); mode = mode === 'login' ? 'register' : 'login'; draw(); });
      document.getElementById('authform').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(e.target));
        try {
          const r = await api(`/auth/${mode}`, { method: 'POST', body: fd });
          me = r.user;
          if (r.firstUser) toast('Welcome, admin! Your console is ready.', 'ok');
          location.hash = '#/overview';
          render();
        } catch (err) { oops(err); }
      });
    };
    draw();
  }

  // ── shell ───────────────────────────────────────────────────────
  function shell(active, content) {
    const nav = (id, ico, label) =>
      `<a class="nav-item ${active === id ? 'active' : ''}" href="#/${id}"><span class="ico">${ico}</span>${label}</a>`;
    $app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="logo"><span class="hex">⬡</span> Hosting</div>
        ${nav('overview', '◈', 'Overview')}
        ${nav('sites', '▤', 'Sites')}
        ${nav('network', '⇄', 'Network / VPN')}
        ${me.role === 'admin' ? `
          <div class="side-label">Administration</div>
          ${nav('admin/users', '👥', 'Users')}
          ${nav('admin/system', '⚙', 'System')}
          ${nav('admin/activity', '≡', 'Activity log')}` : ''}
        <div class="spacer"></div>
        <div class="userchip">
          <div class="avatar">${esc((me.name || '?')[0].toUpperCase())}</div>
          <div class="uinfo"><div class="uname">${esc(me.name)}</div><div class="urole">${esc(me.role)}</div></div>
          <button class="logout" id="logout" title="Sign out">⏻</button>
        </div>
      </aside>
      <main class="main" id="main"></main>
    </div>`;
    document.getElementById('logout').addEventListener('click', async () => {
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      me = null; location.hash = ''; render();
    });
    const main = document.getElementById('main');
    main.appendChild(content);
    return main;
  }

  // ── overview page ───────────────────────────────────────────────
  async function pageOverview() {
    const [{ stats, recent }, m] = await Promise.all([api('/overview'), api('/metrics').catch(() => null)]);
    const c = h(`
      <div>
        <div class="page-head"><h1>Overview</h1>
          <div class="sub">Hello ${esc(me.name)} — here's what's happening on your platform.</div></div>
        <div class="tiles">
          <div class="tile accent"><div class="t-label">Sites</div><div class="t-value">${stats.sites}</div><div class="t-note">${stats.liveSites} live</div></div>
          <div class="tile"><div class="t-label">Live now</div><div class="t-value">${stats.liveSites}</div><div class="t-note">serving traffic</div></div>
          <div class="tile"><div class="t-label">Deployments</div><div class="t-value">${stats.deployments}</div><div class="t-note">all time</div></div>
          <div class="tile"><div class="t-label">WireGuard peers</div><div class="t-value">${stats.peers}</div><div class="t-note">tunnels configured</div></div>
        </div>
        <div class="chart-row">
          <div class="card"><h2>Traffic <span class="hint">requests/min · last hour</span></h2>
            <div class="chart" id="ch-traffic"></div></div>
          <div class="card"><h2>Deployments <span class="hint">last 14 days</span></h2>
            <div class="chart" id="ch-deploys"></div></div>
        </div>
        <div class="card">
          <h2>Recent deployments <span class="hint">latest 8</span></h2>
          ${recent.length ? `<div class="tbl-scroll"><table class="tbl">
            <tr><th>Site</th><th>Status</th><th>Trigger</th><th>Commit</th><th>When</th></tr>
            ${recent.map(d => `<tr>
              <td><a href="#/sites/${d.site_id}">${esc(d.site_name)}</a></td>
              <td>${pill(d.status)}</td>
              <td>${esc(d.trigger)}</td>
              <td class="mono">${esc(d.commit_sha || '—')} ${esc((d.commit_msg || '').split('\n')[0].slice(0, 40))}</td>
              <td>${ago(d.started_at)}</td></tr>`).join('')}
          </table></div>` : `<div class="empty"><div class="big">🚀</div>No deployments yet.<br>Create a site and connect a GitHub repository to get going.</div>`}
        </div>
      </div>`);
    const main = shell('overview', c);
    if (m) {
      lineChart(main.querySelector('#ch-traffic'), m.traffic.map(p => ({ t: p.t, v: p.n })), { unit: ' req', label: 'Requests per minute' });
      deployBars(main.querySelector('#ch-deploys'), deployDays(m.deploys));
    }
  }

  // ── sites list ──────────────────────────────────────────────────
  async function pageSites() {
    const [{ sites }, ghState] = await Promise.all([api('/sites'), api('/github').catch(() => ({ connected: false }))]);
    const c = h(`
      <div>
        <div class="page-head"><h1>Sites</h1><div class="grow"></div>
          <button class="btn" id="ghconnect">${ghState.connected ? `🐙 ${esc(ghState.login)}` : '🐙 Connect GitHub'}</button>
          <button class="btn primary" id="newsite">＋ New site</button></div>
        ${sites.length ? `<div class="site-grid">${sites.map(s => `
          <div class="site-card" data-id="${s.id}">
            <div class="s-top"><span class="type-badge ${s.type}">${s.type}</span>
              <span class="s-name">${esc(s.name)}</span>${pill(s.status)}</div>
            <div class="s-domain">${esc(s.domains[0] || s.default_domain)}</div>
            ${s.ipv6_addr ? `<div class="s-domain" style="color:var(--ink-3)">⬡ ${esc(s.ipv6_addr)}</div>` : ''}
            <div class="s-meta">
              <span>${s.repo_url ? '⎇ ' + esc(s.repo_url.replace(/^https:\/\/(www\.)?/, '').replace(/\.git$/, '')) : 'no repo connected'}</span>
            </div>
          </div>`).join('')}</div>`
        : `<div class="empty"><div class="big">▤</div>No sites yet. Create your first one — static HTML or a Node.js app.</div>`}
      </div>`);
    const main = shell('sites', c);
    main.querySelector('#newsite').addEventListener('click', () => newSiteModal(ghState));
    main.querySelector('#ghconnect').addEventListener('click', () => githubModal(ghState));
    main.querySelectorAll('.site-card').forEach(el =>
      el.addEventListener('click', () => { location.hash = `#/sites/${el.dataset.id}`; }));
  }

  function githubModal(ghState) {
    const m = modal(ghState.connected ? `
      <h2>GitHub connected</h2>
      <p style="color:var(--ink-2);font-size:.9rem">Connected as <b>${esc(ghState.login)}</b>. Your private
        repositories can be browsed and deployed, and webhooks are created automatically — no need to make
        anything public.</p>
      <div class="actions">
        <button type="button" class="btn" id="cancel">Close</button>
        <button type="button" class="btn danger" id="disconnect">Disconnect</button>
      </div>` : `
      <h2>Connect GitHub</h2>
      <p style="color:var(--ink-2);font-size:.9rem">Paste a <b>Personal Access Token</b> so Hosting can deploy your
        <b>private</b> repositories and create webhooks for you — repos never need to be public.</p>
      <p style="color:var(--ink-3);font-size:.82rem">Create one at <b>GitHub → Settings → Developer settings →
        Personal access tokens</b>. A <b>classic</b> token with the <code class="code">repo</code> scope (and
        <code class="code">admin:repo_hook</code> for auto-webhooks) works; or a fine-grained token with
        <b>Contents: Read</b> and <b>Webhooks: Read &amp; write</b>.</p>
      <form id="ghf">
        <label class="field"><span class="lbl">Personal Access Token</span>
          <input type="password" name="token" required placeholder="ghp_… or github_pat_…"></label>
        <div class="actions">
          <button type="button" class="btn" id="cancel">Cancel</button>
          <button type="submit" class="btn primary">Connect</button>
        </div>
      </form>`);
    m.querySelector('#cancel').addEventListener('click', () => m.remove());
    m.querySelector('#disconnect')?.addEventListener('click', async () => {
      try { await api('/github', { method: 'DELETE' }); toast('GitHub disconnected', 'ok'); m.remove(); pageSites(); }
      catch (e) { oops(e); }
    });
    m.querySelector('#ghf')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('/github', { method: 'POST', body: { token: e.target.token.value } });
        toast(`Connected as ${r.login}`, 'ok'); m.remove(); pageSites();
      } catch (err) { oops(err); }
    });
  }

  function newSiteModal(ghState = { connected: false }) {
    const m = modal(`
      <h2>Create a site</h2>
      <form id="f">
        <div class="formrow">
          <label class="field"><span class="lbl">Name</span><input type="text" name="name" required placeholder="my-portfolio"></label>
          <label class="field"><span class="lbl">Type</span>
            <select name="type"><option value="static">Static (HTML/CSS/JS)</option><option value="node">Node.js app</option></select></label>
        </div>
        ${ghState.connected ? `
        <label class="field"><span class="lbl">Pick a repository <span style="font-weight:400">(${esc(ghState.login)} — incl. private)</span></span>
          <select id="repopick"><option value="">Loading your repos…</option></select>
          <span class="help">Or paste a URL below. Private repos deploy automatically via your connected account.</span></label>` : `
        <div class="first-user-banner" style="margin-bottom:1rem">🐙 <b>Connect GitHub</b> (button on the Sites page) to browse and deploy <b>private</b> repos without a per-site token.</div>`}
        <label class="field"><span class="lbl">GitHub repository (https)</span>
          <input type="text" name="repo_url" placeholder="https://github.com/you/repo">
          <span class="help">Pushes to the branch below auto-deploy.${ghState.connected ? ' The webhook is created for you.' : ' Add the webhook shown after creation.'}</span></label>
        <div class="formrow">
          <label class="field"><span class="lbl">Branch</span><input type="text" name="repo_branch" value="main"></label>
          <label class="field"><span class="lbl">Access token <span style="font-weight:400">(${ghState.connected ? 'optional — uses your account' : 'private repos'})</span></span>
            <input type="password" name="repo_token" placeholder="ghp_… (optional)"></label>
        </div>
        <div class="formrow">
          <label class="field"><span class="lbl">Custom domain <span style="font-weight:400">(optional)</span></span>
            <input type="text" name="domain" placeholder="www.example.com"></label>
          <label class="field"><span class="lbl">Serve subfolder / build output</span>
            <input type="text" name="static_dir" placeholder="dist (optional)"></label>
        </div>
        <div class="formrow">
          <label class="field"><span class="lbl">Build command</span><input type="text" name="build_cmd" placeholder="npm run build (optional)"></label>
          <label class="field"><span class="lbl">Start command <span style="font-weight:400">(node)</span></span>
            <input type="text" name="start_cmd" placeholder="npm start (default)"></label>
        </div>
        <div class="actions">
          <button type="button" class="btn" id="cancel">Cancel</button>
          <button type="submit" class="btn primary">Create site</button>
        </div>
      </form>`);
    m.querySelector('#cancel').addEventListener('click', () => m.remove());

    // Populate the repo picker from the connected account
    const pick = m.querySelector('#repopick');
    if (pick) {
      api('/github/repos').then(({ repos }) => {
        pick.innerHTML = '<option value="">— choose a repository —</option>' +
          repos.map(r => `<option value="${esc(r.clone_url)}" data-branch="${esc(r.default_branch)}">${r.private ? '🔒 ' : ''}${esc(r.full_name)}</option>`).join('');
      }).catch(() => { pick.innerHTML = '<option value="">Could not load repos</option>'; });
      pick.addEventListener('change', () => {
        const opt = pick.selectedOptions[0];
        if (opt?.value) {
          m.querySelector('input[name=repo_url]').value = opt.value.replace(/\.git$/, '');
          m.querySelector('input[name=repo_branch]').value = opt.dataset.branch || 'main';
          const nameInput = m.querySelector('input[name=name]');
          if (!nameInput.value) nameInput.value = opt.textContent.replace(/^🔒 /, '').split('/')[1] || '';
        }
      });
    }

    m.querySelector('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      try {
        const body = { ...fd, domains: fd.domain ? [fd.domain] : [] };
        delete body.domain;
        const { site, webhook } = await api('/sites', { method: 'POST', body });
        m.remove();
        toast(`Site "${site.name}" created${site.repo_url ? ' — first deploy started' : ''}`, 'ok');
        if (webhook?.created) toast('GitHub webhook created automatically 🎉', 'ok');
        else if (site.repo_url && webhook && webhook.reason && !/already/.test(webhook.reason)) toast(`Webhook not auto-created: ${webhook.reason}`, '');
        location.hash = `#/sites/${site.id}`;
      } catch (err) { oops(err); }
    });
  }

  // ── site detail ─────────────────────────────────────────────────
  async function pageSiteDetail(id, tab = 'deploys') {
    let data;
    try { data = await api(`/sites/${id}`); }
    catch (e) { oops(e); location.hash = '#/sites'; return; }
    const { site, deployments } = data;

    const tabBtn = (t, label) => `<div class="tab ${tab === t ? 'active' : ''}" data-tab="${t}">${label}</div>`;
    const domains = site.domains.length ? site.domains : [];
    const c = h(`
      <div>
        <span class="back-link" id="back">← All sites</span>
        <div class="page-head">
          <h1>${esc(site.name)}</h1>
          <span class="type-badge ${site.type}">${site.type}</span> ${pill(site.status)}
          <div class="grow"></div>
          ${site.repo_url ? `<button class="btn" id="deploy">🚀 Deploy now</button>` : ''}
          ${site.status === 'live' || site.status === 'deploying'
            ? `<button class="btn" id="stop">⏸ Stop</button>`
            : `<button class="btn" id="start">▶ Start</button>`}
          <button class="btn danger" id="del">Delete</button>
        </div>
        <div class="card"><h2>Access</h2>
          <div class="kv">
            <span class="k">Default URL</span><span class="v"><a href="${esc(site.default_url)}" target="_blank">${esc(site.default_url)}</a>
              <button class="cp" style="background:none;border:none;cursor:pointer;color:var(--ink-3)" onclick="_copy('${esc(site.default_url)}')" title="copy">⧉</button></span>
            ${site.ipv6_addr ? `<span class="k">Dedicated IPv6</span><span class="v">${esc(site.ipv6_addr)}
              <button class="cp" style="background:none;border:none;cursor:pointer;color:var(--ink-3)" onclick="_copy('${esc(site.ipv6_addr)}', 'IPv6 copied')" title="copy">⧉</button>
              <span style="color:var(--ink-3)"> — point your AAAA records here</span></span>` : ''}
            ${domains.map(d => `<span class="k">Custom domain</span><span class="v"><a href="http://${esc(d)}" target="_blank">http://${esc(d)}</a></span>`).join('')}
            ${site.type === 'node' ? `<span class="k">Internal port</span><span class="v">${site.app_port} ${site.process?.running ? `· running ${uptimeStr(site.process.uptimeSec)}` : '· not running'}</span>` : ''}
          </div>
        </div>
        <div class="tabs">
          ${tabBtn('deploys', 'Deployments')}
          ${tabBtn('github', 'GitHub')}
          ${site.type === 'node' ? tabBtn('logs', 'Runtime logs') : ''}
          ${tabBtn('settings', 'Settings')}
        </div>
        <div id="tabbody"></div>
      </div>`);
    const main = shell('sites', c);
    main.querySelector('#back').addEventListener('click', () => { location.hash = '#/sites'; });
    main.querySelectorAll('.tab').forEach(el =>
      el.addEventListener('click', () => pageSiteDetail(id, el.dataset.tab)));
    main.querySelector('#deploy')?.addEventListener('click', async () => {
      try { await api(`/sites/${id}/deploy`, { method: 'POST' }); toast('Deployment started', 'ok'); setTimeout(() => pageSiteDetail(id, 'deploys'), 600); }
      catch (e) { oops(e); }
    });
    main.querySelector('#stop')?.addEventListener('click', async () => {
      try { await api(`/sites/${id}/stop`, { method: 'POST' }); toast('Site stopped', 'ok'); pageSiteDetail(id, tab); } catch (e) { oops(e); }
    });
    main.querySelector('#start')?.addEventListener('click', async () => {
      try { await api(`/sites/${id}/start`, { method: 'POST' }); toast('Site started', 'ok'); pageSiteDetail(id, tab); } catch (e) { oops(e); }
    });
    main.querySelector('#del').addEventListener('click', async () => {
      if (!confirm(`Delete site "${site.name}" and all its deployments? This cannot be undone.`)) return;
      try { await api(`/sites/${id}`, { method: 'DELETE' }); toast('Site deleted', 'ok'); location.hash = '#/sites'; } catch (e) { oops(e); }
    });

    const body = main.querySelector('#tabbody');

    if (tab === 'deploys') {
      body.appendChild(h(`<div class="card"><h2>Traffic <span class="hint">requests/min · last hour</span></h2>
        <div class="chart" id="ch-site-traffic"></div></div>`));
      api(`/metrics?site=${id}`).then(m =>
        lineChart(body.querySelector('#ch-site-traffic'), m.traffic.map(p => ({ t: p.t, v: p.n })), { unit: ' req', label: 'Requests per minute' })
      ).catch(() => {});
      body.appendChild(h(`<div class="card">
        <h2>Deployments</h2>
        ${deployments.length ? `<div class="tbl-scroll"><table class="tbl">
          <tr><th>#</th><th>Status</th><th>Trigger</th><th>Commit</th><th>Started</th><th></th></tr>
          ${deployments.map(d => `<tr>
            <td>${d.id}</td><td>${pill(d.status)}</td><td>${esc(d.trigger)}</td>
            <td class="mono">${esc(d.commit_sha || '—')} ${esc((d.commit_msg || '').split('\n')[0].slice(0, 44))}</td>
            <td>${ago(d.started_at)}</td>
            <td><button class="btn small viewlog" data-dep="${d.id}">log</button></td></tr>`).join('')}
        </table></div>` : `<div class="empty">No deployments yet. Connect a repo and hit <b>Deploy now</b>.</div>`}
      </div>`));
      body.querySelectorAll('.viewlog').forEach(btn => btn.addEventListener('click', async () => {
        try {
          const { deployment } = await api(`/sites/${id}/deployments/${btn.dataset.dep}`);
          modal(`<h2>Deploy #${deployment.id} — ${esc(deployment.status)}</h2>
            <div class="logbox">${esc(deployment.log || '(no output)')}</div>
            <div class="actions"><button class="btn" onclick="this.closest('.modal-back').remove()">Close</button></div>`);
        } catch (e) { oops(e); }
      }));
    }

    if (tab === 'github') {
      body.appendChild(h(`<div class="card">
        <h2>GitHub auto-deploy</h2>
        ${site.repo_url ? `
          <p style="color:var(--ink-2);font-size:.9rem">Pushes to <code class="code">${esc(site.repo_branch)}</code> on
            <code class="code">${esc(site.repo_url)}</code> deploy automatically.
              <button class="btn small" id="mkhook" style="margin-left:.4rem">⚡ Create webhook automatically</button></p>
          <p style="color:var(--ink-3);font-size:.82rem;margin-top:-.4rem">Connected a GitHub account? Use the button above and skip the manual steps. Otherwise add it by hand:</p>
          <label class="field"><span class="lbl">Payload URL</span>
            <div class="copybox"><code>${esc(site.webhook_url)}</code>
              <button class="cp" onclick="_copy('${esc(site.webhook_url)}')">⧉</button></div></label>
          <label class="field"><span class="lbl">Secret</span>
            <div class="copybox"><code>${esc(site.webhook_secret)}</code>
              <button class="cp" onclick="_copy('${esc(site.webhook_secret)}')">⧉</button></div>
            <span class="help">Content type: <b>application/json</b> · Events: <b>Just the push event</b>.</span></label>
          <label class="field" style="display:flex;align-items:center;gap:.5rem;margin-top:1rem">
            <input type="checkbox" id="autodep" style="width:auto" ${site.auto_deploy ? 'checked' : ''}>
            <span class="lbl" style="margin:0">Auto-deploy on push</span></label>`
        : `<div class="empty">No repository connected. Add one in <b>Settings</b>.</div>`}
      </div>`));
      body.querySelector('#autodep')?.addEventListener('change', async (e) => {
        try { await api(`/sites/${id}`, { method: 'PATCH', body: { auto_deploy: e.target.checked } }); toast('Saved', 'ok'); } catch (err) { oops(err); }
      });
      body.querySelector('#mkhook')?.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          const { webhook } = await api(`/sites/${id}/webhook`, { method: 'POST' });
          if (webhook.created) toast('Webhook created on GitHub 🎉', 'ok');
          else toast(`Not created: ${webhook.reason}`, /already/.test(webhook.reason) ? 'ok' : 'err');
        } catch (err) { oops(err); }
      });
    }

    if (tab === 'logs') {
      const draw = async () => {
        try {
          const { logs } = await api(`/sites/${id}/logs`);
          const box = body.querySelector('.logbox');
          if (box) { box.textContent = logs.join('\n') || '(no output yet)'; box.scrollTop = box.scrollHeight; }
        } catch {}
      };
      body.appendChild(h(`<div class="card"><h2>Runtime logs <span class="hint">auto-refreshes</span></h2>
        <div class="logbox">loading…</div></div>`));
      draw();
      const iv = setInterval(() => { if (!document.body.contains(body)) return clearInterval(iv); draw(); }, 3000);
    }

    if (tab === 'settings') {
      const envText = Object.entries(site.env_vars).map(([k, v]) => `${k}=${v}`).join('\n');
      body.appendChild(h(`<div class="card"><h2>Settings</h2>
        <form id="sform">
          <div class="formrow">
            <label class="field"><span class="lbl">Name</span><input type="text" name="name" value="${esc(site.name)}"></label>
            <label class="field"><span class="lbl">Type</span>
              <select name="type"><option value="static" ${site.type === 'static' ? 'selected' : ''}>Static</option>
              <option value="node" ${site.type === 'node' ? 'selected' : ''}>Node.js</option></select></label>
          </div>
          <label class="field"><span class="lbl">Repository URL</span>
            <input type="text" name="repo_url" value="${esc(site.repo_url || '')}" placeholder="https://github.com/you/repo"></label>
          <div class="formrow">
            <label class="field"><span class="lbl">Branch</span><input type="text" name="repo_branch" value="${esc(site.repo_branch)}"></label>
            <label class="field"><span class="lbl">Access token</span>
              <input type="password" name="repo_token" placeholder="${site.has_repo_token ? '••••••• (saved — type to replace)' : 'ghp_… (optional)'}"></label>
          </div>
          <label class="field"><span class="lbl">Domains <span style="font-weight:400">(comma-separated)</span></span>
            <input type="text" name="domains" value="${esc(site.domains.join(', '))}" placeholder="www.example.com, example.com">
            <span class="help">Point an A/AAAA record at this server, or use the free default that works right now: <a href="${esc(site.default_url)}" target="_blank">${esc(site.default_url)}</a></span></label>
          <div class="formrow">
            <label class="field"><span class="lbl">Serve subfolder</span><input type="text" name="static_dir" value="${esc(site.static_dir)}" placeholder="dist"></label>
            <label class="field"><span class="lbl">Build command</span><input type="text" name="build_cmd" value="${esc(site.build_cmd || '')}" placeholder="npm run build"></label>
          </div>
          <label class="field"><span class="lbl">Start command (node)</span>
            <input type="text" name="start_cmd" value="${esc(site.start_cmd || '')}" placeholder="npm start"></label>
          <label class="field"><span class="lbl">Environment variables <span style="font-weight:400">(KEY=value, one per line)</span></span>
            <textarea name="env">${esc(envText)}</textarea></label>
          <button class="btn primary" type="submit">Save settings</button>
        </form></div>`));
      body.querySelector('#sform').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(e.target));
        const env_vars = {};
        for (const line of (fd.env || '').split('\n')) {
          const i = line.indexOf('=');
          if (i > 0) env_vars[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        }
        const bodyData = {
          name: fd.name, type: fd.type, repo_url: fd.repo_url, repo_branch: fd.repo_branch,
          static_dir: fd.static_dir, build_cmd: fd.build_cmd, start_cmd: fd.start_cmd,
          domains: fd.domains.split(',').map(d => d.trim()).filter(Boolean), env_vars,
        };
        if (fd.repo_token) bodyData.repo_token = fd.repo_token;
        try { await api(`/sites/${id}`, { method: 'PATCH', body: bodyData }); toast('Settings saved — redeploy to apply', 'ok'); pageSiteDetail(id, 'settings'); }
        catch (err) { oops(err); }
      });
    }
  }

  // ── network / wireguard ─────────────────────────────────────────
  async function pageNetwork() {
    const { server, peers, bgp } = await api('/wireguard' + (me.role === 'admin' ? '?all=1' : ''));
    const up = me.role === 'admin' ? await api('/wireguard/uplink').catch(() => null) : null;

    const bgpCell = (p) => {
      if (!p.asn) return '<span style="color:var(--ink-3)">—</span>';
      if (!p.bgp_enabled) return pill('stopped').replace('stopped', 'off');
      const ses = bgp?.sessions?.[p.id];
      if (!bgp?.available) return pill('queued').replace('queued', 'configured');
      if (!ses) return pill('queued').replace('queued', 'starting');
      const infos = ['v6', 'v4'].filter(f => ses[f]).map(f => `${f}: ${ses[f].info || ses[f].state}`);
      const up = Object.values(ses).every(x => /Established/i.test(x.info));
      return `<span class="pill ${up ? 'live' : 'queued'}" title="${esc(infos.join(' · '))}"><span class="dot"></span>${up ? 'established' : esc(Object.values(ses)[0].info || Object.values(ses)[0].state)}</span>`;
    };
    const c = h(`
      <div>
        <div class="page-head"><h1>Network / VPN</h1>
          <div class="sub">WireGuard tunnels — route your own IPv6 block or IPv4 space through this server, and announce it with your ASN.</div>
          <div class="grow"></div><button class="btn primary" id="newpeer">＋ New peer</button></div>

        <div class="card"><h2>WireGuard server</h2>
          <div class="kv">
            <span class="k">Endpoint</span><span class="v">${esc(server.endpoint)}:${server.listen_port}</span>
            <span class="k">Public key</span><span class="v">${esc(server.public_key)}</span>
            <span class="k">Tunnel subnets</span><span class="v">${esc(server.tunnel_v4)} · ${esc(server.tunnel_v6)}</span>
            <span class="k">BGP (BIRD2)</span><span class="v">${server.server_asn ? `AS${esc(server.server_asn.replace(/^AS/i, ''))}${bgp?.available ? ' · daemon running' : ' · daemon not detected'}` : '<span style="color:var(--warn)">server ASN not set — BGP sessions disabled</span>'}</span>
            <span class="k">Site IPv6 pool</span><span class="v">${server.site_v6_pool ? `${esc(server.site_v6_pool)} — every site auto-gets a dedicated address` : '<span style="color:var(--ink-3)">not set — sites share the server address</span>'}</span>
          </div>
          ${me.role === 'admin' ? `<div style="margin-top:1rem;display:flex;gap:.6rem;flex-wrap:wrap">
            <button class="btn small" id="wgsettings">⚙ Server settings</button>
            <a class="btn small" href="/api/wireguard/server/config" download>⬇ Download wg0.conf</a>
            <a class="btn small" href="/api/wireguard/server/bird-config" download>⬇ Download bird.conf</a></div>` : ''}
        </div>

        ${me.role === 'admin' ? `
        <div class="card"><h2>Uplink — provider BGP tunnel
          <span class="hint">${up?.enabled ? (up.status.wg.up ? (up.status.wg.handshake ? `connected · handshake ${esc(up.status.wg.handshake)}` : 'interface up · no handshake yet') : 'enabled · tunnel down') : (up?.configured.wg ? 'disconnected' : 'not configured')}</span></h2>
          <p style="color:var(--ink-2);font-size:.9rem;margin:0 0 1rem">
            Using a service like <b>BGPTunnel (iFog)</b> or another upstream? There <i>this server</i> is the
            WireGuard <b>client</b>: download the <b>WireGuard config</b> and the <b>BIRD config</b> from your
            provider's dashboard and paste them below. The server connects out, announces your prefix from
            your ASN, and your IPv6 block lands here — ready for the Site IPv6 pool.</p>
          ${up?.status?.sessions?.length ? `<div class="kv" style="margin-bottom:1rem">
            ${up.status.sessions.map(s => `<span class="k">Session ${esc(s.name)}</span><span class="v">${esc(s.info || s.state)}</span>`).join('')}
          </div>` : ''}
          <form id="uplinkf">
            <div class="formrow">
              <label class="field"><span class="lbl">WireGuard config (from provider)</span>
                <textarea name="wg_conf" rows="7" placeholder="[Interface]&#10;PrivateKey = …&#10;Address = …&#10;[Peer]&#10;Endpoint = …">${esc(up?.wg_conf || '')}</textarea>
                <span class="help">Upload: <input type="file" class="upfile" data-target="wg_conf" accept=".conf,.txt" style="width:auto;display:inline"></span></label>
              <label class="field"><span class="lbl">BIRD config (from provider)</span>
                <textarea name="bird_conf" rows="7" placeholder="protocol bgp … { local … as YOURASN; neighbor … as THEIRASN; }">${esc(up?.bird_conf || '')}</textarea>
                <span class="help">Upload: <input type="file" class="upfile" data-target="bird_conf" accept=".conf,.txt" style="width:auto;display:inline"> — parse-checked before apply; router id / kernel bits are merged safely.</span></label>
            </div>
            <div style="display:flex;gap:.6rem;flex-wrap:wrap">
              <button type="submit" class="btn primary">Save &amp; connect</button>
              ${up?.enabled ? `<button type="button" class="btn" id="uplinkdown">Disconnect</button>` : (up?.configured.wg ? `<button type="button" class="btn" id="uplinkup">Connect</button>` : '')}
              ${up?.configured.wg || up?.configured.bird ? `<button type="button" class="btn danger" id="uplinkdel">Remove uplink</button>` : ''}
            </div>
          </form>
        </div>` : ''}

        <div class="card"><h2>Peers <span class="hint">${peers.length} configured</span></h2>
          ${peers.length ? `<div class="tbl-scroll"><table class="tbl">
            <tr><th>Name</th>${me.role === 'admin' ? '<th>Owner</th>' : ''}<th>Tunnel IPs</th><th>Routed prefixes</th><th>ASN</th><th>BGP</th><th></th></tr>
            ${peers.map(p => `<tr>
              <td><b>${esc(p.name)}</b></td>
              ${me.role === 'admin' ? `<td>${esc(p.owner_email || '')}</td>` : ''}
              <td class="mono">${esc(p.addr_v4)}<br>${esc(p.addr_v6)}</td>
              <td class="mono">${[p.routed_v6, p.routed_v4].filter(Boolean).map(esc).join('<br>') || '—'}</td>
              <td class="mono">${esc(p.asn || '—')}</td>
              <td>${bgpCell(p)}</td>
              <td style="white-space:nowrap">
                <a class="btn small" href="/api/wireguard/peers/${p.id}/config" download title="WireGuard client config">⬇ conf</a>
                ${p.asn && (p.routed_v6 || p.routed_v4) ? `<button class="btn small bgpbtn" data-id="${p.id}" title="BGP session over the tunnel">BGP</button>` : ''}
                <button class="btn small danger delpeer" data-id="${p.id}" data-name="${esc(p.name)}">✕</button>
              </td></tr>`).join('')}
          </table></div>`
          : `<div class="empty"><div class="big">⇄</div>No tunnels yet. Create a peer to get a ready-to-import WireGuard config.</div>`}
        </div>

        <div class="card"><h2>How it works</h2>
          <ol style="color:var(--ink-2);font-size:.9rem;line-height:1.9;margin:0;padding-left:1.2rem">
            <li>Create a peer — optionally enter <b>your own IPv6 block</b> (e.g. <code class="code">2a0e:8f02:f01f::/48</code>), extra IPv4 space, and your <b>ASN</b>.</li>
            <li>Download the <code class="code">.conf</code> and import it into any WireGuard client (<code class="code">wg-quick up ./file.conf</code>).</li>
            <li>Your prefixes are routed through the tunnel — traffic to them arrives at your machine.</li>
            <li>Hit <b>BGP</b> on the peer to run a real BGP session over the tunnel: the server (BIRD2) peers with your tunnel address and accepts your registered prefixes. Download the ready-made config for your side, or upload your own <code class="code">bird.conf</code> — it's parse-checked before it goes live.</li>
          </ol>
        </div>
      </div>`);
    const main = shell('network', c);
    main.querySelector('#newpeer').addEventListener('click', () => {
      const m = modal(`
        <h2>New WireGuard peer</h2>
        <form id="f">
          <label class="field"><span class="lbl">Peer name</span><input type="text" name="name" required placeholder="laptop / home-router / bgp-vm"></label>
          <label class="field"><span class="lbl">Your IPv6 block <span style="font-weight:400">(optional)</span></span>
            <input type="text" name="routed_v6" placeholder="2a0e:8f02:f01f::/48">
            <span class="help">This whole prefix gets routed to you through the tunnel.</span></label>
          <div class="formrow">
            <label class="field"><span class="lbl">Extra IPv4 <span style="font-weight:400">(optional)</span></span>
              <input type="text" name="routed_v4" placeholder="203.0.113.0/29"></label>
            <label class="field"><span class="lbl">Your ASN <span style="font-weight:400">(optional)</span></span>
              <input type="text" name="asn" placeholder="AS211234"></label>
          </div>
          <div class="actions">
            <button type="button" class="btn" id="cancel">Cancel</button>
            <button type="submit" class="btn primary">Create peer</button>
          </div>
        </form>`);
      m.querySelector('#cancel').addEventListener('click', () => m.remove());
      m.querySelector('#f').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const r = await api('/wireguard/peers', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
          m.remove();
          toast(`Peer created${r.wireguard?.applied ? ' and applied live' : ' — config saved'}`, 'ok');
          pageNetwork();
        } catch (err) { oops(err); }
      });
    });
    // uplink card handlers
    main.querySelectorAll('.upfile').forEach(inp => inp.addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (f) main.querySelector(`textarea[name=${e.target.dataset.target}]`).value = await f.text();
    }));
    main.querySelector('#uplinkf')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      try {
        const r = await api('/wireguard/uplink', { method: 'POST', body: {
          wg_conf: form.wg_conf.value, bird_conf: form.bird_conf.value,
        }});
        (r.notes || []).forEach(n => toast(n));
        toast(r.wireguard?.up ? 'Uplink saved — tunnel up' : 'Uplink saved', 'ok');
        pageNetwork();
      } catch (err) { oops(err); }
    });
    main.querySelector('#uplinkup')?.addEventListener('click', async () => {
      try { const r = await api('/wireguard/uplink/connect', { method: 'POST' });
        toast(r.wireguard?.up ? 'Uplink connected' : (r.wireguard?.reason || 'Could not connect'), r.wireguard?.up ? 'ok' : 'err');
        pageNetwork(); } catch (e) { oops(e); }
    });
    main.querySelector('#uplinkdown')?.addEventListener('click', async () => {
      try { await api('/wireguard/uplink/disconnect', { method: 'POST' }); toast('Uplink disconnected', 'ok'); pageNetwork(); } catch (e) { oops(e); }
    });
    main.querySelector('#uplinkdel')?.addEventListener('click', async () => {
      if (!confirm('Remove the uplink configs entirely?')) return;
      try { await api('/wireguard/uplink', { method: 'DELETE' }); toast('Uplink removed', 'ok'); pageNetwork(); } catch (e) { oops(e); }
    });

    main.querySelectorAll('.bgpbtn').forEach(btn => btn.addEventListener('click', () => {
      const p = peers.find(x => String(x.id) === btn.dataset.id);
      if (!p) return;
      const ses = bgp?.sessions?.[p.id];
      const sesLine = (f) => ses?.[f] ? `<span class="k">Session ${f}</span><span class="v">${esc(ses[f].info || ses[f].state)}</span>` : '';
      const m = modal(`
        <h2>BGP over the tunnel — ${esc(p.name)}</h2>
        <div class="kv" style="margin-bottom:1rem">
          <span class="k">Your ASN</span><span class="v">${esc(p.asn)}</span>
          <span class="k">Server ASN</span><span class="v">${server.server_asn ? esc(server.server_asn) : '<span style="color:var(--warn)">not set (admin: Server settings)</span>'}</span>
          <span class="k">Accepted prefixes</span><span class="v">${[p.routed_v6, p.routed_v4].filter(Boolean).map(esc).join(' · ')}</span>
          <span class="k">Neighbor for you</span><span class="v">${esc(server.tunnel_v6.split('/')[0])} / ${esc(server.tunnel_v4.split('/')[0])}</span>
          ${sesLine('v6')}${sesLine('v4')}
        </div>
        <p style="color:var(--ink-2);font-size:.88rem;margin:0 0 1rem">
          When enabled, the server runs a BIRD2 session against your tunnel address and
          accepts <b>only your registered prefixes</b>. Run BIRD on your side too —
          <a href="/api/wireguard/peers/${p.id}/bird" download>download your ready-made bird.conf</a> —
          or upload your own config below.</p>
        <form id="bgpf">
          <label class="field" style="display:flex;align-items:center;gap:.5rem">
            <input type="checkbox" name="bgp_enabled" style="width:auto" ${p.bgp_enabled ? 'checked' : ''}>
            <span class="lbl" style="margin:0">Enable server-side BGP session for this peer</span></label>
          <label class="field"><span class="lbl">Custom BIRD config <span style="font-weight:400">(optional — included on the server, parse-checked before apply)</span></span>
            <textarea name="bird_custom" rows="8" placeholder="# e.g. tweak timers, add an extra protocol…&#10;# leave empty to use the auto-generated session">${esc(p.bird_custom || '')}</textarea>
            <span class="help">Or upload a file: <input type="file" id="birdfile" accept=".conf,.txt" style="width:auto;display:inline"></span></label>
          <div class="actions">
            <button type="button" class="btn" id="cancel">Cancel</button>
            <button type="submit" class="btn primary">Save &amp; apply</button>
          </div>
        </form>`);
      m.querySelector('#cancel').addEventListener('click', () => m.remove());
      m.querySelector('#birdfile').addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (f) m.querySelector('textarea[name=bird_custom]').value = await f.text();
      });
      m.querySelector('#bgpf').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target;
        try {
          const r = await api(`/wireguard/peers/${p.id}/bgp`, {
            method: 'POST',
            body: { bgp_enabled: form.bgp_enabled.checked, bird_custom: form.bird_custom.value },
          });
          m.remove();
          const note = r.bird?.applied ? 'applied to BIRD live'
            : (r.validation?.checked === false && r.validation?.note) ? r.validation.note
            : (r.bird?.reason || 'saved');
          toast(`BGP settings saved — ${note}`, 'ok');
          pageNetwork();
        } catch (err) { oops(err); }
      });
    }));
    main.querySelectorAll('.delpeer').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm(`Delete peer "${btn.dataset.name}"?`)) return;
      try { await api(`/wireguard/peers/${btn.dataset.id}`, { method: 'DELETE' }); toast('Peer deleted', 'ok'); pageNetwork(); } catch (e) { oops(e); }
    }));
    main.querySelector('#wgsettings')?.addEventListener('click', () => {
      const m = modal(`
        <h2>WireGuard server settings</h2>
        <form id="f">
          <label class="field"><span class="lbl">Public endpoint (hostname or IP)</span>
            <input type="text" name="endpoint" value="${esc(server.endpoint)}"></label>
          <div class="formrow">
            <label class="field"><span class="lbl">Listen port</span><input type="number" name="listen_port" value="${server.listen_port}"></label>
            <label class="field"><span class="lbl">DNS for clients <span style="font-weight:400">(optional)</span></span>
              <input type="text" name="dns" value="${esc(server.dns)}" placeholder="1.1.1.1, 2606:4700:4700::1111"></label>
          </div>
          <label class="field"><span class="lbl">Server ASN <span style="font-weight:400">(enables BGP sessions over the tunnels)</span></span>
            <input type="text" name="server_asn" value="${esc(server.server_asn || '')}" placeholder="AS64512">
            <span class="help">The ASN this server speaks BGP as. Peers' sessions peer against it; private range 64512–65534 is fine if you don't have a public one.</span></label>
          <div class="formrow">
            <label class="field"><span class="lbl">Site IPv6 pool <span style="font-weight:400">(auto-delegation)</span></span>
              <input type="text" name="site_v6_pool" value="${esc(server.site_v6_pool || '')}" placeholder="2a0e:8f02:f01f:100::/64">
              <span class="help">A chunk of your IPv6 block routed to this server. Every site automatically gets its own address from it.</span></label>
            <label class="field"><span class="lbl">Attach to interface <span style="font-weight:400">(optional)</span></span>
              <input type="text" name="site_v6_iface" value="${esc(server.site_v6_iface || '')}" placeholder="auto-detect">
              <span class="help">Interface the site addresses are added to. Leave empty to use the default route's interface.</span></label>
          </div>
          <div class="actions">
            <button type="button" class="btn" id="cancel">Cancel</button>
            <button type="submit" class="btn primary">Save</button>
          </div>
        </form>`);
      m.querySelector('#cancel').addEventListener('click', () => m.remove());
      m.querySelector('#f').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('/wireguard/server', { method: 'PATCH', body: Object.fromEntries(new FormData(e.target)) });
          m.remove(); toast('Server settings saved', 'ok'); pageNetwork();
        } catch (err) { oops(err); }
      });
    });
  }

  // ── admin: users ────────────────────────────────────────────────
  async function pageUsers() {
    const { users } = await api('/users');
    const c = h(`
      <div>
        <div class="page-head"><h1>Users</h1>
          <div class="sub">${users.length} account${users.length === 1 ? '' : 's'} on this platform.</div></div>
        <div class="card"><div class="tbl-scroll"><table class="tbl">
          <tr><th>User</th><th>Role</th><th>Sites</th><th>Peers</th><th>Joined</th><th></th></tr>
          ${users.map(u => `<tr>
            <td><b>${esc(u.name)}</b><br><span style="color:var(--ink-3);font-size:.8rem">${esc(u.email)}</span></td>
            <td>${u.suspended ? pill('suspended') : `<span class="pill ${u.role === 'admin' ? 'admin' : 'new'}">${esc(u.role)}</span>`}</td>
            <td>${u.site_count}</td><td>${u.peer_count}</td>
            <td>${ago(u.created_at)}</td>
            <td style="white-space:nowrap">
              ${u.id !== me.id ? `
                <button class="btn small act" data-id="${u.id}" data-act="${u.role === 'admin' ? 'demote' : 'promote'}">${u.role === 'admin' ? 'demote' : 'make admin'}</button>
                <button class="btn small act" data-id="${u.id}" data-act="${u.suspended ? 'unsuspend' : 'suspend'}">${u.suspended ? 'unsuspend' : 'suspend'}</button>
                <button class="btn small danger act" data-id="${u.id}" data-act="delete" data-email="${esc(u.email)}">✕</button>` : '<span style="color:var(--ink-3);font-size:.8rem">you</span>'}
            </td></tr>`).join('')}
        </table></div></div>
      </div>`);
    const main = shell('admin/users', c);
    main.querySelectorAll('.act').forEach(btn => btn.addEventListener('click', async () => {
      const { id, act, email } = btn.dataset;
      try {
        if (act === 'delete') {
          if (!confirm(`Delete user ${email} and ALL their sites and tunnels?`)) return;
          await api(`/users/${id}`, { method: 'DELETE' });
        } else if (act === 'promote') await api(`/users/${id}`, { method: 'PATCH', body: { role: 'admin' } });
        else if (act === 'demote') await api(`/users/${id}`, { method: 'PATCH', body: { role: 'user' } });
        else await api(`/users/${id}`, { method: 'PATCH', body: { suspended: act === 'suspend' } });
        toast('Done', 'ok'); pageUsers();
      } catch (e) { oops(e); }
    }));
  }

  // ── admin: system ───────────────────────────────────────────────
  async function pageSystem() {
    const [s, m] = await Promise.all([api('/system'), api('/metrics').catch(() => null)]);
    const memPct = Math.round(s.memUsedMB / s.memTotalMB * 100);
    const diskPct = s.disk ? Math.round(s.disk.usedMB / s.disk.totalMB * 100) : null;
    const loadPct = Math.min(100, Math.round(s.load1 / s.cpus * 100));
    const meter = (label, val, pct) => `
      <div class="meter"><div class="m-head"><span>${label}</span><span class="m-val">${val}</span></div>
        <div class="m-bar"><div class="m-fill" style="width:${pct}%"></div></div></div>`;
    const c = h(`
      <div>
        <div class="page-head"><h1>System</h1>
          <div class="sub">${esc(s.hostname)} · ${esc(s.platform)} · Node ${esc(s.node)}</div></div>
        <div class="tiles">
          <div class="tile accent"><div class="t-label">Hosting uptime</div><div class="t-value">${uptimeStr(s.uptimeSec)}</div></div>
          <div class="tile"><div class="t-label">System uptime</div><div class="t-value">${uptimeStr(s.systemUptimeSec)}</div></div>
          <div class="tile"><div class="t-label">CPU cores</div><div class="t-value">${s.cpus}</div></div>
          <div class="tile"><div class="t-label">Load (1m)</div><div class="t-value">${s.load1.toFixed(2)}</div><div class="t-note">${s.load5.toFixed(2)} / ${s.load15.toFixed(2)} (5m/15m)</div></div>
        </div>
        <div class="chart-row">
          <div class="card"><h2>CPU load <span class="hint">% of ${s.cpus} cores · last hour</span></h2>
            <div class="chart" id="ch-cpu"></div></div>
          <div class="card"><h2>Memory <span class="hint">% used · last hour</span></h2>
            <div class="chart" id="ch-mem"></div></div>
        </div>
        <div class="card"><h2>Resources <span class="hint">right now</span></h2>
          ${meter('Memory', `${(s.memUsedMB / 1024).toFixed(1)} / ${(s.memTotalMB / 1024).toFixed(1)} GB (${memPct}%)`, memPct)}
          ${meter('CPU load vs cores', `${s.load1.toFixed(2)} / ${s.cpus} cores (${loadPct}%)`, loadPct)}
          ${diskPct !== null ? meter('Disk (/)', `${(s.disk.usedMB / 1024).toFixed(1)} / ${(s.disk.totalMB / 1024).toFixed(1)} GB (${diskPct}%)`, diskPct) : ''}
        </div>
      </div>`);
    const main = shell('admin/system', c);
    if (m?.system) {
      lineChart(main.querySelector('#ch-cpu'), m.system.map(p => ({ t: p.t, v: p.loadPct })), { unit: '%', maxY: 100, color: 'var(--accent)', label: 'CPU load percent' });
      lineChart(main.querySelector('#ch-mem'), m.system.map(p => ({ t: p.t, v: p.memPct })), { unit: '%', maxY: 100, color: 'var(--accent-2)', label: 'Memory percent' });
    }
  }

  // ── admin: activity ─────────────────────────────────────────────
  async function pageActivity() {
    const { activity } = await api('/activity');
    const c = h(`
      <div>
        <div class="page-head"><h1>Activity log</h1><div class="sub">Latest 100 events across the platform.</div></div>
        <div class="card"><div class="tbl-scroll"><table class="tbl">
          <tr><th>When</th><th>User</th><th>Action</th><th>Detail</th></tr>
          ${activity.map(a => `<tr>
            <td style="white-space:nowrap">${ago(a.created_at)}</td>
            <td>${esc(a.user_email || 'system')}</td>
            <td class="mono">${esc(a.action)}</td>
            <td style="color:var(--ink-2)">${esc(a.detail)}</td></tr>`).join('')}
        </table></div></div>
      </div>`);
    shell('admin/activity', c);
  }

  // ── router ──────────────────────────────────────────────────────
  async function render() {
    if (!me) {
      try { const r = await api('/auth/me'); me = r.user; }
      catch {
        const { hasUsers } = await api('/auth/setup-state').catch(() => ({ hasUsers: true }));
        return renderAuth(hasUsers);
      }
    }
    const route = location.hash.replace(/^#\//, '') || 'overview';
    try {
      if (route === 'overview') await pageOverview();
      else if (route === 'sites') await pageSites();
      else if (route.startsWith('sites/')) await pageSiteDetail(route.split('/')[1]);
      else if (route === 'network') await pageNetwork();
      else if (route === 'admin/users' && me.role === 'admin') await pageUsers();
      else if (route === 'admin/system' && me.role === 'admin') await pageSystem();
      else if (route === 'admin/activity' && me.role === 'admin') await pageActivity();
      else { location.hash = '#/overview'; }
    } catch (e) {
      if (String(e.message).match(/authent|session/i)) { me = null; render(); }
      else oops(e);
    }
  }

  window.addEventListener('hashchange', render);
  render();
})();
