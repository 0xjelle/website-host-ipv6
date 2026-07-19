#!/usr/bin/env bash
# HexaHost bare-metal installer (Debian/Ubuntu). Run as root.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/hexahost}"
REPO_URL="${REPO_URL:-https://github.com/0xjelle/website-host-ipv6}"

echo "⬡ HexaHost installer"
echo "   target: $APP_DIR"

if [ "$(id -u)" -ne 0 ]; then echo "Please run as root (sudo)."; exit 1; fi

echo "── installing packages (git, node, wireguard)…"
apt-get update -qq
apt-get install -y -qq git curl wireguard-tools >/dev/null
if ! command -v node >/dev/null || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs >/dev/null
fi

echo "── fetching HexaHost…"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund

if [ ! -f "$APP_DIR/.env" ]; then
  echo "── writing default .env (edit it afterwards!)"
  sed -e "s/^JWT_SECRET=.*/JWT_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '=+\/')/" \
      -e "s/^PROXY_PORT=.*/PROXY_PORT=80/" \
      .env.example > .env
fi

echo "── installing systemd service…"
sed "s|__APP_DIR__|$APP_DIR|g" scripts/hexahost.service > /etc/systemd/system/hexahost.service
systemctl daemon-reload
systemctl enable --now hexahost

echo "── bringing up WireGuard interface (wg0)…"
mkdir -p /etc/wireguard
if [ -f "$APP_DIR/data/wireguard/wg0.conf" ]; then
  ln -sf "$APP_DIR/data/wireguard/wg0.conf" /etc/wireguard/wg0.conf
  systemctl enable --now wg-quick@wg0 || echo "   (wg0 will start once configured in the dashboard)"
fi

echo
echo "✔ Done. Dashboard: http://$(hostname -I | awk '{print $1}'):3000"
echo "  The FIRST account you register becomes the admin."
echo "  Set PUBLIC_HOST in $APP_DIR/.env to your server's public DNS name."
