# relay-vercel — the WoWSP cache-mesh edge adapter

A deployable Vercel project implementing the **HTTP-only subset** of the
cache-mesh contract: `/api/health`, `/api/lookup/fetch`, `/api/peers`,
`/api/peers/announce`, `/api/blocks/<cid>` (+ `/raw`) and the
`/ipfs/<cid>` alias. Pure TypeScript edge functions on Web-standard
APIs (`fetch`, `URL`, `crypto.subtle`, `Request`/`Response`) — no Rust
toolchain, no build step: connect a repo, set env vars, deploy.

- Protocol contract (single source of truth):
  [`docs/en/designs/cache-mesh.md`](../../docs/en/designs/cache-mesh.md)
- Ops guide for people running nodes:
  [`docs/en/guides/self-host-gateway.md`](../../docs/en/guides/self-host-gateway.md)
- Sibling implementations: the Cloudflare Worker and the native VPS/LAN
  server share the same policy via `relay-core`; this adapter mirrors
  the policy in TypeScript and is pinned to the same fixture.

## Deploy (fork → import → env → done)

1. Fork the repo (or push a branch containing `packages/relay-vercel`).
2. In Vercel: **Add New… → Project**, import the fork. Set **Root
   Directory** to `packages/relay-vercel`. Framework preset stays
   **Other** — Vercel compiles the `api/` directory itself.
3. Create an Upstash KV database (below) and add its env vars.
4. Deploy. Your node answers at `https://<project>.vercel.app/api/health`.

Each `api/*.ts` file carries `export const config = { runtime: "edge" }`.
That per-file export is the current documented mechanism for the edge
runtime (the Vercel docs, "Edge Runtime" / "Configuring the Runtime");
`vercel.json`'s `functions.runtime` key is reserved for custom npm
runtimes, so it is not used here.

CLI route instead of the web import:

```bash
cd packages/relay-vercel
npx vercel link
npx vercel env add KV_REST_URL
npx vercel env add KV_REST_TOKEN
npx vercel deploy --prod
```

## Upstash KV setup

The adapter stores envelopes, peer rows and rate counters in Upstash KV
over its REST API (plain `fetch`, no SDK):

1. Vercel dashboard → **Storage → Upstash KV → Create Database**
   (or <https://console.upstash.com> directly).
2. Copy the **UPSTASH_REDIS_REST_URL** and
   **UPSTASH_REDIS_REST_TOKEN** values into the project env vars
   `KV_REST_URL` / `KV_REST_TOKEN`.

### ⚠️ Memory mode (no KV env) is per-instance

Without `KV_REST_URL` + `KV_REST_TOKEN` the adapter falls back to an
in-memory `Map`. **Every edge isolate then keeps its own cache, peer
table and rate counters** — hits are not shared, counters reset on
cold starts, and the 128-peer registry cap cannot evict globally. That
is fine for `vercel dev`, tests and quick previews; a real deployment
must attach Upstash KV.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `KV_REST_URL` / `KV_REST_TOKEN` | — | Upstash REST access; absent = memory mode. |
| `NODE_ID` | random per isolate | `node.id` in the manifest (32 hex). Set it: otherwise every cold start looks like a new node (§2). |
| `NODE_ROLE` | `community` | `official` or `community` (informational). |
| `NOTICE` | — | Operator notice surfaced in `/api/health`. |
| `PEERS_UPSTREAM` | `https://wowsp.langyo.xyz` | Where the broadcast list is subscribed from; empty string disables (own table only). |
| `PEERS_SYNC` | `true` | Pull blocks from peers on a local miss (§5.4). |
| `SYNC_PEERS_MAX` | `3` | Peers asked per miss. |
| `PEERS_ACCEPT_ANNOUNCES` | `true` | `false` closes the registry (announce answers 403). |
| `LOOKUP_RATE_PER_HOUR` | `240` | Per-IP hourly lookup budget (§3.5). |
| `UPSTREAM_OVERRIDE` | — | JSON map allowlisted host → base URL, e.g. `{"vortex.wowsgame.cn":"http://127.0.0.1:8800"}`. **Test/air-gapped use only** — the allowlist gate still applies to the original host; never set in production. |

## Capabilities and limits

| Route | Status | Notes |
| --- | --- | --- |
| `/api/health` | ✔ | Manifest + `capabilities` + `node` (§2). |
| `/api/lookup/fetch` | ✔ | Allowlist gate, TTL cache, peer pull, upstream proxy (§3). |
| `/api/peers` / `announce` | ✔ | Broadcast list + liveness-checked handshake (§5). |
| `/api/blocks/<cid>` (+`/raw`, `/ipfs`) | ✔ | Content-addressed store (§4). |
| `/gateway/*` | — | **No WebSocket namespace on edge functions**; `capabilities.gateway` is `false`. Use the Worker or native server for battle push. |

Adapter policy details worth knowing (all documented in the source):

- The canonical request line uses the upstream URL string **exactly as
  supplied** in the `url=` parameter; the fixture pins this so the Rust
  and TS sides derive identical CIDs.
- The lookup gate additionally rejects userinfo and explicit ports in
  the `url` (canonical lines are cache keys; credentials and non-default
  origins must never enter them).
- Announce additionally requires a dotted hostname and an origin-shaped
  URL (no path/query): the callback is `{url}/api/health`, and §5.3
  keeps LAN/http names private anyway.
- Non-2xx upstream statuses answer `502 upstream_failed` (§3.1: the
  client falls back to its direct chain either way).
- Rate-limit counters fail OPEN on KV errors: budgets are abuse brakes,
  not auth. Block-store reads/writes degrade the same way (read error
  → cache miss; write error → serve the document anyway).
- Stored envelopes carry the optional `line` field (the canonical
  request line, relay-core PR #2067). Own writes always include it;
  peer-pulled rows are trusted ONLY when the field is present and
  hashes to the requested CID — a row without it fails closed to the
  next peer / the upstream fetch.

## Development

```bash
pnpm install                  # at the repo root
pnpm --filter @wowsp/relay-vercel test        # vitest, node env, 91 cases
pnpm --filter @wowsp/relay-vercel lint        # oxlint (repo .oxlintrc.json)
pnpm --filter @wowsp/relay-vercel typecheck   # tsc --noEmit, strict
```

### The shared policy fixture

`test/policy.fixture.json` pins the allowlist-adjacent policy to data:
canonical request lines, the CIDs they derive to, and one vector per
`§3.3` TTL row plus the defaults. relay-core (wave A) consumes the same
fixture, so once it lands, drift between the two policy cores fails CI
on whichever side disagrees; until then this file pins the TypeScript
implementation (the envelope `line` field and the fail-closed peer-row
verification already mirror the relay-core decision). The CID vectors
were verified independently at authoring time (layout
`0x01 0x55 0x12 0x20` + sha256 of the line, base58btc spelling).
