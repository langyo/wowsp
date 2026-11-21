# wowsp-server (relay-server)

The **native WoWSP server** — the same capability set as the official
Cloudflare Worker node, as one self-hostable binary for a VPS, a LAN box
or Docker (design contract: `docs/en/designs/cache-mesh.md`, §7
“deployment freedom”). One `relay-core` policy crate, many transports:
the Worker keeps its Durable Objects, this crate replaces them with
in-process state + SQLite.

| Route | Meaning |
| --- | --- |
| `GET /api/health` | manifest + `capabilities` + `node` block (§2), `cache-control: no-store` |
| `GET\|POST /api/lookup/fetch?url=` | stats-cache proxy: allowlist gate (§3.2, 13 hosts), 15 s / 8 MiB budgets, browser UA, `x-wowsp-cache: hit\|miss\|peer-hit` + `age`, `cache-control: public, max-age=<remaining>`, CORS `*` |
| `GET /api/blocks/<cid>` | the stored envelope JSON (§4.2) |
| `GET /api/blocks/<cid>/raw` | decoded body bytes with the stored content-type |
| `GET /ipfs/<cid>` | IPFS-gateway alias of `/raw` |
| `GET /api/peers` | the broadcast server list: own table ∪ peersUpstream's list, private rows excluded, cap 128, ETag + `max-age=60` (§5.1) |
| `POST /api/peers/announce` | self-announce: shape gate → liveness callback → 48 h row; 10/h/IP (§5.2) |
| `GET /gateway/health` | battle-push namespace config doc (Turnstile/password demands) |
| `POST /gateway/session` | auth exchange → single-use ticket (120 s), password lockout 5/min → 5 min |
| `WS /gateway/pub?route=&ticket=[&hostId=]` | desktop publisher — one per channel, a different persistent hostId replaces the first (close 1000 `replaced by a new host`) |
| `WS /gateway/sub?route=&ticket=` | phone subscriber — hello → host presence → snapshot; battle frames fan out verbatim (≤ 64 KiB, over → close 1009), 32-subscriber cap, server-side 30 s keepalives |

Everything else — including the maintainer-only namespaces
(`/api/digests`, feedback, erp, qqbot, sponsors, replays) — answers
404: those surfaces stay on the official node.

Every policy decision is relay-core's (the wave that landed with the
cache-mesh worker namespaces): the lookup allowlist, the TTL table, the
canonical request line + CID derivation, the envelope shape, the peers
URL gates / merge / budgets, the manifest capability + node docs, and
the gateway's auth/channel state machines and frame builders — this
crate consumes `relay_core::lookup` / `relay_core::peers` /
`relay_core::manifest` / `relay_core::gateway` directly and owns
only transport, storage and configuration.

## HTTP, not HTTPS (by design)

The app's own URL policy is https-only-except-loopback; this SERVER is
plain-http friendly so a LAN box works with zero certificate setup.
Serve HTTP as given — **TLS termination is your reverse proxy's job**
(Caddy/nginx/Cloudflare). Public deployments SHOULD front the server
with HTTPS before pointing clients at it. The per-IP budgets and the
gateway password lockout key on the caller's IP: by default that is
the SOCKET address (proxy headers are client-spoofable and therefore
ignored); behind a reverse proxy that OVERWRITES `X-Real-IP` /
`X-Forwarded-For`, set `WOWSP_SERVER_TRUST_PROXY=true` so distinct
clients get distinct budgets.

## Configuration

Precedence: `WOWSP_SERVER_*` environment variable > optional
`wowsp-server.toml` in the working directory > defaults. Secrets
belong in the service environment, never in a tracked file.

| Env var (toml key) | Default | Meaning |
| --- | --- | --- |
| `WOWSP_SERVER_BIND` (`bind`) | `127.0.0.1:8787` | listen address — `0.0.0.0:8787` for LAN/public |
| `WOWSP_SERVER_DATA_DIR` (`data_dir`) | `./wowsp-server-data` | SQLite db + node-id file (created on startup) |
| `WOWSP_SERVER_PUBLIC_URL` (`public_url`) | unset | this deployment's public base URL. When set (and https + name-shaped) the node lists itself in its own registry and best-effort re-announces to peersUpstream every sweep; an http/IP-literal value is kept as a private row (§5.3) |
| `WOWSP_SERVER_ROLE` (`role`) | `community` | informational (`official\|community`), rides `node.role` |
| `WOWSP_SERVER_NOTICE` (`notice`) | unset | operator message riding both health documents |
| `WOWSP_SERVER_GATEWAY_PASSWORD` (`gateway_password`) | unset | gateway password (absent ⇒ off; 5 failures/min → 5 min IP lock) |
| `WOWSP_SERVER_TURNSTILE_SITEKEY` / `_SECRET` | unset | Turnstile gating for /gateway/session (siteverify via reqwest) |
| `WOWSP_SERVER_PEERS_UPSTREAM` (`peers_upstream`) | `https://wowsp.langyo.xyz` | where the server list is subscribed (§5.1) |
| `WOWSP_SERVER_SYNC` (`sync`) | `true` | pull blocks from peers on a local cache miss (§5.4) |
| `WOWSP_SERVER_SYNC_PEERS_MAX` (`sync_peers_max`) | `3` | peers asked per miss (3 s budget each) |
| `WOWSP_SERVER_PEERS_ACCEPT_ANNOUNCES` (`peers_accept_announces`) | `true` | accept `POST /api/peers/announce` (off → 403) |
| `WOWSP_SERVER_LOOKUP_RATE_PER_HOUR` (`lookup_rate_per_hour`) | `240` | per-IP hourly budget on /api/lookup/* |
| `WOWSP_SERVER_NODE_ID_FILE` (`node_id_file`) | `node-id.txt` | node-id file name inside the data dir |
| `WOWSP_SERVER_TRUST_PROXY` (`trust_proxy`) | `false` | trust `X-Real-IP` / the first `X-Forwarded-For` hop for the per-IP budgets and the gateway password lockout. OFF by default: the headers are client-spoofable whenever the server is directly exposed, and a forged one resets every budget. Enable ONLY behind a reverse proxy that OVERWRITES those headers |
| `WOWSP_SERVER_UPSTREAM_OVERRIDE` (`[upstream_override]` map) | empty | **test/air-gap only**: `host1=base1,host2=base2` remap of OUTBOUND dials (lookup upstreams, announce liveness callbacks, peer block fetches). Lets the integration tests stand a mock in for an allowlisted host and an air-gapped LAN pin a name to a local address. |

Example `wowsp-server.toml`:

```toml
bind = "0.0.0.0:8787"
data_dir = "/var/lib/wowsp"
public_url = "https://wowsp.example.org"
notice = "XX军团节点"

[upstream_override]
"vortex.wowsgame.cn" = "http://192.0.2.10:8788"
```

## Storage

One `wowsp-server.db` (SQLite, WAL) in the data dir:
`blocks(cid, envelope, expires_at, request_line)` — cached envelopes
keyed by CID with the TTL + 24 h grace (§4.3) and the canonical request
line for the §4.2 serve-time content check;
`peers(url, doc, private, added_at, last_seen_at)` — the 48 h announce
registry (128-row cap); `battle_snapshots(route, frame, updated_at,
expires_at)` — the `battle:<route>` KV-mirror stand-in serving cold
subscribers; `rate_counters(key, count, window_start)` — the hourly
windows (in-memory-first, written through so a restart keeps the
budget). The node id is 16 random bytes hex in `node-id.txt`, minted
once. A housekeeping task sweeps expired rows every 10 minutes;
SIGTERM/SIGINT drain in-flight requests (graceful shutdown).

## Build & run

```sh
just run-server           # cargo run -p relay-server --release
just build-server         # release build only
```

or directly:

```sh
cd packages/pairing-relay && cargo run -p relay-server --release
```

Smoke check: `curl http://127.0.0.1:8787/api/health` answers the
manifest with `capabilities` all true.

## Docker

```sh
cd packages/pairing-relay/crates/relay-server
docker compose -f docker-compose.yml.example up -d --build
```

Multi-stage (`rust:1-bookworm` → `gcr.io/distroless/cc`), volume
`/data`, non-root user, `EXPOSE 8787`. Read the compose file's
`0.0.0.0` warning before exposing the port.

## Checks

```sh
cd packages/pairing-relay
cargo test -p relay-core                                    # policy core
cargo check --target wasm32-unknown-unknown -p relay-worker # wasm crate only
cargo check -p relay-server                                 # host crate
cargo test -p relay-server                                  # unit + integration
```

`relay-server` is HOST-ONLY (axum/tokio are the services; rusqlite's
bundled SQLite does not build for wasm32) — the wasm32 check is scoped
to the wasm crates, `just check-relay` runs all four commands.

