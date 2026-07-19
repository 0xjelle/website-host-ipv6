#!/usr/bin/env bash
# ⬡ HexaHost installer for Ubuntu Server (20.04+) / Debian (11+).
#
# Usage (as root):
#   curl -fsSL https://raw.githubusercontent.com/0xjelle/website-host-ipv6/main/scripts/install.sh | sudo bash
#
# Optional environment overrides:
#   PUBLIC_HOST=host.example.com   public DNS name or IP of this server
#   APP_DIR=/opt/hexahost          install location
#   PROXY_PORT=80                  public port for hosted sites
#   ADMIN_PORT=3000                dashboard port
#   REPO_URL=…                     alternate git source
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/hexahost}"
REPO_URL="${REPO_URL:-https://github.com/0xjelle/website-host-ipv6}"
PROXY_PORT="${PROXY_PORT:-80}"
ADMIN_PORT="${ADMIN_PORT:-3000}"
export DEBIAN_FRONTEND=noninteractive

say()  { echo -e "\033[1;35m⬡\033[0m $*"; }
warn() { echo -e "\033[1;33m!\033[0m $*"; }

[ "$(id -u)" -eq 0 ] || { echo "Please run as root:  curl -fsSL …/install.sh | sudo bash"; exit 1; }

if ! command -v apt-get >/dev/null; then
  echo "This installer supports Ubuntu/Debian (apt). For other distros install"
  echo "git + node>=18 + wireguard-tools manually, then: git clone && npm install && npm start"
  exit 1
fi

. /etc/os-release 2>/dev/null || true
say "Installing HexaHost on ${PRETTY_NAME:-this system} → $APP_DIR"

# ── packages ────────────────────────────────────────────────────────
say "Installing packages (git, curl, wireguard, bird2)…"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates wireguard-tools bird2 >/dev/null

node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 18 ]; then
  say "Installing Node.js 22 (NodeSource)…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
say "Node $(node --version), npm $(npm --version)"

# ── fetch + build ───────────────────────────────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  say "Updating existing install…"
  git -C "$APP_DIR" pull --ff-only
else
  say "Cloning HexaHost…"
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
say "Installing dependencies…"
npm install --omit=dev --no-audit --no-fund --loglevel=error

# ── configuration ───────────────────────────────────────────────────
if [ ! -f "$APP_DIR/.env" ]; then
  DETECTED_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  HOST_VALUE="${PUBLIC_HOST:-${DETECTED_IP:-localhost}}"
  say "Writing .env (PUBLIC_HOST=$HOST_VALUE, sites on :$PROXY_PORT, dashboard on :$ADMIN_PORT)"
  sed -e "s|^JWT_SECRET=.*|JWT_SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')|" \
      -e "s|^PROXY_PORT=.*|PROXY_PORT=$PROXY_PORT|" \
      -e "s|^ADMIN_PORT=.*|ADMIN_PORT=$ADMIN_PORT|" \
      -e "s|^PUBLIC_HOST=.*|PUBLIC_HOST=$HOST_VALUE|" \
      .env.example > .env
  chmod 600 .env
else
  say "Keeping existing $APP_DIR/.env"
fi

# ── systemd service ─────────────────────────────────────────────────
sed "s|__APP_DIR__|$APP_DIR|g" scripts/hexahost.service > /etc/systemd/system/hexahost.service

SYSTEMD_UP=0
if [ -d /run/systemd/system ]; then
  SYSTEMD_UP=1
  say "Starting hexahost.service…"
  systemctl daemon-reload
  systemctl enable --now hexahost
  systemctl restart hexahost
else
  warn "systemd is not running (container?). Service file installed;"
  warn "start manually with:  cd $APP_DIR && npm start"
fi

# ── wireguard interface ─────────────────────────────────────────────
mkdir -p /etc/wireguard
# HexaHost writes/refreshes this file; wg-quick reads it through the symlink.
if [ ! -e /etc/wireguard/wg0.conf ]; then
  ln -s "$APP_DIR/data/wireguard/wg0.conf" /etc/wireguard/wg0.conf
fi
if [ "$SYSTEMD_UP" -eq 1 ]; then
  # wait for first boot to generate keys + wg0.conf, then bring the tunnel up
  for _ in $(seq 1 20); do [ -f "$APP_DIR/data/wireguard/wg0.conf" ] && break; sleep 1; done
  if [ -f "$APP_DIR/data/wireguard/wg0.conf" ]; then
    systemctl enable --now wg-quick@wg0 2>/dev/null \
      || warn "wg-quick@wg0 did not start (kernel module missing?) — tunnels will still be generated as configs."
  fi
fi

# ── bird2 (BGP over the tunnels) ────────────────────────────────────
mkdir -p /etc/bird
if [ -f /etc/bird/bird.conf ] && [ ! -L /etc/bird/bird.conf ]; then
  mv /etc/bird/bird.conf /etc/bird/bird.conf.dist
fi
ln -sf "$APP_DIR/data/bird/bird.conf" /etc/bird/bird.conf
if [ "$SYSTEMD_UP" -eq 1 ]; then
  for _ in $(seq 1 20); do [ -f "$APP_DIR/data/bird/bird.conf" ] && break; sleep 1; done
  if [ -f "$APP_DIR/data/bird/bird.conf" ]; then
    systemctl enable --now bird 2>/dev/null && systemctl restart bird 2>/dev/null \
      || warn "bird did not start — check 'journalctl -u bird'. BGP configs are still generated."
  fi
fi

# ── firewall ────────────────────────────────────────────────────────
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
  say "Opening firewall ports (ufw): $PROXY_PORT/tcp, $ADMIN_PORT/tcp, 51820/udp"
  ufw allow "$PROXY_PORT/tcp"  >/dev/null
  ufw allow "$ADMIN_PORT/tcp"  >/dev/null
  ufw allow 51820/udp          >/dev/null
fi

# ── forwarding (needed for routed WireGuard prefixes) ───────────────
cat > /etc/sysctl.d/99-hexahost.conf <<'SYSCTL'
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=1
SYSCTL
sysctl -p /etc/sysctl.d/99-hexahost.conf >/dev/null 2>&1 || true

# ── done ────────────────────────────────────────────────────────────
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
say "Done!"
echo "   Dashboard : http://${IP:-<server-ip>}:$ADMIN_PORT   ← the FIRST account you register becomes admin"
echo "   Sites     : port $PROXY_PORT (Host-header routed)"
echo "   WireGuard : udp/51820"
echo
echo "   Config    : $APP_DIR/.env   (set PUBLIC_HOST to your DNS name, then: systemctl restart hexahost)"
echo "   Logs      : journalctl -u hexahost -f"
echo "   Update    : cd $APP_DIR && git pull && npm install --omit=dev && systemctl restart hexahost"
echo "   Uninstall : systemctl disable --now hexahost wg-quick@wg0 bird; rm -rf $APP_DIR /etc/systemd/system/hexahost.service /etc/wireguard/wg0.conf /etc/bird/bird.conf"
echo
echo "   HTTPS tip : set PROXY_PORT=8080 in .env, then run Caddy on 80/443 with"
echo "               'reverse_proxy localhost:8080' for automatic Let's Encrypt certificates."
