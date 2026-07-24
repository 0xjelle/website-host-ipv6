// Built-in SFTP server. Users authenticate with their account email +
// password and get a virtual filesystem where each of their sites is a
// top-level folder mapping to that site's document root
// (data/sites/<id>/current). Everything is sandboxed per user and per site.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { db, logActivity } = require('../db');

let ssh2;
try { ssh2 = require('ssh2'); } catch { ssh2 = null; }

const { STATUS_CODE, OPEN_MODE } = ssh2 ? ssh2.utils.sftp : {};

function hostKey() {
  const p = path.join(config.dataDir, 'ssh_host_rsa_key');
  if (!fs.existsSync(p)) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    fs.writeFileSync(p, privateKey, { mode: 0o600 });
  }
  return fs.readFileSync(p);
}

const siteDir = (id) => path.join(config.sitesDir, String(id), 'current');

// Resolve a virtual path into what it represents.
//  • jailed session (logged in as email+slug): "/" IS that one site's document
//    root - the user never sees their other sites.
//  • unjailed session (logged in as just the email): "/" lists their sites and
//    "/slug/..." is a path inside a site.
function resolve(userId, vpath, jail) {
  const parts = path.posix.normalize('/' + vpath).split('/').filter(Boolean);
  const within = (root, rel) => {
    fs.mkdirSync(root, { recursive: true });
    const real = path.normalize(path.join(root, rel));
    if (real !== path.normalize(root) && !real.startsWith(path.normalize(root) + path.sep)) return null;
    return real;
  };
  if (jail) {
    const root = siteDir(jail.id);
    const real = within(root, parts.join('/'));
    if (real === null) return { kind: 'denied' };
    // In a jail the site root is the top level, so writing there is allowed
    // (atSiteRoot only blocks writes at the site-listing level, which a jail
    // doesn't have).
    return { kind: 'site', site: jail, root, real, atSiteRoot: false };
  }
  if (parts.length === 0) return { kind: 'root' };
  const slug = parts[0];
  const site = db.prepare('SELECT * FROM sites WHERE slug = ? AND user_id = ?').get(slug, userId);
  if (!site) return { kind: 'missing' };
  const root = siteDir(site.id);
  const real = within(root, parts.slice(1).join('/'));
  if (real === null) return { kind: 'denied' };
  return { kind: 'site', site, root, real, atSiteRoot: parts.length === 1 };
}

function attrsFor(stat, isDir) {
  return {
    mode: (isDir ?? stat.isDirectory()) ? 0o40755 : 0o100644,
    uid: 0, gid: 0,
    size: stat ? stat.size : 0,
    atime: stat ? Math.floor(stat.atimeMs / 1000) : Date.now() / 1000,
    mtime: stat ? Math.floor(stat.mtimeMs / 1000) : Date.now() / 1000,
  };
}

function start() {
  if (!ssh2) { console.log('SFTP disabled (ssh2 module not installed)'); return; }
  const { Server } = ssh2;

  const server = new Server({ hostKeys: [hostKey()] }, (client) => {
    let userId = null;
    let jail = null; // when set, the session is confined to this one site

    client.on('authentication', (ctx) => {
      if (ctx.method !== 'password') return ctx.reject(['password']);
      // Username may be "email+slug" to confine the session to a single site.
      // Split on the LAST '+' and only treat the suffix as a site if it looks
      // like a slug - so plus-addressed emails (user+tag@x.com) still work.
      let username = (ctx.username || '').trim();
      let wantSlug = null;
      const plus = username.lastIndexOf('+');
      if (plus > 0 && /^[a-z0-9-]+$/.test(username.slice(plus + 1))) {
        wantSlug = username.slice(plus + 1);
        username = username.slice(0, plus);
      }
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(username.toLowerCase());
      if (!user || user.suspended || !bcrypt.compareSync(ctx.password || '', user.password_hash)) {
        return ctx.reject();
      }
      if (wantSlug) {
        const site = db.prepare('SELECT * FROM sites WHERE slug = ? AND user_id = ?').get(wantSlug, user.id);
        if (!site) return ctx.reject(); // asked for a site that isn't theirs
        jail = site;
      }
      userId = user.id;
      ctx.accept();
    });

    client.on('ready', () => {
      logActivity(userId, 'sftp.login', '');
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map();
          let counter = 0;
          const newHandle = (obj) => { const h = Buffer.from('h' + (counter++)); handles.set(h.toString(), obj); return h; };
          const S = STATUS_CODE;

          const denyOrMissing = (reqid, r) =>
            sftp.status(reqid, r.kind === 'denied' ? S.PERMISSION_DENIED : S.NO_SUCH_FILE);

          sftp.on('REALPATH', (reqid, p) => {
            const norm = path.posix.normalize('/' + p).replace(/\/+$/, '') || '/';
            sftp.name(reqid, [{ filename: norm, longname: norm, attrs: attrsFor(null, true) }]);
          });

          const doStat = (reqid, p) => {
            const r = resolve(userId, p, jail);
            if (r.kind === 'root') return sftp.attrs(reqid, attrsFor(null, true));
            if (r.kind !== 'site') return denyOrMissing(reqid, r);
            fs.stat(r.real, (err, st) => err ? sftp.status(reqid, S.NO_SUCH_FILE) : sftp.attrs(reqid, attrsFor(st)));
          };
          sftp.on('STAT', doStat);
          sftp.on('LSTAT', doStat);

          sftp.on('FSTAT', (reqid, h) => {
            const o = handles.get(h.toString());
            if (!o) return sftp.status(reqid, S.FAILURE);
            fs.fstat(o.fd ?? -1, (err, st) => err ? sftp.status(reqid, S.FAILURE) : sftp.attrs(reqid, attrsFor(st)));
          });

          sftp.on('OPENDIR', (reqid, p) => {
            const r = resolve(userId, p, jail);
            if (r.kind === 'root') return sftp.handle(reqid, newHandle({ dir: 'root', read: false }));
            if (r.kind !== 'site') return denyOrMissing(reqid, r);
            if (!fs.existsSync(r.real) || !fs.statSync(r.real).isDirectory()) return sftp.status(reqid, S.NO_SUCH_FILE);
            sftp.handle(reqid, newHandle({ dir: r.real, read: false }));
          });

          sftp.on('READDIR', async (reqid, h) => {
            const o = handles.get(h.toString());
            if (!o || !o.dir) return sftp.status(reqid, S.FAILURE);
            if (o.read) return sftp.status(reqid, S.EOF);
            o.read = true;
            let names = [];
            if (o.dir === 'root') {
              const sites = db.prepare('SELECT slug FROM sites WHERE user_id = ? ORDER BY slug').all(userId);
              names = sites.map(s => ({ filename: s.slug, longname: `drwxr-xr-x 1 owner owner 0 ${s.slug}`, attrs: attrsFor(null, true) }));
            } else {
              // async so listing a huge directory doesn't block the event loop
              const list = await fs.promises.readdir(o.dir).catch(() => []);
              for (const name of list) {
                try {
                  const st = await fs.promises.stat(path.join(o.dir, name));
                  names.push({ filename: name, longname: `${st.isDirectory() ? 'd' : '-'}rw-r--r-- 1 owner owner ${st.size} ${name}`, attrs: attrsFor(st) });
                } catch {}
              }
            }
            sftp.name(reqid, names);
          });

          sftp.on('OPEN', (reqid, filename, flags, attrs) => {
            const r = resolve(userId, filename, jail);
            if (r.kind !== 'site' || r.atSiteRoot) return denyOrMissing(reqid, r);
            const read = !!(flags & OPEN_MODE.READ);
            const write = !!(flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC));
            let fsFlags = 'r';
            if (write && (flags & OPEN_MODE.APPEND)) fsFlags = 'a';
            else if (write) fsFlags = 'w';
            if (write) fs.mkdirSync(path.dirname(r.real), { recursive: true });
            fs.open(r.real, fsFlags, (err, fd) => {
              if (err) return sftp.status(reqid, err.code === 'ENOENT' ? S.NO_SUCH_FILE : S.FAILURE);
              sftp.handle(reqid, newHandle({ fd, path: r.real, write, siteId: r.site.id }));
            });
          });

          sftp.on('READ', (reqid, h, offset, length) => {
            const o = handles.get(h.toString());
            if (!o || o.fd == null) return sftp.status(reqid, S.FAILURE);
            const buf = Buffer.alloc(length);
            fs.read(o.fd, buf, 0, length, offset, (err, bytes) => {
              if (err) return sftp.status(reqid, S.FAILURE);
              if (bytes === 0) return sftp.status(reqid, S.EOF);
              sftp.data(reqid, buf.subarray(0, bytes));
            });
          });

          sftp.on('WRITE', (reqid, h, offset, data) => {
            const o = handles.get(h.toString());
            if (!o || o.fd == null) return sftp.status(reqid, S.FAILURE);
            fs.write(o.fd, data, 0, data.length, offset, (err) => sftp.status(reqid, err ? S.FAILURE : S.OK));
          });

          sftp.on('CLOSE', (reqid, h) => {
            const o = handles.get(h.toString());
            handles.delete(h.toString());
            if (o && o.fd != null) fs.close(o.fd, () => {});
            if (o && o.write) { try { db.prepare("UPDATE sites SET status='live' WHERE id=? AND status IN ('new','failed','stopped')").run(o.siteId); } catch {} }
            sftp.status(reqid, S.OK);
          });

          const guardWrite = (reqid, p, fn) => {
            const r = resolve(userId, p, jail);
            if (r.kind !== 'site' || r.atSiteRoot) return denyOrMissing(reqid, r);
            fn(r);
          };
          sftp.on('MKDIR', (reqid, p) => guardWrite(reqid, p, r => fs.mkdir(r.real, { recursive: true }, e => sftp.status(reqid, e && e.code !== 'EEXIST' ? S.FAILURE : S.OK))));
          sftp.on('RMDIR', (reqid, p) => guardWrite(reqid, p, r => fs.rm(r.real, { recursive: true, force: true }, e => sftp.status(reqid, e ? S.FAILURE : S.OK))));
          sftp.on('REMOVE', (reqid, p) => guardWrite(reqid, p, r => fs.unlink(r.real, e => sftp.status(reqid, e ? S.FAILURE : S.OK))));
          sftp.on('RENAME', (reqid, oldP, newP) => {
            const a = resolve(userId, oldP, jail), b = resolve(userId, newP, jail);
            if (a.kind !== 'site' || b.kind !== 'site' || a.atSiteRoot || b.atSiteRoot) return sftp.status(reqid, S.PERMISSION_DENIED);
            fs.rename(a.real, b.real, e => sftp.status(reqid, e ? S.FAILURE : S.OK));
          });
          sftp.on('SETSTAT', (reqid) => sftp.status(reqid, S.OK));
          sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, S.OK));
        });
      });
    });

    client.on('error', () => {});
  });

  server.on('error', (e) => console.error('SFTP server error:', e.message));
  server.listen(config.sftpPort, '0.0.0.0', () => {
    console.log(`⬡ Hosting SFTP       → sftp://<account-email>@localhost:${config.sftpPort}`);
  });
}

module.exports = { start, available: !!ssh2 };
