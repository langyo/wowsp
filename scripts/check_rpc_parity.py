#!/usr/bin/env python3
"""Tauri RPC command-name parity validator for WoWSP.

The Rust <-> TypeScript command contract is hand-mirrored across two full
surfaces (the main app and the installer shell) plus a dev mock:

  - `packages/app/tauri/src/**/*.rs` — the `#[tauri::command]` functions
    (the wire truth; includes the mobile stand-ins in `commands/mod.rs`),
  - the `tauri::generate_handler![...]` list in `packages/app/tauri/src/lib.rs`
    — a command that is defined (and even mirrored in rpc.ts) but forgotten
    in the handler list compiles fine and only fails at runtime,
  - `packages/webui/src/rpc.ts` — the hand-maintained `RPC` name table the
    webui routes every `transport.invoke(cmd)` through,
  - raw `invoke("...")` string literals in `packages/webui/src/**/*.{ts,tsx}`
    (overlay/ and manual-locate/ bypass rpc.ts entirely) — a typo'd literal
    here passes every other check and explodes at runtime,
  - `scripts/mock/src/main.py` — the browser-dev mock backend, which
    mirrors a SUBSET of the same names under `/api/<cmd>`,
  - the installer shell's own IPC surface: `#[tauri::command]` fns + the
    `generate_handler!` list in `packages/installer-shell/src/main.rs` and
    the raw invokes in `packages/installer-shell/web/src/**/*.{ts,tsx}`
    (the installer UI has no rpc.ts-style table — it calls a local
    `invoke(cmd)` helper with literal names).

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
  - Rust vs raw invokes: every string-literal first argument of an
    `invoke(...)` call in the webui must be a Rust command. Call sites
    routed through rpc.ts's wrapper (non-literal argument) are naturally
    skipped.
  - Rust vs mock: one-directional. The mock only serves the browser-dev
    subset, so missing mock routes are fine; a mock route with no Rust
    command is a stale route and fails.
  - Installer surface: the same defined-vs-registered bidirectional check
    against its own `generate_handler!` list, plus literal invokes in its
    web UI as a subset of its Rust command set.

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
INSTALLER_SRC_DIR = REPO_ROOT / "packages" / "installer-shell" / "src"
INSTALLER_MAIN_RS = INSTALLER_SRC_DIR / "main.rs"
INSTALLER_WEB_SRC_DIR = REPO_ROOT / "packages" / "installer-shell" / "web" / "src"

# `#[tauri::command]` / `#[tauri::command(...)]` — anchored on '[', so the
# doc/comment lines that merely mention the attribute never match.
COMMAND_ATTR_RE = re.compile(r"^\s*#\[\s*tauri::command(?:\([^)]*\))?\s*\]")
# `pub` is optional: the installer shell's command fns are crate-private.
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

# An `invoke` call matched BY NAME with a string-literal first argument:
# `invoke("cmd")`, `invoke<T>("cmd")`, `tauri.core.invoke("cmd")` — the
# `<...>` optional generics tolerate one nesting level and never contain
# parens. Non-literal first arguments (`transport.invoke(RPC.foo)`, the
# wrapper's own `invoke(cmd, args)`) do not match, so rpc.ts-routed call
# sites are naturally skipped. Quotes may be double or single.
INVOKE_LITERAL_RE = re.compile(
    r"\binvoke\s*(?:<(?:[^<>()]|<[^<>()]*>)*>)?\(\s*([\"'])([A-Za-z0-9_]+)\1"
)

# How far below a `#[tauri::command]` attribute to look for its `pub fn`
# (doc comments / other attributes may sit in between).
FN_SEARCH_WINDOW = 10


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
            "generate_handler! registration, raw invoke literals, and the "
            "installer shell IPC surface"
        )
    )
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    rust = collect_rust_commands(RUST_SRC_DIR)
    registered = collect_registered_commands(APP_LIB_RS)
    ts, ts_key_drift = collect_rpc_ts()
    webui_invokes = collect_invoke_literals(WEBUI_SRC_DIR)
    mock = collect_mock_routes()
    installer_rust = collect_rust_commands(INSTALLER_SRC_DIR)
    installer_registered = collect_registered_commands(INSTALLER_MAIN_RS)
    installer_invokes = collect_invoke_literals(INSTALLER_WEB_SRC_DIR)

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
    diff_registration("installer", installer_rust, installer_registered, problems)
    diff_invoke_literals("installer", installer_invokes, installer_rust, problems)

    stale_mock = sorted(set(mock) - set(rust))
    if stale_mock:
        problems["mock stale (route with no Rust command)"] = [
            f"-{name}  ({mock[name]})" for name in stale_mock
        ]

    invoke_site_count = sum(len(s) for s in webui_invokes.values())
    installer_invoke_site_count = sum(len(s) for s in installer_invokes.values())

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
                    "installer": {
                        "rust_commands": len(installer_rust),
                        "registered_commands": len(installer_registered),
                        "raw_invoke_literals": len(installer_invokes),
                        "raw_invoke_sites": installer_invoke_site_count,
                    },
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
            f"installer: {len(installer_rust)} commands == "
            f"{len(installer_registered)} registered, "
            f"{len(installer_invokes)} invoke names "
            f"({installer_invoke_site_count} sites) all resolve; "
            f"{len(mock)} mock routes all resolve"
        )

    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
