# Building and Development Guide

> **Audience**: Contributors setting up a local WoWSP development environment.

## Prerequisites

| Tool | Minimum Version | Notes |
| --- | --- | --- |
| Rust | 1.85+ | Edition 2024; install via <https://rustup.rs> |
| Node.js | 20+ | LTS recommended |
| pnpm | 9+ | `corepack enable && corepack prepare pnpm@latest --activate` |
| just | latest | `cargo install just` |
| Python | 3.11+ | For tooling + mock backend + model converters |
| Tauri CLI | 2+ | `cargo install tauri-cli` (needed for `cargo tauri dev`) |

Verify everything:

```bash
rustc --version    # >= 1.85
node --version     # >= 20
pnpm --version     # >= 9
just --version
python --version
```

## Clone and Bootstrap

```bash
git clone https://github.com/celestia-island/wowsp.git
cd wowsp
cp .env.example .env
just init          # cargo fetch + pnpm install + gen shaders + gen icons
```

## Development

```bash
just dev           # native: Vite + Tauri (full desktop shell)
just dev webui     # browser-only Vite (no Tauri commands — calls fail gracefully)
just dev --mock    # FastAPI mock backend + Vite (frontend development without the game)
just watch         # alias for `just dev`
```

The mock backend (`scripts/mock/`) serves the same command surface as the Rust
side over HTTP under `/api`, so the frontend code path is identical between
desktop and browser.

## Quality gates

```bash
just fmt           # format Rust + TS imports
just lint          # fmt-check + clippy + pnpm lint
just check         # cargo check --workspace
just test          # cargo test --workspace (or `just test e2e` for Playwright)
just i18n-check    # validate i18n key parity across en + zhs
```

## Building for release

```bash
just build         # build webui (Vite) + Rust shell (cargo)
just build tauri   # produce a packaged Tauri installer (MSI/NSIS on Windows)
```

Frontend assets are emitted to `dist/webui/` and consumed by Tauri via
`frontendDist` in `tauri.conf.json`.

## Common issues

- **`icons/icon.ico` not found** — run `just gen icons` (regenerates from
  `docs/logo.svg` via `cargo tauri icon`).
- **`frontendDist` path doesn't exist** — run `just build webui` first, or
  `just dev` for the dev server.
- **No replays found** — set `WOWSP_GAME_PATH` in `.env` to your World of
  Warships install, or pass `dir=` explicitly.
