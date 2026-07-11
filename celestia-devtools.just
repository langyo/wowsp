# celestia-devtools common.just — vendored build recipes.
#
# This file is COPIED into your repo by `celestia-devtools init`.
# Commit it to git so every clone gets it — no package install needed
# to parse the justfile, only to run the recipes.
#
# Refresh with:  celestia-devtools init --force
# Version: 0.2.0
#
# All recipes and variables are overridable — redefine anything after the
# `import` line in your justfile to customize it.
#
# This file is intentionally free of `set` directives (shell, windows-shell,
# unstable) so it composes cleanly with each repo's own header.
#
# Windows note: `set windows-shell` only governs linewise recipes. Shebang
# recipes bypass it and force `just` to call `cygpath` (which Git for Windows
# keeps off PATH), so they die with "could not find cygpath executable". To
# avoid that, the multi-line recipes below use the `[script('bash')]` attribute
# (stable since just 1.32.0), which resolves the interpreter via PATH and never
# calls cygpath. The `windows-shell-check` recipe below verifies bash is on PATH.

# ── Tool resolution ───────────────────────────────────────────────────────────

# On Windows prefer `python` — `python3` is often the broken WindowsApps Store
# stub that exits 49. On Unix, `python3` is the norm.
python_cmd := if os_family() == "windows" {
    if which("python") != "" { "python" } else { "python3" }
} else {
    if which("python3") != "" { "python3" } else { "python" }
}

# Resolve the celestia-devtools CLI: installed entry point, or module fallback.
_devtools := if which("celestia-devtools") != "" { "celestia-devtools" } else { python_cmd + " -m celestia_devtools" }

# ── Bootstrap ─────────────────────────────────────────────────────────────────

# Ensure celestia-devtools is installed. Run once on a fresh checkout.
# Override the install source with $CELESTIA_DEVTOOLS_INSTALL (e.g. a local path).
ensure:
    @command -v celestia-devtools >/dev/null 2>&1 || \
        {{python_cmd}} -c "import celestia_devtools" 2>/dev/null || \
        pip install "${CELESTIA_DEVTOOLS_INSTALL:-git+https://github.com/celestia-island/celestia-devtools.git}"

# Fail fast on Windows if the importing justfile forgot `set windows-shell`.
[script('bash')]
windows-shell-check:
    set -euo pipefail
    if [ "{{os_family()}}" != "windows" ]; then
      echo "windows-shell-check: non-Windows host, nothing to check."
      exit 0
    fi
    if ! command -v bash.exe >/dev/null 2>&1; then
      echo "windows-shell-check: bash.exe not on PATH." >&2
      echo "  Install Git for Windows, or add its usr/bin to PATH." >&2
      exit 1
    fi
    echo "windows-shell-check: bash.exe found. Ensure the importing justfile sets:"
    echo "  set windows-shell := [\"bash.exe\", \"-c\"]"

# ── Build helper ──────────────────────────────────────────────────────────────

# Shared build dispatcher: runs a prerequisite, then picks dev vs release cmd.
[script('bash')]
_build always_pre dcmd rcmd *FLAGS='':
    set -euo pipefail
    profile=release
    for a in {{FLAGS}}; do
      case "$a" in
        --dev)   profile=dev ;;
        --clean) cargo clean ;;
      esac
    done
    [ "X{{always_pre}}" != "X:" ] && {{always_pre}}
    if [ "$profile" = dev ]; then {{dcmd}}; else {{rcmd}}; fi

# ── Cache management ──────────────────────────────────────────────────────────

# target/ cache guard:
#   free-disk floor < 10 GiB → cargo clean (instant check, every run)
#   target ≥ 40 GiB → cargo sweep --time 7 (needs cargo-sweep; cached du)
# Tune via flags or CARGO_CACHE_GUARD_* env vars. Run before `just build`.
cache-guard *ARGS='':
    {{ _devtools }} cache-guard . {{ARGS}}

# Backwards-compatible alias of cache-guard.
sweep-guard min_free="10":
    {{ _devtools }} cache-guard . --min-free-gib {{min_free}}

# Manually remove target/**/incremental/ (keeps compiled dep artifacts).
clean-incremental:
    {{ _devtools }} cache-guard . --clean-incremental

# ── Formatting ────────────────────────────────────────────────────────────────

# Format Markdown docs (stdlib-only; call inside your fmt/fmt-check recipe).
# Does NOT touch Rust or JS — compose with cargo fmt / pnpm lint yourself.
fmt-markdown *ARGS='':
    {{ _devtools }} format-markdown . {{ARGS}}

# ── Dependencies ──────────────────────────────────────────────────────────────

# Pre-stage all deps for offline builds (cargo fetch + pnpm install).
# Run once after cloning (needs network); subsequent builds run fully offline.
prefetch:
    {{ _devtools }} prefetch .

# ── Crate location ────────────────────────────────────────────────────────────

# Locate a celestia-island crate checkout (env → cargo [patch] → sibling → clone).
locate crate:
    {{ _devtools }} locate --crate {{crate}}
