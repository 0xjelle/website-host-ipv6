/* HexaHost console — hash-routed SPA, no build step. */
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

  // ── auth screens ────────────────────────────────────────────────
  function renderAuth(hasUsers) {
    let mode = hasUsers ? 'login' : 'register';
    const draw = () => {
      $app.innerHTML = `
      <div class="auth-wrap"><div class="auth-card">
        <div class="logo"><span class="hex">⬡</span> HexaHost</div>
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
        <div class="logo"><span class="hex">⬡</span> HexaHost</div>
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
    const { stats, recent } = await api('/overview');
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
    shell('overview', c);
  }

  // ── sites list ──────────────────────────────────────────────────
  async function pageSites() {
    const { sites } = await api('/sites');
    const c = h(`
      <div>
        <div class="page-head"><h1>Sites</h1><div class="grow"></div>
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
    main.querySelector('#newsite').addEventListener('click', newSiteModal);
    main.querySelectorAll('.site-card').forEach(el =>
      el.addEventListener('click', () => { location.hash = `#/sites/${el.dataset.id}`; }));
  }

  function newSiteModal() {
    const m = modal(`
      <h2>Create a site</h2>
      <form id="f">
        <div class="formrow">
          <label class="field"><span class="lbl">Name</span><input type="text" name="name" required placeholder="my-portfolio"></label>
          <label class="field"><span class="lbl">Type</span>
            <select name="type"><option value="static">Static (HTML/CSS/JS)</option><option value="node">Node.js app</option></select></label>
        </div>
        <label class="field"><span class="lbl">GitHub repository (https)</span>
          <input type="text" name="repo_url" placeholder="https://github.com/you/repo">
          <span class="help">Pushes to the branch below auto-deploy once you add the webhook (shown after creation).</span></label>
        <div class="formrow">
          <label class="field"><span class="lbl">Branch</span><input type="text" name="repo_branch" value="main"></label>
          <label class="field"><span class="lbl">Access token <span style="font-weight:400">(private repos)</span></span>
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
    m.querySelector('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      try {
        const body = { ...fd, domains: fd.domain ? [fd.domain] : [] };
        delete body.domain;
        const { site } = await api('/sites', { method: 'POST', body });
        m.remove();
        toast(`Site "${site.name}" created${site.repo_url ? ' — first deploy started' : ''}`, 'ok');
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
            <span class="k">Default URL</span><span class="v"><a href="http://${esc(site.default_domain)}" target="_blank">http://${esc(site.default_domain)}</a></span>
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
            Add this webhook in your repo: <b>Settings → Webhooks → Add webhook</b>.</p>
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
            <span class="help">Point an A/AAAA record at this server, or use the free default: ${esc(site.default_domain)}</span></label>
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
    const s = await api('/system');
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
          <div class="tile accent"><div class="t-label">HexaHost uptime</div><div class="t-value">${uptimeStr(s.uptimeSec)}</div></div>
          <div class="tile"><div class="t-label">System uptime</div><div class="t-value">${uptimeStr(s.systemUptimeSec)}</div></div>
          <div class="tile"><div class="t-label">CPU cores</div><div class="t-value">${s.cpus}</div></div>
          <div class="tile"><div class="t-label">Load (1m)</div><div class="t-value">${s.load1.toFixed(2)}</div><div class="t-note">${s.load5.toFixed(2)} / ${s.load15.toFixed(2)} (5m/15m)</div></div>
        </div>
        <div class="card"><h2>Resources</h2>
          ${meter('Memory', `${(s.memUsedMB / 1024).toFixed(1)} / ${(s.memTotalMB / 1024).toFixed(1)} GB (${memPct}%)`, memPct)}
          ${meter('CPU load vs cores', `${s.load1.toFixed(2)} / ${s.cpus} cores (${loadPct}%)`, loadPct)}
          ${diskPct !== null ? meter('Disk (/)', `${(s.disk.usedMB / 1024).toFixed(1)} / ${(s.disk.totalMB / 1024).toFixed(1)} GB (${diskPct}%)`, diskPct) : ''}
        </div>
      </div>`);
    shell('admin/system', c);
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
