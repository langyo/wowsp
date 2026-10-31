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

import? "./.just/celestia-devtools.just"

# ── dev ───────────────────────────────────────────────────────────────
# Usage: just dev [target] [flags]
#   just dev          → cargo tauri dev (default)
#   just dev tauri    → same as above
#   just dev webui    → Vite dev server
#   just dev mock     → FastAPI mock backend + Vite (browser-only, no game)
#   just dev site     → site dev server (landing page)
#   just dev test     → tauri dev with test-harness feature

_dev-tauri *FLAGS='':
    python scripts/dev.py tauri {{FLAGS}}

_dev-webui *FLAGS='':
    python scripts/dev.py webui {{FLAGS}}

_dev-mock *FLAGS='':
    python scripts/dev.py webui --mock {{FLAGS}}

_dev-site port='4173':
    @command -v lagrange >/dev/null 2>&1 || cargo install lagrange-library
    lagrange dev --src docs --out dist/site --port {{port}}

_dev-test *FLAGS='':
    cargo tauri dev --features test-harness {{FLAGS}}

dev target='tauri' *FLAGS='':
    @just _dev-{{target}} {{FLAGS}}

# ── build ─────────────────────────────────────────────────────────────
#   just build                   → webui + Rust shell (release by default)
#   just build app [--release]   → cargo build (release by default)
#   just build webui             → pnpm build @wowsp/webui
#   just build site              → site + lagrange docs → dist/
#   just build package           → cargo tauri build (app only, no install bundles)
#   just build installers [--flavors ...] → shun installers (webview2 / lite)
#   just build game-assets        → compile the vendored game-assets
#   just build model-exporter    → compile the Rust ship GLB exporter
#   just build unoodle           → fetch + build the Lesta Oodle decoder
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
    @python scripts/check_docs.py
    @command -v lagrange >/dev/null 2>&1 || cargo install lagrange-library
    lagrange build --src docs --out dist

_build-package *FLAGS='':
    cargo tauri build {{FLAGS}}

_build-installers *FLAGS='':
    python scripts/build_installers.py {{FLAGS}}

_build-game-assets:
    @# The vendor tree is TRACKED IN-TREE (packages/tools/game-assets tree),
    @# never a nested clone: an independent fork slimmed to the game-assets /
    @# game-assets-core library crates — changes land via normal PRs, never via a
    @# pull from inside this checkout.
    @echo "Building vendored game-assets (landaire/wows-toolkit fork, tracked in-tree)..."
    cargo build --release -p game-assets

_build-model-exporter:
    @# The Rust ship GLB exporter (packages/tools/model-exporter) over the
    @# vendored game-asset VFS library — the bake pipeline's front end.
    @# Batch-mode capable: one process pays the GameParams parse for the
    @# whole fleet. Replaced the C++/CMake wows-model-exporter vendoring.
    @echo "Building model-exporter (Rust, cargo workspace)..."
    cargo build --release -p model-exporter

_build-unoodle:
    @# The Lesta Oodle decoder (github.com/lvlvllvlvllvlvl/oozextract, MIT):
    @# shallow-clone + cargo build + install to target/release/. The Lesta
    @# extraction routes also run this automatically when no decoder is
    @# found (see scripts/extract/fetch_oodle.py).
    python scripts/extract/fetch_oodle.py

build target='app' *FLAGS='':
    @just _build-{{target}} {{FLAGS}}

# ── test ──────────────────────────────────────────────────────────────
#   just test          → cargo test --workspace (default)
#   just test unit     → same as above
#   just test visual   → visual regression (needs dev-test running)
#   just test e2e      → Playwright browser tests

_test-unit *FLAGS='':
    cargo test --workspace {{FLAGS}}

_test-visual *FLAGS='':
    python -m pytest scripts/visual -c scripts/pyproject.toml {{FLAGS}} -m visual

_test-e2e *FLAGS='':
    python -m pytest scripts/e2e -c scripts/pyproject.toml {{FLAGS}} -m ui

test target='unit' *FLAGS='':
    @just _test-{{target}} {{FLAGS}}

# ── lint ──────────────────────────────────────────────────────────────
#   just lint           → full: fmt-check + clippy + anyhow policy +
#                         pnpm lint + i18n + license domains +
#                         release-notes grammar
#   just lint rust      → fmt-check + clippy
#   just lint webui     → pnpm lint
#   just lint i18n      → i18n parity check
#   just lint notes     → release-notes i18n grammar self-test (offline)
#   just check          → cargo check (fast compile check)

# Both recipes mirror the CI rust gate (ci.yml "Rustfmt"/"Clippy") exactly:
# the two app crates get fmt + clippy (--no-deps keeps the vendored
# game-assets/game-assets-core upstream lint style out), while repo-wide fmt would
# fail on the vendored dependency sources.
_lint-full:
    cargo fmt -p wowsp_tauri -p wowsp_tauri_shared -- --check
    cargo clippy -p wowsp_tauri -p wowsp_tauri_shared --lib --bins --no-deps -- -D warnings
    @python scripts/check_anyhow.py
    {{PM}} -r lint
    @python scripts/check_i18n.py
    @python scripts/check_licenses.py
    @python scripts/check_licenses.py --self-test
    @python scripts/release_notes_i18n.py self-test

_lint-rust:
    cargo fmt -p wowsp_tauri -p wowsp_tauri_shared -- --check
    cargo clippy -p wowsp_tauri -p wowsp_tauri_shared --lib --bins --no-deps -- -D warnings

_lint-webui:
    {{PM}} -r lint

_lint-i18n *FLAGS='':
    @python scripts/check_i18n.py {{FLAGS}}

_lint-notes:
    @python scripts/release_notes_i18n.py self-test

lint target='full' *FLAGS='':
    @just _lint-{{target}} {{FLAGS}}

# Live gate over the PUBLISHED GitHub Releases bodies (needs gh auth; the
# same lint ci.yml runs — AGENTS.md §10). Run after every
# release_notes_i18n.py set/wrap:
#   just notes-lint                → hard-validate every v* release body
#   just notes-lint --tag v0.6.7   → scope to one release
notes-lint *FLAGS='':
    @python scripts/release_notes_i18n.py lint {{FLAGS}}

# Standalone i18n parity check (same script as `just lint i18n`).
#   just i18n-check          → i18n parity check
#   just i18n-check --quiet  → suppress per-key detail
i18n-check *FLAGS='':
    @python scripts/check_i18n.py {{FLAGS}}

# Propagate the release version from its single source of truth (the root
# package.json) into the six derived manifests. CI runs the same script
# with --check and fails on drift (AGENTS.md §5).
sync-versions:
    @python scripts/sync_versions.py

# Upstream drift review for the game-assets fork (AGENTS.md §11): lists
# landaire/wows-toolkit commits touching the two forked crates since the
# reviewed baseline (scripts/upstream_drift_state.json) and flags the
# game-version adaptation candidates. Run at every game version bump.
#   just upstream-drift                  → review report (needs gh auth)
#   just upstream-drift --mark-reviewed  → advance the baseline after porting
upstream-drift *FLAGS='':
    @python scripts/upstream_drift.py {{FLAGS}}

check:
    cargo check --workspace

# Offline sandbox-conformance harness for the in-game probe (Main.py):
# execs it under a deliberately crippled builtins set and drives a full
# battle, asserting the bridge artifacts the app consumes. Run on every
# Main.py change — the Lesta ModsAPI whitelist cost too many field
# restart cycles to rediscover.
check-ingame-plugin:
    python scripts/check_ingame_plugin.py

# ── pairing relay ─────────────────────────────────────────────────────
# The pairing gateway (packages/pairing-relay) is a STANDALONE Rust
# workspace compiled to wasm32 for Cloudflare Workers (excluded from the
# root workspace — own gitignored Cargo.lock). One recipe covers both
# halves of its verification; wasm32 check is quick and holds no shared
# target-dir lock (the package has its own target/). Pure cargo — no
# frontend deps needed (the console pages live in packages/console).
check-relay:
    cd packages/pairing-relay && cargo test -p relay-core
    cd packages/pairing-relay && cargo check --target wasm32-unknown-unknown

# Maintainer replay-share drain CLI (packages/tools/replay-drain):
#   just drain-replays                → pull + verify + drain every staged shard
#   just drain-replays -- --dry-run   → verify + archive only
#   just drain-credits                → export contributors.json
# Auth: --key or WOWSP_REPLAY_ADMIN_KEY (the worker's REPLAY_ADMIN_KEY).
drain-replays *FLAGS='':
    cargo run -p replay-drain -- pull {{FLAGS}}

drain-credits *FLAGS='':
    cargo run -p replay-drain -- credits {{FLAGS}}

# Bundles the WEBSITE-ONLY site into packages/pairing-relay/assets —
# the worker's [assets] layer (worker-primary hosting; see
# packages/pairing-relay/README.md ▶ Site hosting model). The full
# deploy bundle is built by the Deploy Site workflow from the merged
# docs+website artifact; this is the quick local path for `wrangler
# dev` or a site-only manual `wrangler deploy`.
bundle-site:
    #!/bin/sh
    set -e
    # Two-origin layout (see the script's docstring): Pages at /wowsp/
    # (first resource candidate) and the worker's nested copy at
    # /wowsp/** (fallback). MSYS2_ENV_CONV_EXCL: Git Bash would
    # otherwise rewrite the /wowsp/ env value into a Windows path on
    # its way to node.
    MSYS2_ENV_CONV_EXCL="WOWSP_SITE_BASE" WOWSP_SITE_BASE=/wowsp/ pnpm --filter @wowsp/website build
    pnpm --filter @wowsp/console build
    python scripts/build_worker_site.py dist/website packages/pairing-relay/assets --console dist/console
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
#   just build android-apk          → one-ABI SLIM APK (the distributed flavor)
#   just build android-apk-full     → one-ABI FULL APK (resource pack embedded)
#
# TWO flavors:
#
# SLIM (the default, what gets distributed): the resource pack and the
# offline GameParams pack are NOT embedded — the APK ships ~80 MB instead
# of ~500, the resource pack downloads on demand (设置 ▸ 资源, res_download
# streams it with progress; the downloaded cache serves over the asset
# protocol through tauri.android.conf.json's $CACHE scope) and ship data
# comes from the data-latest channel / the compile-time Lesta snapshot
# (commands/gameparams.rs's ladder). The recipes pin WOWSP_MOBILE_BUNDLE=0
# so the webui build prunes the packs even under Tauri's own
# TAURI_ENV_PLATFORM=android (see vite.config.ts), and no
# fetch_models/extract_gameparams step runs — a slim build needs neither.
#
# FULL (`android-apk-full`, or `dev android`): the old behavior — the
# recipes run fetch_models + the offline GameParams extraction first (both
# idempotent — the model pull skips the ~1.3 GB download when the local
# wowsp-res.json tree hash already matches res-latest; the gameparams pack
# re-extracts only when build.txt lags the installed game) and export
# WOWSP_MOBILE_BUNDLE=1 so the webui build's prune steps keep
# models/*.glb + dogtags + data/gameparams in dist; the app then serves
# them same-origin from the read-only APK assets. Desktop `just build
# tauri`/`package` is untouched — no env var, pruning stays on.
#
# NDK note: pin 29.x. tauri-cli 2.12 HONORS NDK_HOME (2.11 always picked
# the newest installed one), so the pin below is what builds actually use —
# and 26.1 must NOT be pinned anymore: its old-style clang .cmd wrappers
# mishandle a cdylib link's --version-script replay through %* ("was
# unexpected at this time" on any cdylib dep like hifumi), which NDK 29's
# rewritten wrappers fixed. cargo check (check-android below) links
# nothing, so the wrapper class never matters there.

# Machine-local SDK/JDK locations as OVERRIDABLE defaults:
# `env_var_or_default` picks up ANDROID_HOME / NDK_HOME / JAVA_HOME from the
# environment when present, so CI or another workstation only needs to
# export the vars — no file edits. NDK_HOME still derives from ANDROID_HOME
# by default so the 26.1 pin below stays the source of truth.
ANDROID_HOME := env_var_or_default("ANDROID_HOME", "C:/Users/langy/AppData/Local/Android/Sdk")
NDK_HOME     := env_var_or_default("NDK_HOME", ANDROID_HOME / "ndk/29.0.13846066")
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
# per-target CC/linker env itself from the resolved NDK. The build recipes
# pin their flavor through WOWSP_MOBILE_BUNDLE (0 slim / 1 full) — it must
# reach tauri.conf.json's beforeBuildCommand (`pnpm --filter @wowsp/webui
# build`) so the webui build prunes (slim) or keeps (full) the GLBs and
# the offline gameparams pack.
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
    # SLIM (the distributed flavor): no pack fetch, no embed — the user
    # downloads the resource pack on demand and ship data rides the
    # data-latest channel. WOWSP_MOBILE_BUNDLE=0 pins the prune even under
    # Tauri's own TAURI_ENV_PLATFORM=android.
    export ANDROID_HOME={{ANDROID_HOME}} NDK_HOME={{NDK_HOME}} \
        ANDROID_NDK_HOME={{NDK_HOME}} ANDROID_NDK_ROOT={{NDK_HOME}} \
        JAVA_HOME="{{JAVA_HOME}}" WOWSP_MOBILE_BUNDLE=0
    # The Android NDK's lld mangles non-ASCII rustc paths on Windows (GBK
    # bytes under a Chinese checkout path fail to open), so the Rust half
    # must build into an ASCII CARGO_TARGET_DIR. The resolver prints/creates
    # one (override: WOWSP_ANDROID_CARGO_TARGET); the Gradle/Android Studio
    # path mirrors the same candidate order in buildSrc/.../BuildTask.kt.
    export CARGO_TARGET_DIR="$(python scripts/android_cargo_target.py)"
    cargo tauri android build {{FLAGS}}

# FULL flavor: the resource pack + offline GameParams pack ride into the
# APK's read-only assets (~500 MB, works fully offline). Skip-if-present
# fetches of the packs: the GLB model pack (res-latest release) and the
# offline GameParams ship-data pack (re-extracted when the game build
# changed). The extract_gameparams step FAILS the build when neither the
# cached GameParams.json nor a game install to generate it from is
# available — a full APK without offline tech data is a defect, not a
# degraded mode.
_build-android-full *FLAGS='':
    #!/usr/bin/env bash
    set -euo pipefail
    python scripts/fetch_models.py
    python scripts/extract_gameparams.py
    export ANDROID_HOME={{ANDROID_HOME}} NDK_HOME={{NDK_HOME}} \
        ANDROID_NDK_HOME={{NDK_HOME}} ANDROID_NDK_ROOT={{NDK_HOME}} \
        JAVA_HOME="{{JAVA_HOME}}" WOWSP_MOBILE_BUNDLE=1
    export CARGO_TARGET_DIR="$(python scripts/android_cargo_target.py)"
    cargo tauri android build {{FLAGS}}

# Single-ABI APK shortcuts: the canonical `--debug --apk --target aarch64`
# from the section note above. Without an explicit --target, cargo tauri
# android build compiles ALL FOUR ABIs (aarch64/armv7/i686/x86_64) — slow,
# and the extra Rust targets are usually not even installed. Debug output
# is signed with the local debug keystore automatically; a RELEASE APK
# (pass --release as FLAGS) comes out unsigned until a signingConfig +
# gen/android/key.properties (gitignored) is wired into the gradle project.
_build-android-apk *FLAGS='--debug':
    just _build-android --apk --target aarch64 {{FLAGS}}

_build-android-apk-full *FLAGS='--debug':
    just _build-android-full --apk --target aarch64 {{FLAGS}}

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
#   just convert-ship --name Yamato            → ship → GLB
#   just convert-map --name 18_NE_ice_islands  → map → GLB
#   just convert-map-holo --name 18_NE_ice_islands → contour holomap

convert-ship *ARGS:
    python scripts/model_convert/convert_ship.py {{ARGS}}

convert-map *ARGS:
    python scripts/model_convert/convert_map.py {{ARGS}}

convert-map-holo *ARGS:
    WOWSP_GAME_ASSETS="target/release/game-assets.exe" python scripts/model_convert/convert_map_holo.py {{ARGS}}

# ── bake ──────────────────────────────────────────────────────────────
#   just bake-model raw.glb -o ship.glb --triangles 2000
#   just bake-ships
#   just bake-maps
#   just bake-optimize

bake-model *ARGS:
    python scripts/model_convert/bake_model.py {{ARGS}}

bake-ships *ARGS:
    python scripts/model_convert/batch_bake.py {{ARGS}}

bake-maps *ARGS:
    WOWSP_GAME_ASSETS="target/release/game-assets.exe" python scripts/model_convert/batch_bake_maps.py {{ARGS}}

# Optimize the baked GLB pack in place (meshopt + quantize; idempotent,
# skips already-optimized files). Run after bake-ships/bake-maps.
bake-optimize *ARGS:
    python scripts/model_convert/optimize_glbs.py {{ARGS}}

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

# ── publish-data ────────────────────────────────────────────────────────
# Publish the baked ship-data assets to the fixed `data-latest` release —
# the hot-update channel `commands/data_pack.rs` refreshes on every app
# boot. Run after re-baking data (extract_ship_consumable_kit.py & co.);
# identical content is a client-side no-op (content-addressed assets).
# Idempotent; --dry-run shows the upload/prune plan. Pushing the release is
# the maintainer's step (gh auth), by design.

publish-data *ARGS:
    python scripts/publish_data_pack.py {{ARGS}}

# Bake the two-realm ship-data bundle (both GameParams dumps from the extract
# cache) and publish just that dataset: the fleet's armor/ballistics/sonar
# slices reach machines with no install — and both realms — without an app
# release. Needs the WG dump plus a Lesta dump (`just extract` fills both;
# --lesta-gameparams accepts a pre-decoded one).
#   just publish-shipdata            → bake + publish + prune
#   just publish-shipdata --dry-run  → bake + show the upload plan

publish-shipdata *ARGS:
    python scripts/extract/build_shipdata_bundle.py
    python scripts/publish_data_pack.py --dataset ship-gameparams {{ARGS}}

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
