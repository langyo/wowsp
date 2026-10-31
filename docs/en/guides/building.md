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
```

## Building for release

```bash
just build            # build webui (Vite) + Rust shell (cargo, release by default)
just build package    # cargo tauri build — packaged app bundle, no installer flavors
just build installers # shun three-mode installers (full flavors bundle the model pack, lite fetches it on demand)
```

Frontend assets are emitted to `dist/webui/` and consumed by Tauri via
`frontendDist` in `tauri.conf.json`.

## Building for Android

The Android edition is built from source on a machine with the toolchain
below; there is no CI lane for it yet.

**Prerequisites**

- JDK 17 (the justfile defaults to a local Corretto 17; override with
  `JAVA_HOME`), Android SDK with platform 36 (`ANDROID_HOME`), and NDK
  **26.1.10909125** as the only/newest NDK under `$ANDROID_HOME/ndk` —
  tauri-cli picks the NEWEST NDK there and ignores `NDK_HOME`, so a stray
  newer NDK silently changes your build.
- Rust target `aarch64-linux-android` (`rustup target add …`); the
  canonical build is single-ABI arm64-v8a.
- The checkout may live anywhere, but the **cargo target directory must be
  ASCII-only**: the NDK linker receives target paths as raw bytes and
  fails on non-ASCII (the classic `D:\源代码\…` GBK break, "cannot find
  version script"). The build exports `CARGO_TARGET_DIR` from
  `scripts/android_cargo_target.py` automatically (override with
  `WOWSP_ANDROID_CARGO_TARGET`), and `gradle.properties` sets
  `android.overridePathCheck=true` for the AGP side.

**Build**

```bash
just check-android   # cargo check for the android target (fast sanity)
just build android-apk   # fetch_models + gameparams + pnpm webui + cargo tauri android build --apk --target aarch64
```

The APK lands in `packages/app/tauri/gen/android/app/build/outputs/apk/`.
Debug builds sign with the local debug keystore automatically; **release
builds come out unsigned** until a signing config is wired into
`gen/android` (deliberate — see the justfile notes).

**The shared mobile facility**

`celestia-devtools mobile doctor` audits the whole surface (JDK/SDK/NDK,
the NDK newest-wins trap, ASCII compliance of every path involved), and
`celestia-devtools mobile build wowsp-android` wraps the same justfile
flow with that audit plus a pinned ASCII target dir. When the facility
drives a build it exports `WOWSP_ANDROID_CARGO_TARGET`, so this repo's
own resolver and the shared one converge on the same directory by
construction; standalone `just`/Android Studio builds keep using the
resolver below (the two implementations are deliberately lockstep).

## Common issues

- **`icons/icon.ico` not found** — run `just gen icons` (regenerates from
  `docs/logo.webp` via `cargo tauri icon`).
- **`frontendDist` path doesn't exist** — run `just build webui` first, or
  `just dev` for the dev server.
- **No replays found** — set `WOWSP_GAME_PATH` in `.env` to your World of
  Warships install, or pass `dir=` explicitly.
