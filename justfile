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
#   just build package           → cargo tauri build (installer)
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
    @python scripts/check_i18n.py --quiet || true
    {{PM}} --filter @wowsp/webui build

_build-site:
    @command -v lagrange >/dev/null 2>&1 || cargo install lagrange-library
    lagrange build --src docs --out dist

_build-package *FLAGS='':
    cargo tauri build {{FLAGS}}

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

_lint-full:
    cargo fmt --all -- --check
    cargo clippy --workspace --lib --bins -- -D warnings
    {{PM}} -r lint
    @python scripts/check_i18n.py --no-fail

_lint-rust:
    cargo fmt --all -- --check
    cargo clippy --workspace --lib --bins -- -D warnings

_lint-webui:
    {{PM}} -r lint

_lint-i18n *FLAGS='':
    @python scripts/check_i18n.py {{FLAGS}}

lint target='full' *FLAGS='':
    @just _lint-{{target}} {{FLAGS}}

check:
    cargo check --workspace

# ── fmt ───────────────────────────────────────────────────────────────
#   just fmt           → auto-fix: organize imports + clippy fix + cargo fmt + pnpm lint --fix
#   just fmt check     → cargo fmt --check only

_fmt-fix:
    cargo clippy --workspace --all-targets --all-features -- -D warnings
    cargo fmt --all
    {{PM}} -r lint --fix

_fmt-check:
    cargo fmt --all -- --check

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

bake-model *ARGS:
    python scripts/model_convert/bake_model.py {{ARGS}}

bake-ships *ARGS:
    python scripts/model_convert/batch_bake.py {{ARGS}}

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
    @echo "Done."

install: init
bootstrap: init
    cargo build -p wowsp_tauri

# ── ci ────────────────────────────────────────────────────────────────

ci:
    just fmt check
    cargo clippy --workspace --lib --bins -- -D warnings
    cargo check --workspace
    cargo test --workspace
    {{PM}} -r typecheck
    {{PM}} -r lint

# ── package ───────────────────────────────────────────────────────────

package *FLAGS:
    cargo tauri build {{FLAGS}}

# ── e2e ───────────────────────────────────────────────────────────────

e2e-setup:
    @pip install -q -r scripts/requirements.txt && python -m playwright install chromium 2>/dev/null

# ── release-models ─────────────────────────────────────────────────────
# Package baked GLB models as a GitHub Release asset and prune old releases
# (keeps the 3 most recent model packs). Requires `gh` CLI.
#   just release-models 0.14.1
#   just release-models 0.14.1 --dry-run
release-models *ARGS:
    python scripts/release_models.py {{ARGS}}

# ── check-env ─────────────────────────────────────────────────────────
# WoWSP-specific environment check (celestia-devtools provides a generic
# `preflight`, so we use a distinct name to avoid collision).

check-env *FLAGS:
    python scripts/preflight.py {{FLAGS}}
