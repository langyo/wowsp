set shell := ["bash", "-c"]
# `set windows-shell` only governs linewise (non-shebang) recipes on Windows.
# Shebang recipes bypass it and force `just` to call `cygpath` to translate the
# interpreter path — which Git for Windows keeps off PATH, so they die with
# "could not find cygpath executable". To avoid that, every multi-line recipe
# below uses the `[script('bash')]` attribute instead of a `#!` shebang:
# `[script]` resolves the interpreter via PATH (PATHEXT-aware) and never calls
# cygpath. See casey/just#2828 and the just manual (Script Recipes).
set windows-shell := ["pwsh.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $PSDefaultParameterValues['*:Encoding'] = 'utf8';"]
set unstable
set lists

default:
    @just --list

PM := "pnpm"

import "./celestia-devtools.just"

# ── Lifecycle ────────────────────────────────────────────────────────

init:
    @echo "Initializing WoWSP..."
    cargo fetch
    {{PM}} install
    just gen shaders
    just gen icons
    @echo "Done."

install:
    just init

bootstrap: init
    cargo build -p wowsp_tauri

# ── Build ────────────────────────────────────────────────────────────

# Build everything (release by default; --dev for debug; --clean to wipe)
[script('bash')]
build target='all' *FLAGS=''):
    set -euo pipefail
    case "{{target}}" in
      all)
        profile=release
        for a in {{FLAGS}}; do case "$a" in --dev) profile=dev;; esac; done
        if [ "$profile" != dev ]; then just _build-webui; fi
        cargo build -p wowsp_tauri {{FLAGS}}
        ;;
      webui)  just _build-webui ;;
      tauri)  cargo tauri build {{FLAGS}} ;;
      *) echo "Usage: just build all|webui|tauri"; exit 1 ;;
    esac

_build-webui:
    just gen shaders
    @python scripts/check_i18n.py --quiet || true
    {{PM}} --filter @wowsp/webui build

[script('bash')]
clean target='all':
    set -euo pipefail
    case "{{target}}" in
      all)  cargo clean; {{PM}} -r run clean; rm -rf dist/ packages/webui/.generated/ ;;
      rust) cargo clean ;;
      webui) {{PM}} --filter @wowsp/webui run clean; rm -rf dist/ ;;
      *) echo "Unknown clean target: {{target}}"; exit 1 ;;
    esac

# ── Run ──────────────────────────────────────────────────────────────

# Dev server — dispatch by target:
#   just dev              → native desktop (Vite + Tauri)
#   just dev webui        → native browser (Vite only)
#   just dev --mock       → WoWSP mock backend (FastAPI) + Vite
#   just dev watch --mock → mock stack + auto-rebuild
[script('bash')]
dev target='' *FLAGS=''):
    set -euo pipefail
    # Prefer plain `python` on Windows (python3 is often the broken
    # WindowsApps Store stub that exits 49). On Unix, `python3` is the norm.
    PY=""
    for candidate in python python3 python3.12 python3.11; do
      if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'pass' 2>/dev/null; then
        PY="$candidate"; break
      fi
    done
    if [ -z "$PY" ]; then echo "error: no working python found"; exit 1; fi
    case "{{target}}" in
      tauri) "$PY" scripts/dev.py --native tauri {{FLAGS}} ;;
      webui) "$PY" scripts/dev.py --native {{FLAGS}} ;;
      "")    "$PY" scripts/dev.py {{FLAGS}} ;;
      *) echo "Usage: just dev [tauri|webui] [--mock|--clean]"; exit 1 ;;
    esac

watch *FLAGS:
    just dev {{FLAGS}}

# Run a specific target
[script('bash')]
run target='webui' *FLAGS=''):
    set -euo pipefail
    case "{{target}}" in
      webui) {{PM}} --filter @wowsp/webui dev ;;
      tauri)  cargo tauri dev {{FLAGS}} ;;
      mock)   python scripts/dev.py --mock & DEV_PID=$!; trap 'kill $DEV_PID 2>/dev/null || true' EXIT INT TERM; cargo tauri dev {{FLAGS}} ;;
      *) echo "Unknown run target: {{target}}"; echo "Usage: just run webui|tauri|mock"; exit 1 ;;
    esac

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

[script('bash')]
test target='all' *FLAGS=''):
    set -euo pipefail
    case "{{target}}" in
      all)     if [ -z "{{FLAGS}}" ]; then cargo test --workspace; else python -m pytest scripts/e2e {{FLAGS}}; fi ;;
      backend) cargo test --workspace ;;
      e2e)     python -m pytest scripts/e2e {{FLAGS}} ;;
      *) echo "Usage: just test all|backend|e2e [-- -k overlay]"; exit 1 ;;
    esac

i18n-check *FLAGS:
    @python scripts/check_i18n.py {{FLAGS}}

ci: gen fmt-check clippy test
    {{PM}} -r typecheck
    {{PM}} -r lint

# ── Generate (codegen, bundles, icons) ───────────────────────────────

[script('bash')]
gen target='all' *FLAGS=''):
    set -euo pipefail
    case "{{target}}" in
      all)       just gen shaders; just gen icons ;;
      shaders)   python scripts/glsl_bundle.py --verbose ;;
      icons)     python scripts/ensure_tauri_icons.py ;;
      *) echo "Usage: just gen all|shaders|icons"; exit 1 ;;
    esac

# ── Package ──────────────────────────────────────────────────────────

[script('bash')]
package target='tauri' *FLAGS=''):
    set -euo pipefail
    case "{{target}}" in
      tauri)  cargo tauri build {{FLAGS}} ;;
      *) echo "Usage: just package tauri"; exit 1 ;;
    esac

# ── E2E ──────────────────────────────────────────────────────────────

e2e-setup:
    @pip install -q -r scripts/requirements.txt && python -m playwright install chromium 2>/dev/null

# ── Model conversion (WoWSP-specific: ship/map → GLB for three.js) ───

[script('bash')]
convert-model kind *ARGS=''):
    set -euo pipefail
    case "{{kind}}" in
      ship) python scripts/model_convert/convert_ship.py {{ARGS}} ;;
      map)  python scripts/model_convert/convert_map.py {{ARGS}} ;;
      *) echo "Usage: just convert-model ship|map [--input <path> --output <path>]"; exit 1 ;;
    esac

# ── Internal ─────────────────────────────────────────────────────────

_fmt-imports:
    @python scripts/utils/enforce_import_groups.py
