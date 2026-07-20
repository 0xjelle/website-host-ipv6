// SSL certificate overview across all of the user's sites (admins: all).
const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');
const acme = require('../services/acme');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const rows = req.user.role === 'admin'
    ? db.prepare('SELECT s.*, u.email AS owner_email FROM sites s JOIN users u ON u.id = s.user_id ORDER BY s.name').all()
    : db.prepare('SELECT * FROM sites WHERE user_id = ? ORDER BY name').all(req.user.id);

  const certs = rows.map((s) => {
    const st = acme.readStatus(s.id);
    const domains = JSON.parse(s.domains || '[]');
    const eligible = domains.some(d => !/\.sslip\.io$/i.test(d) && !/^\d+\.\d+\.\d+\.\d+$/.test(d));
    let state = st.status; // active | pending | failed | none
    if (state === 'active' && st.daysLeft !== null) {
      if (st.daysLeft < 0) state = 'expired';
      else if (st.daysLeft <= 20) state = 'expiring';
    }
    if (state === 'none' && !eligible) state = 'ineligible';
    return {
      site_id: s.id, name: s.name, owner_email: s.owner_email || null,
      domains, state,
      not_after: st.not_after, daysLeft: st.daysLeft,
      issuer: st.issuer, auto_renew: st.auto_renew, last_error: st.last_error,
    };
  });

  const summary = {
    active: certs.filter(c => c.state === 'active').length,
    expiring: certs.filter(c => c.state === 'expiring').length,
    expired: certs.filter(c => c.state === 'expired').length,
    pending: certs.filter(c => c.state === 'pending').length,
    none: certs.filter(c => c.state === 'none').length,
  };
  res.json({ available: acme.available(), summary, certs });
});

module.exports = router;
