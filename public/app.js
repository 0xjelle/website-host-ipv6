/* Hosting console - hash-routed SPA, no build step. */
(() => {
  const $app = document.getElementById('app');
  let me = null;

  // ── helpers ─────────────────────────────────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content; };
  // Query params carried on the hash route, e.g. "#/billing?checkout=success".
  const hashQuery = () => {
    const i = location.hash.indexOf('?');
    return new URLSearchParams(i >= 0 ? location.hash.slice(i + 1) : '');
  };

  async function api(path, opts = {}) {
    // Bound every request so a non-responding server surfaces an error instead
    // of hanging the UI on "Loading…" forever. Pass opts.timeout=0 to disable
    // (e.g. large uploads); default 20s is plenty for normal calls.
    const { timeout = 20000, ...fetchOpts } = opts;
    const ctrl = new AbortController();
    const timer = timeout > 0 ? setTimeout(() => ctrl.abort(), timeout) : null;
    try {
      const res = await fetch('/api' + path, {
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        signal: ctrl.signal,
        ...fetchOpts,
        body: fetchOpts.body !== undefined ? JSON.stringify(fetchOpts.body) : undefined,
      });
      let data = {};
      try { data = await res.json(); } catch {}
      if (!res.ok) { const err = new Error(data.error || `Request failed (${res.status})`); err.data = data; err.status = res.status; throw err; }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Timed out - the server did not respond in 20s');
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
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
    navigator.clipboard?.writeText(text).then(() => toast(label, 'ok')).catch(() => toast('Copy failed - select manually', 'err'));
  }
  window._copy = copy;

  const fmtDate = (s) => s ? new Date(s.includes('T') ? s : s + 'Z').toLocaleString() : '-';
  const ago = (s) => {
    if (!s) return '-';
    const sec = Math.floor((Date.now() - new Date(s.includes('T') ? s : s + 'Z')) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  };
  const fmtBytes = (n) => {
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
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

  // ── Cloudflare-for-SaaS custom-domain DNS records ───────────────
  // Shared by the site-settings routing card and the post-create setup screen
  // so both render the exact same CNAME + TXT records and status pill.
  function cfRecordRows(hn, fallbackOrigin) {
    const v = hn.verification || {};
    const recs = [{ t: 'CNAME', name: hn.hostname, value: hn.cname_target || fallbackOrigin || '(admin must set a fallback origin)' }];
    if (v.ownership) recs.push({ t: (v.ownership.type || 'txt').toUpperCase(), name: v.ownership.name, value: v.ownership.value });
    (v.ssl_records || []).forEach(r => recs.push({ t: (r.type || 'txt').toUpperCase(), name: r.name, value: r.value }));
    return recs;
  }
  function cfRecordsTable(recs) {
    return `<div class="tbl-scroll"><table class="tbl"><tr><th>Type</th><th>Name</th><th>Value</th></tr>
      ${recs.map(r => `<tr><td>${esc(r.t)}</td><td class="mono">${esc(r.name)}</td><td class="mono">${esc(r.value)}</td></tr>`).join('')}
      </table></div>`;
  }
  function cfStatusPill(hn) {
    return hn.active
      ? '<span class="pill live"><span class="dot"></span>active</span>'
      : (hn.last_error ? '<span class="pill failed">error</span>' : `<span class="pill queued"><span class="dot"></span>${esc(hn.status || 'pending')}${hn.ssl_status ? ` · ssl ${esc(hn.ssl_status)}` : ''}</span>`);
  }

  // Two-step progress for a custom hostname: is the CNAME in DNS yet, and has
  // Cloudflare auto-issued the certificate. cname_detected is filled in by the
  // /domains/cf endpoint's live DNS check.
  function cfCheck(ok, done, pending) {
    return `<div style="display:flex;gap:.5rem;align-items:center;font-size:.85rem;margin:.15rem 0">
      <span style="color:${ok ? 'var(--good)' : 'var(--warn)'};font-weight:700">${ok ? '✓' : '○'}</span>
      <span style="color:var(--ink-2)">${ok ? done : pending}</span></div>`;
  }
  const CF_CA = { lets_encrypt: "Let's Encrypt", google: 'Google Trust Services', digicert: 'DigiCert', ssl_com: 'SSL.com' };
  function cfChecklist(hn) {
    const d = hn.ssl_detail || {};
    const fmtDate = (s) => { if (!s) return ''; const t = new Date(s); return isNaN(t) ? '' : t.toLocaleDateString(); };
    const ca = d.authority ? (CF_CA[d.authority] || d.authority) : '';
    const exp = fmtDate(d.expires_on);
    const sslDone = 'SSL certificate active'
      + (ca ? ` - ${esc(ca)}` : '')
      + (exp ? `, valid until ${esc(exp)}` : '');
    return `<div style="margin:.3rem 0 .5rem">
      ${cfCheck(hn.cname_detected, 'CNAME record detected in DNS', 'CNAME not added yet - add it below')}
      ${cfCheck(hn.ssl_status === 'active', sslDone, 'Certificate issues automatically once the CNAME is live')}
    </div>`;
  }

  // Render an error + Retry into a card body, so a failed/timed-out load is
  // actionable instead of a permanent "Loading…".
  function cardError(box, msg, retry) {
    box.classList.remove('empty');
    box.innerHTML = `<span style="color:var(--bad)">${esc(msg)}</span> <button class="btn small" id="cardretry" style="margin-left:.5rem">↻ Retry</button>`;
    box.querySelector('#cardretry').addEventListener('click', retry);
  }

  // Shown right after a site with a custom domain is created, so the user gets
  // the DNS records to add without hunting through Settings. `cf` is the create
  // response's Cloudflare result: { enabled, hostnames:[...], fallback_origin? }.
  function domainSetupModal(site, cf) {
    const rows = (cf.hostnames || []).map(hn => `
      <div style="margin-bottom:1.1rem">
        <div style="display:flex;gap:.6rem;align-items:center;margin-bottom:.4rem"><b class="mono">${esc(hn.hostname)}</b> ${cfStatusPill(hn)}</div>
        ${hn.last_error ? `<div style="color:var(--bad);font-size:.85rem;margin-bottom:.4rem">${esc(hn.last_error)}</div>` : ''}
        ${hn.active ? '' : cfRecordsTable(cfRecordRows(hn, cf.fallback_origin))}
      </div>`).join('');
    const m = modal(`
      <h2>Almost there - point your domain</h2>
      <p style="color:var(--ink-2);font-size:.9rem;margin:.2rem 0 1rem">Add these DNS records at your domain's provider. Your site goes live behind Cloudflare - with its certificate and DDoS protection - automatically once the records are detected. You don't have to wait here; the same status is on the site's Settings.</p>
      ${rows}
      <div class="actions"><button type="button" class="btn primary" id="godone">Got it - go to site</button></div>`);
    m.querySelector('#godone').addEventListener('click', () => { m.remove(); location.hash = `#/sites/${site.id}`; });
    return m;
  }

  // A prominent, top-of-page banner listing the CNAME record(s) still needed to
  // bring a site's custom domain(s) live. `pending` = hostnames not yet active.
  function cfBannerHtml(pending, fallbackOrigin) {
    const rows = pending.map(hn => `
      <div style="margin-top:.7rem">
        <div style="display:flex;gap:.6rem;align-items:center;margin-bottom:.3rem"><b class="mono">${esc(hn.hostname)}</b> ${cfStatusPill(hn)}</div>
        ${hn.last_error ? `<div style="color:var(--bad);font-size:.85rem;margin-bottom:.3rem">${esc(hn.last_error)}</div>` : ''}
        ${cfRecordsTable(cfRecordRows(hn, fallbackOrigin))}
      </div>`).join('');
    return `<div class="card" style="border-color:#5a3a12;background:#1c1408">
      <h2 style="color:var(--warn)">⚠ Add your DNS record to go live</h2>
      <p style="color:var(--ink-2);font-size:.9rem;margin:.2rem 0 0">Your custom domain isn't active yet. Add the record${pending.length > 1 ? 's' : ''} below at your domain's DNS provider - <b>just the one CNAME, no TXT</b>. The site turns on automatically (certificate + Cloudflare DDoS) once it's detected.</p>
      ${rows}</div>`;
  }

  // ── charts (SVG, no deps) ───────────────────────────────────────
  const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // validated categorical palette (dark surface) - dataviz skill, fixed order
  const SERIES_COLORS = ['#3987e5', '#008300', '#d55181', '#c98500', '#199e70', '#d95926', '#9085e9', '#e66767'];

  // Multi-series line chart with legend + crosshair tooltip. series:
  // [{ id, name, color, points:[{t,n}] }] (all sharing the same time axis).
  function multiLineChart(el, series, { unit = '', fmtVal = (v) => v + unit, fmtAxis = null } = {}) {
    const axisLabel = fmtAxis || ((v) => (v >= 10 ? Math.round(v) : v.toFixed(1)));
    if (!series.length || series.every(s => s.points.length < 2)) {
      el.innerHTML = `<div class="chart-empty">No traffic yet - this fills in as visitors arrive.</div>`;
      return;
    }
    const W = 680, H = 190, PL = fmtAxis ? 60 : 40, PB = 18, PT = 8, PR = 8;
    const xs = series[0].points.map(p => p.t);
    const x0 = xs[0], x1 = xs[xs.length - 1];
    const yMax = Math.max(1, ...series.flatMap(s => s.points.map(p => p.n))) * 1.15;
    const X = (t) => PL + (t - x0) / (x1 - x0 || 1) * (W - PL - PR);
    const Y = (v) => PT + (1 - v / yMax) * (H - PT - PB);
    const grid = [0.5, 1].map(f => yMax * f);
    const paths = series.map(s => {
      const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.n).toFixed(1)}`).join('');
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
    }).join('');
    el.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        ${grid.map(v => `<line x1="${PL}" y1="${Y(v)}" x2="${W - PR}" y2="${Y(v)}" class="grid"/>
          <text x="${PL - 6}" y="${Y(v) + 3}" class="axis" text-anchor="end">${axisLabel(v)}</text>`).join('')}
        <line x1="${PL}" y1="${Y(0)}" x2="${W - PR}" y2="${Y(0)}" class="grid base"/>
        <text x="${PL}" y="${H - 4}" class="axis">${fmtTime(x0)}</text>
        <text x="${W - PR}" y="${H - 4}" class="axis" text-anchor="end">${fmtTime(x1)}</text>
        ${paths}
        <line class="xhair" y1="${PT}" y2="${Y(0)}" style="display:none"/>
        <g class="dots" style="display:none">${series.map(s => `<circle r="3.5" fill="${s.color}" stroke="var(--panel)" stroke-width="2"/>`).join('')}</g>
      </svg>
      <div class="chart-legend">${series.map(s => `<span><span class="swatch" style="background:${s.color}"></span>${esc(s.name)}</span>`).join('')}</div>
      <div class="chart-tip" style="display:none"></div>`;
    const svg = el.querySelector('svg'), tip = el.querySelector('.chart-tip');
    const xhair = svg.querySelector('.xhair'), dots = [...svg.querySelector('.dots').children];
    svg.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const t = x0 + ((e.clientX - r.left) / r.width * W - PL) / (W - PL - PR) * (x1 - x0);
      let idx = 0, best = Infinity;
      xs.forEach((xt, i) => { const d = Math.abs(xt - t); if (d < best) { best = d; idx = i; } });
      const tx = X(xs[idx]);
      xhair.setAttribute('x1', tx); xhair.setAttribute('x2', tx);
      series.forEach((s, i) => { dots[i].setAttribute('cx', tx); dots[i].setAttribute('cy', Y(s.points[idx].n)); });
      xhair.style.display = svg.querySelector('.dots').style.display = tip.style.display = '';
      tip.innerHTML = `<div style="color:var(--ink-3);margin-bottom:.2rem">${fmtTime(xs[idx])}</div>` +
        series.filter(s => s.points[idx].n > 0).map(s => `<div><span class="swatch" style="background:${s.color}"></span>${esc(s.name)}: <b>${fmtVal(s.points[idx].n)}</b></div>`).join('') || '<div style="color:var(--ink-3)">no traffic</div>';
      const px = (tx / W) * r.width;
      tip.style.left = Math.min(Math.max(px, 70), r.width - 90) + 'px';
    });
    svg.addEventListener('mouseleave', () => { xhair.style.display = svg.querySelector('.dots').style.display = tip.style.display = 'none'; });
  }

  // Smooth single-series line/area chart with crosshair tooltip.
  function lineChart(el, points, { color = 'var(--accent)', unit = '', maxY = null, label = '' } = {}) {
    if (!points || points.length < 2) {
      el.innerHTML = `<div class="chart-empty">No data yet - collecting…</div>`;
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
  function renderAuth(hasUsers, resetToken, tsSiteKey) {
    let mode = resetToken ? 'reset' : (hasUsers ? 'login' : 'register');
    let askCode = false, pendingCreds = null; // 2FA: waiting for an authenticator code
    let tsWidget = null;
    const showCaptcha = () => tsSiteKey && (mode === 'login' || mode === 'register');
    const mountTurnstile = () => {
      if (!showCaptcha()) return;
      const el = document.getElementById('cf-turnstile');
      if (!el) return;
      if (window.turnstile && window.turnstile.render) { try { tsWidget = window.turnstile.render(el, { sitekey: tsSiteKey, theme: 'dark' }); } catch { /* already rendered */ } }
      else setTimeout(mountTurnstile, 300); // Cloudflare script still loading
    };
    const captchaToken = () => { try { return (tsWidget != null && window.turnstile) ? window.turnstile.getResponse(tsWidget) : undefined; } catch { return undefined; } };
    const resetCaptcha = () => { try { if (tsWidget != null && window.turnstile) window.turnstile.reset(tsWidget); } catch {} };
    const TITLE = { login: 'Welcome back', register: 'Create your account', forgot: 'Reset your password', reset: 'Choose a new password' };
    const SUB = {
      login: 'Sign in to your hosting console.',
      register: 'Host sites, connect GitHub, tunnel your IPv6 space.',
      forgot: 'Enter your email and we will send you a reset link.',
      reset: 'Enter a new password for your account.',
    };
    const BTN = { login: 'Sign in', register: 'Create account', forgot: 'Send reset link', reset: 'Update password' };
    const draw = () => {
      $app.innerHTML = `
      <div class="auth-wrap"><div class="auth-card">
        <div class="logo"><span class="hex">⬡</span> Hosting</div>
        ${mode === 'register' && !hasUsers ? `<div class="first-user-banner" style="margin-top:1.2rem">✨ You're the first user - this account becomes the <b>administrator</b>.</div>` : ''}
        <h1>${TITLE[mode]}</h1>
        <p class="sub">${SUB[mode]}</p>
        <form id="authform">
          ${mode === 'login' && askCode ? `<label class="field"><span class="lbl">Authenticator code</span><input type="text" name="code" required inputmode="numeric" autocomplete="one-time-code" placeholder="123456 or a backup code" autofocus></label>`
          : `${mode === 'register' ? `<label class="field"><span class="lbl">Name</span><input type="text" name="name" required placeholder="Jelle"></label>` : ''}
          ${mode === 'reset' ? '' : `<label class="field"><span class="lbl">Email</span><input type="email" name="email" required placeholder="you@example.com"></label>`}
          ${mode === 'forgot' ? '' : `<label class="field"><span class="lbl">${mode === 'reset' ? 'New password' : 'Password'}</span><input type="password" name="password" required minlength="${mode === 'register' || mode === 'reset' ? 8 : 1}" placeholder="••••••••"></label>`}`}
          ${showCaptcha() ? `<div id="cf-turnstile" style="display:flex;justify-content:center;margin:.6rem 0"></div>` : ''}
          <button class="btn primary block" type="submit">${askCode ? 'Verify' : BTN[mode]}</button>
        </form>
        <p class="sub" style="margin-top:1.1rem;text-align:center">
          ${mode === 'login' ? `<a href="#" id="forgot">Forgot password?</a> · No account yet? <a href="#" id="swap">Register</a>`
            : mode === 'register' ? `Already registered? <a href="#" id="swap">Sign in</a>`
            : `<a href="#" id="backlogin">Back to sign in</a>`}
        </p>
        <p class="sub" style="text-align:center;font-size:.78rem;margin-top:.3rem"><a href="/terms" target="_blank">Terms</a> · <a href="/privacy" target="_blank">Privacy</a></p>
      </div></div>`;
      document.getElementById('swap')?.addEventListener('click', (e) => { e.preventDefault(); mode = mode === 'login' ? 'register' : 'login'; draw(); });
      document.getElementById('forgot')?.addEventListener('click', (e) => { e.preventDefault(); mode = 'forgot'; draw(); });
      document.getElementById('backlogin')?.addEventListener('click', (e) => { e.preventDefault(); mode = 'login'; resetToken = null; location.hash = ''; draw(); });
      document.getElementById('authform').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(e.target));
        try {
          if (mode === 'forgot') {
            const r = await api('/auth/forgot', { method: 'POST', body: { email: fd.email } });
            toast(r.mail_configured ? 'If that email exists, a reset link is on its way.' : 'Email is not set up on this server - ask the admin to configure it.', r.mail_configured ? 'ok' : '');
            mode = 'login'; draw(); return;
          }
          if (mode === 'reset') {
            await api('/auth/reset', { method: 'POST', body: { token: resetToken, password: fd.password } });
            toast('Password updated - you can sign in now.', 'ok');
            mode = 'login'; resetToken = null; location.hash = ''; draw(); return;
          }
          const body = (mode === 'login' && askCode) ? { ...pendingCreds, code: fd.code } : { ...fd };
          const cap = captchaToken();
          if (showCaptcha() && cap) body.captcha = cap;
          const r = await api(`/auth/${mode}`, { method: 'POST', body });
          me = r.user;
          if (r.firstUser) toast('Welcome, admin! Your console is ready.', 'ok');
          askCode = false; pendingCreds = null;
          location.hash = '#/overview';
          render();
        } catch (err) {
          resetCaptcha(); // Turnstile tokens are single-use - get a fresh one
          if (mode === 'login' && err.data && err.data.twofa) {
            pendingCreds = { email: fd.email || pendingCreds?.email, password: fd.password || pendingCreds?.password };
            if (!askCode) { askCode = true; draw(); return; } // first prompt, don't shout an error
          }
          oops(err);
        }
      });
      mountTurnstile();
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
        ${nav('overview', '◈', 'Overview')}
        ${nav('sites', '▤', 'Sites')}
        ${nav('traffic', '📈', 'Traffic')}
        ${nav('certs', '🔒', 'Certificates')}
        ${me.role === 'admin' ? nav('network', '⇄', 'Network / VPN') : ''}
        ${nav('billing', '💳', 'Billing')}
        ${me.role === 'admin' ? `
          <div class="side-label">Administration</div>
          ${nav('admin/users', '👥', 'Users')}
          ${nav('admin/cloudflare', '☁', 'Cloudflare')}
          ${nav('admin/system', '⚙', 'System')}
          ${nav('admin/activity', '≡', 'Activity log')}` : ''}
        <a class="nav-item" href="/status" target="_blank"><span class="ico">◉</span>Status page</a>
        <a class="nav-item" href="/terms" target="_blank"><span class="ico">§</span>Terms &amp; Privacy</a>
        <div class="spacer"></div>
        <div class="userchip">
          <div class="avatar">${esc((me.name || '?')[0].toUpperCase())}</div>
          <a class="uinfo" href="#/account" style="text-decoration:none;color:inherit"><div class="uname">${esc(me.name)}</div><div class="urole">${esc(me.role)} · account</div></a>
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
    const [{ stats, recent, bandwidth }, m] = await Promise.all([api('/overview'), api('/metrics').catch(() => null)]);
    const bw = bandwidth || { total: 0, rateBps: 0 };
    const c = h(`
      <div>
        <div class="page-head"><h1>Overview</h1>
          <div class="sub">Hello ${esc(me.name)} - here's what's happening on your platform.</div></div>
        <div class="tiles">
          <div class="tile accent"><div class="t-label">Sites</div><div class="t-value">${stats.sites}</div><div class="t-note">${stats.liveSites} live</div></div>
          <div class="tile"><div class="t-label">Bandwidth</div><div class="t-value" id="bw-rate">${fmtBytes(bw.rateBps)}/s</div><div class="t-note" id="bw-total">${fmtBytes(bw.total)} total served</div></div>
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
              <td class="mono">${esc(d.commit_sha || '-')} ${esc((d.commit_msg || '').split('\n')[0].slice(0, 40))}</td>
              <td>${ago(d.started_at)}</td></tr>`).join('')}
          </table></div>` : `<div class="empty"><div class="big">🚀</div>No deployments yet.<br>Create a site and connect a GitHub repository to get going.</div>`}
        </div>
      </div>`);
    const main = shell('overview', c);
    if (m) {
      lineChart(main.querySelector('#ch-traffic'), m.traffic.map(p => ({ t: p.t, v: p.n })), { unit: ' req', label: 'Requests per minute' });
      deployBars(main.querySelector('#ch-deploys'), deployDays(m.deploys));
    }
    // live bandwidth refresh
    const bwTimer = setInterval(async () => {
      if (!document.body.contains(main)) return clearInterval(bwTimer);
      try {
        const { bandwidth } = await api('/overview');
        const r = main.querySelector('#bw-rate'), t = main.querySelector('#bw-total');
        if (r && bandwidth) r.textContent = `${fmtBytes(bandwidth.rateBps)}/s`;
        if (t && bandwidth) t.textContent = `${fmtBytes(bandwidth.total)} total served`;
      } catch {}
    }, 5000);
  }

  // ── traffic per website ─────────────────────────────────────────
  // Colour follows the site (not its rank), so a site keeps its hue as the
  // ranking shifts or the metric toggles. First-seen sites (sorted by id)
  // claim the next palette slot.
  const trafficColors = new Map();
  function colorFor(id) {
    if (!trafficColors.has(id)) trafficColors.set(id, SERIES_COLORS[trafficColors.size % SERIES_COLORS.length]);
    return trafficColors.get(id);
  }

  async function pageTraffic() {
    let metric = 'req';
    const c = h(`
      <div>
        <div class="page-head"><h1>Traffic per website</h1>
          <div class="sub">Requests and bandwidth for each of your sites - last hour, per minute.</div></div>
        <div class="card">
          <h2 style="display:flex;align-items:center;gap:.6rem">
            <span id="tr-title">Requests</span>
            <span class="hint" id="tr-hint" style="margin:0">per minute · last hour</span>
            <div class="seg" id="tr-toggle" style="margin-left:auto">
              <button data-m="req" class="active">Requests</button>
              <button data-m="bytes">Bandwidth</button>
            </div>
          </h2>
          <div class="chart tall" id="ch-persite"></div>
        </div>
        <div class="card">
          <h2>Sites <span class="hint">totals over the last hour</span></h2>
          <div id="tr-table"></div>
        </div>
      </div>`);
    const main = shell('traffic', c);
    const chartEl = main.querySelector('#ch-persite');
    const tableEl = main.querySelector('#tr-table');

    async function load() {
      const { sites } = await api(`/metrics/per-site?metric=${metric}`);
      // stable id order first, so colours are assigned deterministically
      [...sites].sort((a, b) => a.id - b.id).forEach(s => colorFor(s.id));
      let series = sites.map(s => ({ id: s.id, name: s.name, color: colorFor(s.id), points: s.points }));
      // 9th+ series folds into "Other" (dataviz: never cycle hues)
      if (series.length > 8) {
        const keep = series.slice(0, 7);
        const rest = series.slice(7);
        const len = rest[0].points.length;
        const merged = Array.from({ length: len }, (_, i) => ({
          t: rest[0].points[i].t, n: rest.reduce((s, r) => s + r.points[i].n, 0),
        }));
        series = [...keep, { id: -1, name: `Other (${rest.length} sites)`, color: 'var(--ink-3)', points: merged }];
      }
      const isBytes = metric === 'bytes';
      const fmtVal = isBytes ? (v) => fmtBytes(v) : (v) => `${v} req`;
      multiLineChart(chartEl, series, { fmtVal, fmtAxis: isBytes ? (v) => fmtBytes(v) : null });
      main.querySelector('#tr-title').textContent = isBytes ? 'Bandwidth' : 'Requests';
      main.querySelector('#tr-hint').textContent = isBytes ? 'bytes/min · last hour' : 'per minute · last hour';
      tableEl.innerHTML = sites.length ? `<div class="tbl-scroll"><table class="tbl">
        <tr><th></th><th>Site</th><th style="text-align:right">${isBytes ? 'Served' : 'Requests'}</th></tr>
        ${sites.map(s => `<tr>
          <td style="width:1.4rem"><span class="swatch" style="background:${colorFor(s.id)}"></span></td>
          <td><a href="#/sites/${s.id}">${esc(s.name)}</a></td>
          <td class="mono" style="text-align:right">${isBytes ? fmtBytes(s.total) : s.total}</td></tr>`).join('')}
      </table></div>` : `<div class="empty"><div class="big">📈</div>No traffic in the last hour yet.</div>`;
    }

    main.querySelectorAll('#tr-toggle button').forEach(b =>
      b.addEventListener('click', () => {
        metric = b.dataset.m;
        main.querySelectorAll('#tr-toggle button').forEach(x => x.classList.toggle('active', x === b));
        load().catch(oops);
      }));

    await load();
    const timer = setInterval(() => {
      if (!document.body.contains(main)) return clearInterval(timer);
      load().catch(() => {});
    }, 10000);
  }

  // ── sites list ──────────────────────────────────────────────────
  async function pageSites() {
    const [{ sites }, ghState, bill] = await Promise.all([
      api('/sites'),
      api('/github').catch(() => ({ connected: false })),
      api('/billing').catch(() => ({ configured: false })),
    ]);
    // A subscription is required to create sites (the server enforces this too;
    // this just explains it up front instead of showing a payment error).
    const needsPlan = bill.configured && !bill.subscribed && me.role !== 'admin';
    const c = h(`
      <div>
        <div class="page-head"><h1>Sites</h1><div class="grow"></div>
          <button class="btn" id="ghconnect">${ghState.connected ? `🐙 ${esc(ghState.login)}` : '🐙 Connect GitHub'}</button>
          <button class="btn primary" id="newsite">＋ New site</button></div>
        ${needsPlan ? `<div class="first-user-banner" style="border-color:rgba(255,201,120,.3);background:rgba(255,201,120,.1);color:#ffd9a3">
          💳 <b>A subscription is required to host a site.</b> Hosting is ${esc(bill.price_label || 'billed per site')} - subscribe once and every site you add is billed automatically.
          <div style="margin-top:.7rem"><a class="btn primary" href="#/billing">Go to Billing →</a></div></div>` : ''}
        ${sites.length ? `<div class="site-grid">${sites.map(s => `
          <div class="site-card" data-id="${s.id}">
            <div class="s-top"><span class="type-badge ${s.type}">${s.type}</span>
              <span class="s-name">${esc(s.name)}</span>${pill(s.status)}</div>
            <div class="s-domain">${esc(s.domains[0] || s.default_domain)}</div>
            ${s.ipv6_addr && me.role === 'admin' ? `<div class="s-domain" style="color:var(--ink-3)">⬡ ${esc(s.ipv6_addr)}</div>` : ''}
            <div class="s-meta">
              <span>${s.repo_url ? '⎇ ' + esc(s.repo_url.replace(/^https:\/\/(www\.)?/, '').replace(/\.git$/, '')) : 'no repo connected'}</span>
            </div>
          </div>`).join('')}</div>`
        : `<div class="empty"><div class="big">▤</div>No sites yet. Create your first one - static HTML or a Node.js app.</div>`}
      </div>`);
    const main = shell('sites', c);
    main.querySelector('#newsite').addEventListener('click', () => {
      if (needsPlan) { toast('Subscribe first - hosting is billed per site.', ''); location.hash = '#/billing'; return; }
      newSiteModal(ghState);
    });
    main.querySelector('#ghconnect').addEventListener('click', () => githubModal(ghState));
    main.querySelectorAll('.site-card').forEach(el =>
      el.addEventListener('click', () => { location.hash = `#/sites/${el.dataset.id}`; }));
  }

  function githubModal(ghState) {
    const m = modal(ghState.connected ? `
      <h2>GitHub connected</h2>
      <p style="color:var(--ink-2);font-size:.9rem">Connected as <b>${esc(ghState.login)}</b>. Your private
        repositories can be browsed and deployed, and webhooks are created automatically - no need to make
        anything public.</p>
      <div class="actions">
        <button type="button" class="btn" id="cancel">Close</button>
        <button type="button" class="btn danger" id="disconnect">Disconnect</button>
      </div>` : `
      <h2>Connect GitHub</h2>
      <p style="color:var(--ink-2);font-size:.9rem">Paste a <b>Personal Access Token</b> so Hosting can deploy your
        <b>private</b> repositories and create webhooks for you - repos never need to be public.</p>
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
        <label class="field"><span class="lbl">Pick a repository <span style="font-weight:400">(${esc(ghState.login)} - incl. private)</span></span>
          <select id="repopick"><option value="">Loading your repos…</option></select>
          <span class="help">Or paste a URL below. Private repos deploy automatically via your connected account.</span></label>` : `
        <div class="first-user-banner" style="margin-bottom:1rem">🐙 <b>Connect GitHub</b> (button on the Sites page) to browse and deploy <b>private</b> repos without a per-site token.</div>`}
        <label class="field"><span class="lbl">GitHub repository (https)</span>
          <input type="text" name="repo_url" placeholder="https://github.com/you/repo">
          <span class="help">Pushes to the branch below auto-deploy.${ghState.connected ? ' The webhook is created for you.' : ' Add the webhook shown after creation.'}</span></label>
        <div class="formrow">
          <label class="field"><span class="lbl">Branch</span><input type="text" name="repo_branch" value="main"></label>
          <label class="field"><span class="lbl">Access token <span style="font-weight:400">(${ghState.connected ? 'optional - uses your account' : 'private repos'})</span></span>
            <input type="password" name="repo_token" placeholder="ghp_… (optional)"></label>
        </div>
        <div class="formrow">
          <label class="field"><span class="lbl">Custom domain <span style="color:var(--warn)">(required)</span></span>
            <input type="text" name="domain" placeholder="www.example.com" required></label>
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
        pick.innerHTML = '<option value="">- choose a repository -</option>' +
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
        const { site, webhook, cf } = await api('/sites', { method: 'POST', body });
        m.remove();
        toast(`Site "${site.name}" created${site.repo_url ? ' - first deploy started' : ''}`, 'ok');
        if (webhook?.created) toast('GitHub webhook created automatically 🎉', 'ok');
        else if (site.repo_url && webhook && webhook.reason && !/already/.test(webhook.reason)) toast(`Webhook not auto-created: ${webhook.reason}`, '');
        // If a custom domain was registered with Cloudflare, show the DNS records
        // to add right away; otherwise go straight to the new site.
        if (cf && cf.enabled && cf.hostnames && cf.hostnames.length) domainSetupModal(site, cf);
        else location.hash = `#/sites/${site.id}`;
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
            ${site.status === 'stopped' ? `<span class="k"></span><span class="v" style="color:#f0b429">⏸ Stopped - not public, but still ${site.type === 'node' ? 'running and reachable' : 'reachable'} at the default URL above so you can test it locally. Custom domains and the dedicated IPv6 stay offline.</span>` : ''}
            ${site.ipv6_addr && me.role === 'admin' ? `<span class="k">Dedicated IPv6 <span style="color:var(--ink-3);font-weight:400">(admin only)</span></span><span class="v">${esc(site.ipv6_addr)}
              <button class="cp" style="background:none;border:none;cursor:pointer;color:var(--ink-3)" onclick="_copy('${esc(site.ipv6_addr)}', 'IPv6 copied')" title="copy">⧉</button>
              <span style="color:var(--ink-3)"> - internal origin address</span></span>` : ''}
            ${domains.map(d => `<span class="k">Custom domain</span><span class="v"><a href="http://${esc(d)}" target="_blank">http://${esc(d)}</a> <span class="cf-stat" data-host="${esc(String(d).toLowerCase())}"></span></span>`).join('')}
            ${site.type === 'node' ? `<span class="k">Internal port</span><span class="v">${site.app_port} ${site.process?.running ? `· running ${uptimeStr(site.process.uptimeSec)}` : '· not running'}</span>` : ''}
          </div>
        </div>
        <div class="tabs">
          ${tabBtn('deploys', 'Deployments')}
          ${tabBtn('files', 'Files')}
          ${tabBtn('ssl', 'SSL')}
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

    // Cloudflare status: fill the pill next to each custom domain in the Access
    // card, and show a prominent CNAME banner while any domain isn't live yet.
    api(`/sites/${id}/domains/cf`).then(cf => {
      if (!cf.enabled) return;
      const byHost = {};
      (cf.hostnames || []).forEach(hn => { byHost[String(hn.hostname || '').toLowerCase()] = hn; });
      main.querySelectorAll('.cf-stat').forEach(el => {
        const hn = byHost[el.dataset.host];
        if (hn) el.innerHTML = cfStatusPill(hn);
      });
      const pending = (cf.hostnames || []).filter(hn => !hn.active);
      if (pending.length) main.querySelector('.page-head')?.insertAdjacentElement('afterend', h(cfBannerHtml(pending, cf.fallback_origin)));
    }).catch(() => {});

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
            <td class="mono">${esc(d.commit_sha || '-')} ${esc((d.commit_msg || '').split('\n')[0].slice(0, 44))}</td>
            <td>${ago(d.started_at)}</td>
            <td><button class="btn small viewlog" data-dep="${d.id}">log</button></td></tr>`).join('')}
        </table></div>` : `<div class="empty">No deployments yet. Connect a repo and hit <b>Deploy now</b>.</div>`}
      </div>`));
      body.querySelectorAll('.viewlog').forEach(btn => btn.addEventListener('click', async () => {
        try {
          const { deployment } = await api(`/sites/${id}/deployments/${btn.dataset.dep}`);
          modal(`<h2>Deploy #${deployment.id} - ${esc(deployment.status)}</h2>
            <div class="logbox">${esc(deployment.log || '(no output)')}</div>
            <div class="actions"><button class="btn" onclick="this.closest('.modal-back').remove()">Close</button></div>`);
        } catch (e) { oops(e); }
      }));
    }

    if (tab === 'github') {
      // GitHub account connection panel (guide + token field), inline here
      const ghPanel = h(`<div class="card" id="ghpanel">
        <h2>GitHub account <span class="hint" id="ghstate">checking…</span></h2>
        <div id="ghbody"><div style="color:var(--ink-3);font-size:.85rem">Loading…</div></div>
      </div>`);
      const ghCard = ghPanel.firstElementChild; // keep a live ref (fragment empties on append)
      body.appendChild(ghPanel);
      const renderGh = (st) => {
        const gb = ghCard.querySelector('#ghbody');
        ghCard.querySelector('#ghstate').textContent = st.connected ? `connected as ${st.login}` : 'not connected';
        if (st.connected) {
          gb.innerHTML = `<p style="color:var(--ink-2);font-size:.9rem;margin:0 0 .8rem">
            Connected as <b>${esc(st.login)}</b>. Private repos deploy automatically and webhooks are created for you.</p>
            <button class="btn small danger" id="ghdisc">Disconnect</button>`;
          gb.querySelector('#ghdisc').addEventListener('click', async () => {
            try { await api('/github', { method: 'DELETE' }); toast('GitHub disconnected', 'ok'); loadGh(); } catch (e) { oops(e); }
          });
        } else {
          gb.innerHTML = `
            <p style="color:var(--ink-2);font-size:.9rem;margin:0 0 .6rem">Connect your account so <b>private</b>
              repositories deploy without being made public.</p>
            <ol style="color:var(--ink-3);font-size:.83rem;line-height:1.8;margin:0 0 .8rem;padding-left:1.2rem">
              <li>GitHub → <b>Settings → Developer settings → Personal access tokens</b></li>
              <li><b>Tokens (classic)</b> → <i>Generate new token</i> → tick <code class="code">repo</code>
                and <code class="code">admin:repo_hook</code> - or a <b>fine-grained</b> token with
                <b>Contents: Read</b> and <b>Webhooks: Read &amp; write</b></li>
              <li>Copy the token (starts with <code class="code">ghp_</code> or <code class="code">github_pat_</code>) and paste it below</li>
            </ol>
            <div style="display:flex;gap:.6rem;align-items:flex-end;flex-wrap:wrap">
              <label class="field" style="flex:1;min-width:220px;margin:0"><span class="lbl">Personal Access Token</span>
                <input type="password" id="ghtok" placeholder="ghp_… or github_pat_…"></label>
              <a class="btn small" href="https://github.com/settings/tokens/new?scopes=repo,admin:repo_hook&description=Hosting" target="_blank">Open GitHub ↗</a>
              <button class="btn primary" id="ghsave">Connect</button>
            </div>`;
          gb.querySelector('#ghsave').addEventListener('click', async () => {
            const token = gb.querySelector('#ghtok').value.trim();
            if (!token) return toast('Paste a token first', 'err');
            try { const r = await api('/github', { method: 'POST', body: { token } }); toast(`Connected as ${r.login} - redeploy to pull private repos`, 'ok'); loadGh(); }
            catch (e) { oops(e); }
          });
          gb.querySelector('#ghtok').addEventListener('keydown', (e) => { if (e.key === 'Enter') gb.querySelector('#ghsave').click(); });
        }
      };
      const loadGh = () => api('/github').then(renderGh).catch(() => { ghCard.querySelector('#ghbody').innerHTML = '<div style="color:var(--bad)">Could not load GitHub status</div>'; });
      loadGh();

      body.appendChild(h(`<div class="card">
        <h2>GitHub auto-deploy</h2>
        ${site.repo_url ? `
          <p style="color:var(--ink-2);font-size:.9rem">Pushes to <code class="code">${esc(site.repo_branch)}</code> on
            <code class="code">${esc(site.repo_url)}</code> deploy automatically.</p>
          <div class="first-user-banner" style="margin-bottom:1rem">🔄 <b>Auto-deploy is on by polling</b> - Hosting checks GitHub for new
            commits every couple of minutes and redeploys, so it works even when your server isn't reachable from the internet.
            <button class="btn small" id="checknow" style="margin-left:.4rem">Check now</button></div>
          <div style="margin-bottom:.6rem"><button class="btn small" id="mkhook">⚡ Create webhook automatically</button></div>
          <label class="field" style="display:flex;align-items:center;gap:.5rem;margin-top:.4rem">
            <input type="checkbox" id="autodep" style="width:auto" ${site.auto_deploy ? 'checked' : ''}>
            <span class="lbl" style="margin:0">Auto-deploy on push (polling + webhook)</span></label>`
        : `<div class="empty">No repository connected. Add one in <b>Settings</b>.</div>`}
      </div>`));
      body.querySelector('#checknow')?.addEventListener('click', async (e) => {
        e.preventDefault();
        e.target.disabled = true; e.target.textContent = 'Checking…';
        try {
          const r = await api(`/sites/${id}/check`, { method: 'POST' });
          if (r.deploying) { toast(`New commit ${r.sha} - deploying`, 'ok'); setTimeout(() => pageSiteDetail(id, 'deploys'), 700); }
          else if (r.upToDate) toast(`Already up to date (${r.sha})`, 'ok');
          else toast(r.error || r.skipped || 'Nothing to do', r.error ? 'err' : '');
        } catch (err) { oops(err); }
        finally { if (e.target) { e.target.disabled = false; e.target.textContent = 'Check now'; } }
      });
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

    if (tab === 'ssl') {
      const wrap = h(`<div id="sslwrap"><div class="card"><h2>SSL certificate</h2><div id="sslbody">Loading…</div></div></div>`);
      body.appendChild(wrap);
      const sslBody = () => body.querySelector('#sslbody');
      const pill2 = (cls, text) => `<span class="pill ${cls}"><span class="dot"></span>${text}</span>`;
      const statePill = (st) => {
        if (st.status === 'active') {
          const soon = st.daysLeft !== null && st.daysLeft <= 30;
          return pill2(soon ? 'deploying' : 'live', soon ? `active · expires in ${st.daysLeft}d` : 'active');
        }
        if (st.status === 'pending') return pill2('queued', 'awaiting DNS');
        if (st.status === 'failed') return pill2('failed', 'failed');
        return pill2('stopped', 'no certificate');
      };
      const render = (st, cf) => {
        if (!st.available) { sslBody().innerHTML = `<div class="empty">SSL support isn't installed on this server (the <code class="code">acme-client</code> package). Run <code class="code">npm install</code> and restart.</div>`; return; }
        const domains = st.domains_configured || [];
        const eligible = domains.filter(d => !/\.sslip\.io$/i.test(d) && !/^\d+\.\d+\.\d+\.\d+$/.test(d));
        // Domains that Cloudflare already secures (active custom hostname) don't
        // need a Let's Encrypt cert - reflect that instead of "no certificate".
        const cfActiveHosts = (cf && cf.enabled ? (cf.hostnames || []) : []).filter(h => h.active);
        const cfActive = cfActiveHosts.map(h => h.hostname);
        const cfCert = cfActiveHosts.find(h => h.ssl_detail && h.ssl_detail.expires_on);
        const statusHtml = st.status === 'active' ? statePill(st)
          : (cfActive.length ? pill2('live', 'active') : statePill(st));
        sslBody().innerHTML = `
          <div class="kv" style="margin-bottom:1rem">
            <span class="k">Status</span><span class="v">${statusHtml}</span>
            ${st.not_after ? `<span class="k">Expires</span><span class="v">${fmtDate(st.not_after)} (${st.daysLeft}d)</span>`
              : (cfCert ? `<span class="k">Expires</span><span class="v">${fmtDate(cfCert.ssl_detail.expires_on)} · renews automatically</span>` : '')}
            ${st.issuer ? `<span class="k">Issuer</span><span class="v">${esc(st.issuer)}${st.staging ? ' - staging (not trusted by browsers)' : ''}</span>` : ''}
            <span class="k">Domains</span><span class="v">${domains.length ? domains.map(esc).join(', ') : '<span style="color:var(--warn)">none - add a custom domain in Settings first</span>'}</span>
          </div>
          ${!eligible.length ? `<div class="first-user-banner">Add a <b>real custom domain</b> you control (Settings → Domains) to get a certificate. The free <code class="code">.sslip.io</code> address can't be certified.</div>` : `
            ${st.status === 'pending' && st.challenge.length ? `
              <div class="card" style="background:var(--bg-2);margin:0 0 1rem">
                <h2 style="font-size:.95rem">① Add these DNS TXT records</h2>
                <p style="color:var(--ink-2);font-size:.86rem;margin:.2rem 0 .8rem">At your DNS provider, add each record below, wait a minute for it to propagate, then click <b>Verify &amp; issue</b>.</p>
                <table class="tbl"><tr><th>Type</th><th>Name</th><th>Value</th></tr>
                  ${st.challenge.map(c => `<tr>
                    <td class="mono">TXT</td>
                    <td class="mono">${esc(c.name)} <button class="cp" onclick="_copy('${esc(c.name)}')">⧉</button></td>
                    <td class="mono" style="word-break:break-all">${esc(c.value)} <button class="cp" onclick="_copy('${esc(c.value)}')">⧉</button></td></tr>`).join('')}
                </table>
                <div style="margin-top:1rem;display:flex;gap:.6rem">
                  <button class="btn primary" id="sslverify">② Verify &amp; issue</button>
                  <button class="btn" id="sslcancel">Cancel</button>
                </div>
              </div>` : `
              <div style="display:flex;gap:.6rem;flex-wrap:wrap;align-items:center">
                <button class="btn primary" id="sslrequest">${st.status === 'active' ? '🔄 Renew now' : '🔒 Get certificate'}</button>
                ${st.status === 'active' ? `<button class="btn danger" id="sslremove">Remove</button>` : ''}
                <label style="display:flex;align-items:center;gap:.4rem;margin-left:.4rem;font-size:.85rem;color:var(--ink-2)">
                  <input type="checkbox" id="sslauto" style="width:auto" ${st.auto_renew ? 'checked' : ''}> Auto-renew (re-stage TXT ~30d before expiry)</label>
              </div>
              <p style="color:var(--ink-3);font-size:.8rem;margin-top:.8rem">Uses Let's Encrypt with DNS-01 verification - no inbound access needed, so it works behind NAT. Point your domain's A/AAAA records at this server, then get a certificate.</p>`}
          `}`;
        wireSsl(st);
      };
      const wireSsl = (st) => {
        const b = sslBody();
        b.querySelector('#sslrequest')?.addEventListener('click', async (e) => {
          e.target.disabled = true; e.target.textContent = 'Creating order…';
          try { await api(`/sites/${id}/ssl/request`, { method: 'POST' }); toast('Order created - add the DNS TXT records shown', 'ok'); load(); }
          catch (err) { oops(err); load(); }
        });
        b.querySelector('#sslverify')?.addEventListener('click', async (e) => {
          e.target.disabled = true; e.target.textContent = 'Verifying…';
          try { const r = await api(`/sites/${id}/ssl/verify`, { method: 'POST' }); toast(`Certificate issued 🔒 (until ${new Date(r.not_after).toLocaleDateString()})`, 'ok'); load(); }
          catch (err) { oops(err); load(); }
        });
        b.querySelector('#sslcancel')?.addEventListener('click', async () => { await api(`/sites/${id}/ssl`, { method: 'DELETE' }).catch(() => {}); load(); });
        b.querySelector('#sslremove')?.addEventListener('click', async () => {
          if (!confirm('Remove this certificate?')) return;
          try { await api(`/sites/${id}/ssl`, { method: 'DELETE' }); toast('Certificate removed', 'ok'); load(); } catch (err) { oops(err); }
        });
        b.querySelector('#sslauto')?.addEventListener('change', async (e) => {
          try { await api(`/sites/${id}/ssl`, { method: 'PATCH', body: { auto_renew: e.target.checked } }); toast('Saved', 'ok'); } catch (err) { oops(err); }
        });
      };
      const load = () => Promise.all([
        api(`/sites/${id}/ssl`),
        api(`/sites/${id}/domains/cf`).catch(() => ({ enabled: false, hostnames: [] })),
      ]).then(([st, cf]) => render(st, cf)).catch(e => { sslBody().innerHTML = `<div style="color:var(--bad)">${esc(e.message)}</div>`; });
      load();
    }

    if (tab === 'files') {
      let cwd = '';
      const card = h(`<div class="card">
        <h2>Files <span class="hint" id="fpath">/</span></h2>
        <div class="dropzone" id="drop">
          <div class="dz-inner">⬆ <b>Drag &amp; drop</b> files or folders here, or
            <label class="linklike">browse<input type="file" id="fileinput" multiple hidden></label> ·
            <label class="linklike">folder<input type="file" id="dirinput" webkitdirectory hidden></label></div>
          <div class="dz-bar" id="dzbar" style="display:none"><div class="dz-fill" id="dzfill"></div></div>
        </div>
        <div id="filelist"></div>
      </div>
      <div class="card"><h2>Upload over SFTP <span class="hint">FileZilla · WinSCP · sftp CLI</span></h2>
        <div class="kv">
          <span class="k">Host</span><span class="v">${esc(site.sftp.host)}</span>
          <span class="k">Port</span><span class="v">${site.sftp.port}</span>
          <span class="k">Username</span><span class="v">${esc(me.email)}+${esc(site.slug)} <button class="cp" style="background:none;border:none;cursor:pointer;color:var(--ink-3)" onclick="_copy('${esc(me.email)}+${esc(site.slug)}', 'Username copied')" title="copy">⧉</button></span>
          <span class="k">Password</span><span class="v">your account password</span>
          <span class="k">Your files are in</span><span class="v">/ (you land directly in this site - no other sites are visible)</span>
        </div>
        <div class="copybox" style="margin-top:.8rem"><code>sftp -P ${site.sftp.port} ${esc(me.email)}+${esc(site.slug)}@${esc(site.sftp.host)}</code>
          <button class="cp" onclick="_copy('sftp -P ${site.sftp.port} ${esc(me.email)}+${esc(site.slug)}@${esc(site.sftp.host)}')">⧉</button></div>
        <span class="help">The <code class="code">+${esc(site.slug)}</code> on the username scopes the session to <b>this site only</b>. Drop your website files straight into the root.
          ${site.repo_url ? '<b>Note:</b> this site deploys from Git - a redeploy overwrites uploaded files.' : ''}</span>
      </div>`);
      body.appendChild(card);
      const q=(sel)=>body.querySelector(sel);
      const fpath = q('#fpath');
      const list = q('#filelist');

      const loadFiles = async () => {
        fpath.textContent = '/' + cwd;
        try {
          const { entries } = await api(`/sites/${id}/files?path=${encodeURIComponent(cwd)}`);
          list.innerHTML = `<table class="tbl">
            ${cwd ? `<tr class="frow" data-up="1"><td>📁 <a href="#">..</a></td><td></td><td></td></tr>` : ''}
            ${entries.length || cwd ? '' : '<tr><td colspan="3" style="color:var(--ink-3);padding:1.2rem;text-align:center">Empty - drop files above to get started.</td></tr>'}
            ${entries.map(e => `<tr>
              <td>${e.dir ? '📁' : '📄'} ${e.dir ? `<a href="#" class="fdir" data-name="${esc(e.name)}">${esc(e.name)}</a>` : esc(e.name)}</td>
              <td style="color:var(--ink-3)">${e.dir ? '' : fmtBytes(e.size)}</td>
              <td style="text-align:right"><button class="btn small danger fdel" data-name="${esc(e.name)}">✕</button></td></tr>`).join('')}
          </table>`;
          list.querySelector('[data-up]')?.addEventListener('click', (ev) => { ev.preventDefault(); cwd = cwd.split('/').slice(0, -1).join('/'); loadFiles(); });
          list.querySelectorAll('.fdir').forEach(a => a.addEventListener('click', (ev) => { ev.preventDefault(); cwd = (cwd ? cwd + '/' : '') + a.dataset.name; loadFiles(); }));
          list.querySelectorAll('.fdel').forEach(b => b.addEventListener('click', async () => {
            if (!confirm(`Delete ${b.dataset.name}?`)) return;
            try { await api(`/sites/${id}/files?path=${encodeURIComponent((cwd ? cwd + '/' : '') + b.dataset.name)}`, { method: 'DELETE' }); loadFiles(); } catch (e) { oops(e); }
          }));
        } catch (e) { oops(e); }
      };

      const uploadFiles = async (files) => {
        const bar = q('#dzbar'), fill = q('#dzfill');
        bar.style.display = 'block'; let done = 0;
        for (const f of files) {
          const rel = (f.webkitRelativePath || f.name);
          const dest = (cwd ? cwd + '/' : '') + rel;
          try {
            await fetch(`/api/sites/${id}/files?path=${encodeURIComponent(dest)}`, {
              method: 'PUT', credentials: 'same-origin',
              headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f,
            }).then(r => { if (!r.ok) throw new Error('upload failed: ' + rel); });
          } catch (e) { oops(e); }
          fill.style.width = Math.round(++done / files.length * 100) + '%';
        }
        setTimeout(() => { bar.style.display = 'none'; fill.style.width = '0'; }, 600);
        toast(`Uploaded ${files.length} file${files.length === 1 ? '' : 's'}`, 'ok');
        loadFiles();
      };

      const drop = q('#drop');
      ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', async (e) => {
        const items = [...(e.dataTransfer.items || [])];
        const walk = async (entry, base = '') => {
          if (entry.isFile) return new Promise(r => entry.file(f => { Object.defineProperty(f, 'webkitRelativePath', { value: base + f.name }); r([f]); }));
          if (entry.isDirectory) {
            const reader = entry.createReader();
            const ents = await new Promise(r => reader.readEntries(r));
            const nested = await Promise.all(ents.map(en => walk(en, base + entry.name + '/')));
            return nested.flat();
          }
          return [];
        };
        const entries = items.map(i => i.webkitGetAsEntry?.()).filter(Boolean);
        if (entries.length) {
          const files = (await Promise.all(entries.map(en => walk(en)))).flat();
          if (files.length) return uploadFiles(files);
        }
        if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
      });
      q('#fileinput').addEventListener('change', e => uploadFiles([...e.target.files]));
      q('#dirinput').addEventListener('change', e => uploadFiles([...e.target.files]));
      loadFiles();
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
              <input type="password" name="repo_token" placeholder="${site.has_repo_token ? '••••••• (saved - type to replace)' : 'ghp_… (optional)'}"></label>
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
        try { await api(`/sites/${id}`, { method: 'PATCH', body: bodyData }); toast('Settings saved - redeploy to apply', 'ok'); pageSiteDetail(id, 'settings'); }
        catch (err) { oops(err); }
      });

      // ── Cloudflare-for-SaaS routing for this site's custom domains ──
      // .firstElementChild: h() returns a DocumentFragment that empties on
      // append, so keep a live reference to the actual card element.
      const cfCard = h(`<div class="card"><h2>Custom domain routing <span class="hint">Cloudflare</span></h2><div id="cfbody" class="empty">Loading…</div></div>`).firstElementChild;
      body.appendChild(cfCard);
      const renderCf = (d) => {
        const box = cfCard.querySelector('#cfbody');
        if (!d.enabled) {
          box.innerHTML = `Cloudflare for SaaS isn't enabled on this platform. Custom domains still work by pointing an A/AAAA record at this server - ask an admin to enable Cloudflare for SaaS (Administration → Cloudflare) to route them through Cloudflare automatically.`;
          return;
        }
        if (!d.hostnames.length) {
          box.innerHTML = `Add a real custom domain above and save - it'll be registered with Cloudflare and the exact DNS records to add will appear here.`;
          return;
        }
        box.classList.remove('empty');
        box.innerHTML = d.hostnames.map(hn => `<div style="margin-bottom:1.1rem">
            <div style="display:flex;gap:.6rem;align-items:center;margin-bottom:.4rem"><b class="mono">${esc(hn.hostname)}</b> ${cfStatusPill(hn)}</div>
            ${cfChecklist(hn)}
            ${hn.last_error ? `<div style="color:var(--bad);font-size:.85rem;margin-bottom:.4rem">${esc(hn.last_error)}</div>` : ''}
            ${hn.active ? '' : `<div style="color:var(--ink-2);font-size:.85rem;margin-bottom:.4rem">Add these at your domain's DNS provider - the <b>CNAME</b> routes traffic; the <b>TXT</b> completes ownership verification:</div>
            ${cfRecordsTable(cfRecordRows(hn, d.fallback_origin))}`}
          </div>`).join('') + `<button class="btn small" id="cfsync">↻ Refresh status</button>`;
        cfCard.querySelector('#cfsync')?.addEventListener('click', async (e) => {
          e.target.disabled = true;
          try { renderCf(await api(`/sites/${id}/domains/cf/sync`, { method: 'POST' })); }
          catch (err) { oops(err); e.target.disabled = false; }
        });
      };
      const loadCf = () => { cfCard.querySelector('#cfbody').textContent = 'Loading…'; return api(`/sites/${id}/domains/cf`).then((d) => { renderCf(d); return d; }).catch((e) => { cardError(cfCard.querySelector('#cfbody'), e.message || 'Could not load Cloudflare routing status.', loadCf); return null; }); };
      // While a custom domain isn't fully active, poll: pull fresh status from
      // Cloudflare (sync) then re-render - so once the user adds the CNAME/TXT,
      // the card flips to "active" with the issued-cert data on its own. Stops
      // when everything is active, after ~5 min, or when the card is gone.
      loadCf().then((first) => {
        if (!first || !first.enabled) return;
        if ((first.hostnames || []).length && first.hostnames.every(hn => hn.active)) return;
        let cfPolls = 0;
        const cfPoll = setInterval(async () => {
          if (!document.body.contains(cfCard) || cfPolls++ > 20) return clearInterval(cfPoll);
          try { await api(`/sites/${id}/domains/cf/sync`, { method: 'POST' }); } catch { /* keep polling */ }
          const d = await loadCf();
          if (d && d.hostnames && d.hostnames.length && d.hostnames.every(hn => hn.active)) clearInterval(cfPoll);
        }, 15000);
      });
      // Custom 404: no UI - the edge proxy automatically serves a 404.html from
      // the site's directory if the site ships one.
    }
  }

  // ── SSL certificates overview ───────────────────────────────────
  async function pageCerts() {
    const { available, summary, certs } = await api('/certs');
    const badge = (c) => {
      const map = {
        active:   ['live', 'Active'],
        expiring: ['deploying', `Expires in ${c.daysLeft}d`],
        expired:  ['failed', 'Expired'],
        pending:  ['queued', 'Awaiting DNS'],
        failed:   ['failed', 'Failed'],
        none:     ['stopped', 'No certificate'],
        ineligible: ['stopped', '-'],
      };
      const [cls, text] = map[c.state] || ['stopped', c.state];
      return `<span class="pill ${cls}"><span class="dot"></span>${text}</span>`;
    };
    const c = h(`
      <div>
        <div class="page-head"><h1>Certificates</h1>
          <div class="sub">SSL/TLS status across your sites - Let's Encrypt via DNS-01.</div></div>
        ${!available ? `<div class="card"><div class="empty">SSL support isn't installed (the <code class="code">acme-client</code> package). Run <code class="code">npm install</code> and restart.</div></div>` : `
        <div class="tiles">
          <div class="tile"><div class="t-label">Active</div><div class="t-value" style="color:var(--good)">${summary.active}</div></div>
          <div class="tile"><div class="t-label">Expiring soon</div><div class="t-value" style="color:${summary.expiring ? 'var(--warn)' : 'var(--ink)'}">${summary.expiring}</div></div>
          <div class="tile"><div class="t-label">Expired</div><div class="t-value" style="color:${summary.expired ? 'var(--bad)' : 'var(--ink)'}">${summary.expired}</div></div>
          <div class="tile"><div class="t-label">No certificate</div><div class="t-value">${summary.none + (summary.pending || 0)}</div></div>
        </div>
        ${summary.expiring || summary.expired ? `<div class="first-user-banner" style="margin-bottom:1.2rem">${summary.expired ? `🔴 <b>${summary.expired}</b> expired. ` : ''}${summary.expiring ? `🟡 <b>${summary.expiring}</b> expiring within 20 days. ` : ''}Open a site to renew (re-verify the DNS TXT record).</div>` : ''}
        <div class="card"><h2>All certificates</h2>
          <div class="tbl-scroll"><table class="tbl">
            <tr><th>Site</th><th>Domains</th><th>Status</th><th>Expires</th><th>Auto-renew</th><th></th></tr>
            ${certs.map(ct => `<tr>
              <td><b>${esc(ct.name)}</b>${ct.owner_email ? `<br><span style="color:var(--ink-3);font-size:.8rem">${esc(ct.owner_email)}</span>` : ''}</td>
              <td class="mono">${ct.domains.length ? ct.domains.map(esc).join('<br>') : '<span style="color:var(--ink-3)">- no custom domain</span>'}</td>
              <td>${badge(ct)}</td>
              <td>${ct.not_after ? `${fmtDate(ct.not_after)}${ct.daysLeft !== null ? `<br><span style="color:var(--ink-3);font-size:.8rem">${ct.daysLeft}d left</span>` : ''}` : '<span style="color:var(--ink-3)">-</span>'}</td>
              <td>${ct.state === 'ineligible' ? '<span style="color:var(--ink-3)">-</span>' : (ct.auto_renew ? '✓' : '✕')}</td>
              <td><a class="btn small" href="#/sites/${ct.site_id}">Manage →</a></td></tr>`).join('')}
          </table></div>
        </div>`}
      </div>`);
    shell('certs', c);
  }

  // ── network / wireguard ─────────────────────────────────────────
  async function pageNetwork() {
    const { server, peers, bgp } = await api('/wireguard' + (me.role === 'admin' ? '?all=1' : ''));
    const up = me.role === 'admin' ? await api('/wireguard/uplink').catch(() => null) : null;

    const bgpCell = (p) => {
      if (!p.asn) return '<span style="color:var(--ink-3)">-</span>';
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
          <div class="sub">WireGuard tunnels - route your own IPv6 block or IPv4 space through this server, and announce it with your ASN.</div>
          <div class="grow"></div><button class="btn primary" id="newpeer">＋ New peer</button></div>

        <div class="card"><h2>WireGuard server</h2>
          <div class="kv">
            <span class="k">Endpoint</span><span class="v">${esc(server.endpoint)}:${server.listen_port}</span>
            <span class="k">Public key</span><span class="v">${esc(server.public_key)}</span>
            <span class="k">Tunnel subnets</span><span class="v">${esc(server.tunnel_v4)} · ${esc(server.tunnel_v6)}</span>
            <span class="k">BGP (BIRD2)</span><span class="v">${server.server_asn ? `AS${esc(server.server_asn.replace(/^AS/i, ''))}${bgp?.available ? ' · daemon running' : ' · daemon not detected'}` : '<span style="color:var(--warn)">server ASN not set - BGP sessions disabled</span>'}</span>
            <span class="k">Site IPv6 pool</span><span class="v">${server.site_v6_pool ? `${esc(server.site_v6_pool)} - every site auto-gets a dedicated address` : '<span style="color:var(--ink-3)">not set - sites share the server address</span>'}</span>
          </div>
          ${me.role === 'admin' ? `<div style="margin-top:1rem;display:flex;gap:.6rem;flex-wrap:wrap">
            <button class="btn small" id="wgsettings">⚙ Server settings</button>
            <a class="btn small" href="/api/wireguard/server/config" download>⬇ Download wg0.conf</a>
            <a class="btn small" href="/api/wireguard/server/bird-config" download>⬇ Download bird.conf</a></div>` : ''}
        </div>

        ${me.role === 'admin' ? `
        <div class="card"><h2>Uplink - provider BGP tunnel
          <span class="hint">${up?.enabled ? (up.status.wg.up ? (up.status.wg.handshake ? `connected · handshake ${esc(up.status.wg.handshake)}` : 'interface up · no handshake yet') : 'enabled · tunnel down') : (up?.configured.wg ? 'disconnected' : 'not configured')}</span></h2>
          <p style="color:var(--ink-2);font-size:.9rem;margin:0 0 1rem">
            Using a service like <b>BGPTunnel (iFog)</b> or another upstream? There <i>this server</i> is the
            WireGuard <b>client</b>: download the <b>WireGuard config</b> and the <b>BIRD config</b> from your
            provider's dashboard and paste them below. The server connects out, announces your prefix from
            your ASN, and your IPv6 block lands here - ready for the Site IPv6 pool.</p>
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
                <span class="help">Upload: <input type="file" class="upfile" data-target="bird_conf" accept=".conf,.txt" style="width:auto;display:inline"> - parse-checked before apply; router id / kernel bits are merged safely.</span></label>
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
              <td class="mono">${[p.routed_v6, p.routed_v4].filter(Boolean).map(esc).join('<br>') || '-'}</td>
              <td class="mono">${esc(p.asn || '-')}</td>
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
            <li>Create a peer - optionally enter <b>your own IPv6 block</b> (e.g. <code class="code">2a0e:8f02:f01f::/48</code>), extra IPv4 space, and your <b>ASN</b>.</li>
            <li>Download the <code class="code">.conf</code> and import it into any WireGuard client (<code class="code">wg-quick up ./file.conf</code>).</li>
            <li>Your prefixes are routed through the tunnel - traffic to them arrives at your machine.</li>
            <li>Hit <b>BGP</b> on the peer to run a real BGP session over the tunnel: the server (BIRD2) peers with your tunnel address and accepts your registered prefixes. Download the ready-made config for your side, or upload your own <code class="code">bird.conf</code> - it's parse-checked before it goes live.</li>
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
          toast(`Peer created${r.wireguard?.applied ? ' and applied live' : ' - config saved'}`, 'ok');
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
        toast(r.wireguard?.up ? 'Uplink saved - tunnel up' : 'Uplink saved', 'ok');
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
        <h2>BGP over the tunnel - ${esc(p.name)}</h2>
        <div class="kv" style="margin-bottom:1rem">
          <span class="k">Your ASN</span><span class="v">${esc(p.asn)}</span>
          <span class="k">Server ASN</span><span class="v">${server.server_asn ? esc(server.server_asn) : '<span style="color:var(--warn)">not set (admin: Server settings)</span>'}</span>
          <span class="k">Accepted prefixes</span><span class="v">${[p.routed_v6, p.routed_v4].filter(Boolean).map(esc).join(' · ')}</span>
          <span class="k">Neighbor for you</span><span class="v">${esc(server.tunnel_v6.split('/')[0])} / ${esc(server.tunnel_v4.split('/')[0])}</span>
          ${sesLine('v6')}${sesLine('v4')}
        </div>
        <p style="color:var(--ink-2);font-size:.88rem;margin:0 0 1rem">
          When enabled, the server runs a BIRD2 session against your tunnel address and
          accepts <b>only your registered prefixes</b>. Run BIRD on your side too -
          <a href="/api/wireguard/peers/${p.id}/bird" download>download your ready-made bird.conf</a> -
          or upload your own config below.</p>
        <form id="bgpf">
          <label class="field" style="display:flex;align-items:center;gap:.5rem">
            <input type="checkbox" name="bgp_enabled" style="width:auto" ${p.bgp_enabled ? 'checked' : ''}>
            <span class="lbl" style="margin:0">Enable server-side BGP session for this peer</span></label>
          <label class="field"><span class="lbl">Custom BIRD config <span style="font-weight:400">(optional - included on the server, parse-checked before apply)</span></span>
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
          toast(`BGP settings saved - ${note}`, 'ok');
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
            <span class="help">The ASN this server speaks BGP as. Peers' sessions peer against it; private range 64512-65534 is fine if you don't have a public one.</span></label>
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

  // ── admin: cloudflare (DDoS protection) ─────────────────────────
  async function pageCloudflare() {
    const st = await api('/cloudflare');
    const wildcard = `*.${st.site_base_domain}`;
    const tlsSuffix = st.tls_port === 443 ? '' : `:${st.tls_port}`;
    const seenVia = st.seen.via_cloudflare;
    const lastVia = st.seen.last_via_at ? new Date(st.seen.last_via_at).toLocaleString() : null;
    const liveBadge = seenVia > 0
      ? `<span class="pill live"><span class="dot"></span>active - ${seenVia.toLocaleString()} request${seenVia === 1 ? '' : 's'} via Cloudflare</span>`
      : `<span class="pill queued"><span class="dot"></span>no Cloudflare traffic seen yet</span>`;

    const saas = await api('/cloudflare/saas').catch(() => ({}));
    const saasRows = (saas.hostnames || []).map(hn => {
      const pill = hn.active
        ? '<span class="pill live"><span class="dot"></span>active</span>'
        : (hn.last_error ? '<span class="pill failed">error</span>' : `<span class="pill queued"><span class="dot"></span>${esc(hn.status || 'pending')}</span>`);
      return `<tr><td class="mono">${esc(hn.hostname)}</td><td>${esc(hn.site_name || '')}</td><td>${pill}</td><td class="mono">${esc(hn.cname_target || '-')}</td></tr>`;
    }).join('');
    const saasHtml = `
      <div class="card">
        <h2>Cloudflare for SaaS <span class="hint">route users' own custom domains through Cloudflare</span></h2>
        <p style="color:var(--ink-2);font-size:.9rem;margin:.2rem 0 1rem">
          When a user adds their <b>own</b> domain to a site, the platform registers it as a Cloudflare
          <b>custom hostname</b> under your zone and shows them a single <b>CNAME</b> to add - no TXT record
          needed (HTTP validation). Cloudflare then auto-issues the certificate and filters DDoS for it.
          Needs your <b>Zone ID</b> and a Cloudflare API token with
          <b>Zone → SSL and Certificates → Edit</b> and <b>Zone → DNS → Edit</b> on the zone, plus a
          <b>fallback origin</b> that all custom hostnames route to.</p>
        <form id="saasf">
          <label class="field" style="display:flex;align-items:center;gap:.5rem">
            <input type="checkbox" name="enabled" style="width:auto" ${saas.enabled ? 'checked' : ''}>
            <span class="lbl" style="margin:0">Enable Cloudflare for SaaS for custom domains</span></label>
          <div class="formrow">
            <label class="field"><span class="lbl">Zone ID</span>
              <input type="text" name="zone_id" value="${esc(saas.zone_id || '')}" placeholder="32-char zone id">
              <span class="help">Your zone's Overview page → API → Zone ID.</span></label>
            <label class="field"><span class="lbl">Account ID <span style="font-weight:400">(optional)</span></span>
              <input type="text" name="account_id" value="${esc(saas.account_id || '')}" placeholder="32-char account id">
              <span class="help">Not required for custom hostnames. Lets Test verify the token and enables future zone provisioning.</span></label>
          </div>
          <div class="formrow">
            <label class="field"><span class="lbl">Fallback origin</span>
              <input type="text" name="fallback_origin" value="${esc(saas.fallback_origin || '')}" placeholder="customers.${esc(st.public_host)}">
              <span class="help">A hostname in your zone (e.g. <code class="code">customers.${esc(st.public_host)}</code>). All custom hostnames route here.</span></label>
            <label class="field"><span class="lbl">Origin IP <span style="font-weight:400">(recommended)</span></span>
              <input type="text" name="origin_ip" value="${esc(saas.origin_ip || '')}" placeholder="this server's public IPv6 or IPv4">
              <span class="help">If set, the proxied fallback-origin DNS record (A/AAAA) is created for you. Leave blank to create it by hand.</span></label>
          </div>
          <label class="field"><span class="lbl">API token ${saas.has_token ? '<span style="color:var(--good)">✓ stored - leave blank to keep</span>' : ''}</span>
            <input type="password" name="token" placeholder="${saas.has_token ? '•••••••• stored (type to replace)' : 'Cloudflare API token'}">
            <span class="help">Stored encrypted. Scope: Zone · SSL and Certificates · Edit <b>and</b> Zone · DNS · Edit for your zone.</span></label>
          <div style="display:flex;gap:.6rem;flex-wrap:wrap">
            <button type="button" class="btn" id="saastest">Test token &amp; zone</button>
            <button type="submit" class="btn primary">Save</button>
          </div>
        </form>
        ${(saas.hostnames && saas.hostnames.length) ? `<div class="tbl-scroll" style="margin-top:1rem"><table class="tbl">
          <tr><th>Custom domain</th><th>Site</th><th>Status</th><th>CNAME target</th></tr>${saasRows}</table></div>`
          : `<div class="empty" style="margin-top:1rem">No custom domains registered yet. When a user adds a real domain to a site, it appears here.</div>`}
      </div>`;

    const c = h(`
      <div>
        <div class="page-head"><h1>Cloudflare - DDoS protection</h1>
          <div class="sub">Put this platform's domain and its free per-site subdomains behind Cloudflare. Once the DNS is proxied, Cloudflare's always-on DDoS protection shields <b>every</b> site automatically - users do nothing.</div></div>

        ${!st.host_is_real_domain ? `<div class="card" style="border-color:#5a3a12">
          <h2 style="color:var(--warn)">⚠ A real domain is required</h2>
          <p style="color:var(--ink-2);margin:.2rem 0 0">
            <code class="code">PUBLIC_HOST</code> is currently <b>${esc(st.public_host)}</b>. Cloudflare can only
            proxy a real domain name - it can't sit in front of a bare IP address or an
            <code class="code">.sslip.io</code> hostname. Point <code class="code">PUBLIC_HOST</code>
            (and optionally <code class="code">SITE_BASE_DOMAIN</code>) at a domain you've added to
            Cloudflare, restart, then follow the steps below.</p>
        </div>` : ''}

        <div class="card">
          <h2>Status ${liveBadge}</h2>
          <div class="kv">
            <span class="k">Platform domain</span><span class="v">${esc(st.public_host)} ${st.host_is_real_domain ? '<span style="color:var(--good)">✓ real domain</span>' : '<span style="color:var(--warn)">not a real domain</span>'}</span>
            <span class="k">Free subdomains</span><span class="v"><code class="code">${esc(wildcard)}</code></span>
            <span class="k">Trust Cloudflare headers</span><span class="v">
              <label style="display:inline-flex;align-items:center;gap:.5rem;cursor:pointer">
                <input type="checkbox" id="cftrust" style="width:auto" ${st.trust ? 'checked' : ''} ${st.env_forced_off ? 'disabled' : ''}>
                <span>${st.trust ? 'On - real visitor IP recovered from CF-Connecting-IP' : 'Off - using the direct socket address'}</span>
              </label>
              ${st.env_forced_off ? '<span class="help">Forced off by <code class="code">TRUST_CLOUDFLARE=0</code>.</span>' : '<span class="help">Only honored when the connection actually comes from a Cloudflare IP, so it cannot be spoofed. Safe to leave on.</span>'}
            </span>
            <span class="k">Cloudflare IP ranges</span><span class="v">${st.count} ranges · source: ${esc(st.source)}${st.fetched_at ? ` · refreshed ${new Date(st.fetched_at).toLocaleDateString()}` : ''}
              <button class="btn small" id="cfrefresh" style="margin-left:.5rem">↻ Refresh from Cloudflare</button></span>
            <span class="k">Requests seen</span><span class="v">${seenVia.toLocaleString()} via Cloudflare · ${st.seen.direct.toLocaleString()} direct${lastVia ? ` · last via CF ${esc(lastVia)}` : ''}</span>
          </div>
        </div>

        <div class="card">
          <h2>Set it up (once, in your Cloudflare dashboard)</h2>
          <ol style="color:var(--ink-2);font-size:.92rem;line-height:1.9;margin:0;padding-left:1.2rem">
            <li><b>DNS records - proxied.</b> In Cloudflare → <i>DNS → Records</i> for <b>${esc(st.public_host)}</b>, make sure these exist with <b>Proxy status: Proxied (orange cloud)</b>:
              <ul style="margin:.3rem 0;padding-left:1.1rem">
                <li><code class="code">A</code> / <code class="code">AAAA</code> &nbsp;<b>${esc(st.public_host)}</b> → your server's public IPv4 / IPv6</li>
                <li><code class="code">A</code> / <code class="code">AAAA</code> &nbsp;<b>${esc(wildcard)}</b> → the same server IPs &nbsp;<span style="color:var(--ink-3)">(this is what protects every free <code class="code">&lt;site&gt;.${esc(st.site_base_domain)}</code> link)</span></li>
              </ul>
              The orange cloud is the whole thing - a proxied record automatically gets Cloudflare's unmetered L3/4 + HTTP DDoS protection. A grey cloud (DNS-only) does <b>not</b>.</li>
            <li><b>SSL/TLS mode = Full.</b> Cloudflare → <i>SSL/TLS → Overview</i> → <b>Full</b>. This server already answers HTTPS on port ${st.tls_port} (its Let's Encrypt / default cert), so Cloudflare↔origin stays encrypted. <span style="color:var(--ink-3)">(Avoid "Flexible" - it leaves the origin leg unencrypted.)</span></li>
            <li><b>Wildcard certificate.</b> Cloudflare's free Universal SSL covers <code class="code">${esc(st.site_base_domain)}</code> and one level of wildcard (<code class="code">${esc(wildcard)}</code>). If your free-subdomain base is deeper than one label, enable <i>Advanced Certificate Manager</i> for the wildcard.</li>
            <li><b>That's it.</b> Reload a site over <code class="code">https://&lt;site&gt;.${esc(st.site_base_domain)}${esc(tlsSuffix)}</code>. When traffic starts arriving through Cloudflare the <b>Status</b> badge above flips to <span style="color:var(--good)">active</span>. Optionally turn on <i>Security → Bots → Bot Fight Mode</i> and add a rate-limiting rule.</li>
          </ol>
        </div>

        <div class="card">
          <h2>What this does &amp; doesn't cover</h2>
          <p style="color:var(--ink-2);font-size:.9rem;margin:.2rem 0 .6rem">
            Cloudflare proxies <b>HTTP/HTTPS websites</b> on the standard ports, so it protects the public sites served by the edge proxy. It does <b>not</b> front:</p>
          <ul style="color:var(--ink-2);font-size:.9rem;line-height:1.8;margin:0;padding-left:1.2rem">
            <li>the <b>dashboard/API</b> (port ${st.proxy_port === 80 ? '3000' : '3000'}), <b>SFTP</b>, and <b>WireGuard</b> - those are non-HTTP or admin-only; leave them off Cloudflare (or use a Cloudflare Tunnel separately).</li>
            <li><b>a site's dedicated IPv6 hit directly</b> - pointing an <code class="code">AAAA</code> straight at a site's own address bypasses Cloudflare. For a domain you want protected, CNAME/point it at the Cloudflare-proxied name instead of the raw IPv6.</li>
          </ul>
          <p style="color:var(--ink-3);font-size:.85rem;margin:.6rem 0 0">Users' <i>own</i> custom domains are handled separately by <b>Cloudflare for SaaS</b> below - the platform registers each one and hands the user a single CNAME so their domain routes through Cloudflare too.</p>
        </div>

        ${saasHtml}
      </div>`);

    const main = shell('admin/cloudflare', c);

    main.querySelector('#cftrust')?.addEventListener('change', async (e) => {
      try {
        await api('/cloudflare', { method: 'PATCH', body: { trust: e.target.checked } });
        toast(`Cloudflare header trust ${e.target.checked ? 'enabled' : 'disabled'}`, 'ok');
        pageCloudflare();
      } catch (err) { oops(err); e.target.checked = !e.target.checked; }
    });
    main.querySelector('#cfrefresh')?.addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = '↻ Refreshing…';
      try {
        const r = await api('/cloudflare/refresh', { method: 'POST' });
        toast(`Ranges refreshed - ${r.v4count} IPv4 · ${r.v6count} IPv6`, 'ok');
        pageCloudflare();
      } catch (err) { oops(err); e.target.disabled = false; e.target.textContent = '↻ Refresh from Cloudflare'; }
    });

    main.querySelector('#saasf')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const bodyData = {
        enabled: form.enabled.checked, zone_id: form.zone_id.value,
        account_id: form.account_id.value, origin_ip: form.origin_ip.value,
        fallback_origin: form.fallback_origin.value,
      };
      if (form.token.value) bodyData.token = form.token.value;
      try {
        const r = await api('/cloudflare/saas', { method: 'PATCH', body: bodyData });
        toast(r.note || 'Cloudflare for SaaS saved', r.note ? '' : 'ok');
        pageCloudflare();
      } catch (err) { oops(err); }
    });
    main.querySelector('#saastest')?.addEventListener('click', async (e) => {
      const form = main.querySelector('#saasf');
      e.target.disabled = true;
      try {
        const r = await api('/cloudflare/saas/test', { method: 'POST', body: { token: form.token.value, zone_id: form.zone_id.value, account_id: form.account_id.value } });
        toast(`✓ Zone "${r.zone_name}" (${r.zone_status})${r.account_name ? ` · account "${r.account_name}"` : ''}`, 'ok');
      } catch (err) { oops(err); }
      finally { e.target.disabled = false; }
    });
  }

  // ── billing (Stripe, pay per site) ─────────────────────────────
  async function pageBilling() {
    const c = h(`<div>
      <div class="page-head"><h1>Billing</h1><div class="sub">Your plan and subscription.</div></div>
      <div class="card"><div id="billbody" class="empty">Loading…</div></div>
    </div>`).firstElementChild;
    const main = shell('billing', c);
    const box = () => main.querySelector('#billbody');
    // Coming back from Checkout: Stripe redirects immediately, but the webhook
    // that records the subscription can land a moment later - so poll briefly
    // instead of telling the customer they aren't subscribed.
    let justPaid = hashQuery().get('checkout') === 'success';
    if (hashQuery().get('checkout') === 'cancelled') {
      toast('Checkout cancelled - nothing was charged.', '');
      history.replaceState(null, '', '#/billing');
    }
    let waited = 0;
    const load = async () => {
      try {
        let b = await api('/billing');
        // Don't rely on the webhook: ask the server to read the subscription
        // straight from Stripe. Works even when Stripe can't reach this panel.
        if (justPaid && !b.subscribed) {
          await api('/billing/sync', { method: 'POST' }).catch(() => {});
          b = await api('/billing');
        }
        if (justPaid && !b.subscribed && waited < 15000) {
          const el = box(); el.classList.add('empty');
          el.textContent = 'Confirming your subscription with Stripe…';
          waited += 2000;
          setTimeout(load, 2000);
          return;
        }
        if (justPaid && b.subscribed) {
          toast('Subscription active - you can create your sites now 🎉', 'ok');
          history.replaceState(null, '', '#/billing');
          justPaid = false;
        } else if (justPaid) {
          // Payment went through but we still can't see it. Say so plainly -
          // showing a bare "Subscribe" button here invites paying twice.
          justPaid = false;
          history.replaceState(null, '', '#/billing');
          const el = box(); el.classList.remove('empty');
          el.innerHTML = `<div class="first-user-banner" style="border-color:rgba(255,201,120,.3);background:rgba(255,201,120,.1);color:#ffd9a3">
            ⚠ <b>We couldn't confirm your subscription yet.</b> If you completed the payment, <b>do not pay again</b> - it may just need a moment.
            <div style="margin-top:.7rem"><button class="btn" id="retry">Check again</button></div></div>`;
          el.querySelector('#retry').addEventListener('click', () => { justPaid = true; waited = 0; load(); });
          return;
        }
        render(b);
      } catch (e) { cardError(box(), e.message || 'Could not load billing', load); }
    };
    const render = (b) => {
      const el = box(); el.classList.remove('empty');
      if (!b.configured) {
        el.innerHTML = `<p style="color:var(--ink-2)">Billing isn't set up on this server - everything is free with no limits. <span style="color:var(--ink-3)">(Admin: configure the Stripe keys in <code class="code">.env</code> to enable per-site billing.)</span></p>`;
        return;
      }
      if (b.subscribed) {
        const ord = (n) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
        el.innerHTML = `
          ${b.cancelling ? `<div class="first-user-banner" style="border-color:rgba(255,201,120,.3);background:rgba(255,201,120,.1);color:#ffd9a3">
            Your subscription is cancelled but <b>stays active until ${b.renews_at ? fmtDate(b.renews_at) : 'the end of the paid period'}</b> - your sites keep running until then. You can resume any time from the portal.</div>` : ''}
          <div class="kv" style="margin-bottom:1rem">
            <span class="k">Plan</span><span class="v">Pay per site · ${esc(b.price_label)}</span>
            <span class="k">Status</span><span class="v">${esc(b.status || 'active')}${b.cancelling ? ' · cancels at period end' : ''}</span>
            <span class="k">Sites (billed)</span><span class="v">${b.sites_used}</span>
            <span class="k">Billing day</span><span class="v">${esc(ord(b.anchor_day))} of each month</span>
            ${b.renews_at ? `<span class="k">${b.cancelling ? 'Active until' : 'Next invoice'}</span><span class="v">${fmtDate(b.renews_at)}</span>` : ''}
          </div>
          ${b.sites_used === 0 ? `<div class="first-user-banner" style="border-color:rgba(79,227,166,.3);background:rgba(79,227,166,.1);color:#b6f5da">
            ✅ <b>You're all set.</b> Your subscription is active - create your first website to get it online. Each extra site is added to your bill automatically.
            <div style="margin-top:.7rem"><a class="btn primary" href="#/sites">Create your first site →</a></div></div>` : ''}
          <div style="display:flex;gap:.6rem;flex-wrap:wrap">
            <button class="btn" id="portal">Manage subscription</button>
            ${b.sites_used > 0 ? `<a class="btn" href="#/sites">Your sites</a>` : ''}
          </div>`;
        el.querySelector('#portal').addEventListener('click', async () => {
          try { const r = await api('/billing/portal', { method: 'POST' }); window.open(r.url, '_blank'); } catch (e) { oops(e); }
        });
        return;
      }
      el.innerHTML = `
        <p style="color:var(--ink-2)">Hosting is <b>pay per site</b> - <b>${esc(b.price_label)}</b>. Subscribe once; every website you create is added to your bill, and deleting one lowers it automatically.</p>
        <p style="color:var(--ink-3);font-size:.85rem">Billing runs on the <b>${esc(String(b.anchor_day))}${b.anchor_day === 1 ? 'st' : b.anchor_day === 2 ? 'nd' : b.anchor_day === 3 ? 'rd' : 'th'} of each month</b> - you only pay pro rata for the days until then. Cancel any time and your sites keep running until the end of the paid month.</p>
        ${b.status ? `<p style="color:var(--warn);font-size:.88rem">Your subscription is <b>${esc(b.status)}</b> - resubscribe below to keep hosting sites.</p>` : ''}
        <div style="display:flex;gap:.6rem;flex-wrap:wrap">
          <button class="btn primary" id="sub">Subscribe</button>
          <button class="btn" id="sync" title="Already paid? Fetch your subscription from Stripe.">↻ Already paid?</button>
          ${b.has_customer ? `<button class="btn" id="portal">Billing history</button>` : ''}
        </div>`;
      el.querySelector('#sync').addEventListener('click', async (e) => {
        e.target.disabled = true; e.target.textContent = 'Checking…';
        try {
          const r = await api('/billing/sync', { method: 'POST' });
          toast(r.found ? `Found a subscription (${r.status}).` : 'No subscription found for your account yet.', r.found ? 'ok' : '');
        } catch (err) { oops(err); }
        load();
      });
      el.querySelector('#sub').addEventListener('click', async (e) => {
        e.target.disabled = true;
        try { const r = await api('/billing/checkout', { method: 'POST' }); location.href = r.url; }
        catch (err) { oops(err); e.target.disabled = false; }
      });
      el.querySelector('#portal')?.addEventListener('click', async () => {
        try { const r = await api('/billing/portal', { method: 'POST' }); window.open(r.url, '_blank'); } catch (e) { oops(e); }
      });
    };
    load();
  }

  // ── account (self-service: two-factor) ─────────────────────────
  async function pageAccount() {
    const c = h(`<div>
      <div class="page-head"><h1>Account</h1><div class="sub">Security for ${esc(me.email)}.</div></div>
      <div class="card"><h2>Two-factor authentication</h2><div id="twofa" class="empty">Loading…</div></div>
    </div>`).firstElementChild;
    const main = shell('', c);
    const box = () => main.querySelector('#twofa');
    const load = () => api('/auth/2fa').then(render2fa).catch(e => cardError(box(), e.message || 'Could not load', load));
    const render2fa = (st) => {
      const b = box(); b.classList.remove('empty');
      if (st.enabled) {
        b.innerHTML = `<p style="color:var(--good)">✓ Two-factor is <b>on</b> - ${st.backup_codes_left} backup code(s) left.</p>
          <label class="field" style="max-width:280px"><span class="lbl">Password (to turn it off)</span><input type="password" id="dpw"></label>
          <button class="btn danger" id="disable" style="margin-top:.4rem">Disable 2FA</button>`;
        b.querySelector('#disable').addEventListener('click', async () => {
          try { await api('/auth/2fa/disable', { method: 'POST', body: { password: b.querySelector('#dpw').value } }); toast('Two-factor disabled', 'ok'); load(); }
          catch (err) { oops(err); }
        });
        return;
      }
      b.innerHTML = `<p style="color:var(--ink-2)">Add a second factor with an authenticator app (Google Authenticator, 1Password, Aegis…).</p>
        <button class="btn primary" id="setup">Set up 2FA</button>`;
      b.querySelector('#setup').addEventListener('click', async () => {
        try {
          const s = await api('/auth/2fa/setup', { method: 'POST' });
          b.innerHTML = `<p style="color:var(--ink-2)">Add this to your authenticator (paste the <b>secret</b>, or the setup URL), then enter the 6-digit code to confirm.</p>
            <div class="kv">
              <span class="k">Secret</span><span class="v mono">${esc(s.secret)} <button class="cp" onclick="_copy('${esc(s.secret)}')">⧉</button></span>
              <span class="k">Setup URL</span><span class="v mono" style="word-break:break-all">${esc(s.otpauth)} <button class="cp" onclick="_copy('${esc(s.otpauth)}')">⧉</button></span>
            </div>
            <label class="field" style="max-width:220px;margin-top:.8rem"><span class="lbl">6-digit code</span><input type="text" id="ecode" inputmode="numeric" placeholder="123456"></label>
            <button class="btn primary" id="enable">Enable</button>`;
          b.querySelector('#enable').addEventListener('click', async () => {
            try {
              const r = await api('/auth/2fa/enable', { method: 'POST', body: { code: b.querySelector('#ecode').value } });
              b.innerHTML = `<p style="color:var(--good)">✓ Two-factor is now on. <b>Save these backup codes</b> somewhere safe - each works once if you lose your device:</p>
                <div class="copybox"><code style="white-space:pre-wrap;line-height:1.8">${r.backup_codes.map(esc).join('   ')}</code>
                  <button class="cp" onclick="_copy('${r.backup_codes.join(' ')}')">⧉</button></div>
                <button class="btn" id="done" style="margin-top:.6rem">Done</button>`;
              b.querySelector('#done').addEventListener('click', load);
            } catch (err) { oops(err); }
          });
        } catch (err) { oops(err); }
      });
    };
    load();
  }

  // ── router ──────────────────────────────────────────────────────
  async function render() {
    // A password-reset link always shows the reset form, logged in or not.
    const resetMatch = location.hash.match(/^#\/reset\/([a-f0-9]{16,})/i);
    if (resetMatch) {
      const s = await api('/auth/setup-state').catch(() => ({ hasUsers: true }));
      return renderAuth(s.hasUsers, resetMatch[1], s.turnstile_site_key);
    }
    if (!me) {
      try { const r = await api('/auth/me'); me = r.user; }
      catch {
        const s = await api('/auth/setup-state').catch(() => ({ hasUsers: true }));
        return renderAuth(s.hasUsers, null, s.turnstile_site_key);
      }
    }
    // Strip any query string: "#/billing?checkout=success" is still the billing
    // route (without this it matched nothing and fell through to overview).
    const route = location.hash.replace(/^#\//, '').split('?')[0] || 'overview';
    try {
      if (route === 'overview') await pageOverview();
      else if (route === 'sites') await pageSites();
      else if (route.startsWith('sites/')) await pageSiteDetail(route.split('/')[1]);
      else if (route === 'traffic') await pageTraffic();
      else if (route === 'certs') await pageCerts();
      else if (route === 'network' && me.role === 'admin') await pageNetwork();
      else if (route === 'admin/users' && me.role === 'admin') await pageUsers();
      else if (route === 'admin/cloudflare' && me.role === 'admin') await pageCloudflare();
      else if (route === 'admin/system' && me.role === 'admin') await pageSystem();
      else if (route === 'account') await pageAccount();
      else if (route === 'billing') await pageBilling();
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
