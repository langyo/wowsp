# Building and Development Guide

> **Audience**: Contributors setting up a local WoWSP development environment.

## Prerequisites

| Tool | Minimum Version | Notes |
| --- | --- | --- |
| Rust | 1.85+ | Edition 2024; install via <https://rustup.rs> |
| Node.js | 22+ | Required by `engines` in `package.json`; CI uses 22 |
| pnpm | 11+ | `corepack enable && corepack prepare pnpm@latest --activate` |
| just | latest | `cargo install just` |
| Python | 3.11+ | For tooling + mock backend + model converters |
| Tauri CLI | 2+ | `cargo install tauri-cli` (needed for `cargo tauri dev`) |

Verify everything:

```bash
rustc --version    # >= 1.85
node --version     # >= 22
pnpm --version     # >= 11
just --version
python --version
```

## Clone and Bootstrap

```bash
git clone https://github.com/langyo/wowsp.git
cd wowsp
cp .env.example .env
just init          # cargo fetch + pnpm install + gen shaders + gen icons + fetch-models
```

> `just init` is not lightweight: the final `just fetch-models` step pulls the
> baked GLB model pack (~1.3 GB, cached — skipped on later runs when the local
> tree hash matches the published `res-latest` release).

## Development

```bash
just dev           # native: Vite + Tauri (full desktop shell)
just dev webui     # browser-only Vite (no Tauri commands — calls fail gracefully)
just dev mock      # FastAPI mock backend + Vite (frontend development without the game)
```

The mock backend (`scripts/mock/`) serves the same command surface as the Rust
side over HTTP under `/api`, so the frontend code path is identical between
desktop and browser.

## Quality gates

```bash
just fmt           # format Rust + TS imports
just lint          # fmt-check + clippy + pnpm lint + i18n parity
just check         # cargo check --workspace
just test          # cargo test --workspace (or `just test e2e` for Playwright)
just i18n-check    # validate i18n key parity (link URLs are en-US-only, shared via fallback)
just check-relay  # l'espace de travail autonome pairing-relay : tests relay-core + vérification wasm32 + check/tests du serveur natif
```

## Building for release

```bash
just build            # build webui (Vite) + Rust shell (cargo, release by default)
just build package    # cargo tauri build — packaged app bundle, no installer flavors
just build installers # shun three-mode installers (full flavors bundle the model pack, lite fetches it on demand)
```

Frontend assets are emitted to `dist/webui/` and consumed by Tauri via
`frontendDist` in `tauri.conf.json`.

## Compiler le serveur

```bash
just build-server  # compiler en release le wowsp-server natif (packages/pairing-relay, axum + SQLite)
just run-server    # l'exécuter localement (écoute sur 127.0.0.1:8787 par défaut ; voir crates/relay-server/README.md)
```

Le Cloudflare Worker se construit via `npx wrangler deploy` depuis `packages/pairing-relay` (le workflow Deploy Site s'en charge aux fusions) ; l'adaptateur Vercel se déploie depuis `packages/relay-vercel`. Les trois formes sont couvertes dans `guides/self-host-gateway.md`.

## Common issues

- **`icons/icon.ico` not found** — run `just gen icons` (regenerates from
  `docs/logo.webp` via `cargo tauri icon`).
- **`frontendDist` path doesn't exist** — run `just build webui` first, or
  `just dev` for the dev server.
- **No replays found** — set `WOWSP_GAME_PATH` in `.env` to your World of
  Warships install, or pass `dir=` explicitly.
