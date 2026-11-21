# Self-hosting the WoWSP server

> This guide walks a legion commander — or any player — through running
> your OWN WoWSP server node and pointing the desktop app and the
> members' phones at it. A node can be the full battle-push gateway, a
> battle-record lookup cache, or both: the whole server is the standard
> `packages/pairing-relay` code in this repository. The wire contract
> lives in [cache-mesh.md](../designs/cache-mesh.md) (lookup cache,
> blocks, peers) and [gateway-push.md](../designs/gateway-push.md)
> (battle push); this page is the operations manual.

## Why self-host

- **Privacy**: battle pushes for your members route through YOUR
  server, not the public node.
- **No captcha**: private deployments may turn Turnstile OFF and/or
  protect the gateway with a simple password instead.
- **Control**: point it at any domain you own (a legion domain works
  great) — it makes a clean member benefit a commander can hand out.
- **Speed**: your node caches battle-record lookups, so your members'
  stats queries hit your cache (and the shared mesh) instead of each
  fighting the upstream alone at CN evening peak.

A 战队 (clan/legion) or individual deploying a node and adding its
domain in the app's cache-server settings is exactly the outcome the
mesh was designed for — the more nodes, the faster everyone.

## What a node can be

| Capability | Meaning | Cloudflare Worker | Native server (VPS / LAN / Docker) | Vercel edge |
| --- | --- | --- | --- | --- |
| `gateway` | `/gateway/*` battle-push WebSocket | ✔ | ✔ | — (no WS on edge functions) |
| `lookup` | `/api/lookup/*` stats-cache proxy | ✔ | ✔ | ✔ |
| `peers` | `/api/peers/*` registry (list + announce) | ✔ | ✔ | ✔ |
| `blocks` | `/api/blocks/*` + `/ipfs/*` content store | ✔ | ✔ | ✔ |

- **Cloudflare Worker** — the same wasm the official node runs; the
  desktop app's built-in wizard deploys it (gateway-only by default,
  mesh optional). Best for zero-maintenance public nodes.
- **Native server** — one self-contained binary (`relay-server`,
  axum + SQLite) for a VPS, a LAN box or Docker; every capability,
  no Cloudflare account needed. Best for full control and LAN fleets.
- **Vercel edge** — the `packages/relay-vercel` TypeScript adapter,
  an HTTP-only subset (no battle push); deployable with zero Rust
  toolchain from the Vercel dashboard.

Every deployment answers `GET /api/health` with its capabilities;
clients probe before use, so a gateway-only node simply never receives
lookup traffic.

## The battle-record lookup cache

**Why it exists**: every stats lookup used to go desktop →
WG/Lesta/vortex upstreams directly, and in CN the vortex transport
crawls at evening peak — a query can take 30 s while the whole
ecosystem feels broken.

**What a node improves**: lookups become server-side cached. One
player's slow 30 s fetch turns into everyone's ~100 ms cache hit —
first on your own node, then across the mesh: nodes share cached
blocks with each other, content-addressed and verified, so a community
node serves data it never fetched itself.

**What stays private**: the mesh carries ONLY public game data (the
same bytes the official stats sites serve anonymously). Battle-push
frames and feedback NEVER enter the mesh, nodes keep no query logs
and no client identifiers, and an http or IP-literal node is never
published in a public list — LAN fleets stay private by construction
(cache-mesh.md §8).

## Path 1 — Cloudflare Worker

### Prerequisites

1. A Cloudflare account (the free Workers plan is enough — Durable
   Objects on the free plan use SQLite storage, which the gateway and
   the mesh's rate limiter use).
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
2. **Wrangler login** — runs `npx wrangler login` (opens the browser;
   the token stays in wrangler's own local state, never in WoWSP).
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

The wizard deploys the battle-push gateway with the cache mesh OFF
(`LOOKUP_ENABLED = "0"` in the template, by design — an ungated
allowlist proxy should not ride along unnoticed).

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

The template ships mesh-off; a Worker-based mesh node needs the mesh's
storage seams bound first. Add to your selfhost config:

1. `[[kv_namespaces]]` binding `LOOKUP_KV` (any namespace — it holds
   the peer-registry documents, `node:id` and the announce counters).
2. `[[r2_buckets]]` binding `LOOKUP_R2`, and create the bucket ONCE:
   `npx wrangler r2 bucket create wowsp-lookup-blocks` (block
   envelopes).
3. `[[durable_objects.bindings]]` `LOOKUP_RATE` (class `LookupRate`)
   plus its migration entry on your chain (the template's next tag):
   ```toml
   [[migrations]]
   tag = "v2"
   new_sqlite_classes = ["LookupRate"]
   ```
4. Remove `LOOKUP_ENABLED = "0"` (absent = mesh on) and optionally set
   `PEERS_UPSTREAM = "https://wowsp.langyo.xyz"` (subscribe the
   broadcast list) and `NODE_ROLE = "community"`.

Tuning knobs as vars: `LOOKUP_SYNC = "0"` (disable peer pull-through),
`SYNC_PEERS_MAX`, `LOOKUP_RATE_PER_HOUR`,
`PEERS_ACCEPT_ANNOUNCES = "false"` (make your registry read-only).

Why the storage is split this way (free-tier quota reality):

- **Blocks live in R2** — every cache fill is a WRITE; the free KV
  namespace budget is 1000 writes/day shared with everything else,
  while R2's free tier allows 1M class-A operations/month.
- **Rate limits live in a Durable Object** — a KV counter costs one
  PUT per request; the `LookupRate` SQLite DO (one shard per
  (hour, IP), self-deleting) carries no such shared quota.
- **KV writes stay bounded to announce traffic** — the whole own peer
  registry is ONE document rewritten only on accepted announces
  (already limited to 10/hour/IP); the hot lookup path is edge-cached
  in front of everything and burns no storage reads when warm.

Honest note: the Worker is the most quota-fragile mesh shape. For a
serious cache node prefer the native server below; keep the Worker for
battle push and experiments.

## Path 2 — Native server (VPS / LAN / Docker)

> The `relay-server` crate lands with PR #2068 (in review as of this
> writing); this section is written from that PR's README
> (`packages/pairing-relay/crates/relay-server/README.md`).

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
your LAN address). To serve the public internet, bind `0.0.0.0` AND
front it with a TLS-terminating reverse proxy that sets
`X-Forwarded-For` — the per-IP budgets key on that header, and
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

### Data directory layout

One `wowsp-server.db` (SQLite, WAL) plus `node-id.txt` (the stable
node id, minted once): cached envelopes keyed by CID with TTL + 24 h
grace, the 48 h announce registry (128-row cap), battle snapshots,
and the hourly rate windows. A housekeeping task sweeps expired rows
every 10 minutes; SIGTERM drains in-flight requests.

### Joining the mesh

- **Subscribing**: the default `WOWSP_SERVER_PEERS_UPSTREAM` subscribes
  the official broadcast list — your node serves the union of its own
  registry and the official one, and pulls blocks from peers on a
  local miss.
- **Announcing**: with `WOWSP_SERVER_PUBLIC_URL` set, the node lists
  itself in its own registry and best-effort re-announces to the
  upstream on every sweep. Without that, announce manually — rows live
  48 h, so a twice-daily cron keeps you listed:
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

**Memory-mode caveat**: without the Upstash env vars the adapter falls
back to an in-memory map — every edge isolate keeps its own cache,
counters reset on cold starts, and the peer cap cannot evict globally.
Fine for `vercel dev` and previews; a real deployment attaches
Upstash KV (the free tier is enough).

## Pointing WoWSP at your node

- **Desktop (battle push)**: Settings ▸ 连接 ▸ Pairing ▸ 路由入口 —
  replace the official `https://wowsp.langyo.xyz/gateway/` with
  `https://<your-domain>/gateway/`, then turn on the 手机服务 toggle.
- **Desktop (lookup cache)**: the **缓存服务器 / Cache servers** pane
  (Settings ▸ 连接, the connection group) — arriving with the client
  wave. The official node is pinned first; add your domain as the
  first user row, drag-reorder, and probe each entry. Your own rows
  always take priority over autodiscovered community nodes.
- **Phone**: the custom gateway root field in the phone's settings is
  unchanged. Phones do not talk to cache servers directly — the
  desktop's lookups ride the mesh for both.

### The mesh trust model (short version)

Cache servers are information sources for PUBLIC data, nothing more
(cache-mesh.md §8): blocks are content-verified (a lying peer's row
fails the CID hash check and is dropped), public peers are https-name
only with a liveness-checked announce, and a hostile node can at worst
serve stale or wrong STATS — which the client's own sanity checks
police, the same trust level as any upstream. User-managed ordering
means your own node always wins. Battle-push frames and feedback never
enter the mesh.

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
  `retryAfter`). Neither set ⇒ anyone who knows a channel id can
  subscribe — fine for a private legion node.
- **Rate limits**: `LOOKUP_RATE_PER_HOUR` (default 240) bounds the
  lookup proxy per IP; announces are 10/hour/IP and the registry caps
  at 128 rows everywhere. Lower the lookup budget if your quota is
  tight; raise it on a members-only node with headroom.

Connection failures surface as a toast (top-right) on both ends.
