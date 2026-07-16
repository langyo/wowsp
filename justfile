# WoWSP — Windows-first Tauri desktop app. The justfile is fully self-contained
# (no celestia-devtools import, no WSL assumptions): every recipe is linewise so
# it runs under `windows-shell` (pwsh) on Windows and the default sh on Unix.

set windows-shell := ["pwsh.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $PSDefaultParameterValues['*:Encoding'] = 'utf8';"]
set unstable
set lists

default:
    @just --list

PM := "pnpm"

# ── dev ───────────────────────────────────────────────────────────────
# Usage: just dev app | webui | site | test
#   just dev app [--mock]        → cargo tauri dev
#   just dev app --watch         → cargo tauri dev + watch Cargo.toml
#   just dev webui [--mock]      → Vite dev server
#   just dev site                → site dev server (landing page)
#   just dev test                → tauri dev with test-harness feature

_dev-app *FLAGS='':
    python scripts/dev.py tauri {{FLAGS}}

_dev-webui *FLAGS='':
    python scripts/dev.py webui {{FLAGS}}

_dev-site port='0':
    @where lagrange >nul 2>nul || cargo install lagrange-library
    lagrange dev --src docs --out dist/site --port {{port}}

_dev-test *FLAGS='':
    cargo tauri dev --features test-harness {{FLAGS}}

dev target *FLAGS='':
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
    @where lagrange >nul 2>nul || cargo install lagrange-library
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
    @python scripts/utils/enforce_import_groups.py
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

# ── preflight ─────────────────────────────────────────────────────────

preflight *FLAGS:
    python scripts/preflight.py {{FLAGS}}
