# wowsp-pairing-relay

A Cloudflare Worker that is BOTH the WoWSP **website host** and the
**internet pairing gateway** (a phone app pairs with a WoWSP desktop from
outside the desktop's local network — cellular / another Wi-Fi). Static
assets (website + docs) answer `/` via Workers Static Assets; the pairing
API lives under `/api/*`. The gateway is a rendezvous + raw byte tunnel:
both ends dial OUTBOUND, the worker never dials anything, and the tunneled
traffic is the desktop pairing server's ordinary HTTP protocol,
byte-for-byte.

The worker is **Rust compiled to WebAssembly** (the
[`workers-rs`](https://github.com/cloudflare/workers-rs) `worker` crate,
target `wasm32-unknown-unknown`). Two crates:

- `crates/relay-core` — the pure protocol/policy core (message types,
  code directory state machine, room connection accounting, manifest,
  route classification). No Cloudflare types, no wasm-bindgen; every
  TTL / rate-limit / one-code-per-host / cap rule is a plain state
  machine over an injected clock and RNG, unit-tested on the host.
- `crates/relay-worker` — the thin wasm shell: routing, the two
  Durable Objects, WebSocket glue. Every decision delegates to
  relay-core.

> This is a **hidden built-in service**, not something users configure. The
> production deployment is bound to the custom domain
> **`wowsp.langyo.xyz`** and both apps hardcode the host (desktop:
> `BUILTIN_RELAY_ROOT_URL` in `packages/app/tauri/src/commands/pairing_relay.rs`,
> an `https://` root the v2 manifest and WebSocket base derive from; webui:
> the `wss://` spelling in `stores/pairing.ts` `PAIRING_GATEWAY_WS`).
> The only supported development override is the undocumented
> `WOWSP_RELAY_URL` environment variable on the DESKTOP (e.g.
> `WOWSP_RELAY_URL=ws://127.0.0.1:8787` against `wrangler dev`); there is no
> UI field anywhere.

## How it works (v2 — code-coordinated, manifest-discovered)

```
phone ──wss control/data ──▶ WORKER (this package) ◀──wss── desktop bridge
  │                                                            │
  └─ raw HTTP request bytes ──▶ [byte pipe] ──▶ 127.0.0.1:58041┘
```

1. **Discovery** — `GET /api/health` is the merged liveness + discovery
   document (like the celestia services): provider id, the gateway's
   `version`, the `minClientVersion` it demands, protocol versions, the
   relay base path (`/api/relay`), the feature list, an optional operator
   `notice`, and `upstream` (see
   [Forwarding station](#forwarding-station-mode-gateway_upstream) below).
2. **Host** — the desktop mints a random 64-hex **room key** and connects
   `WS /api/relay/control?room=<key>&role=host`. It may open with a
   `{"type":"hello","protocol":"v1","hostId":"<hex>"}` handshake (answered
   with `{"type":"welcome",…,"capabilities":["pin-allocation","byte-tunnel"]}`;
   clients that skip hello keep working — v1 compatibility). It then sends
   `{"type":"allocate"}`; the Room DO asks the singleton **Directory** to
   mint a CSPRNG 6-digit code bound to `{room, hostId}` and the reply
   `{"type":"code","code":"XXXXXX","room":"<key>"}` is what the desktop
   displays. The bridge keepalives every **30 s** (any inbound text also
   refreshes the room's 15-minute idle TTL).
3. **Client** — the phone resolves its code via
   `WS /api/relay/resolve?code=NNNNNN` → `{"type":"room","room":"<key>"}`, joins
   the room's control channel as `role=client` (greeted
   `{"type":"ready"}` / `{"type":"waiting"}`), then per request:
   `{"type":"open","connId":"…"}` → the host is signaled
   `{"type":"conn","connId":"…"}` → both sides dial
   `WS /api/relay/data/<room>/<connId>` (`?role=host` on the desktop leg) —
   from there bytes are piped opaquely and the flow is IDENTICAL to the
   LAN protocol: `POST /pair`, `GET /api/replays`,
   `GET /api/replay/<name>`, `GET /api/gamedata`.

### Server-side pairing policy (all in `relay-core`, all unit-tested)

- **One active code per host** — allocation keys by the `hello` hostId
  (v1 fallback: the room key). Regenerating, or a desktop restart with
  the same hostId, kills the previous code instantly.
- **10-minute code TTL**, alarm-swept in the Directory DO; bindings and
  the resolved-IP claim are persisted in DO storage so they survive
  eviction.
- **Resolve-once claiming** — the first successful resolve stamps the
  client IP (from `CF-Connecting-IP`); the SAME IP may re-resolve to
  reconnect within the TTL, any other IP is refused (and is
  indistinguishable from an unknown code, so it leaks nothing).
- **Per-IP brute-force guard** — more than 10 failed resolves in a
  sliding minute rejects that IP for 60 s with
  `{"type":"error","code":"rate_limited"}` (even for valid codes).
- **Room limits** — max **4 concurrent data connections** per room
  (5th `open` gets `{"type":"error","code":"conn_limit"}`); binary
  frames are capped at **256 KiB** (`{"type":"error","code":"frame_too_large","size":N}`
  + close 1009); rooms idle >15 min are torn down by alarm; a second
  host on a room is refused (409).
- **Pre-pairing buffering** — data frames that arrive before the peer's
  socket finishes its handshake are buffered (≤256 KiB per direction)
  instead of dropped, closing the race where the phone's request beats
  the desktop's data dial.

### Route surface

| Route | Meaning |
| --- | --- |
| `/` and every non-`/api` path | the WEBSITE + docs (Workers Static Assets; SPA fallback to `index.html`) |
| `GET /api/health` | merged liveness + discovery document (see below), `cache-control: no-store` |
| `WS /api/relay/control?room=<64hex>&role=host\|client` | presence + open-request signaling + code allocation |
| `WS /api/relay/resolve?code=NNNNNN` | phone: code → room handshake (`{"type":"room",…}` / rate-limited error / 404) |
| `WS /api/relay/data/<room>/<connId>[?role=host\|client]` | the raw byte pipe |

The pre-unification spellings (`/v1/*`, `/health`, bare `/control` …) are
**retired** — the only consumers were the unreleased 0.5.0 apps, updated in
the same change.

`/api/health` (default deployment):

```json
{
  "ok": true,
  "provider": "wowsp-gateway",
  "name": "WoWSP Pairing Gateway",
  "version": "0.5.0",
  "minClientVersion": "0.5.0",
  "protocol": ["v1"],
  "endpoints": { "relay": "/api/relay" },
  "upstream": null,
  "features": ["pin-allocation", "byte-tunnel"],
  "notice": null
}
```

Clients below `minClientVersion` get a distinct update-the-app error
(`relay-core::MIN_CLIENT_VERSION` is the knob to turn when a wire change
old clients cannot talk to lands).

## Feedback pipeline (`/feedback`, `/erp`)

### QQ 通知机器人（进群验证 + 受理/结果回访）

QQ 官方机器人平台不给 QQ 号 ↔ openid 的互换接口，普通群也没有成员
查询 API——所以“进群才能反馈”通过**交互证明**实现：

1. 表单里 QQ 联系方式下方出现验证块，“获取验证码”拿一个 6 位码
   （`POST /api/feedback/qq/code`，每 IP 每小时 5 次，码 30 分钟有效）。
2. 用户在通知群里 @机器人 发送「验证 123456」（或私发，私聊同时补
   c2c openid）。回调 `POST /api/qqbot/callback`（Ed25519 验签，URL
   配置走 op 13/14）把 member/group openid 绑定到该 QQ 号（KV
   `qqbind:*`，长期）。
3. `POST /api/feedback/submit` 对 QQ 联系方式要求绑定存在，否则
   `not_verified`；邮箱联系方式不受影响。
4. 回访：受理成功 → C2C 私聊（自限额 3 条/人/月，留平台配额余量）；
   `/erp` 状态改到「已开PR」→ 群内 markdown `<@member_openid>` 单独
   @（群主动消息配额珍贵，只留给这个场景）。全部尽力而为，失败静默。
   用户随时可在群里 @机器人 发「查询」被动拉取自己的最新处理状态。

控制台配置（q.qq.com → 机器人 → 开发设置）：回调地址填
`https://wowsp.langyo.xyz/api/qqbot/callback`，把页面给的 Ed25519
种子/公钥分别 `wrangler secret put` 到 `QQBOT_ED25519_SEED` /
`QQBOT_ED25519_PUB`（app 凭证为 `QQBOT_APPID`/`QQBOT_SECRET`）。


The same worker also hosts WoWSP's self-service feedback flow. Everything
is worker-first (`run_worker_first` in `wrangler.toml` routes `/feedback`
and `/erp` past the static-asset layer):

- **`GET /feedback`** — an embedded, dependency-free form localized in the
  same nine locales as the app's `res/i18n` files (language selector with
  `?lang=`/localStorage/browser resolution) and styled with hikari's design
  tokens: `res/theme/feedback-hikari.css` is generated from the webui's
  `@celestia-island/hikari` dependency by `scripts/export_feedback_theme.py`
  (channels + scale tokens plus the default preset's light/dark palettes),
  embedded at compile time, and flipped between schemes via the same
  `data-mode` attribute the app's `useTheme` sets. A Cloudflare Turnstile
  widget guards submissions. The WoWSP desktop app's 设置 ▸ 问题反馈 pane
  links here with `?version=…&sysinfo=…&channel=desktop&lang=…` prefill
  (plus `server`/`game_id` when an account is bound; the history lookup
  link adds `focus=history`); the form itself mints a localStorage
  anonymous id and remembers the contact, server and game-ID fields.
- **`POST /api/feedback/submit`** (multipart) — normalize → Turnstile
  siteverify → KV rate limits (5/h per IP, 10/day per anonymous id, 300/day
  global) → a record in the 飞书多维表「WoWSP 反馈」(created/bootstrapped on
  first use; see below) → optional log-bundle upload via
  `drive/v1/medias/upload_all` attached to the record's 日志包 field.
- **`GET /erp`** — the maintainer's review console (admin-key gated):
  lists records, flips 处理状态, writes PR links, downloads attachments
  through `/api/feedback/attachment` (302 to a Feishu temporary URL).
- **`GET /api/feedback/list` / `POST /api/feedback/update`** — the JSON
  surface behind the console, also what fix-agents consume (header
  `X-Admin-Key`).

Anti-abuse is layered: Turnstile (human check) → KV counters (speed) →
every record starts as 待审查 and only matters once a human flips it.

### Configuration (secrets & vars)

```
npx wrangler secret put FEISHU_APP_ID        # 飞书自建应用 app_id (cli_…)
npx wrangler secret put FEISHU_APP_SECRET    # … its app_secret
npx wrangler secret put TURNSTILE_SECRET     # Turnstile widget secret key
npx wrangler secret put FEEDBACK_ADMIN_KEY   # the /erp + admin API key
# dashboard ▶ Settings ▶ Variables (plaintext vars):
#   TURNSTILE_SITEKEY        — Turnstile sitekey (public; form shows a
#                              maintenance notice until it is set)
#   FEEDBACK_ADMIN_OPEN_ID   — optional; granted full_access on the
#                              bootstrapped Bitable so a human can open it
#   FEEDBACK_BITABLE_APP_TOKEN / FEEDBACK_BITABLE_TABLE_ID — optional pin
#                              to a pre-existing base instead of bootstrap
```

The Bitable is bootstrapped by the worker on first submission: it creates
the base「WoWSP 反馈」+ the 反馈 table (schema in
`crates/relay-core/src/feedback.rs`, verified live against the Feishu
OpenAPI), caches the ids in `FEEDBACK_KV`, and — when
`FEEDBACK_ADMIN_OPEN_ID` is set — grants that user `full_access` so they
can review records in the Feishu app. The Feishu app needs the Bitable
read/write + drive upload + permission-member scopes.

A `FEEDBACK_TURNSTILE_BYPASS` **secret** exists purely for post-deploy
smoke tests: a submission whose `_bypass` field equals the secret skips
siteverify. Set it, curl a submission through, then `npx wrangler secret
delete FEEDBACK_TURNSTILE_BYPASS` — never leave it in place.

The `FEEDBACK_KV` namespace is bound in `wrangler.toml` (rate-limit
counters + the tenant-token and base-id caches; create it once with
`npx wrangler kv namespace create FEEDBACK_KV`).

## Deploy (the owner's manual step)

Prerequisites: Rust (rustup with the `wasm32-unknown-unknown` target:
`rustup target add wasm32-unknown-unknown`) and a one-time install of the
build tool:

```sh
cargo install -t worker-build worker-build
```

Then from the REPO ROOT (the worker also serves the website, so its
assets must be bundled first):

```sh
pnpm install              # once, for the workspace (wrangler)
just bundle-site          # website (+docs when lagrange is installed) → assets/
npx wrangler login        # once, from packages/pairing-relay
npx wrangler deploy       # from packages/pairing-relay
```

`just bundle-site` rebuilds `packages/website` into
`packages/pairing-relay/assets/` and, when the `lagrange` binary exists,
also renders `docs/` into `assets/docs` (without lagrange the site ships
and the docs stay on the GitHub Pages backup).

`[build] command = "worker-build --release crates/relay-worker"` in
`wrangler.toml` compiles the Rust workspace to
`crates/relay-worker/build/worker/shim.mjs` + wasm automatically
(wasm-opt is disabled via crate metadata — see the note in
`crates/relay-worker/Cargo.toml`; the bundle is ~0.9 MB raw / ~0.27 MB
gzipped, far under the Workers free-plan size limit).

**Network-restricted builds** — worker-build downloads a matching
`wasm-bindgen-cli` from GitHub releases on first use. If that download
fails on your network, install it from crates.io and point worker-build
at it (the version must match the `wasm-bindgen` crate version pinned in
this package's `Cargo.lock`, currently 0.2.128):

```sh
cargo install wasm-bindgen-cli --version 0.2.128
export WASM_BINDGEN_BIN="$(cygpath -m "$HOME")/.cargo/bin/wasm-bindgen.exe"  # Git Bash
# (plain Windows: set WASM_BINDGEN_BIN=C:\Users\<you>\.cargo\bin\wasm-bindgen.exe)
npx wrangler deploy
```

The env override is only consulted when set and resolvable; unset, it
falls back to the normal download.

Custom domain: bind `wowsp.langyo.xyz` to the `wowsp-pairing`
worker in the Cloudflare dashboard (Workers → wowsp-pairing → Settings →
Domains & Routes → Custom Domain). Until that record exists the apps
report the gateway unreachable and fall back to LAN-only pairing —
nothing breaks.

Smoke checks: `curl https://wowsp.langyo.xyz/api/health` (the JSON above)
and `curl -I https://wowsp.langyo.xyz/` (the website's `index.html`).
GitHub Pages remains a BACKUP mirror of the site; this worker is the
primary host once the custom domain is bound.

**Migrations note** — the Durable Object classes are unchanged from the
TypeScript deployment (`Room` v1 + `Directory` v2, both SQLite-backed),
so this rewrite ships **no new migration tag**: the Rust worker deploys
cleanly over the live one. Storage rows in the old v1 key format are
garbage-collected lazily on the Directory's first load
(`crates/relay-worker/src/directory.rs`, `ensure_loaded`).

## Local development

```sh
pnpm --filter @wowsp/pairing-relay dev        # wrangler dev on :8787
```

Point the desktop at it with the undocumented override
(`WOWSP_RELAY_URL=ws://127.0.0.1:8787`, see
`packages/app/tauri/src/commands/pairing_relay.rs`).

Rust-side checks (no Cloudflare account needed):

```sh
cargo test -p relay-core                            # host unit tests
cargo check --target wasm32-unknown-unknown         # both crates, wasm
just check-relay                                    # both, from repo root
```

## Forwarding-station mode (`GATEWAY_UPSTREAM`)

The gateway is a stable, hardcoded address; the exchange behind it does
not have to be. Setting the `GATEWAY_UPSTREAM` variable (dashboard →
Settings → Variables, or `[vars]` in wrangler.toml) to an absolute
`https://`/`wss://` URL switches `/api/health` to

```json
"upstream": "https://exchange.example.org/…"
```

Clients that honor the manifest then follow the upstream and stop
pairing through this gateway — a hand-off with **no app redeploy**: the
address clients dial stays `wowsp.langyo.xyz`, and if WoWSP ever
runs an official exchange (or a 360/Lesta-run one) it can take over by
flipping this one variable. Clearing the variable flips it back. Values
that are not absolute https/wss URLs are ignored (a typo must not strand
clients). `GATEWAY_NOTICE` optionally surfaces an operator message
(e.g. maintenance windows) in the same document.

## Cloudflare facts this design is built on

- **WebSockets on every plan** — outbound and inbound WebSocket support
  is available on all Workers plans, including Free.
  Source: developers.cloudflare.com/workers/runtime-apis/websockets/ and
  the Workers pricing page.
- **~100 s proxy idle cutoff** — proxied connections without traffic are
  dropped after roughly 100 s, so the desktop bridge sends keepalive
  text frames every **30 s**. Source:
  developers.cloudflare.com/workers/platform/limits/ (WebSockets).
- **32 MiB max WebSocket message** — a single message may be up to
  32 MiB on Cloudflare's edge. Our protocol keeps its own **256 KiB**
  binary-frame cap anyway (enforced server-side with an error-close
  notice): the cap is a design choice bounding per-frame buffering in
  the Room DO and keeping every tunneled write cheap, not a workaround
  for a 1 MiB platform ceiling (an earlier draft of this document
  claimed one — the real limit is 32 MiB). Source: same limits page.
- **Durable Objects on Free** — the free plan provisions SQLite-backed
  DO classes ONLY (no KV-backed classes), with 100 000 DO requests/day,
  ~13 000 GB-s duration/day, 5 M row reads + 100 k row writes/day, and
  5 GB storage per account. The $5/month minimum spend applies to the
  Workers Paid plan only — Free has no minimum. Sources:
  developers.cloudflare.com/durable-objects/platform/pricing/ and the
  Workers pricing page.
- **No hard duration cap while active** — DO duration is not capped by
  a per-invocation wall clock while the object stays active with I/O in
  flight (an open WebSocket counts); the constraint that matters is the
  GB-s/day allowance above, and SQLite-backed duration billing only
  accrues while the object is actually running. The alarm-swept
  15-minute idle TTL below is OUR bound, not a platform one.
- **~6 simultaneous outbound connections per invocation** — a Worker is
  limited to about 6 connections awaiting response headers at once.
  This gateway dials at most one subrequest at a time (the Room DO →
  Directory bind), so the cap is never in play. Source: the same
  limits page (simultaneous open connections).

### Free-tier budget math

A pairing session costs, roughly:

- resolve + 3–5 WS handshakes + ~6 DO requests per tunneled request → a
  full pairing (pair + list + pull one replay) is on the order of **a
  few dozen DO requests**;
- duration: the Directory DO lives in millisecond bursts (alarm sweeps
  + lookups); a Room DO holds sockets while a room is paired but is
  **wall-clock idle between frames** — SQLite-backed DO duration
  billing only accrues while the object is actively running, and the
  15-minute idle TTL bounds how long an abandoned room lingers.

So 100 k DO requests/day comfortably covers hundreds of pairing sessions
per day; the thing to respect is **bandwidth, not DO budget**: a replay
is a few MB (fine), the full game-data zip can be hundreds of MB (do
that sync on the LAN, not through the relay). The Workers Free request
limit (100 k HTTP requests/day, no WebSocket-message counting on the
free tier's WS support) similarly covers the phone's low request counts.

## Caveats

- **Trust**: the worker's operator sees every code→room binding and could
  join any room as a fake host and MITM the pairing exchange. This is why
  the endpoint is a first-party deployment — don't point the apps at a
  third-party worker. (Forwarding-station mode is the escape hatch.)
- **Volume**: the tunnel streams through Workers' request/DO pipelines;
  see the budget math above.
- **Eviction**: a DO eviction mid-transfer fails that transfer (the app
  surfaces it as a normal pull error — retry). Plain (non-hibernating)
  DO WebSockets keep the Room DO pinned while any socket is open, which
  the free tier's duration accounting tolerates at these session
  lengths; the hibernation API remains an option if usage ever grows.

## Repository integration

- `packages/pairing-relay` is its OWN Cargo workspace (the repo root
  `Cargo.toml` `exclude`s it) with its own gitignored `Cargo.lock`, so
  the wasm/worker dependency tree never touches the app crates' builds.
- `just check-relay` (repo root) runs both the host tests and the
  wasm32 check.
- The Rust clients (desktop bridge + phone transport) live in
  `packages/app/tauri/src/commands/pairing_relay.rs`; their test suite
  runs an in-process mock of this protocol.
- No TypeScript sources remain in this package (the `typecheck` script is
  gone with them; `pnpm -r typecheck` skips this package naturally).
