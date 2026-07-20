// Public status page data — no auth. Lists every site and whether it is
// currently serving, for a built-in status dashboard. Only exposes the
// site name, type and public URL (no IPs, owners or internal ports).
const express = require('express');
const { db } = require('../db');
const config = require('../config');
const { checkHealth } = require('../services/health');

const router = express.Router();

router.get('/', async (req, res) => {
  const rows = db.prepare("SELECT * FROM sites ORDER BY name").all();
  const sites = await Promise.all(rows.map(async (s) => {
    const h = await checkHealth(s);
    return {
      name: s.name,
      type: s.type,
      url: `http://${s.slug}.${config.siteBaseDomain}${config.proxyPort === 80 ? '' : ':' + config.proxyPort}`,
      online: !!h.online,
      degraded: s.status === 'deploying',
      reason: h.reason || null,
      ms: h.ms || null,
    };
  }));
  const up = sites.filter(s => s.online).length;
  res.json({
    generated: new Date().toISOString(),
    overall: sites.length === 0 ? 'none' : (up === sites.length ? 'operational' : (up === 0 ? 'major' : 'partial')),
    counts: { total: sites.length, up, down: sites.length - up },
    sites,
  });
});

module.exports = router;
