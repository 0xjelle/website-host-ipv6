# ⬡ Hosting

**A self-hosted, IPv6-first hosting platform.** Host static HTML sites and Node.js
apps, auto-deploy them from GitHub on every push to `main`, and tunnel **your own
IPv6 block / IPv4 space** to yourself over WireGuard — with a BGP config generator
for announcing your prefix from your ASN. All managed from a pretty dark-mode
dashboard with a full admin area.

```
                        ┌────────────────────────────────────────────┐
   git push → webhook   │                  Hosting                   │
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
- **GitHub auto-deploy** — connect any repo; Hosting gives you a webhook URL +
  secret. Pushes to your chosen branch (default `main`) trigger
  clone → install → build → go-live. Deploy logs for every run. Private repos
  supported via access token.
- **Built-in edge proxy** — routes by `Host` header **and by destination
  IPv6 address**. Every site gets a free `<slug>.<your-host>` domain, plus any
  custom domains you add.
- **IPv6 auto-delegation** — set a *Site IPv6 pool* (a chunk of your own IPv6
  block routed to this server, e.g. a `/64`) and **every site automatically
  gets its own dedicated IPv6 address** out of it: allocated on creation,
  attached to the server's interface, released on deletion, shown in the
  dashboard. Point AAAA records straight at a site's address — no shared IP,
  no Host-header dependence.
- **WireGuard tunnels** — one click creates a peer with generated keys
  (Curve25519 via Node's crypto, no shelling out), a tunnel IPv4 + IPv6, and a
  downloadable `.conf`. Enter **your own IPv6 block** (e.g. `2a0e:xxxx::/48`)
  and/or extra IPv4 space and the whole prefix is routed to you through the tunnel.
- **BGP over the tunnel (BIRD2)** — enable a real server-side BGP session per
  peer: your ASN peers with the server's ASN across the WireGuard tunnel,
  with strict per-peer prefix filters. Download a ready-made BIRD2 config for
  your side, or **upload your own bird.conf** — parse-checked before it goes
  live, with session state shown in the dashboard.
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
- clones Hosting to `/opt/hosting` and installs dependencies
- writes `/opt/hosting/.env` with a random `JWT_SECRET` and your server's IP
  as `PUBLIC_HOST` (override: `PUBLIC_HOST=host.example.com` before the command)
- installs + starts the `hosting` systemd service, enables `wg-quick@wg0`
  against the generated WireGuard config, enables IPv4/IPv6 forwarding
- opens ports 80, 3000 and 51820/udp if ufw is active

Then open `http://your-server:3000` — the first account you register becomes
the admin. Useful afterwards:

```bash
journalctl -u hosting -f        # live logs
systemctl restart hosting       # after editing /opt/hosting/.env
cd /opt/hosting && git pull && npm install --omit=dev && systemctl restart hosting   # update
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
2. Hosting deploys immediately, then shows a **Payload URL + Secret** in the
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
2. Download the generated `.conf` → `wg-quick up ./hosting-peer.conf` (or import
   into any WireGuard app).
3. The server config (`data/wireguard/wg0.conf`) lists your prefix in
   `AllowedIPs`, so the whole block is routed down your tunnel. If `wg` is
   installed, Hosting applies changes live via `wg syncconf`; otherwise the
   config is written to disk for `wg-quick@wg0`.
4. **BGP over the tunnel** — hit the peer's **BGP** button:
   - Toggle *Enable server-side BGP session*: Hosting runs **BIRD2 on the
     server** with a session against your tunnel address (your ASN ↔ the
     server ASN set in *Server settings*). Import filters accept **only your
     registered prefixes**; accepted routes are exported to the kernel so
     traffic follows your announcement.
   - Download the ready-made **bird.conf for your side** — it originates your
     prefixes from your ASN and peers with the server over the tunnel. Bring
     WireGuard up, `bird -c hosting-bird.conf`, and the session establishes.
   - Or **upload your own BIRD config** (paste or file) — it's parse-checked
     with `bird -p` before being included, and applied live via
     `birdc configure`. Session state (Established/Idle/…) shows in the
     dashboard peer table.

> Routing a public prefix end-to-end also requires that this server is actually
> a valid next-hop for your block (your upstream routes it here, or you announce
> it from the server). Hosting handles the tunnel + configs; the upstream
> arrangement is between you and your transit provider.

## Dedicated IPv6 per site (auto-delegation)

Give websites their own addresses from your block:

1. **Network / VPN → Server settings** (admin) — set *Site IPv6 pool* to a
   subnet of your block that is routed to this server, e.g.
   `2a0e:8f02:f01f:100::/64`. (The rest of the block can keep tunneling to
   your WireGuard peers.)
2. Every existing site is immediately assigned an address (`::1`, `::2`, …),
   and every new site gets one automatically at creation. Addresses are
   attached to the server's default interface via `ip -6 addr` (override the
   interface in the same settings dialog) and released when a site is deleted.
3. The edge proxy recognizes the destination address of each connection, so
   traffic hitting a site's dedicated IPv6 lands on that site even without a
   matching `Host` header — point `AAAA yoursite.example → 2a0e:…::2` and
   you're done. The address is shown on the site page with a copy button.

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
scripts/              install.sh · hosting.service
```
