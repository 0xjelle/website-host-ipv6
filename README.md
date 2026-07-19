# ⬡ HexaHost

**A self-hosted, IPv6-first hosting platform.** Host static HTML sites and Node.js
apps, auto-deploy them from GitHub on every push to `main`, and tunnel **your own
IPv6 block / IPv4 space** to yourself over WireGuard — with a BGP config generator
for announcing your prefix from your ASN. All managed from a pretty dark-mode
dashboard with a full admin area.

```
                        ┌────────────────────────────────────────────┐
   git push → webhook   │                 HexaHost                   │
  ──────────────────►   │                                            │
                        │  ┌──────────┐   ┌───────────────────────┐  │
   http (Host header)   │  │ Dashboard│   │ Edge proxy :80        │  │
  ──────────────────►   │  │ + API    │   │  static files ────────┼──┼─► site checkouts
                        │  │ :3000    │   │  reverse proxy ───────┼──┼─► node apps :2010x
                        │  └──────────┘   └───────────────────────┘  │
   wireguard :51820/udp │  ┌──────────────────────────────────────┐  │
  ◄──────────────────►  │  │ WireGuard manager                    │  │
   your IPv6 block      │  │  peers · routed prefixes · BIRD2 BGP │  │
                        │  └──────────────────────────────────────┘  │
                        └────────────────────────────────────────────┘
```

## Features

- **Sites** — static (HTML/CSS/JS, optional build step like `npm run build`) and
  **Node.js apps** (supervised processes with auto-restart, env vars, runtime logs).
- **GitHub auto-deploy** — connect any repo; HexaHost gives you a webhook URL +
  secret. Pushes to your chosen branch (default `main`) trigger
  clone → install → build → go-live. Deploy logs for every run. Private repos
  supported via access token.
- **Built-in edge proxy** — routes by `Host` header. Every site gets a free
  `<slug>.<your-host>` domain, plus any custom domains you add.
- **WireGuard tunnels** — one click creates a peer with generated keys
  (Curve25519 via Node's crypto, no shelling out), a tunnel IPv4 + IPv6, and a
  downloadable `.conf`. Enter **your own IPv6 block** (e.g. `2a0e:xxxx::/48`)
  and/or extra IPv4 space and the whole prefix is routed to you through the tunnel.
- **ASN / BGP** — peers with an ASN + IPv6 block get a generated **BIRD2**
  config snippet to announce the prefix from your side of the tunnel.
- **Pretty dashboard** — overview with stat tiles and recent deployments, site
  detail pages with tabs (deployments, GitHub, runtime logs, settings).
- **Admin dashboard** — user management (roles, suspend, delete), all-sites view,
  live system stats (CPU load, memory, disk), WireGuard server settings,
  platform-wide activity log. **The first registered account becomes admin.**

## Quick start

### Ubuntu Server (one command)

On a fresh Ubuntu Server 20.04/22.04/24.04 (or Debian 11+), as root:

```bash
curl -fsSL https://raw.githubusercontent.com/0xjelle/website-host-ipv6/main/scripts/install.sh | sudo bash
```

The installer:

- installs git, WireGuard tools and Node.js 22 (via NodeSource) if missing
- clones HexaHost to `/opt/hexahost` and installs dependencies
- writes `/opt/hexahost/.env` with a random `JWT_SECRET` and your server's IP
  as `PUBLIC_HOST` (override: `PUBLIC_HOST=host.example.com` before the command)
- installs + starts the `hexahost` systemd service, enables `wg-quick@wg0`
  against the generated WireGuard config, enables IPv4/IPv6 forwarding
- opens ports 80, 3000 and 51820/udp if ufw is active

Then open `http://your-server:3000` — the first account you register becomes
the admin. Useful afterwards:

```bash
journalctl -u hexahost -f        # live logs
systemctl restart hexahost       # after editing /opt/hexahost/.env
cd /opt/hexahost && git pull && npm install --omit=dev && systemctl restart hexahost   # update
```

### Manual (any Linux with Node ≥ 18)

```bash
git clone https://github.com/0xjelle/website-host-ipv6 && cd website-host-ipv6
npm install
cp .env.example .env   # edit: PUBLIC_HOST, ports, JWT_SECRET
npm start
```

Open `http://your-server:3000` and register — the first account is the admin.

### Docker

```bash
PUBLIC_HOST=host.example.com docker compose up -d --build
```

Dashboard on `:3000`, public sites on `:80`, WireGuard on `:51820/udp`.

## Hosting a site from GitHub

1. **Sites → New site**, pick *Static* or *Node.js*, paste your repo URL
   (`https://github.com/you/repo`), branch `main`.
2. HexaHost deploys immediately, then shows a **Payload URL + Secret** in the
   site's *GitHub* tab.
3. In GitHub: *Settings → Webhooks → Add webhook* — paste both, content type
   `application/json`, just the push event.
4. Every push to `main` now deploys automatically. 🎉

Static sites can set a *build command* (`npm run build`) and *serve subfolder*
(`dist`). Node apps get `PORT` injected — listen on `process.env.PORT` and
you're live; `npm start` is the default start command.

## Your IPv6 block + ASN over WireGuard

1. **Network / VPN → New peer** — name it, and optionally enter your IPv6 prefix
   (e.g. `2a0e:8f02:f01f::/48`), extra IPv4 CIDR, and ASN.
2. Download the generated `.conf` → `wg-quick up ./hexahost-peer.conf` (or import
   into any WireGuard app).
3. The server config (`data/wireguard/wg0.conf`) lists your prefix in
   `AllowedIPs`, so the whole block is routed down your tunnel. If `wg` is
   installed, HexaHost applies changes live via `wg syncconf`; otherwise the
   config is written to disk for `wg-quick@wg0`.
4. With an ASN set, the peer's **BGP** button serves a BIRD2 snippet that
   originates your prefix from your ASN on your side of the tunnel — adjust the
   neighbor to your transit/IX session.

> Routing a public prefix end-to-end also requires that this server is actually
> a valid next-hop for your block (your upstream routes it here, or you announce
> it from the server). HexaHost handles the tunnel + configs; the upstream
> arrangement is between you and your transit provider.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_PORT` | `3000` | Dashboard, API and GitHub webhooks |
| `PROXY_PORT` | `8080` | Public edge proxy (use `80` in production) |
| `PUBLIC_HOST` | `localhost` | Public DNS name — used for default site domains, webhook URLs and WireGuard endpoints |
| `JWT_SECRET` | auto-generated | Session signing key (persisted in `DATA_DIR`) |
| `DATA_DIR` | `./data` | SQLite DB, site checkouts, WireGuard configs |
| `APP_PORT_BASE` | `20100` | First internal port for Node.js apps |

**TLS:** the edge proxy speaks plain HTTP. For HTTPS put Caddy or nginx with
Let's Encrypt in front (`reverse_proxy localhost:8080` with Caddy is two lines
and gives you automatic certificates for every domain).

## Stack

Node.js + Express 5, SQLite (better-sqlite3), vanilla-JS SPA (no build step),
zero-dependency reverse proxy, WireGuard keys via `node:crypto` x25519.

```
server/
  index.js            boot: API + edge proxy + resume running apps
  config.js  db.js  auth.js
  routes/             auth · sites · webhooks · wireguard · admin
  services/           deployer · procman · proxy · wireguard
public/               dashboard SPA (index.html, app.css, app.js)
scripts/              install.sh · hexahost.service
```
