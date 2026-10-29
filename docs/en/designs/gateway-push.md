# Gateway push: account-routed live battles (design contract)

> Status: DRAFT (implementation contract for the feat/mobile-gateway wave).
> Scope: replace the desktop pairing CODE with a configurable ROUTE ENTRY
> (a Cloudflare Worker running the standard pairing-relay wasm), add
> account-routed battle PUSH from the desktop, a mobile waiting/live receive
> flow, per-deployment Turnstile/password gating, and a self-host wizard.

## 1. Goals

1. **No pairing code on the desktop.** The desktop instead CONFIGURES a
   route entry — the base URL of a gateway deployment. The default is the
   official deployment at `https://wowsp.langyo.xyz/gateway/`.
2. **Automatic battle push.** Every NEW battle the desktop detects
   (tempArenaInfo delivery, `arena_info::deliver_arena` returning
   `Battle`) triggers exactly one push carrying the battle's realm, both
   teams' player names + ships, mode, map, and timestamp.
3. **Same-account receive.** The phone — after confirming the SAME account
   is bound/active as the one playing on the desktop — actively subscribes
   and receives battle events from the server, including the current
   battle snapshot if it connects mid-battle.
4. **Self-host first-class.** The server source is this repo's
   `packages/pairing-relay`; a settings wizard deploys a private instance
   (target domain, wrangler login, KV bucket, subdomain) and the phone can
   point at a custom domain. Legion commanders can offer this as a member
   benefit.
5. **Abuse gating.** The PUBLIC (official) node requires Cloudflare
   Turnstile on BOTH roles before the push service starts; PRIVATE nodes
   may disable Turnstile and/or set a password (5 failed attempts within
   one minute locks the source out for five minutes).

## 2. Channel identity

- Channel id: `r:<realm>:<accountId>` of the **playing account** (the
  session hub's resolved identity — the roster's local player matched
  against bound profiles; falls back to the active bound account).
- The phone subscribes to the channel of its own **active account**
  (realm + accountId equality is the "same account" confirmation).
- ids are opaque ASCII; the worker validates shape `^r:[a-z]{2,5}:[0-9]+$`
  and never interprets beyond routing.

## 3. HTTP + WebSocket surface (all under the route entry)

The route entry is a BASE URL. All endpoints are relative to it, so the
same wasm serves the official node (`https://wowsp.langyo.xyz/gateway/`)
and any self-hosted root (`https://gateway.example.com/` — the selfhost
template binds ONLY `/gateway/*`, no site assets needed).

```
GET  {entry}/health        — deployment config document (no auth)
POST {entry}/session       — auth exchange: Turnstile token and/or password
                             → { ticket } (single-use, ≤120 s TTL)
WS   {entry}/pub?route=…&ticket=…   — desktop publisher (role=host)
WS   {entry}/sub?route=…&ticket=…   — phone subscriber (role=client)
```

### 3.1 `GET /health`

```json
{
  "gateway": "v1",
  "minClientVersion": "0.6.8",
  "auth": {
    "turnstile": { "required": true, "sitekey": "0x4AAA…" },
    "password":  { "required": false }
  },
  "notice": "optional operator notice"
}
```

- `turnstile.required` is TRUE on the official deployment. A missing
  `GATEWAY_TURNSTILE_SITEKEY` var means Turnstile is OFF (self-host
  default). `password.required` reflects the `GATEWAY_PASSWORD` secret.
- Cached at the edge for 60 s (public, no auth).

### 3.2 `POST /session`

Body: `{ "route": "r:asia:123456", "cf-turnstile-response": "…token…",
"password": "…" }` (either credential may be omitted when not required).

- Verifies EXACTLY what the health document demands: Turnstile token via
  `https://challenges.cloudflare.com/turnstile/v0/siteverify` (reuse
  `relay-core::feedback::turnstile_verify_body`), password via
  constant-time compare against the `GATEWAY_PASSWORD` secret.
- Password failures: 5 within any 60 s window (keyed by remote IP) →
  the IP is locked out for 300 s with HTTP 429 + `retryAfter`. Counters
  live in the auth Durable Object (KV is not atomic enough).
- Success → `{ "ticket": "<32 hex>", "route": "…", "ttl": 120 }`. The
  ticket is single-use, bound to (route, credential kind), and consumed at
  the first WS upgrade.

### 3.3 `WS /pub` (desktop) and `WS /sub` (phone)

- Query: `route` (validated channel id) + `ticket` from /session. One
  publisher per channel: a second host with a DIFFERENT persistent host id
  replaces the first (same policy as the relay directory's one-code rule).
- On connect the server sends:
  `{"type":"hello","gateway":"v1","role":"pub|sub"}` then the CURRENT
  channel state (if any): `{"type":"battle", …}`.
- Desktop → server (text frames). The battle body mirrors the app's
`ArenaInfo` head + `VehicleEntry` fields 1:1 (minus `raw`) so the phone
maps the frame into its roster store without translation:
  `{"type":"battle","realm":"asia","route":"r:asia:123456",
     "self":{"name":"…","accountId":123},
     "battle":{"dateTime":"2026-10-29 22:00:00","matchGroup":"pvp",
     "mapName":"14_ATL_NavalBase","scenario":"","eventType":"",
     "botCount":0,"scriptedUnitCount":0,
     "vehicles":[{"id":123,"name":"…","relation":0,
                  "shipId":4189570000,"shipName":"Yamato"}]} }`
  (`relation` 0 = self, 1 = ally, 2+ = enemy — teams derive from it,
  exactly like the local arena roster.) plus `{"type":"bye"}` when the
  battle ends (game exit / roster clear). One battle event ≤ 64 KiB;
  larger frames are rejected (1009).
- Server → phone: the same `battle` frames (fanned out live) + presence:
  `{"type":"host","online":true|false}`. The channel DO retains the last
  battle snapshot for the battle's duration (+5 min) so a phone connecting
  mid-battle gets it immediately from `/sub`.
- Keepalive: text ping every 30 s both directions (Cloudflare drops idle
  proxied sockets at ~100 s), identical to the existing relay sockets.
- BOTH sockets live in Rust commands (the webui never dials a gateway
  WebSocket — the same rule the code-relay follows today):
  - desktop: `gateway_publish_start` / `gateway_publish_stop` + the
    `deliver_arena` Battle hook; connection phases emit to the webui as
    `wowsp://gateway-state` events for the phone-icon UI;
  - phone: `gateway_subscribe_start` / `gateway_subscribe_stop`;
    received frames are re-emitted to the webui as
    `wowsp://gateway-battle` events the live view renders.
  `GET /health` is likewise fetched through a Rust command
  (`gateway_get_health`) — the webui itself does no cross-origin fetches.

## 4. Deployment configuration

Official deployment (wrangler.toml of packages/pairing-relay) adds:

- vars: `GATEWAY_TURNSTILE_SITEKEY` (empty ⇒ Turnstile off), and the
  gateway joins the existing `run_worker_first` `/api*` list — the
  gateway lives under `/gateway/*` which the assets layer never serves,
  so no assets negation is needed.
- secrets: `GATEWAY_TURNSTILE_SECRET` (siteverify), `GATEWAY_PASSWORD`
  (optional; absent ⇒ no password).

Self-host (template `wrangler.selfhost.toml`, generated by the wizard):

- SAME wasm build (one worker binary; the template just binds less):
  routes = `{ pattern = "<subdomain>", custom_domain = true }`; KV
  namespace `GATEWAY_KV` (last-battle snapshot mirror, TTL 1 h); DO
  classes via the same migration chain (v1-v3 unchanged, **v4 adds
  GatewayChannel + GatewayAuth**). No [assets], no R2, no crons, no
  feedback/erp/qqbot vars — a self-host deployment is reachable on
  `/gateway/*` only; the unused handlers are simply never routed to
  (binding absence is an access-time concern, and the README documents
  the supported surface).
- `GATEWAY_PASSWORD` optional via `wrangler secret put`; absent ⇒
  password off.
- On the OFFICIAL deployment the same v4 migration ships in the next
  `wrangler deploy`, and `/gateway*` joins `run_worker_first` (the
  assets layer never serves it; no per-channel negation needed since
  nothing static lives there).

## 5. Desktop flow (push side)

1. Settings ▸ 手机服务 (mobile service): toggle (persisted; default off)
   + route entry picker (official default / custom URL, https enforced,
   loopback allowed for dev — same URL policy as the relay client).
2. While the service is on: the app resolves `{entry}/health`. If
   Turnstile is required the BOTTOM-LEFT tooltip (PluginUpdateHint style,
   anchored next to the running-game card, a phone icon added beside it)
   renders the challenge and STAYS until solved (its title tells the user
   to pass it once; push starts only after a pass mints a ticket).
3. `deliver_arena` == `Battle` (and the mobile service on + a valid
   session ticket) publishes one battle frame on the pub socket; the
   socket stays open for the battle with 30 s keepalive and is torn down
   on game exit (`bye` + close).
4. Custom-node failures surface as a toast on the desktop the same way
   the phone's do (top-right, hikari useToast).

## 6. Phone flow (receive side)

1. /live on the phone auto-enters the WAITING state (account chip + route
   entry + "waiting for the desktop to start a battle").
2. 开始连接 (start connect): resolve `{entry}/health` → if Turnstile is
   required a BOTTOM-SHEET captcha window pops (hikari mobile sheet
   behavior); a password prompt sheet appears when required. Passing =
   handshake success → /session → /sub socket.
3. Received `battle` frames map into the existing ArenaInfo shape and
   render through the same live components; `host.online` flips the
   waiting screen's hint. Connection failures to a CUSTOM node surface as
   a top-right toast.
4. Settings on the phone carry the route entry field (official default,
   custom domain for self-host).

## 7. Self-host wizard (desktop settings)

Steps (each verified before advancing, output streamed to the wizard):

1. Environment probe: node/npx on PATH (version reported); Rust toolchain
   + wasm32 target + worker-build (the wizard offers to install missing
   pieces via the detected package manager).
2. Wrangler auth: `npx wrangler whoami`; if unauthenticated, `npx
   wrangler login` (browser flow) and wait.
3. Target: subdomain input (under a zone already in the account) — the
   wizard lists zones via `npx wrangler` and validates.
4. KV: create/select the `GATEWAY_KV` namespace.
5. Generate `wrangler.selfhost.toml` (route, KV id, DO classes), then
   `npx wrangler deploy`; stream stdout/stderr lines as progress events.
6. Verify `https://<domain>/gateway/health`; on success show the URL to
   enter on the phone (QR + copy).

The CF token never appears in the repo, logs, or wizard state (wrangler's
own login state is used; AGENTS.md §7).

## 8. Webui integration points (verified against the tree)

- **Settings**: the gateway route entry, the mobile-service toggle and
  the self-host wizard live in the settings "connection" group
  (account | network | pairing). The section registry
  (`stores/settingsUi.ts` SETTINGS_GROUPS + MOBILE_HIDDEN_SECTIONS),
  `useSettingsBody.ts` SECTION_ICONS/labels, and a
  `components/settings/sections/*` slot are the exact wiring points.
  The self-host wizard is DESKTOP-only (MOBILE_HIDDEN_SECTIONS); the
  route-entry field shows on both builds.
- **Turnstile tooltip (desktop)**: clone the PluginUpdateHint anchored
  card pattern (fixed, teleported to body, right of the sidebar footer's
  game-status card — the shared `statusCardEl` ref — z-tooltip band,
  hikari menu rows) but carry an HkCaptchaWidget instead of update rows.
  It PINNS open while the mobile service is on and the challenge is
  unsolved (title tells the user to pass it once), unpins on success.
  A phone icon joins the sidebar footer next to the game-status card
  while the service runs (22px slot convention).
- **Captcha widget**: hikari HkCaptchaWidget (siteKey, attempt,
  onVerify) — mount only after the health document lands (async-sitekey
  guard from the console FeedbackApp), reset `attempt` after every
  failed exchange so the widget remints.
- **Phone live view**: /live stops being a placeholder; it auto-enters
  the waiting state (auto-WAIT, no user gesture needed to VIEW), the
  start-connect button drives the handshake (captcha bottom sheet +
  optional password sheet, both hikari mobile-sheet behavior), and
  `wowsp://gateway-battle` events render through the existing live
  panels with the pushed ArenaInfo-shaped payload.
- **Toasts**: connection failures to a custom node surface via hikari
  useToast() (top-right lane).
- **Turnstile widget hostnames**: the app webview origins —
  `tauri.localhost` (Windows desktop), `asset.localhost` (Android) —
  must be on the widget's hostname allowlist. The official deployment's
  widget adds them (maintainer action, see README); self-host docs +
  wizard step 5 instruct the operator to add them to their own widget.
  Localhost is already allowed for `wrangler dev`.

## 9. Tauri IPC surface (pinned — implement against this verbatim)

Commands (all `CommandResult`, anyhow end-to-end; stable error markers
quoted in backticks below are the exact rejection strings):

```ts
gateway_get_config() -> { root: string, enabled: boolean }
   // root = the normalized route entry; default
   // "https://wowsp.langyo.xyz/gateway/". enabled = the mobile service.
gateway_set_config({ root?, enabled? }) -> GatewayClientConfig
   // root validated by the relay URL policy (https enforced, loopback OK).
gateway_get_health({ root }) -> GatewayHealthDoc
   // errors: `gateway unreachable or health document invalid` |
   // `gateway speaks an unsupported gateway protocol` |
   // `gateway requires a newer app version`
gateway_open_session({ root, route, turnstileToken?, password? })
  -> { ticket: string, ttl: number }
   // errors: `gateway captcha verification failed` |
   // `gateway password rejected` |
   // `gateway rate limited, retry after Ns` (N = seconds)
gateway_publish_start({ route, turnstileToken?, password? }) -> void
   // desktop; route derived by the caller (webui) from the session hub.
gateway_publish_stop() -> void
gateway_subscribe_start({ root, route, turnstileToken?, password? }) -> void
gateway_subscribe_stop() -> void
gateway_selfhost_probe() -> SelfhostEnv
   // { nodePath?, nodeVersion?, npxPath?, rustc?, wasmTarget?, workerBuild?,
   //   wranglerAuthed, account? }
gateway_selfhost_step({ step, ...args }) -> SelfhostStepResult
   // step = "wrangler-login" | "list-zones" | "kv-ensure" | "deploy" | "verify"
```

Events:

```ts
"wowsp://gateway-state"  { role: "pub"|"sub", route?,
                           phase: "resolving"|"captcha"|"connecting"|"online"|
                                   "error"|"stopped",
                           detail?: string }        // desktop + phone
"wowsp://gateway-battle" GatewayBattleFrame       // phone (forwarded raw)
"wowsp://gateway-selfhost" { step, stream: "stdout"|"stderr"|"done",
                             line?, result? }      // wizard streaming
```

The TURNSTILE TOKEN always enters through the webui (the widget renders
there); Rust never renders a challenge, it only exchanges the token at
`/session` and re-emits the `captcha` phase when a new one is needed.

## 10. Versioning + compatibility

- `gateway: "v1"` in /health; clients refuse `> v1` with the existing
  unsupported-protocol error markers. `minClientVersion` reuses the
  relay's version gate semantics.
- The legacy code-based relay (`/api/relay/*`) stays untouched for the
  phone's existing replay-pull wizard until a later wave retires it.
  The desktop stops DISPLAYING a pairing code; the code allocation path
  itself stays functional so older phone builds keep pairing while the
  new gateway rolls out.
