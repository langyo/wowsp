# Self-hosting the WoWSP server

> This guide walks you through running your own WoWSP server node — the
> full battle-push gateway (it relays live battle data to members'
> phones), the battle-record lookup cache, or both — and pointing the
> desktop app and your members' phones at it. The whole
> server is the standard `packages/pairing-relay` code in this
> repository. The wire contracts live in
> [cache-mesh.md](../designs/cache-mesh.md) (lookup cache, blocks,
> peers) and [gateway-push.md](../designs/gateway-push.md) (battle
> push); this page is the operations manual.

## Why self-host

- **Privacy**: battle pushes for your members route through your
  server, not the public node.
- **No captcha**: private deployments may turn Turnstile (Cloudflare's
  human-verification widget) off and/or protect the gateway with a
  simple password instead.
- **Control**: put it on any domain you own — a legion domain is a
  natural fit, and the URL doubles as a small perk for your members.
- **Speed**: your node caches battle-record lookups, so your members'
  stats queries hit your cache (and the shared mesh) instead of each
  fighting the upstream alone at CN evening peak.

A clan, or a single player, putting up a node and adding its domain to
the app's cache-server list is precisely the deployment the mesh was
designed around — the more nodes join, the faster everyone's lookups
get.

## What a node can be

| Capability | Meaning | Cloudflare Worker | Native server (VPS / LAN / Docker) | Vercel edge |
| --- | --- | --- | --- | --- |
| `gateway` | `/gateway/*` battle-push WebSocket | ✔ | ✔ | — (no WS on edge functions) |
| `lookup` | `/api/lookup/*` stats-cache proxy | ✔ | ✔ | ✔ |
| `peers` | `/api/peers/*` registry (list + announce) | ✔ | ✔ | ✔ |
| `blocks` | `/api/blocks/*` + `/ipfs/*` content store | ✔ | ✔ | ✔ |

- **Cloudflare Worker** — the same wasm the official node runs; the
  desktop app's wizard can deploy it in one go. Good for
  zero-maintenance public nodes.
- **Native server** — one self-contained binary (`relay-server`,
  axum + SQLite) for a VPS, a LAN box or Docker; every capability, no
  Cloudflare account needed. Good when you want full control and LAN
  fleets.
- **Vercel edge** — the TypeScript adapter; HTTP-only (no battle
  push). The choice when you have no Rust toolchain.

Every deployment answers `GET /api/health` with its capabilities;
clients probe before use, so a gateway-only node never receives
lookup traffic.

## The lookup cache and the mesh (one minute)

The lookup cache: your node fetches stats from the upstreams — the
WG/Lesta/vortex official stats sources — for your members and keeps
the result; the next query for the same player hits the cache and
comes back in ~100 ms (before nodes, every member queried the upstreams
alone, and a single query could take 30 s at peak). The cache mesh:
nodes share their caches with each other, so data nobody on your node
has queried can still arrive from a peer.

Two words used below: **announce** — listing your node in the public
node list so others can find it; **peer** — any other node in the mesh.
A block is one cached query result; blocks are content-addressed and
hash-verified when shared. Only public stats data travels the mesh:
battle-push frames and feedback never do, and nodes keep no query logs
and no client identifiers. An http or IP-literal node never appears in
a public list, so LAN fleets stay private by construction.

## Path 1 — Cloudflare Worker

### Prerequisites

1. A Cloudflare account (the free Workers plan is enough).
2. A domain or subdomain hosted on that Cloudflare account (a Workers
   Custom Domain is bound to it automatically at deploy time).
3. On the machine running the desktop app: Node.js (with `npx`) and a
   Rust toolchain with the `wasm32-unknown-unknown` target — or simply
   use the app's built-in wizard, which probes all of this for you.

### The one-click way (desktop app)

Settings ▸ 连接 (Connection) ▸ Pairing ▸ **自建网关向导** walks the whole
path step by step:

1. **Environment probe** — checks `node`, `npx`, `rustc`, the wasm32
   target and `worker-build`; anything missing is reported with install
   hints.
2. **Wrangler login** — runs `npx wrangler login` (Cloudflare's CLI;
   opens the browser; the token stays in wrangler's own local state,
   never in WoWSP).
3. **Target domain** — the subdomain the gateway will own, e.g.
   `wowsp.your-legion.example`.
4. **KV bucket** — creates/selects the `GATEWAY_KV` namespace the
   gateway uses to keep the last battle per channel.
5. **Deploy** — generates the filled wrangler config from the tracked
   template and runs `npx wrangler deploy`, streaming every output line
   into the wizard.
6. **Verify** — hits `https://<your-domain>/gateway/health` and shows
   the URL (with a copy button) to enter on each member's phone
   (Settings ▸ 连接 ▸ 路由入口).

The wizard deploys the battle-push gateway with the cache mesh off
(`LOOKUP_ENABLED = "0"` in the template). Turn it on with the next
section when you want it.

### The manual way (CLI)

```bash
git clone https://github.com/langyo/wowsp && cd wowsp/packages/pairing-relay
rustup target add wasm32-unknown-unknown
cargo install worker-build@0.8.7 --locked  # 0.9+ needs the worker crate >= 0.9
npx wrangler login
npx wrangler kv namespace create GATEWAY_KV     # note the printed id
cp wrangler.selfhost.toml.example wrangler.selfhost.local.toml
# edit wrangler.selfhost.local.toml: your domain + KV id
npx wrangler deploy --config wrangler.selfhost.local.toml
curl https://<your-domain>/gateway/health
```

### Turning the cache mesh on (Worker)

The template ships mesh-off. To turn it on, bind the mesh's three
pieces of storage in your selfhost config — one KV (Cloudflare
key-value storage), one R2 bucket (Cloudflare object storage) and one
Durable Object (a small stateful instance):

1. `[[kv_namespaces]]` binding `LOOKUP_KV` (any namespace; it holds
   the node list).
2. `[[r2_buckets]]` binding `LOOKUP_R2`, and create the bucket once:
   `npx wrangler r2 bucket create wowsp-lookup-blocks` (cached data
   blocks).
3. `[[durable_objects.bindings]]` `LOOKUP_RATE` (class `LookupRate`)
   plus its migration entry on your chain (the template's next tag):
   ```toml
   [[migrations]]
   tag = "v2"
   new_sqlite_classes = ["LookupRate"]
   ```
4. Remove `LOOKUP_ENABLED = "0"` (absent = mesh on) and optionally set
   `PEERS_UPSTREAM = "https://wowsp.langyo.xyz"` (subscribe the
   public node list) and `NODE_ROLE = "community"`.

Tuning knobs as vars: `LOOKUP_SYNC = "0"` (disable peer pull-through),
`SYNC_PEERS_MAX`, `LOOKUP_RATE_PER_HOUR`,
`PEERS_ACCEPT_ANNOUNCES = "false"` (make your node list read-only).

The three stores are split so the mesh stays inside the free KV budget
(1000 writes/day): data blocks live in R2 (free tier: 1M class-A
operations/month), rate limits in the Durable Object, and KV is written
only when nodes announce. Details in cache-mesh.md.

Of the three shapes, the Worker is the most quota-fragile. For a cache
node you plan to keep, prefer the native server below; keep the Worker
for battle push and experiments.

## Path 2 — Native server (VPS / LAN / Docker)

> This section condenses the crate's own README
> (`packages/pairing-relay/crates/relay-server/README.md`); when in
> doubt, the README is the source of truth.

One binary, every capability (`gateway` + `lookup` + `peers` +
`blocks`), state in SQLite — no Cloudflare account, no wasm toolchain.

### Build and run

```bash
just build-server                       # release build of the binary
just run-server                         # or run it directly
# equivalently:
cd packages/pairing-relay && cargo run -p relay-server --release
```

The server speaks plain HTTP by design (TLS termination is your
reverse proxy's job — Caddy/nginx/Cloudflare). Smoke check:
`curl http://127.0.0.1:8787/api/health` answers the manifest with
all capabilities true.

### Configuration

Precedence: `WOWSP_SERVER_*` environment variable > optional
`wowsp-server.toml` in the working directory > defaults. Secrets
belong in the service environment, never in a tracked file.

| Env var | Default | Meaning |
| --- | --- | --- |
| `WOWSP_SERVER_BIND` | `127.0.0.1:8787` | listen address |
| `WOWSP_SERVER_DATA_DIR` | `./wowsp-server-data` | SQLite db + node-id file |
| `WOWSP_SERVER_PUBLIC_URL` | unset | public base URL; when set (https, name-shaped) the node lists itself and re-announces; http/IP-literal values stay private rows |
| `WOWSP_SERVER_ROLE` | `community` | informational (`official`\|`community`) |
| `WOWSP_SERVER_NOTICE` | unset | operator message riding the health documents |
| `WOWSP_SERVER_GATEWAY_PASSWORD` | unset | gateway password (absent ⇒ off) |
| `WOWSP_SERVER_TURNSTILE_SITEKEY` / `_SECRET` | unset | Turnstile gating for `/gateway/session` |
| `WOWSP_SERVER_PEERS_UPSTREAM` | `https://wowsp.langyo.xyz` | where the server list is subscribed |
| `WOWSP_SERVER_SYNC` | `true` | pull blocks from peers on a local miss |
| `WOWSP_SERVER_SYNC_PEERS_MAX` | `3` | peers asked per miss |
| `WOWSP_SERVER_PEERS_ACCEPT_ANNOUNCES` | `true` | accept announces (off → 403) |
| `WOWSP_SERVER_LOOKUP_RATE_PER_HOUR` | `240` | per-IP hourly lookup budget |

### LAN vs public binding

The `127.0.0.1` default keeps the server invisible outside its host —
fine for a personal cache. To serve a LAN, bind `0.0.0.0:8787` (or
your LAN address). To serve the public internet, bind `0.0.0.0` and
front it with a reverse proxy — a web server sitting in front that
terminates TLS and forwards to the local port — which sets
`X-Forwarded-For` for you; the per-IP budgets key on that header, and
without it every client shares one budget. Public nodes should also
set `WOWSP_SERVER_PUBLIC_URL` so the node lists itself.

### Docker

```bash
cd packages/pairing-relay/crates/relay-server
docker compose -f docker-compose.yml.example up -d --build
```

Multi-stage (`rust:1-bookworm` → `gcr.io/distroless/cc`), volume
`/data`, non-root user, port 8787. Read the compose file's
`0.0.0.0` warning before exposing the port.

### Data directory

All state lives in one SQLite database (`wowsp-server.db`) plus a node
id file (`node-id.txt`); cached entries keep their TTL plus a 24 h
grace window. To reset a node completely, stop it and delete the data
directory.

### Joining the mesh

- **Subscribing**: by default the node subscribes the official public
  node list (`WOWSP_SERVER_PEERS_UPSTREAM`) — on a local miss it asks
  the other nodes on that list.
- **Announcing**: with `WOWSP_SERVER_PUBLIC_URL` set, the node lists
  itself and re-announces on every sweep — no cron needed. Without it,
  announce manually; listings expire after 48 h, so keep a twice-daily
  cron:
  ```bash
  # cron: refresh the announce every 12 h
  0 */12 * * * curl -fsS -X POST https://wowsp.langyo.xyz/api/peers/announce \
    -H 'Content-Type: application/json' \
    -d '{"url":"https://wowsp.your-legion.example","contact":"XX军团节点"}'
  ```

## Path 3 — Vercel edge

The HTTP-only subset (lookup + peers + blocks, no battle push) with
zero Rust toolchain:

1. Fork the repo (or push a branch containing `packages/relay-vercel`).
2. In Vercel: **Add New… → Project**, import the fork, set **Root
   Directory** to `packages/relay-vercel` (framework preset stays
   **Other**).
3. Create an Upstash KV database (Vercel dashboard ▸ Storage ▸ Upstash
   KV, or <https://console.upstash.com>) and set the project env vars
   `KV_REST_URL` / `KV_REST_TOKEN` from its REST credentials.
4. Deploy. Your node answers at
   `https://<project>.vercel.app/api/health`.

Also set `NODE_ID` (a stable 32-hex id — otherwise every cold start
looks like a new node) and optionally `PEERS_UPSTREAM`,
`NODE_ROLE`, `NOTICE`. The full env-var table lives in
`packages/relay-vercel/README.md`.

**Memory mode**: without the Upstash env vars the adapter keeps
everything in memory — counters reset on cold starts and every edge
instance (isolate) caches on its own. Fine for previews; attach Upstash
KV (the free tier is enough) for anything real.

## Pointing WoWSP at your node

- **Desktop (battle push)**: Settings ▸ 连接 ▸ Pairing ▸ 路由入口 —
  replace the official `https://wowsp.langyo.xyz/gateway/` with
  `https://<your-domain>/gateway/`, then turn on the 手机服务 toggle.
- **Desktop (lookup cache)**: the **缓存服务器 / Cache servers** pane
  (Settings ▸ 连接, the connection group). The official node is pinned
  first; add your domain as the first user row, drag-reorder, and probe
  each entry. Your own rows always take priority over autodiscovered
  community nodes.
- **Phone**: the custom gateway root field in the phone's settings is
  unchanged. Phones do not talk to cache servers directly — the
  desktop's lookups cover both ends over the mesh.

### The mesh trust model (short version)

Cache servers are just one source of public stats: every block carries
a content hash and mismatched data is dropped; the public list takes
https-named nodes only, with a liveness-checked announce; a hostile
node can at worst hand out stale stats — the client's own checks
police that.
Ordering is user-managed, so your own node always wins. Battle-push
frames and feedback never enter the mesh (details in cache-mesh.md
§8).

## Operations hygiene

- **Notice**: the `GATEWAY_NOTICE` var (Worker) or
  `WOWSP_SERVER_NOTICE` (native) / `NOTICE` (Vercel) rides the
  health documents — tell users who runs this node.
- **Gateway gating**: Turnstile (`GATEWAY_TURNSTILE_SITEKEY` +
  `TURNSTILE_SECRET` on the Worker; the widget's hostname allowlist
  must cover `tauri.localhost`, `asset.localhost` and
  `localhost`) and/or a password (`GATEWAY_PASSWORD` secret /
  `WOWSP_SERVER_GATEWAY_PASSWORD`). 5 wrong passwords inside one
  minute lock the source IP out for 5 minutes (HTTP 429 with
  `retryAfter`). With neither set, anyone who knows a channel id can
  subscribe — acceptable for a private legion node.
- **Rate limits**: `LOOKUP_RATE_PER_HOUR` (default 240) bounds the
  lookup proxy per IP; announces are 10/hour/IP and the registry caps
  at 128 rows everywhere. Lower the lookup budget if your quota is
  tight; raise it on a members-only node with headroom.

Connection failures surface as a toast (top-right) on both ends.
