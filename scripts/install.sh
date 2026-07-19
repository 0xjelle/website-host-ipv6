#!/usr/bin/env bash
# ⬡ Hosting — pretty installer for Ubuntu Server (20.04+) / Debian (11+)
#
#   curl -fsSL https://raw.githubusercontent.com/0xjelle/website-host-ipv6/main/scripts/install.sh | sudo bash
#
# Optional overrides (export before running):
#   PUBLIC_HOST=host.example.com   public DNS name or IP of this server
#   APP_DIR=/opt/hosting          install location
#   PROXY_PORT=80                  public port for hosted sites
#   ADMIN_PORT=3000                dashboard port
#   REPO_URL=…                     alternate git source
#   NONINTERACTIVE=1               never prompt, use defaults
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/hosting}"
REPO_URL="${REPO_URL:-https://github.com/0xjelle/website-host-ipv6}"
PROXY_PORT="${PROXY_PORT:-80}"
ADMIN_PORT="${ADMIN_PORT:-3000}"
LOG="$(mktemp /tmp/hosting-install.XXXXXX.log)"
export DEBIAN_FRONTEND=noninteractive

# ── looks ───────────────────────────────────────────────────────────
if [ -t 1 ] && command -v tput >/dev/null && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  BOLD=$(tput bold) DIM=$(tput dim) RED=$(tput setaf 1) GRN=$(tput setaf 2)
  YLW=$(tput setaf 3) MAG=$(tput setaf 5) CYN=$(tput setaf 6) RST=$(tput sgr0)
else
  BOLD='' DIM='' RED='' GRN='' YLW='' MAG='' CYN='' RST=''
fi

TOTAL=8; STEP=0
banner() {
  echo
  echo "${MAG}${BOLD}   ⬡  H o s t i n g${RST}"
  echo "${DIM}   ─────────────────────────────────────────────${RST}"
  echo "${DIM}   IPv6-first hosting · GitHub auto-deploy · WireGuard + BGP${RST}"
  echo
}
step() { STEP=$((STEP+1)); printf '%s' "${CYN}[${STEP}/${TOTAL}]${RST} ${BOLD}$1${RST} "; }
ok()   { echo "${GRN}✓${RST}${1:+ ${DIM}$1${RST}}"; }
skip() { echo "${DIM}– $1${RST}"; }
warn() { echo "${YLW}! $1${RST}"; }
die()  { echo; echo "${RED}${BOLD}✗ $1${RST}"; echo "${DIM}  full log: $LOG${RST}"; exit 1; }

# run <description-of-failure> <cmd…> — quiet, logged, spinner on a tty
run() {
  local msg="$1"; shift
  if [ -t 1 ]; then
    ("$@" >>"$LOG" 2>&1) & local pid=$!
    local frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0
    while kill -0 "$pid" 2>/dev/null; do
      printf '\b%s' "${frames:i++%10:1}"; sleep 0.1
    done
    printf '\b'
    wait "$pid" || { echo "${RED}✗${RST}"; echo; tail -n 12 "$LOG" | sed 's/^/  /'; die "$msg"; }
  else
    "$@" >>"$LOG" 2>&1 || { echo "${RED}✗${RST}"; echo; tail -n 12 "$LOG" | sed 's/^/  /'; die "$msg"; }
  fi
}

ask() { # ask "Question" "default" → REPLY   (prompts only on an interactive terminal)
  local q="$1" def="$2"
  REPLY="$def"
  if [ -z "${NONINTERACTIVE:-}" ] && [ -e /dev/tty ] && [ -t 1 ]; then
    printf '%s' "    ${BOLD}${q}${RST} ${DIM}[${def}]${RST} " >/dev/tty
    local answer=''
    IFS= read -r answer </dev/tty || true
    [ -n "$answer" ] && REPLY="$answer"
  fi
}

trap 'echo; echo "${RED}Something went wrong.${RST} ${DIM}See the log: $LOG${RST}"' ERR

# ── preflight ───────────────────────────────────────────────────────
banner
[ "$(id -u)" -eq 0 ] || die "Please run as root:  curl -fsSL …/install.sh | sudo bash"
command -v apt-get >/dev/null || die "This installer needs Ubuntu/Debian (apt). See README for manual install."
. /etc/os-release 2>/dev/null || true
echo "   ${DIM}system :${RST} ${PRETTY_NAME:-unknown}"
echo "   ${DIM}target :${RST} $APP_DIR"
echo "   ${DIM}log    :${RST} $LOG"
echo

# figure out the public host before we start (one friendly question, Enter = default)
DETECTED_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ -z "${PUBLIC_HOST:-}" ]; then
  ask "Public hostname or IP for this server?" "${DETECTED_IP:-localhost}"
  PUBLIC_HOST="$REPLY"
  echo
fi

# ── install ─────────────────────────────────────────────────────────
step "System packages (git · wireguard · bird2 · iproute2)"
run "Package installation failed" apt-get update -qq
run "Package installation failed" apt-get install -y -qq git curl ca-certificates iproute2 wireguard-tools bird2
ok

step "Node.js 18+"
node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -ge 18 ]; then
  ok "already have $(node --version)"
else
  run "Node.js installation failed" bash -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y -qq nodejs'
  ok "installed $(node --version)"
fi

step "Hosting code → $APP_DIR"
# migrate an install made under the old name (hexahost)
if [ -d /opt/hexahost/.git ] && [ ! -d "$APP_DIR/.git" ]; then
  systemctl disable --now hexahost >>"$LOG" 2>&1 || true
  rm -f /etc/systemd/system/hexahost.service
  mv /opt/hexahost "$APP_DIR"
fi
if [ -d "$APP_DIR/.git" ]; then
  run "git pull failed" git -C "$APP_DIR" pull --ff-only
  ok "updated existing install"
else
  run "git clone failed — is the repo reachable?" git clone --depth 1 "$REPO_URL" "$APP_DIR"
  ok "cloned"
fi

step "Dependencies (npm install)"
run "npm install failed" bash -c "cd '$APP_DIR' && npm install --omit=dev --no-audit --no-fund --loglevel=error"
ok

step "Configuration (.env)"
if [ -f "$APP_DIR/.env" ]; then
  ok "keeping existing .env"
else
  sed -e "s|^JWT_SECRET=.*|JWT_SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')|" \
      -e "s|^PROXY_PORT=.*|PROXY_PORT=$PROXY_PORT|" \
      -e "s|^ADMIN_PORT=.*|ADMIN_PORT=$ADMIN_PORT|" \
      -e "s|^PUBLIC_HOST=.*|PUBLIC_HOST=$PUBLIC_HOST|" \
      "$APP_DIR/.env.example" > "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  ok "PUBLIC_HOST=$PUBLIC_HOST · sites :$PROXY_PORT · dashboard :$ADMIN_PORT"
fi

step "System service (systemd)"
sed "s|__APP_DIR__|$APP_DIR|g" "$APP_DIR/scripts/hosting.service" > /etc/systemd/system/hosting.service
SYSTEMD_UP=0
if [ -d /run/systemd/system ]; then
  SYSTEMD_UP=1
  run "Could not start the hosting service" systemctl daemon-reload
  run "Could not start the hosting service" systemctl enable --now hosting
  run "Could not start the hosting service" systemctl restart hosting
  ok "hosting.service running"
else
  skip "systemd not running (container?) — start manually: cd $APP_DIR && npm start"
fi

step "WireGuard + BGP (wg0 · bird)"
mkdir -p /etc/wireguard /etc/bird
[ -e /etc/wireguard/wg0.conf ] || ln -s "$APP_DIR/data/wireguard/wg0.conf" /etc/wireguard/wg0.conf
if [ -f /etc/bird/bird.conf ] && [ ! -L /etc/bird/bird.conf ]; then mv /etc/bird/bird.conf /etc/bird/bird.conf.dist; fi
ln -sf "$APP_DIR/data/bird/bird.conf" /etc/bird/bird.conf
cat > /etc/sysctl.d/99-hosting.conf <<'SYSCTL'
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=1
SYSCTL
sysctl -p /etc/sysctl.d/99-hosting.conf >/dev/null 2>&1 || true
if [ "$SYSTEMD_UP" -eq 1 ]; then
  for _ in $(seq 1 20); do [ -f "$APP_DIR/data/wireguard/wg0.conf" ] && break; sleep 1; done
  WG_MSG="tunnel up" BIRD_MSG="bgp daemon up"
  systemctl enable --now wg-quick@wg0 >>"$LOG" 2>&1 || WG_MSG="wg0 not started yet (fine — starts once configured)"
  { systemctl enable --now bird >>"$LOG" 2>&1 && systemctl restart bird >>"$LOG" 2>&1; } || BIRD_MSG="bird not started (check journalctl -u bird)"
  ok "$WG_MSG · $BIRD_MSG"
else
  skip "configs generated; services start with systemd"
fi

step "Firewall"
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
  run "ufw rule failed" ufw allow "$PROXY_PORT/tcp"
  run "ufw rule failed" ufw allow "$ADMIN_PORT/tcp"
  run "ufw rule failed" ufw allow 51820/udp
  ok "opened $PROXY_PORT/tcp · $ADMIN_PORT/tcp · 51820/udp"
else
  skip "ufw not active — nothing to open"
fi

# ── summary ─────────────────────────────────────────────────────────
DASH_HOST="${PUBLIC_HOST:-${DETECTED_IP:-localhost}}"
echo
echo "${GRN}${BOLD}   ✓ Hosting is installed!${RST}"
echo
echo "   ${MAG}┌──────────────────────────────────────────────────────────┐${RST}"
printf "   ${MAG}│${RST}  %-56s${MAG}│${RST}\n" "Dashboard   http://$DASH_HOST:$ADMIN_PORT"
printf "   ${MAG}│${RST}  %-56s${MAG}│${RST}\n" "Sites       port $PROXY_PORT (Host header + dedicated IPv6)"
printf "   ${MAG}│${RST}  %-56s${MAG}│${RST}\n" "WireGuard   udp/51820"
echo "   ${MAG}└──────────────────────────────────────────────────────────┘${RST}"
echo
echo "   ${BOLD}First step:${RST} open the dashboard and register —"
echo "   the ${BOLD}first account becomes the admin${RST}. ✨"
echo
echo "   ${DIM}config     $APP_DIR/.env  (then: systemctl restart hosting)${RST}"
echo "   ${DIM}logs       journalctl -u hosting -f${RST}"
echo "   ${DIM}update     cd $APP_DIR && git pull && npm install --omit=dev && systemctl restart hosting${RST}"
echo "   ${DIM}uninstall  systemctl disable --now hosting wg-quick@wg0 bird; rm -rf $APP_DIR \\${RST}"
echo "   ${DIM}             /etc/systemd/system/hosting.service /etc/wireguard/wg0.conf /etc/bird/bird.conf${RST}"
echo "   ${DIM}https      set PROXY_PORT=8080 in .env, put Caddy on 80/443 → reverse_proxy localhost:8080${RST}"
echo
