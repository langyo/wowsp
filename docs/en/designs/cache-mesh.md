# WoWSP cache mesh — self-hostable server, lookup cache, peer sync

> Status: contract (v1). This document is the single source of truth for
> the routes, wire shapes and policies implemented by
> `packages/pairing-relay` (Cloudflare Worker), the native
> `relay-server` crate (VPS / LAN), the `packages/relay-vercel` edge
> adapter, and the desktop/phone clients. Like
> `gateway-push.md`, it lives in `en` and `zh-CN` only.

## 1. Why

The battle-push gateway (`/gateway/*`, `gateway-push.md`) proved the
model: one Rust policy core (`relay-core`), many transports. Three
problems now push the same model further:

1. **Deployment freedom.** A legion or individual should be able to run
   a WoWSP server wherever it fits — Cloudflare Workers (existing),
   a VPS or a LAN box (native binary), or Vercel-style serverless
   (HTTP-only subset) — and WoWSP clients should be able to point at
   it by domain.
2. **战绩查询 (stats lookup) is slow where the game is played.** Every
   lookup today goes desktop → WG/Lesta/vortex/clans upstreams
   directly (see `commands/wg_realm.rs`); in CN the vortex transport
   crawls at evening peak and the whole ecosystem feels broken. A
   server-side caching proxy — official node, self-hosted nodes, and
   nodes sharing cached content with each other — turns one player's
   slow 30 s fetch into everyone's 100 ms cache hit.
3. **No single node should be a single point of failure.** Nodes
   discover each other through a broadcast server list (seeded at the
   official node, subscribable from any node) and exchange cached
   lookups content-addressed, so a community node serves data it
   never fetched itself.

## 2. Node capability model

Every WoWSP server deployment answers `GET /api/health` with the
existing manifest plus a `capabilities` object and a `node` block.
Old clients ignore the new keys; new clients probe before use.

```json
{
  "ok": true,
  "provider": "wowsp-gateway",
  "name": "WoWSP Gateway",
  "version": "0.5.0",
  "notice": null,
  "capabilities": {
    "gateway": true,
    "lookup": true,
    "peers": true,
    "blocks": true
  },
  "node": {
    "id": "8f14e45fceea167a5a36dedd4bea2543",
    "role": "official",
    "sync": true,
    "peersUpstream": "https://wowsp.langyo.xyz"
  }
}
```

| Capability | Meaning | Worker | Native | Vercel |
| --- | --- | --- | --- | --- |
| `gateway` | `/gateway/*` battle-push WebSocket namespace | ✔ | ✔ | — (no WS on edge) |
| `lookup` | `/api/lookup/*` stats-cache proxy | ✔ | ✔ | ✔ |
| `peers` | `/api/peers/*` registry (list + announce) | ✔ | ✔ | ✔ |
| `blocks` | `/api/blocks/*` (+`/ipfs/*` alias) content store | ✔ | ✔ | ✔ (memory or KV) |

- `node.id` — 32 lowercase hex, stable per deployment (native: random,
  persisted in the data dir; Worker: cached in KV under `node:id`).
  Not a secret; it lets mesh telemetry tell restarts from different
  nodes apart.
- `node.role` — `official` | `community` (informational).
- `node.sync` — whether this node pulls blocks from peers on a local
  cache miss (§5.4).
- `node.peersUpstream` — where this node subscribes the server list
  from (official default); also informational for humans.

Absence of the whole `capabilities` object (an old deployment or a
foreign 200) means "gateway only" — the lookup client treats the node
as unusable for stats and moves on.

## 3. Lookup namespace — `/api/lookup/*`

### 3.1 Route

```
GET|POST /api/lookup/fetch?url=<percent-encoded absolute upstream URL>
```

- Method mirrors the upstream method. A POST forwards the request body
  (≤ 8 KiB) verbatim.
- `url` MUST be `https` and its host MUST be on the stats allowlist
  (§3.2); anything else answers **403** `{"error":"forbidden_host"}`.
- Upstream fetch budget: 15 s total, 8 MiB response cap. Bodies over
  the cap pass through UNCACHED (streamed once, not stored).
- Upstream failure answers **502** `{"error":"upstream_failed"}` — the
  client falls back to its direct chain.
- User-Agent: the browser-shaped UA the app itself sends (CN WAFs
  reject non-browser UAs) — constant in `relay-core`, mirrored by
  every transport.

### 3.2 Host allowlist (single source: `relay-core::lookup`)

Exactly the stats family of `res/config/upstream-endpoints.json`:

```
api.korabli.su            api.worldofwarships.eu    api.worldofwarships.com
api.worldofwarships.asia  vortex.korabli.su         vortex.worldofwarships.eu
vortex.worldofwarships.com vortex.worldofwarships.asia
vortex.wowsgame.cn        clans.wowsgame.cn
api.wows-numbers.com      v3-api.wows.shinoaki.com  api.wows.yuyuko.dev
```

Redirects: followed, but the FINAL host must equal the original host
(native transport enforces; the Worker fetch follows same-host
redirects in practice — documented residual risk, the allowlist hosts
only ever redirect onto themselves).

### 3.3 Cache key, envelope, TTLs

The cache key is the CID (§4.1) of the canonical request line. The
pinned spelling — the brackets in the original
`"<METHOD> <url>[<sha256(body)>]"` wording were OPTIONAL-FIELD
notation, never literal characters; re-implementations of the bracket
form are a compatibility bug:

- a GET line is exactly `GET <url>` — two fields, one space between
  them, nothing after the url;
- a POST line is `POST <url> <sha256hex>` — the lowercase sha256 hex
  of the forwarded body rides as a THIRD space-separated bare-hex
  field (64 chars, no prefix, no brackets).

The method is uppercased; the url is byte-exactly as the client
spelled it (two spellings of one upstream URL are two cache entries).
The spelling is pinned on both sides of the Rust/TS seam —
`relay-core`'s unit tests and the cross-implementation fixture
`packages/relay-vercel/test/policy.fixture.json` carry the same
canonical-line and CID vectors (each side pins them independently:
`relay-core` in its own test module, the TS adapter in the fixture),
so drift from the pinned spelling fails whichever side disagrees.

Stored envelope (JSON):

```json
{
  "v": 1,
  "status": 200,
  "contentType": "application/json",
  "bodyB64": "…",
  "fetchedAt": 1732185600,
  "ttl": 120,
  "upstream": "vortex.wowsgame.cn",
  "line": "GET https://vortex.wowsgame.cn/api/accounts/503224851/"
}
```

The optional `line` member carries the canonical request line this
block's CID addresses — the §4.2/§8 mesh-verification anchor as
actually implemented. Nodes write it on every row they mint; a
PEER-sourced row without it MUST be rejected fail-closed (there is
nothing to verify the CID against), and a row carrying it is verified
by recomputing the CID over it. Foreign/legacy rows without the
member still parse — and re-serialize without it — so older rows stay
byte-compatible when re-served.

TTL by purpose (host + path prefix classification, pure function in
`relay-core::lookup`, mirrored by the Vercel adapter and pinned by a
shared fixture test):

| Upstream | Path shape | TTL |
| --- | --- | --- |
| vortex | `/api/accounts/<id>/ships/…`, `/api/accounts/<id>` | 120 s |
| vortex | search / autocomplete | 600 s |
| clans.wowsgame.cn | any | 600 s |
| WG/Lesta API | `/wows/account/*` | 120 s |
| WG/Lesta API | `/wows/clans/*`, seasons | 600 s |
| WG/Lesta API | `/wows/encyclopedia/*` | 86400 s |
| api.wows-numbers.com | expected values | 86400 s |
| yuyuko/shinoaki | ban list | 86400 s |
| anything else on the allowlist | — | 300 s |

### 3.4 Response headers

- Original `content-type` (default `application/json`).
- `cache-control: public, max-age=<ttl remaining>` — edge caches and
  browsers may join the party.
- `x-wowsp-cache: hit | miss | peer-hit` and `age: <seconds>` — the
  client surfaces provenance in diagnostics.
- `access-control-allow-origin: *` (the stats family is public data).
- Worker transport additionally fronts KV with the edge Cache API
  (synthetic-key `https://lookup.edge/<cid>`, the `digests.rs`
  pattern) so a hot fleet burns no KV reads.

### 3.5 Abuse budget

Per-IP rate limit on `/api/lookup/*`: 240 requests/hour (a
`LookupRate` SQLite Durable Object on the Worker — NOT a KV
counter, which would cost one PUT per request against the free KV
write budget — in-memory+SQLite natively, Upstash on Vercel). 429
carries `retry-after`. Operator override: `LOOKUP_RATE_PER_HOUR`.

## 4. Content-addressed blocks — `/api/blocks/*`

### 4.1 CID scheme (IPFS-compatible content addressing)

```
cid = CIDv1(raw, sha2-256(multihash 0x12 0x20 || sha256(canonical_request_line)))
```

base58btc spelling in URLs. This is the standard IPFS CID layout for
raw bytes: a wowsp node's block store is addressable by the same CIDs
an IPFS node would produce for the same content, and `/ipfs/<cid>`
(§4.2) makes every wowsp server literally an IPFS HTTP gateway for
its blocks. Embedding kubo is NOT part of v1 (Workers cannot); VPS
operators who want full IPFS participation may pin the block files
themselves — the on-disk layout (one file per CID under
`blocks/`, content = the envelope JSON) is documented for that.

### 4.2 Routes

```
GET /api/blocks/<cid>        → the envelope JSON (404 unknown)
GET /api/blocks/<cid>/raw    → decoded body bytes with stored content-type
GET /ipfs/<cid>              → alias of /raw (IPFS gateway path convention)
```

Verification is line-based, as implemented: the CID addresses the
canonical request line, so body authenticity rides the envelope's own
`line` field (§3.3) — at ingress, a peer-sourced row must carry the
exact line the requester computed, and recomputing the CID over that
line must reproduce the CID asked for. A peer row without the field
fails closed; wrong content fails the hash check and is dropped,
never served — a malicious peer cannot poison the mesh.

### 4.3 Eviction

Blocks expire with their TTL (+ 24 h grace for late peer hits);
expiry is lazy where it landed (native: a periodic housekeeping
sweep; Worker: checked on read — an expired object is a miss and is
deleted best-effort right then, refills overwrite, deliberately no
sweep cron; Vercel: Upstash TTL). No quota accounting in v1 — the
rate limit is the abuse brake, storage is bounded by the TTL.

## 5. Peer registry & mesh sync — `/api/peers/*`

### 5.1 The list

```json
GET /api/peers
{
  "v": 1,
  "generatedAt": 1732185600,
  "peers": [
    {
      "url": "https://wowsp.example.org",
      "capabilities": { "gateway": true, "lookup": true, "peers": true, "blocks": true },
      "role": "community",
      "nodeId": "8f14…",
      "addedAt": 1732185600,
      "lastSeenAt": 1732185700,
      "notice": "XX军团节点"
    }
  ]
}
```

- `cache-control: public, max-age=60`, `etag` for cheap revalidation,
  CORS-open.
- Any node can serve a list. A node's view = its own registry table ∪
  its `peersUpstream`'s list (official by default; configurable), own
  rows winning. This is the gossip: self-hosted nodes SUBSCRIBE to the
  official broadcast list (and may point `peersUpstream` at any other
  node — including another self-host).

### 5.2 Announce (the handshake)

```
POST /api/peers/announce   {"url": "https://wowsp.example.org", "contact": "optional"}
```

1. Shape gate: `https` URL, host not an IP literal (public mesh =
   names only; LAN/http nodes stay private, §5.3), ≤ 253 chars.
2. Liveness callback: the registry fetches `GET {url}/api/health`
   (10 s budget) and records the answered `capabilities` + `node.id`.
   Unreachable or foreign → `{"ok":true,"listed":false,"reason":…}`
   (200 — announce is best-effort, never an error to the caller).
3. The row lives 48 h; re-announcing refreshes `lastSeenAt`. Registry
   caps at 128 peers (oldest-`lastSeenAt` evicted).
4. Rate limit 10 announces/hour/IP.
5. The OFFICIAL registry is the seed everyone subscribes; community
   registries accept announces too (operators may disable with
   `PEERS_ACCEPT_ANNOUNCES=false`).

Implementation realities that are now contract: peer rows expire
LAZILY at read time — a row lives 48 h from its `lastSeenAt`,
expired rows simply stop appearing in reads, and the next
announce-driven rewrite prunes them from the stored document for
good. On the Worker the whole own registry is ONE KV document (key
`peers:own`, the entire row vector) for quota economics — one read
per list render, one write per accepted announce — with the upstream
subscription cached a minute under `peers:upstream` and the list
render itself fronted by a 60 s edge-Cache entry.

### 5.3 Private / LAN nodes

An http or IP-literal URL is never published in a public list. A
native node keeps such rows in its own table (marked
`"private": true`, excluded from its `/api/peers` output) so a LAN
fleet can still mesh: clients on that LAN add the node as a cache
server directly; other LAN nodes point `peersUpstream` at it.

### 5.4 Pull-through sync (wave-1 "P2P data sync")

When a lookup misses LOCALLY and `node.sync` is on:

1. Compute the CID, ask up to `SYNC_PEERS_MAX` (default 3) peers from
   the list (own table first, then upstream's), `GET
   {peer}/api/blocks/<cid>`, 3 s budget each.
2. Verify the CID against the request line, store locally, serve with
   `x-wowsp-cache: peer-hit`.
3. All misses → real upstream as usual.

Two implementation realities are contract as well: a peer-served
block's TTL is RECLASSIFIED locally — the served `ttl` is
`min(peer claim, classify_ttl)` over the §3.3 table, so a peer's
claim can only shrink the window, never extend it — and
sync-candidate selection is own-table-first (own registry rows in
list order), falling back to DETERMINISTIC-random seeding over the
merged list — ordering keyed by sha256(url, cid, hour bucket) — when
the own registry is empty, so a hostile upstream list cannot
monopolize the first `SYNC_PEERS_MAX` slots.

v1 sync is lazy (pull on demand) and content-verified — no background
gossip jobs, no push, no want-list protocol. Those stay future work
(documented here so the route names do not get re-invented).

## 6. Client integration (desktop + phone)

### 6.1 Config (`network-config.toml`, `NetworkConfig`)

```toml
statsCacheEnabled = true
statsCacheServers = ["https://wowsp.langyo.xyz"]     # ordered, user-managed
statsPeerAutodiscover = true
```

The keys follow `network-config.toml`'s canonical camelCase (the IPC
shape doubles as the TOML key set there — one spelling everywhere); the
Rust fields are the snake_case `stats_cache_*` trio.

- Sanitized like the mirror ladders (https-only, loopback http
  tolerated, trim, dedupe, cap 8).
- The default entry is the official node — the same
  `BUILTIN_WORKER_ROOT_URL` constant the apps already pin
  (`packages/app/tauri/src/commands/gateway/urls.rs`), so a fresh
  install is cache-served without typing anything. The settings
  surface is the **缓存服务器 / Cache servers** pane (settings id
  `cacheServers`, the connection group; §6.3).
- `stats_peer_autodiscover`: when on, the client periodically
  subscribes `GET {official}/api/peers`, capability-filters for
  `lookup`, probes the top entries and uses up to 3 verified
  community nodes AFTER the user's own list (never before it). The
  settings page discloses this in plain text; the toggle is one click
  away.

### 6.2 Transport hook (`commands/upstream_health.rs`)

For allowlisted stats URLs, before the existing proxy→direct chain:

```
for server in [user servers…] ++ [autodiscovered…]:
    GET {server}/api/lookup/fetch?url=<enc>     # 6 s budget, full body
    2xx → done (parse as if the upstream answered)
non-2xx/timeout → next server → … → existing chain
```

- The hook lives in the one choke point every stats request already
  rides (`recorded_get` / `get_with_fallback` / `send_with_fallback`)
  — no per-call-site changes.
- Upstream health accounting records ONLY direct-path outcomes (a
  cache hit must not flatter the upstream's health row).
- Session/single-flight/disk caches are untouched — they sit ABOVE
  this hook and keep working.

### 6.3 Probe + settings surface

- New command `stats_cache_probe` (mirrors `github_mirror_probe`):
  per-server `{url, ok, latencyMs, capabilities, error}`.
- New settings pane **缓存服务器 / Cache servers** (connection group):
  official node pinned first, user rows (add/remove/drag-reorder/
  probe pills), test-all, autodiscover toggle, and a self-deploy
  hint card linking the ops guide. i18n in all 8 locales.

## 7. Deployment matrix

| Platform | Package | Capabilities | Storage |
| --- | --- | --- | --- |
| Cloudflare Workers | `crates/relay-worker` (wasm) | all four | KV (single-doc registry + counters caches, edge-Cache-fronted) + R2 (blocks, bucket `wowsp-lookup-blocks`) + `LookupRate` SQLite DO (rate limits) + gateway DOs |
| VPS / LAN / Docker | `crates/relay-server` (native axum) | all four | SQLite + memory |
| Vercel edge | `packages/relay-vercel` (TS adapter) | lookup + peers + blocks | Upstash KV REST (or per-instance memory) |

Worker enable recipe — the vars/bindings the official
`wrangler.toml` binds, and what a self-host adds to turn the mesh
on. The mesh is ON when `LOOKUP_ENABLED` is ABSENT (`"0"` gates
the six mesh routes to 404 and lowers `/api/health` capabilities to
false). Bind `LOOKUP_KV` (registry documents, `node:id`, announce
counters), `LOOKUP_R2` plus the one-time `npx wrangler r2 bucket
create wowsp-lookup-blocks` (block envelopes), and the
`LOOKUP_RATE` Durable Object binding with migration v6
(`new_sqlite_classes = ["LookupRate"]` — the per-IP hourly budget).
Optional vars: `PEERS_UPSTREAM` (subscribe the broadcast list;
official default), `NODE_ROLE`, `PEERS_ACCEPT_ANNOUNCES`,
`SYNC_PEERS_MAX`, `LOOKUP_RATE_PER_HOUR`. `/ipfs/*` additionally
needs its own `run_worker_first` entry next to `/api*` — the
IPFS-gateway path convention sits outside `/api*` on purpose.

- The native server reuses `relay-core` state machines (gateway
  auth/channel, lookup policy, peers policy) with in-process
  implementations of the DO/KV seams: tickets in memory (120 s TTL),
  channels as broadcast hubs, snapshots mirrored to SQLite.
- Configuration: `WOWSP_SERVER_*` env vars (bind, data dir, public
  URL, role, notice, peers upstream, sync toggles, gateway password /
  Turnstile) + optional `wowsp-server.toml`. Defaults are safe:
  `127.0.0.1:8787`, sync ON for public nodes, announces ON.
- The Vercel adapter mirrors ONLY the allowlist/TTL/CID policy (pinned
  by a fixture test shared with `relay-core`) — deployable with zero
  Rust toolchain: `vercel deploy` from the package.

## 8. Security & abuse model

- **SSRF**: the lookup proxy is allowlist-only (13 hosts), https-only,
  same-host redirects, 8 MiB/15 s caps. It is never an open proxy.
- **Mesh poisoning**: blocks are content-verified by CID — a lying
  peer's row fails the hash check and is dropped, never served.
- **Registry poisoning**: announce requires a live health callback,
  https names only, 48 h TTL, 128-peer cap, 10/h/IP rate limit;
  operators can close their registry.
- **Privacy**: stats-family data is public game data (the same bytes
  the official sites serve anonymously). Nodes store cached documents
  only — no query logs, no client identifiers in the mesh. Battle-push
  frames and feedback NEVER enter the mesh.
- **Client trust**: cache servers are information sources for public
  data; a hostile node can at worst serve stale/wrong STATS, which the
  client's own sanity checks (envelope shape, status gates) already
  police — same trust level as any upstream. User-managed order means
  the user's own node always wins.

## 9. Wire reference (quick table)

| Route | Method | Meaning |
| --- | --- | --- |
| `/api/health` | GET | manifest + `capabilities` + `node` |
| `/api/lookup/fetch?url=` | GET/POST | stats-cache proxy (allowlisted) |
| `/api/blocks/<cid>` | GET | cached envelope by CID |
| `/api/blocks/<cid>/raw` | GET | decoded body bytes |
| `/ipfs/<cid>` | GET | IPFS-gateway alias of `/raw` |
| `/api/peers` | GET | broadcast server list |
| `/api/peers/announce` | POST | self-announce (liveness-checked) |
| `/gateway/*` | — | unchanged (`gateway-push.md`) |
