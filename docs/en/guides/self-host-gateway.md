# Self-hosting the WoWSP gateway

> This guide walks a legion commander — or any player — through running a
> PRIVATE WoWSP gateway worker on their own Cloudflare account and domain,
> then pointing the desktop app and the members' phones at it. The whole
> server is the standard `packages/pairing-relay` wasm in this repository
> (see [gateway-push.md](../designs/gateway-push.md) for the protocol).

## Why self-host

- **Privacy**: battle pushes for your members route through YOUR worker,
  not the public node.
- **No captcha**: private deployments may turn Turnstile OFF and/or
  protect the gateway with a simple password instead.
- **Control**: point it at any domain you own (a legion domain works
  great) — it makes a clean member benefit a commander can hand out.

## Prerequisites

1. A Cloudflare account (the free Workers plan is enough — Durable
   Objects on the free plan use SQLite storage, which the gateway uses).
2. A domain or subdomain hosted on that Cloudflare account (a Workers
   Custom Domain is bound to it automatically at deploy time).
3. On the machine running the desktop app: Node.js (with `npx`) and a
   Rust toolchain with the `wasm32-unknown-unknown` target — or simply
   use the app's built-in wizard, which probes all of this for you.

## The one-click way (desktop app)

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

## The manual way (CLI)

```bash
git clone https://github.com/langyo/wowsp && cd wowsp/packages/pairing-relay
rustup target add wasm32-unknown-unknown
cargo install worker-build
npx wrangler login
npx wrangler kv namespace create GATEWAY_KV     # note the printed id
cp wrangler.selfhost.toml.example wrangler.selfhost.local.toml
# edit wrangler.selfhost.local.toml: your domain + KV id
npx wrangler deploy --config wrangler.selfhost.local.toml
curl https://<your-domain>/gateway/health
```

## Security options

| Option | How | Default |
| --- | --- | --- |
| Turnstile captcha | `GATEWAY_TURNSTILE_SITEKEY` var + `TURNSTILE_SECRET` secret | **off** for self-host |
| Password | `npx wrangler secret put GATEWAY_PASSWORD` (secret, on the deployed worker) | off |
| Neither | — | anyone who knows a channel id can subscribe |

- 5 wrong passwords inside one minute lock the source IP out for 5
  minutes (HTTP 429 with `retryAfter`).
- If you enable Turnstile, create the widget for YOUR domain and add the
  app origins to its hostname allowlist: `tauri.localhost` (Windows
  desktop app), `asset.localhost` (Android app) and `localhost`
  (development). The widget's secret goes in via
  `npx wrangler secret put TURNSTILE_SECRET`.

## Pointing WoWSP at your gateway

- **Desktop**: Settings ▸ 连接 ▸ Pairing ▸ 路由入口 — replace the
  official `https://wowsp.langyo.xyz/gateway/` with
  `https://<your-domain>/gateway/`, then turn on the 手机服务 toggle.
- **Phone**: the same field in the phone's settings; the live view then
  waits for pushes routed to the logged-in account.

Connection failures surface as a toast (top-right) on both ends.
