// Where WireGuard interface configs live.
//
// Ubuntu's wireguard-tools ships an AppArmor profile that only lets
// `wg-quick` read configs under /etc/wireguard/. So we write the live
// interface configs there (root, mode 600) and invoke wg-quick by bare
// interface name. A copy is kept in the data dir for the dashboard's
// "download" buttons and for hosts without a writable /etc/wireguard.
const fs = require('fs');
const path = require('path');
const config = require('./../config');

const ETC = '/etc/wireguard';

function etcUsable() {
  try {
    fs.mkdirSync(ETC, { recursive: true });
    fs.accessSync(ETC, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Write an interface config so wg-quick (under AppArmor) can read it.
// Returns { arg } - the argument to pass to wg-quick/wg: the bare
// interface name when using /etc/wireguard, otherwise the full path.
function writeIface(iface, contents) {
  // always keep a data-dir copy (downloads, fallback)
  const dataPath = path.join(config.wgDir, `${iface}.conf`);
  try { fs.unlinkSync(dataPath); } catch {}
  fs.writeFileSync(dataPath, contents, { mode: 0o600 });

  if (etcUsable()) {
    const etcPath = path.join(ETC, `${iface}.conf`);
    // Replace any symlink (e.g. one the installer made) with a real file,
    // so wg-quick's readlink -f doesn't resolve back into the data dir
    // where AppArmor would deny it.
    try { fs.unlinkSync(etcPath); } catch {}
    fs.writeFileSync(etcPath, contents, { mode: 0o600 });
    return { arg: iface, path: etcPath, dataPath };
  }
  return { arg: dataPath, path: dataPath, dataPath };
}

module.exports = { writeIface, dataPath: (iface) => path.join(config.wgDir, `${iface}.conf`) };
