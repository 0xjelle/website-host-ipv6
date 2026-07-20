// Is a site actually serving right now? node: the app answers on its
// internal port; static: it's live and has files to serve. Results are
// cached briefly so the public status page can't be used to hammer apps.
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const cache = new Map(); // siteId -> { at, result }
const TTL = 15_000;

function siteRoot(site) { return path.join(config.sitesDir, String(site.id), 'current'); }

function probe(site) {
  return new Promise((resolve) => {
    if (site.status !== 'live') return resolve({ online: false, reason: site.status });
    if (site.type === 'node') {
      const started = Date.now();
      const req = http.get({ host: '127.0.0.1', port: site.app_port, path: '/', timeout: 2000 }, (r) => {
        r.destroy();
        resolve({ online: (r.statusCode || 0) < 500, status: r.statusCode, ms: Date.now() - started });
      });
      req.on('error', () => resolve({ online: false, reason: 'not responding' }));
      req.on('timeout', () => { req.destroy(); resolve({ online: false, reason: 'timeout' }); });
    } else {
      const dir = path.join(siteRoot(site), site.static_dir || '');
      // async so a large directory can't block the event loop
      fs.promises.access(path.join(dir, 'index.html'))
        .then(() => resolve({ online: true }))
        .catch(() => fs.promises.readdir(dir)
          .then(list => resolve({ online: list.length > 0, reason: list.length ? undefined : 'no files to serve' }))
          .catch(() => resolve({ online: false, reason: 'no files to serve' })));
    }
  });
}

async function checkHealth(site) {
  const c = cache.get(site.id);
  if (c && Date.now() - c.at < TTL) return c.result;
  const result = await probe(site);
  cache.set(site.id, { at: Date.now(), result });
  return result;
}

module.exports = { checkHealth };
