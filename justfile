# WoWSP — Windows-first Tauri desktop app. The justfile is fully self-contained
# (no celestia-devtools import, no WSL assumptions): every recipe is linewise so
# it runs under `windows-shell` (pwsh) on Windows and the default sh on Unix.
# No [script('bash')] attributes — those resolve `bash` via PATH, which on a
# machine with WSL installed picks WSL's bash and fails to see the Windows temp
# dir just writes the script to.

set windows-shell := ["pwsh.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $PSDefaultParameterValues['*:Encoding'] = 'utf8';"]
set unstable
set lists

default:
    @just --list

PM := "pnpm"

# ── Lifecycle ────────────────────────────────────────────────────────

init:
    @echo "Initializing WoWSP..."
    cargo fetch
    {{PM}} install
    just gen-shaders
    just gen-icons
    @echo "Done."

install:
    just init

bootstrap: init
    cargo build -p wowsp_tauri

# ── Build ────────────────────────────────────────────────────────────

# Build the Rust shell (release by default; pass --dev for debug).
build *FLAGS:
    just build-webui
    cargo build -p wowsp_tauri {{FLAGS}}

build-dev *FLAGS:
    just build-webui
    cargo build -p wowsp_tauri --dev {{FLAGS}}

build-webui:
    just gen-shaders
    @python scripts/check_i18n.py --quiet || true
    {{PM}} --filter @wowsp/webui build

build-tauri *FLAGS:
    cargo tauri build {{FLAGS}}

clean:
    cargo clean
    {{PM}} -r run clean
    -rm -rf dist/ packages/webui/.generated/

clean-rust:
    cargo clean

clean-webui:
    {{PM}} --filter @wowsp/webui run clean
    -rm -rf dist/

# ── Run / Dev ────────────────────────────────────────────────────────

# Dev server (DEFAULT = native Tauri desktop). Same as `just dev tauri`.
#   just dev [tauri]        → cargo tauri dev (tauri-cli watches Rust src,
#                             Vite HMRs the webui, malkuth drains on restart)
#   just dev tauri --watch  → also restart when Cargo.toml/tauri.conf.json/
#                             justfile/.env change
#   just dev tauri --mock   → cargo tauri dev + FastAPI mock backend on :8787
#   just dev webui          → browser-only Vite (no Tauri shell)
#   just dev webui --mock   → browser Vite + mock backend
dev target='tauri' *FLAGS='':
    python scripts/dev.py {{target}} {{FLAGS}}

watch *FLAGS:
    just dev tauri --watch {{FLAGS}}

run-webui:
    {{PM}} --filter @wowsp/webui dev

run-tauri *FLAGS:
    cargo tauri dev {{FLAGS}}

# 启动带 test-harness feature 的 app（启用 dev-only HTTP 控制端口，
# 供 `just test-visual` 的 Python 脚本驱动）。feature 门控保证 release
# 构建绝不包含此控制服务器。
dev-test *FLAGS:
    cargo tauri dev --features test-harness {{FLAGS}}

# Host preflight (runs scripts/preflight.py).
preflight *FLAGS:
    python scripts/preflight.py {{FLAGS}}

# ── Quality ──────────────────────────────────────────────────────────

fmt:
    just _fmt-imports
    cargo clippy --workspace --all-targets --all-features -- -D warnings
    cargo fmt --all
    {{PM}} -r lint --fix

fmt-check:
    cargo fmt --all -- --check

clippy:
    cargo clippy --workspace --lib --bins -- -D warnings

lint: fmt-check clippy
    {{PM}} -r lint

check:
    cargo check --workspace

test:
    cargo test --workspace

# 视觉回归测试：驱动运行中的 Tauri app（需先 `just dev-test` 启动）。
# 截图保存到 %APPDATA%/WoWSP/screenshots/，人工肉眼检查。
test-visual *FLAGS:
    python -m pytest scripts/visual -c scripts/pyproject.toml {{FLAGS}} -m visual

# Playwright 浏览器 UI 测试（针对 mock 后端，`just dev webui --mock`）。
test-e2e *FLAGS:
    python -m pytest scripts/e2e -c scripts/pyproject.toml {{FLAGS}} -m ui

i18n-check *FLAGS:
    @python scripts/check_i18n.py {{FLAGS}}

ci: gen fmt-check clippy test
    {{PM}} -r typecheck
    {{PM}} -r lint

# ── Generate (codegen, bundles, icons) ───────────────────────────────

gen:
    just gen-shaders
    just gen-icons

gen-shaders:
    python scripts/glsl_bundle.py --verbose

gen-icons:
    python scripts/ensure_tauri_icons.py

# ── Package ──────────────────────────────────────────────────────────

package *FLAGS:
    cargo tauri build {{FLAGS}}

# ── E2E ──────────────────────────────────────────────────────────────

e2e-setup:
    @pip install -q -r scripts/requirements.txt && python -m playwright install chromium 2>/dev/null

# ── Model conversion (ship/map → baked GLB for holographic rendering) ──

convert-ship *ARGS:
    python scripts/model_convert/convert_ship.py {{ARGS}}

convert-map *ARGS:
    python scripts/model_convert/convert_map.py {{ARGS}}

# Bake (simplify) a raw GLB to a low-poly holographic model.
# Usage: just bake-model raw.glb -o ship.glb --triangles 2000
bake-model *ARGS:
    python scripts/model_convert/bake_model.py {{ARGS}}

# ── Docs (lagrange multilingual site) ────────────────────────────────

# Build the docs site into dist/docs/. Installs lagrange if missing.
docs:
    cargo install lagrange-library --locked || cargo install --git https://github.com/celestia-island/lagrange --branch dev lagrange-library
    lagrange build --src docs --out dist/docs

# Local preview server (default port 3000). Installs lagrange if missing.
docs-serve port='3000':
    cargo install lagrange-library --locked || cargo install --git https://github.com/celestia-island/lagrange --branch dev lagrange-library
    lagrange dev --src docs --out dist/docs --port {{port}}

# ── Internal ─────────────────────────────────────────────────────────

_fmt-imports:
    @python scripts/utils/enforce_import_groups.py
