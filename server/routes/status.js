// Public status page data — no auth. Lists every site and whether it is
// currently serving, for a built-in status dashboard. Only exposes the
// site name, type and public URL (no IPs, owners or internal ports).
const express = require('express');
const { db } = require('../db');
const config = require('../config');
const { checkHealth } = require('../services/health');
const acme = require('../services/acme');

const router = express.Router();

function sslFor(s) {
  const st = acme.readStatus(s.id);
  const domains = JSON.parse(s.domains || '[]');
  if (st.status === 'active') {
    return { state: st.daysLeft !== null && st.daysLeft <= 20 ? 'expiring' : 'secure', daysLeft: st.daysLeft, not_after: st.not_after };
  }
  if (st.status === 'pending') return { state: 'pending' };
  // eligible for a cert but none yet
  const eligible = domains.some(d => !/\.sslip\.io$/i.test(d) && !/^\d+\.\d+\.\d+\.\d+$/.test(d));
  return { state: eligible ? 'none' : 'n/a' };
}

router.get('/', async (req, res) => {
  const rows = db.prepare("SELECT * FROM sites ORDER BY name").all();
  const sites = await Promise.all(rows.map(async (s) => {
    const h = await checkHealth(s);
    const domains = JSON.parse(s.domains || '[]');
    const ssl = sslFor(s);
    const scheme = ssl.state === 'secure' || ssl.state === 'expiring' ? 'https' : 'http';
    const host = domains[0] || `${s.slug}.${config.siteBaseDomain}`;
    const port = scheme === 'http' && config.proxyPort !== 80 ? ':' + config.proxyPort : '';
    return {
      name: s.name,
      type: s.type,
      url: `${scheme}://${host}${port}`,
      online: !!h.online,
      degraded: s.status === 'deploying',
      reason: h.reason || null,
      ms: h.ms || null,
      ssl,
    };
  }));
  const up = sites.filter(s => s.online).length;
  const sslCounts = {
    secure: sites.filter(s => s.ssl.state === 'secure').length,
    expiring: sites.filter(s => s.ssl.state === 'expiring').length,
    none: sites.filter(s => s.ssl.state === 'none' || s.ssl.state === 'pending').length,
  };
  res.json({
    generated: new Date().toISOString(),
    overall: sites.length === 0 ? 'none' : (up === sites.length ? 'operational' : (up === 0 ? 'major' : 'partial')),
    counts: { total: sites.length, up, down: sites.length - up },
    ssl: sslCounts,
    sites,
  });
});

module.exports = router;
