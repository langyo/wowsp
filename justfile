# WoWSP — Windows-first Tauri desktop app. Celestia-devtools recipes are
# staged on demand into .just/ (gitignored) and pulled in via optional import.
# Every recipe is linewise so it runs under `windows-shell` (bash.exe) on
# Windows and the default sh on Unix.

set windows-shell := ["C:/Program Files/Git/usr/bin/bash.exe", "-c"]
set shell := ["bash", "-c"]
set unstable
set lists

default:
    @just --list

PM := "pnpm"

# ── celestia-devtools ─────────────────────────────────────────────────────
# Stage or refresh shared recipes into .just/ (gitignored).
# Source order: explicit URL arg → local pip bundle (offline) → GitHub raw.
[script('bash')]
fetch URL='':
    #!/usr/bin/env bash
    set -euo pipefail
    out=.just/celestia-devtools.just
    mkdir -p .just
    if [ -n "{{URL}}" ]; then
      echo "[fetch] {{URL}} -> $out"
      curl -fsSL "{{URL}}" -o "$out"
    elif command -v celestia-devtools >/dev/null 2>&1; then
      src=$(celestia-devtools include-path)
      echo "[fetch] local bundle ($src) -> $out"
      cp "$src" "$out"
    else
      echo "[fetch] github raw -> $out"
      curl -fsSL "https://raw.githubusercontent.com/celestia-island/celestia-devtools/master/src/celestia_devtools/common.just" -o "$out"
    fi
    echo "[fetch] wrote $out"

import? "./.just/git-bash-interop.just"
import? "./.just/celestia-devtools.just"

# ── dev ───────────────────────────────────────────────────────────────
# Usage: just dev [tauri] [--mock]
#   just dev          → cargo tauri dev (default)
#   just dev tauri    → same as above
#   just dev webui    → Vite dev server
#   just dev site     → site dev server (landing page)
#   just dev test     → tauri dev with test-harness feature

_dev-tauri *FLAGS='':
    python scripts/dev.py tauri {{FLAGS}}

_dev-webui *FLAGS='':
    python scripts/dev.py webui {{FLAGS}}

_dev-site port='4173':
    @command -v lagrange >/dev/null 2>&1 || cargo install lagrange-library
    lagrange dev --src docs --out dist/site --port {{port}}

_dev-test *FLAGS='':
    cargo tauri dev --features test-harness {{FLAGS}}

dev target='tauri' *FLAGS='':
    @just _dev-{{target}} {{FLAGS}}

# ── build ─────────────────────────────────────────────────────────────
#   just build app [--release]   → cargo build (release by default)
#   just build webui             → pnpm build @wowsp/webui
#   just build site              → site + lagrange docs → dist/
#   just build package           → cargo tauri build (app only, no install bundles)
#   just build installers [--flavors ...] → shun installers (full ± webview2)
#   just build wowsunpack        → clone + compile vendored wowsunpack
#   just build all               → webui + site + app

_build-all *FLAGS='':
    @just _build-webui
    @just _build-site
    @just _build-app {{FLAGS}}

_build-app *FLAGS='--release':
    just _build-webui
    cargo build -p wowsp_tauri {{FLAGS}}

_build-webui:
    just gen-shaders
    @python scripts/check_i18n.py --quiet
    {{PM}} --filter @wowsp/webui build

_build-site:
    @command -v lagrange >/dev/null 2>&1 || cargo install lagrange-library
    lagrange build --src docs --out dist

_build-package *FLAGS='':
    cargo tauri build {{FLAGS}}

_build-installers *FLAGS='':
    python scripts/build_installers.py {{FLAGS}}

_build-wowsunpack:
    @echo "Cloning/building wowsunpack (landaire/wows-toolkit)..."
    -git -C packages/tools/wowsunpack-vendor pull --rebase 2>/dev/null || git clone https://github.com/landaire/wows-toolkit.git packages/tools/wowsunpack-vendor
    cargo build --release -p wowsunpack

build target *FLAGS='':
    @just _build-{{target}} {{FLAGS}}

# ── test ──────────────────────────────────────────────────────────────
#   just test unit      → cargo test
#   just test visual    → visual regression (needs dev-test running)
#   just test e2e       → Playwright browser tests

_test-unit *FLAGS='':
    cargo test --workspace {{FLAGS}}

_test-visual *FLAGS='':
    python -m pytest scripts/visual -c scripts/pyproject.toml {{FLAGS}} -m visual

_test-e2e *FLAGS='':
    python -m pytest scripts/e2e -c scripts/pyproject.toml {{FLAGS}} -m ui

test target *FLAGS='':
    @just _test-{{target}} {{FLAGS}}

# ── lint ──────────────────────────────────────────────────────────────
#   just lint           → full: fmt-check + clippy + pnpm lint + i18n
#   just lint rust      → fmt-check + clippy
#   just lint webui     → pnpm lint
#   just lint i18n      → i18n parity check
#   just check          → cargo check (fast compile check)

# Both recipes mirror the CI rust gate (ci.yml "Rustfmt"/"Clippy") exactly:
# the two app crates get fmt + clippy (--no-deps keeps the vendored
# wowsunpack/wows-core upstream lint style out), while repo-wide fmt would
# fail on the vendored dependency sources.
_lint-full:
    cargo fmt -p wowsp_tauri -p wowsp_tauri_shared -- --check
    cargo clippy -p wowsp_tauri -p wowsp_tauri_shared --lib --bins --no-deps -- -D warnings
    {{PM}} -r lint
    @python scripts/check_i18n.py

_lint-rust:
    cargo fmt -p wowsp_tauri -p wowsp_tauri_shared -- --check
    cargo clippy -p wowsp_tauri -p wowsp_tauri_shared --lib --bins --no-deps -- -D warnings

_lint-webui:
    {{PM}} -r lint

_lint-i18n *FLAGS='':
    @python scripts/check_i18n.py {{FLAGS}}

lint target='full' *FLAGS='':
    @just _lint-{{target}} {{FLAGS}}

check:
    cargo check --workspace

# ── pairing relay ─────────────────────────────────────────────────────
# The pairing gateway (packages/pairing-relay) is a STANDALONE Rust
# workspace compiled to wasm32 for Cloudflare Workers (excluded from the
# root workspace — own gitignored Cargo.lock). One recipe covers both
# halves of its verification; wasm32 check is quick and holds no shared
# target-dir lock (the package has its own target/).
check-relay:
    cd packages/pairing-relay && cargo test -p relay-core
    cd packages/pairing-relay && cargo check --target wasm32-unknown-unknown

# Bundle the WEBSITE into the worker's static-asset dir — the deploy
# precondition. The worker serves only the HTML shell + API; built
# assets (JS/CSS/images) load from the GitHub Pages mirror via absolute
# URLs (WOWSP_SITE_ASSET_BASE), and /docs redirects there too — Cloudflare
# is kept out of the heavy-download path entirely.
bundle-site:
    #!/bin/sh
    set -e
    WOWSP_SITE_ASSET_BASE="https://langyo.github.io/wowsp" pnpm --filter @wowsp/website build
    node -e "require('fs').rmSync('packages/pairing-relay/assets',{recursive:true,force:true})"
    mkdir -p packages/pairing-relay/assets
    cp -r dist/website/. packages/pairing-relay/assets/

# ── android ───────────────────────────────────────────────────────────
# Android cross-support (Tauri 2 mobile). The NDK toolchain provides the
# clang wrappers cargo's CC/AR env (and later the target linker) point at;
# `cargo check` itself needs no linker, only the C-compiler env for build
# scripts (ring, cc-based crates). gen/android is scaffolded and tracked —
# `just build android --debug --apk --target aarch64` produces the APK.
#
#   just check-android              → cargo check --target aarch64-linux-android
#   just dev android [--release]    → cargo tauri android dev
#   just build android *FLAGS       → cargo tauri android build
#   just build android-apk          → one-ABI APK (canonical flags baked in)
#
# The APK BUNDLES the resource pack: the recipes run fetch_models + the
# offline GameParams extraction first (both idempotent — the model pull
# skips the ~1.3 GB download when the local wowsp-res.json tree hash
# already matches res-latest; the gameparams pack re-extracts only when
# build.txt lags the installed game) and export WOWSP_MOBILE_BUNDLE=1 so
# the webui build's prune steps keep models/*.glb + dogtags +
# data/gameparams in dist (see packages/webui/vite.config.ts); the app
# then serves them same-origin from the read-only APK assets — gameparams
# through commands/gameparams.rs's bundled-asset fallback. Desktop `just
# build tauri`/`package` is untouched — no env var, pruning stays on.
#
# NDK note: tauri-cli 2.11.x ignores NDK_HOME and always picks the NEWEST
# NDK under $ANDROID_HOME/ndk — make sure 26.1 is the only/newest installed
# one (a stray newer NDK silently wins toolchain selection). If a newer
# NDK (e.g. 29.x) IS installed, temporarily move its directory aside for
# the build and restore it afterwards, exactly like the R2 scaffold run.

# Machine-local SDK/JDK locations as OVERRIDABLE defaults:
# `env_var_or_default` picks up ANDROID_HOME / NDK_HOME / JAVA_HOME from the
# environment when present, so CI or another workstation only needs to
# export the vars — no file edits. NDK_HOME still derives from ANDROID_HOME
# by default so the 26.1 pin below stays the source of truth.
ANDROID_HOME := env_var_or_default("ANDROID_HOME", "C:/Users/langy/AppData/Local/Android/Sdk")
NDK_HOME     := env_var_or_default("NDK_HOME", ANDROID_HOME / "ndk/26.1.10909125")
NDK_TOOLCHAIN_BIN := NDK_HOME / "toolchains/llvm/prebuilt/windows-x86_64/bin"
JAVA_HOME    := env_var_or_default("JAVA_HOME", "C:/Program Files/Amazon Corretto/jdk17.0.19_10")
ANDROID_TARGET := "aarch64-linux-android"

# Cross-compile check for Android. The env var names carry dashes (cargo's
# per-target CC convention), which bash cannot `export` — `env` takes them
# fine. `cargo check` needs the C-compiler env for build scripts (ring & cc
# based crates); linking env is included for reuse but unused by check.
check-android:
    #!/usr/bin/env bash
    set -euo pipefail
    env \
        ANDROID_HOME={{ANDROID_HOME}} \
        NDK_HOME={{NDK_HOME}} \
        ANDROID_NDK_HOME={{NDK_HOME}} \
        ANDROID_NDK_ROOT={{NDK_HOME}} \
        CC_aarch64-linux-android={{NDK_TOOLCHAIN_BIN}}/aarch64-linux-android24-clang.cmd \
        CXX_aarch64-linux-android={{NDK_TOOLCHAIN_BIN}}/aarch64-linux-android24-clang++.cmd \
        AR_aarch64-linux-android={{NDK_TOOLCHAIN_BIN}}/llvm-ar.exe \
        RANLIB_aarch64-linux-android={{NDK_TOOLCHAIN_BIN}}/llvm-ranlib.exe \
        CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER={{NDK_TOOLCHAIN_BIN}}/aarch64-linux-android24-clang.cmd \
        cargo check --target {{ANDROID_TARGET}} -p wowsp_tauri -p wowsp_tauri_shared

# Wrappers around `cargo tauri android` with the same NDK env plus the JDK
# gradle needs (AGP 8.x requires JDK 17). cargo-tauri configures the
# per-target CC/linker env itself from the resolved NDK. Both export
# WOWSP_MOBILE_BUNDLE=1 — it must reach tauri.conf.json's beforeBuildCommand
# (`pnpm --filter @wowsp/webui build`) so the webui build keeps the GLBs and
# the offline gameparams pack. The extract_gameparams step is idempotent:
# it refreshes packages/webui/src/res/data/gameparams/ only when build.txt
# lags the installed game (or the pack is missing/partial) and FAILS the
# build when neither the cached GameParams.json nor a game install to
# generate it from is available — an android APK without offline tech data
# is a defect, not a degraded mode.
_dev-android *FLAGS='':
    #!/usr/bin/env bash
    set -euo pipefail
    python scripts/fetch_models.py
    python scripts/extract_gameparams.py
    export ANDROID_HOME={{ANDROID_HOME}} NDK_HOME={{NDK_HOME}} \
        ANDROID_NDK_HOME={{NDK_HOME}} ANDROID_NDK_ROOT={{NDK_HOME}} \
        JAVA_HOME="{{JAVA_HOME}}" WOWSP_MOBILE_BUNDLE=1
    cargo tauri android dev {{FLAGS}}

_build-android *FLAGS='':
    #!/usr/bin/env bash
    set -euo pipefail
    # Skip-if-present fetches of the packs that ride into the APK assets:
    # the GLB model pack (res-latest release) and the offline GameParams
    # ship-data pack (re-extracted when the game build changed).
    python scripts/fetch_models.py
    python scripts/extract_gameparams.py
    export ANDROID_HOME={{ANDROID_HOME}} NDK_HOME={{NDK_HOME}} \
        ANDROID_NDK_HOME={{NDK_HOME}} ANDROID_NDK_ROOT={{NDK_HOME}} \
        JAVA_HOME="{{JAVA_HOME}}" WOWSP_MOBILE_BUNDLE=1
    cargo tauri android build {{FLAGS}}

# Single-ABI APK shortcut: the canonical `--debug --apk --target aarch64`
# from the section note above. Without an explicit --target, cargo tauri
# android build compiles ALL FOUR ABIs (aarch64/armv7/i686/x86_64) — slow,
# and the extra Rust targets are usually not even installed. Debug output
# is signed with the local debug keystore automatically; a RELEASE APK
# (pass --release as FLAGS) comes out unsigned until a signingConfig +
# gen/android/key.properties (gitignored) is wired into the gradle project.
_build-android-apk *FLAGS='--debug':
    just _build-android --apk --target aarch64 {{FLAGS}}

# ── lint-msg ──────────────────────────────────────────────────────────
#   just lint-msg              → check commit subjects on master..HEAD (AGENTS.md §1)
#   just lint-msg origin/dev   → check against another base

lint-msg base='master':
    @git log --no-merges --format='%s' {{base}}..HEAD | python scripts/commit_msg_lint.py check --stdin-subjects

# ── fmt ───────────────────────────────────────────────────────────────
#   just fmt           → auto-fix: organize imports + clippy fix + cargo fmt + pnpm lint --fix
#   just fmt check     → cargo fmt --check only

_fmt-fix:
    cargo clippy -p wowsp_tauri -p wowsp_tauri_shared --all-targets --no-deps -- -D warnings
    cargo fmt -p wowsp_tauri -p wowsp_tauri_shared
    {{PM}} -r lint --fix

_fmt-check:
    cargo fmt -p wowsp_tauri -p wowsp_tauri_shared -- --check

fmt target='fix':
    @just _fmt-{{target}}

# ── clean ──────────────────────────────────────────────────────────────
#   just clean          → full clean (cargo + pnpm + dist)
#   just clean rust     → cargo clean
#   just clean webui    → pnpm clean + dist

_clean-full:
    cargo clean
    {{PM}} -r run clean
    -rm -rf dist/ packages/webui/.generated/

_clean-rust:
    cargo clean

_clean-webui:
    {{PM}} --filter @wowsp/webui run clean
    -rm -rf dist/

clean target='full':
    @just _clean-{{target}}

# ── gen ────────────────────────────────────────────────────────────────
#   just gen             → shaders + icons
#   just gen shaders     → glsl bundle
#   just gen icons       → tauri icons

_gen-all:
    just gen-shaders
    just gen-icons

gen target='all':
    @just _gen-{{target}}

gen-shaders:
    python scripts/glsl_bundle.py --verbose

gen-icons:
    python scripts/ensure_tauri_icons.py

# ── convert ───────────────────────────────────────────────────────────
#   just convert ship --name Yamato       → ship → GLB
#   just convert map --name 18_NE_ice_islands  → map → GLB
#   just convert map-holo --name 18_NE_ice_islands → contour holomap

convert-ship *ARGS:
    python scripts/model_convert/convert_ship.py {{ARGS}}

convert-map *ARGS:
    python scripts/model_convert/convert_map.py {{ARGS}}

convert-map-holo *ARGS:
    WOWSP_WOWSUNPACK="target/release/wowsunpack.exe" python scripts/model_convert/convert_map_holo.py {{ARGS}}

# ── bake ──────────────────────────────────────────────────────────────
#   just bake model raw.glb -o ship.glb --triangles 2000
#   just bake ships
#   just bake maps

bake-model *ARGS:
    python scripts/model_convert/bake_model.py {{ARGS}}

bake-ships *ARGS:
    python scripts/model_convert/batch_bake.py {{ARGS}}

bake-maps *ARGS:
    WOWSP_WOWSUNPACK="target/release/wowsunpack.exe" python scripts/model_convert/batch_bake_maps.py {{ARGS}}

# ── extract ───────────────────────────────────────────────────────────
#   just extract                  → auto-detect game, run all modules
#   just extract --path D:\WoWS   → explicit game path
#   just extract rarity,techtree  → only specific modules

extract *ARGS:
    python scripts/extract/run.py {{ARGS}}

# ── init ───────────────────────────────────────────────────────────────

init:
    @echo "Initializing WoWSP..."
    cargo fetch
    {{PM}} install
    just gen
    just fetch-models
    @echo "Done."

install: init
bootstrap: init
    cargo build -p wowsp_tauri

# ── ci ────────────────────────────────────────────────────────────────

ci:
    just lint rust
    cargo check --workspace
    cargo test --workspace
    {{PM}} -r typecheck
    {{PM}} -r lint
    @python scripts/check_i18n.py --quiet

# ── package ───────────────────────────────────────────────────────────

package *FLAGS:
    cargo tauri build {{FLAGS}}

# ── e2e ───────────────────────────────────────────────────────────────

e2e-setup:
    @pip install -q -r scripts/requirements.txt && python -m playwright install chromium 2>/dev/null

# ── release-models ─────────────────────────────────────────────────────
# Package baked GLB models as a GitHub Release asset and prune old releases
# (keeps the 3 most recent chain patches). Requires `gh` CLI.
#   just release-models 0.14.1
#   just release-models 0.14.1 --dry-run
release-models *ARGS:
    python scripts/release_models.py {{ARGS}}

# ── fetch-models ───────────────────────────────────────────────────────
# Download the baked GLB model pack from GitHub Releases (res-latest) into
# packages/webui/src/res/models (the GLBs are gitignored). For fresh clones.
#   just fetch-models
#   just fetch-models --dry-run
fetch-models *ARGS:
    python scripts/fetch_models.py {{ARGS}}

# ── check-env ─────────────────────────────────────────────────────────
# WoWSP-specific environment check (celestia-devtools provides a generic
# `preflight`, so we use a distinct name to avoid collision).

check-env *FLAGS:
    python scripts/preflight.py {{FLAGS}}
