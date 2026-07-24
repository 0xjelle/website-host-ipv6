// GitHub webhook receiver: verifies X-Hub-Signature-256 against the site's
// webhook secret and triggers a deploy when the configured branch is pushed.
const express = require('express');
const crypto = require('crypto');
const { db, logActivity } = require('../db');
const deployer = require('../services/deployer');

const router = express.Router();

router.post('/github/:siteId', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.siteId);
  if (!site) return res.status(404).json({ error: 'Unknown site' });

  const sig = req.headers['x-hub-signature-256'];
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  const expected = 'sha256=' + crypto.createHmac('sha256', site.webhook_secret).update(raw).digest('hex');
  if (!sig || sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const event = req.headers['x-github-event'];
  if (event === 'ping') return res.json({ ok: true, msg: 'pong - webhook configured correctly 🎉' });
  if (event !== 'push') return res.json({ ok: true, msg: `ignored event: ${event}` });

  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); }
  catch { return res.status(400).json({ error: 'Invalid JSON payload' }); }

  const branch = (payload.ref || '').replace('refs/heads/', '');
  if (branch !== site.repo_branch) {
    return res.json({ ok: true, msg: `ignored push to "${branch}" (deploying only "${site.repo_branch}")` });
  }
  if (!site.auto_deploy) return res.json({ ok: true, msg: 'auto-deploy is disabled for this site' });

  const head = payload.head_commit || {};
  logActivity(site.user_id, 'deploy.webhook', `"${site.name}" push ${String(head.id || '').slice(0, 7)} - ${head.message || ''}`.trim());
  deployer.deploy(site.id, 'webhook', {
    sha: head.id ? String(head.id).slice(0, 7) : null,
    message: head.message || null,
  }).then(result => res.json({ ok: true, deploy: result }));
});

module.exports = router;
