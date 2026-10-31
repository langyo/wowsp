#!/usr/bin/env python3
"""Tauri RPC command-name parity validator for WoWSP.

The Rust <-> TypeScript command contract is hand-mirrored across the app
surface plus a dev mock:

  - `packages/app/tauri/src/**/*.rs` — the `#[tauri::command]` functions
    (the wire truth; includes the mobile stand-ins in `commands/mod.rs`),
  - the `tauri::generate_handler![...]` list in `packages/app/tauri/src/lib.rs`
    — a command that is defined (and even mirrored in rpc.ts) but forgotten
    in the handler list compiles fine and only fails at runtime,
  - `packages/webui/src/rpc.ts` — the hand-maintained `RPC` name table the
    webui routes every `transport.invoke(cmd)` through,
  - raw `invoke("...")` string literals in `packages/webui/src/**/*.{ts,tsx}`
    (overlay/ bypasses rpc.ts entirely) — a typo'd literal
    here passes every other check and explodes at runtime,
  - `scripts/mock/src/main.py` — the browser-dev mock backend, which
    mirrors a SUBSET of the same names under `/api/<cmd>`.

Drift here compiles fine everywhere and only explodes at runtime ("command
not found"), so this script diffs all the name sets:

  - Rust vs rpc.ts: bidirectional. Every command must be listed in rpc.ts
    (even ones invoked through a raw `invoke("...")` string), and every
    rpc.ts entry must still exist in Rust. Also flags table rows whose
    TS key does not match their wire-name value (the table's convention
    is `snake_case: "snake_case"`).
  - Rust vs generate_handler!: bidirectional. defined-but-unregistered and
    registered-but-undefined are both errors. cfg-gated twins (the
    windows/non-windows `is_game_running` pair, the mobile stand-ins) are
    intentional per-target definitions of ONE wire command, so both sides
    are compared by NAME only and twins never produce false positives.
  - Rust vs raw invokes: every literal first argument (quoted or
    interpolation-free template) of an `invoke(...)` call in the webui
    must be a Rust command. Call sites
    routed through rpc.ts's wrapper (non-literal argument) are naturally
    skipped.
  - Rust vs mock: one-directional. The mock only serves the browser-dev
    subset, so missing mock routes are fine; a mock route with no Rust
    command is a stale route and fails.
  - Installer surface: the same defined-vs-registered bidirectional check
    against its own `generate_handler!` list, plus literal invokes in its
    web UI as a subset of its Rust command set.
  - Window-gating ratchet: a command that takes `window: tauri::Window`
    must actually call `ensure_main_window_label(window.label())` (the
    audit P0-5 gate is opt-in, so a refactor could keep the parameter and
    silently drop the call), and the frozen `GATED_COMMANDS` roster must
    never lose its `window` parameter. Graduating a command onto the
    gate = add the parameter, make the gate call, append the name to
    `GATED_COMMANDS` in the same PR.

Exit codes: 0 = parity, 1 = drift.

Usage:
    python scripts/check_rpc_parity.py             # full report
    python scripts/check_rpc_parity.py --quiet     # only failures
    python scripts/check_rpc_parity.py --json      # machine-readable
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RUST_SRC_DIR = REPO_ROOT / "packages" / "app" / "tauri" / "src"
RPC_TS_PATH = REPO_ROOT / "packages" / "webui" / "src" / "rpc.ts"
WEBUI_SRC_DIR = REPO_ROOT / "packages" / "webui" / "src"
MOCK_PY_PATH = REPO_ROOT / "scripts" / "mock" / "src" / "main.py"
APP_LIB_RS = REPO_ROOT / "packages" / "app" / "tauri" / "src" / "lib.rs"

# `#[tauri::command]` / `#[tauri::command(...)]` — anchored on '[', so the
# doc/comment lines that merely mention the attribute never match.
COMMAND_ATTR_RE = re.compile(r"^\s*#\[\s*tauri::command(?:\([^)]*\))?\s*\]")
# `pub` is optional: crate-private command fns count too.
PUB_FN_RE = re.compile(r"^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)")
# Lines allowed to sit between the attribute and its fn: doc comments,
# other attributes, blanks.
SKIP_RE = re.compile(r"^\s*(//.*|#!?\[.*\]|)$")
# rpc.ts table row: `  name: "name",`
TS_ROW_RE = re.compile(r'^\s*([A-Za-z0-9_]+)\s*:\s*"([A-Za-z0-9_]+)"\s*,?\s*$')
# Mock route decorator: `@app.get("/api/<cmd>")` / `@app.post("/api/<cmd>")`
MOCK_ROUTE_RE = re.compile(r'^@app\.(?:get|post)\("/api/([a-z0-9_]+)"\)')

# `tauri::generate_handler![` — the registration macro invocation.
HANDLER_MACRO_RE = re.compile(r"tauri::generate_handler!\s*\[")
# One handler-list entry: `module::path::name` with an optional trailing
# comma (attributes/comments never reach this regex — they are skipped
# earlier, which also keeps multi-line `#[cfg(all(...))]` continuation
# lines out only as long as they stay single-line, the house style).
HANDLER_ENTRY_RE = re.compile(r"^((?:[A-Za-z0-9_]+::)*[A-Za-z0-9_]+)\s*,?\s*$")

# An `invoke` call matched BY NAME with a literal first argument:
# `invoke("cmd")`, `invoke<T>("cmd")`, `tauri.core.invoke("cmd")` — the
# `<...>` optional generics tolerate two nesting levels
# (`invoke<Record<string, Array<number>>>("cmd")`) and never contain
# parens; deeper nesting or parenthesized types simply do not match, so
# those call sites stay skipped. The literal may be double/single-quoted
# or a template literal WITHOUT `${...}` interpolation (`invoke` + "`" +
# `quit_app` + "`") — an interpolated template is genuinely dynamic and
# stays skipped (its `${` breaks the identifier match). Non-literal first
# arguments (`transport.invoke(RPC.foo)`, the wrapper's own
# `invoke(cmd, args)`) do not match, so rpc.ts-routed call sites are
# naturally skipped.
INVOKE_LITERAL_RE = re.compile(
    r"\binvoke\s*(?:<(?:[^<>()]|<(?:[^<>()]|<[^<>()]*>)*>)*>)?\(\s*([\"'`])([A-Za-z0-9_]+)\1"
)

# How far below a `#[tauri::command]` attribute to look for its `pub fn`
# (doc comments / other attributes may sit in between).
FN_SEARCH_WINDOW = 10

# ── Window-gating ratchet ──────────────────────────────────────────────────
# The main-window gate (`commands/mod.rs`'s `ensure_main_window_label`) is
# opt-in per command: the parameter alone does nothing, and nothing in the
# type system stops a refactor from dropping either half. The ratchet pins
# both halves:
#
#   1. every command whose definition takes `window: tauri::Window` must
#      call `ensure_main_window_label(` inside its own body;
#   2. every name in `GATED_COMMANDS` must keep taking the `window`
#      parameter.
#
# `GATED_COMMANDS` was seeded 2026-10-23 (post-#1349) with the 16 commands
# that then carried the gate; mod_hub_classify_path joined afterwards. It is
# a floor, not a ceiling:
# when a command gains the gate, append its name here in the same PR (the
# systematic-gating wave is expected to grow this list substantially);
# removing a name is only legitimate when the command itself is gone.
# Same-name cfg twins compare by their FIRST definition, matching
# `collect_rust_commands` (so the mobile stand-ins without the parameter
# keep passing).
WINDOW_PARAM_RE = re.compile(r"window\s*:\s*(?:&\s*)?(?:tauri::)?Window\b")
ENSURE_GATE_CALL_RE = re.compile(r"ensure_main_window_label\s*\(")

GATED_COMMANDS: list[str] = [
    "appdata_write",
    "capture_main_window",
    "import_replay_file",
    "markers_import",
    "mod_catalog_install",
    "mod_catalog_uninstall",
    "mod_hub_classify_path",
    "mod_hub_install",
    "mod_hub_pick_source",
    "mod_hub_purge_backup_delete",
    "mod_hub_purge_backup_dismiss",
    "mod_hub_purge_backup_restore",
    "mod_hub_purge_backup_resume",
    "mod_hub_reconcile",
    "pairing_start",
    "pairing_stop",
    "pick_export_path",
    "tactics_profile_open",
    "tactics_profile_save",
    "update_download",
    "update_reinstall_from_cache",
    "write_export_bytes",
]


def collect_rust_commands(src_dir: Path) -> dict[str, str]:
    """Map command name -> `file:line` of its `#[tauri::command]` attribute."""
    commands: dict[str, str] = {}
    for path in sorted(src_dir.rglob("*.rs")):
        lines = path.read_text(encoding="utf-8").splitlines()
        for i, line in enumerate(lines):
            if not COMMAND_ATTR_RE.match(line):
                continue
            for follow in lines[i + 1 : i + 1 + FN_SEARCH_WINDOW]:
                fn = PUB_FN_RE.match(follow)
                if fn:
                    name = fn.group(1)
                    where = f"{path.relative_to(REPO_ROOT).as_posix()}:{i + 1}"
                    # Same-name twins (a `#[cfg(target_os = ...)]` +
                    # `#[cfg(not(...))]` pair, or the mobile stand-ins) are
                    # intentional per-target definitions of one wire
                    # command — keep the first.
                    commands.setdefault(name, where)
                    break
                if not SKIP_RE.match(follow):
                    break
            else:
                raise SystemExit(
                    f"error: no `fn` found within {FN_SEARCH_WINDOW} lines "
                    f"below {path.relative_to(REPO_ROOT).as_posix()}:{i + 1} — "
                    "extend the parser (FN_SEARCH_WINDOW / PUB_FN_RE)"
                )
    if not commands:
        raise SystemExit(
            f"error: no #[tauri::command] found under "
            f"{src_dir.relative_to(REPO_ROOT).as_posix()} — parser broken?"
        )
    return commands


def _fn_body_slice(lines: list[str], fn_idx: int, stop_idx: int) -> str:
    """The `fn` signature-plus-body text, ending at its closing brace.

    Brace-counting over comment-stripped, string-literal-masked lines so a
    `{{ }}` in a doc comment or a `"{"` in a format string cannot end the
    slice early. Falls back to the next `#[tauri::command]` attribute (or
    EOF) when no balanced block is found — the parity collector upstream
    already hard-fails on unparseable shapes, so this side stays lenient.
    """
    depth = 0
    seen_open = False
    for k in range(fn_idx, stop_idx):
        line = re.sub(r"//.*$", "", lines[k])
        line = re.sub(r'"(?:[^"\\]|\\.)*"', '""', line)
        depth += line.count("{") - line.count("}")
        if "{" in line:
            seen_open = True
        if seen_open and depth <= 0:
            return "\n".join(lines[fn_idx : k + 1])
    return "\n".join(lines[fn_idx:stop_idx])


def collect_rust_command_gating(src_dir: Path) -> dict[str, dict[str, object]]:
    """Map command name -> window-gating facts of its first definition.

    For every `#[tauri::command]` fn, record:

      - `where`: `file:line` of the attribute (same shape as
        `collect_rust_commands`),
      - `takes_window`: the fn carries a `window: tauri::Window` parameter,
      - `calls_gate`: the fn body calls `ensure_main_window_label(`.

    Both facts are scanned within the fn's own brace block only — tests and
    helper fns sitting between two commands must not vouch for the command
    above them. Same-name cfg twins keep the first definition, matching
    `collect_rust_commands` exactly so the frozen roster refers to the same
    definition the parity checks see.
    """
    gating: dict[str, dict[str, object]] = {}
    for path in sorted(src_dir.rglob("*.rs")):
        lines = path.read_text(encoding="utf-8").splitlines()
        attr_lines = [i for i, ln in enumerate(lines) if COMMAND_ATTR_RE.match(ln)]
        for idx, start in enumerate(attr_lines):
            stop = attr_lines[idx + 1] if idx + 1 < len(attr_lines) else len(lines)
            fn_idx = None
            fn_name = None
            for k in range(start + 1, min(start + 1 + FN_SEARCH_WINDOW, len(lines))):
                fn = PUB_FN_RE.match(lines[k])
                if fn:
                    fn_idx = k
                    fn_name = fn.group(1)
                    break
                if not SKIP_RE.match(lines[k]):
                    break
            if fn_idx is None or fn_name is None:
                # collect_rust_commands hard-fails on this shape already;
                # stay quiet here so the ratchet never masks that error.
                continue
            body = _fn_body_slice(lines, fn_idx, stop)
            where = f"{path.relative_to(REPO_ROOT).as_posix()}:{start + 1}"
            gating.setdefault(
                fn_name,
                {
                    "where": where,
                    "takes_window": WINDOW_PARAM_RE.search(body) is not None,
                    "calls_gate": ENSURE_GATE_CALL_RE.search(body) is not None,
                },
            )
    return gating


def collect_registered_commands(rs_path: Path) -> dict[str, str]:
    """Map registered command name -> `file:line` of its `generate_handler!` entry.

    Entries are `module::path::name,`; names are kept by their LAST path
    segment so the cfg-gated twins (one registration slot, several per-target
    definitions) compare by wire name. `#[cfg(...)]` attribute lines and
    comments interleaved with the entries are skipped.
    """
    lines = rs_path.read_text(encoding="utf-8").splitlines()
    where = rs_path.relative_to(REPO_ROOT).as_posix()
    registered: dict[str, str] = {}
    in_macro = False
    for i, line in enumerate(lines):
        macro = HANDLER_MACRO_RE.search(line)
        if not in_macro and macro:
            in_macro = True
            body = line[macro.end() :]
        elif in_macro:
            body = line
        else:
            continue
        # The macro body holds identifiers only — a line comment can be
        # stripped without breaking an entry.
        body = body.split("//", 1)[0].strip()
        if not body or body.startswith("#"):
            continue  # blanks, comments, `#[cfg(...)]` attributes
        if "]" in body:
            body = body[: body.index("]")].strip()
            in_macro = False
            if not body:
                continue
        entry = HANDLER_ENTRY_RE.match(body)
        if not entry:
            raise SystemExit(
                f"error: unparseable generate_handler! entry at "
                f"{where}:{i + 1}: {body!r} — extend HANDLER_ENTRY_RE"
            )
        name = entry.group(1).rsplit("::", 1)[-1]
        registered.setdefault(name, f"{where}:{i + 1}")
    if not registered:
        raise SystemExit(
            f"error: no generate_handler! entries parsed from {where} — "
            "parser broken?"
        )
    return registered


def collect_invoke_literals(ts_src_dir: Path) -> dict[str, list[str]]:
    """Map invoke literal -> [`file:line`, ...] across a TS/TSX tree."""
    literals: dict[str, list[str]] = {}
    for path in sorted(ts_src_dir.rglob("*")):
        if path.suffix not in (".ts", ".tsx"):
            continue
        text = path.read_text(encoding="utf-8")
        where = path.relative_to(REPO_ROOT).as_posix()
        for m in INVOKE_LITERAL_RE.finditer(text):
            line = text.count("\n", 0, m.start()) + 1
            literals.setdefault(m.group(2), []).append(f"{where}:{line}")
    return literals


def collect_rpc_ts() -> tuple[dict[str, str], list[tuple[str, str, str]]]:
    """Return (wire name -> file:line, [(key, value, file:line)] key!=value rows)."""
    entries: dict[str, str] = {}
    key_drift: list[tuple[str, str, str]] = []
    where = RPC_TS_PATH.relative_to(REPO_ROOT).as_posix()
    for i, line in enumerate(RPC_TS_PATH.read_text(encoding="utf-8").splitlines()):
        row = TS_ROW_RE.match(line)
        if not row:
            continue
        key, value = row.group(1), row.group(2)
        entries[value] = f"{where}:{i + 1}"
        if key != value:
            key_drift.append((key, value, f"{where}:{i + 1}"))
    if not entries:
        raise SystemExit(f"error: no RPC table rows parsed from {where}")
    return entries, key_drift


def collect_mock_routes() -> dict[str, str]:
    """Map mock route name -> file:line (subset of the command surface)."""
    routes: dict[str, str] = {}
    where = MOCK_PY_PATH.relative_to(REPO_ROOT).as_posix()
    for i, line in enumerate(MOCK_PY_PATH.read_text(encoding="utf-8").splitlines()):
        route = MOCK_ROUTE_RE.match(line)
        if route:
            routes[route.group(1)] = f"{where}:{i + 1}"
    return routes


def diff_registration(
    surface: str,
    defined: dict[str, str],
    registered: dict[str, str],
    problems: dict[str, list[str]],
) -> None:
    """Flag defined-but-unregistered and registered-but-undefined commands."""
    unregistered = sorted(set(defined) - set(registered))
    if unregistered:
        problems[f"{surface}: unregistered (command missing from generate_handler!)"] = [
            f"+{name}  ({defined[name]})" for name in unregistered
        ]
    undefined = sorted(set(registered) - set(defined))
    if undefined:
        problems[f"{surface}: stale registration (handler entry with no command)"] = [
            f"-{name}  ({registered[name]})" for name in undefined
        ]


def diff_invoke_literals(
    surface: str,
    invokes: dict[str, list[str]],
    defined: dict[str, str],
    problems: dict[str, list[str]],
) -> None:
    """Flag raw invoke string literals that name no Rust command."""
    unknown = sorted(set(invokes) - set(defined))
    if unknown:
        problems[f"{surface}: raw invoke unknown command (literal is not a Rust command)"] = [
            f'-{name}  ({", ".join(sites)})' for name in unknown for sites in [invokes[name]]
        ]


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Validate WoWSP Rust/webui/mock RPC command-name parity, "
            "generate_handler! registration, and raw invoke literals"
        )
    )
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    rust = collect_rust_commands(RUST_SRC_DIR)
    registered = collect_registered_commands(APP_LIB_RS)
    gating = collect_rust_command_gating(RUST_SRC_DIR)
    ts, ts_key_drift = collect_rpc_ts()
    webui_invokes = collect_invoke_literals(WEBUI_SRC_DIR)
    mock = collect_mock_routes()

    problems: dict[str, list[str]] = {}

    missing_in_ts = sorted(set(rust) - set(ts))
    stale_in_ts = sorted(set(ts) - set(rust))
    if missing_in_ts:
        problems["rpc.ts missing (Rust command not in the RPC table)"] = [
            f"+{name}  ({rust[name]})" for name in missing_in_ts
        ]
    if stale_in_ts:
        problems["rpc.ts stale (table entry with no Rust command)"] = [
            f"-{name}  ({ts[name]})" for name in stale_in_ts
        ]
    if ts_key_drift:
        problems["rpc.ts key/value mismatch (key must equal the wire name)"] = [
            f"~{key}: \"{value}\"  ({where})" for key, value, where in ts_key_drift
        ]

    diff_registration("app", rust, registered, problems)
    diff_invoke_literals("webui", webui_invokes, rust, problems)

    stale_mock = sorted(set(mock) - set(rust))
    if stale_mock:
        problems["mock stale (route with no Rust command)"] = [
            f"-{name}  ({mock[name]})" for name in stale_mock
        ]

    ungated_calls = sorted(
        name for name, facts in gating.items()
        if facts["takes_window"] and not facts["calls_gate"]
    )
    if ungated_calls:
        problems[
            "window gating: command takes `window` but never calls "
            "ensure_main_window_label"
        ] = [f"~{name}  ({gating[name]['where']})" for name in ungated_calls]
    unknown_gated = sorted(set(GATED_COMMANDS) - set(gating))
    if unknown_gated:
        problems["window gating: GATED_COMMANDS entry names no command"] = [
            f"-{name}" for name in unknown_gated
        ]
    lost_param = sorted(
        name
        for name in GATED_COMMANDS
        if name in gating and not gating[name]["takes_window"]
    )
    if lost_param:
        problems["window gating: gated command lost its `window` param"] = [
            f"~{name}  ({gating[name]['where']})" for name in lost_param
        ]

    invoke_site_count = sum(len(s) for s in webui_invokes.values())

    if args.json:
        print(
            json.dumps(
                {
                    "rust_commands": len(rust),
                    "registered_commands": len(registered),
                    "ts_entries": len(ts),
                    "raw_invoke_literals": len(webui_invokes),
                    "raw_invoke_sites": invoke_site_count,
                    "mock_routes": len(mock),
                    "window_gated_commands": sum(
                        1 for facts in gating.values() if facts["takes_window"]
                    ),
                    "gated_roster": len(GATED_COMMANDS),
                    "parity": not problems,
                    "problems": problems,
                },
                indent=2,
                ensure_ascii=False,
            )
        )
    elif problems:
        for title, items in problems.items():
            print(f"[{title}] {len(items)}:")
            for it in items:
                print(f"  {it}")
    elif not args.quiet:
        print(
            f"RPC parity OK: {len(rust)} Rust commands == {len(ts)} rpc.ts entries; "
            f"{len(registered)} registered; "
            f"{len(webui_invokes)} raw invoke names ({invoke_site_count} sites) all resolve; "
            f"{len(mock)} mock routes all resolve; "
            f"window gate on {sum(1 for facts in gating.values() if facts['takes_window'])}/{len(gating)} "
            f"commands, {len(GATED_COMMANDS)} frozen"
        )

    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
