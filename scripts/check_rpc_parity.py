#!/usr/bin/env python3
"""Tauri RPC command-name parity validator for WoWSP.

The Rust <-> TypeScript command contract is hand-mirrored in three places:

  - `packages/app/tauri/src/**/*.rs` — the `#[tauri::command]` functions
    (the wire truth; includes the mobile stand-ins in `commands/mod.rs`),
  - `packages/webui/src/rpc.ts` — the hand-maintained `RPC` name table the
    webui routes every `transport.invoke(cmd)` through,
  - `scripts/mock/src/main.py` — the browser-dev mock backend, which
    mirrors a SUBSET of the same names under `/api/<cmd>`.

Drift here compiles fine everywhere and only explodes at runtime ("command
not found"), so this script diffs the three name sets:

  - Rust vs rpc.ts: bidirectional. Every command must be listed in rpc.ts
    (even ones invoked through a raw `invoke("...")` string), and every
    rpc.ts entry must still exist in Rust. Also flags table rows whose
    TS key does not match their wire-name value (the table's convention
    is `snake_case: "snake_case"`).
  - Rust vs mock: one-directional. The mock only serves the browser-dev
    subset, so missing mock routes are fine; a mock route with no Rust
    command is a stale route and fails.

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
MOCK_PY_PATH = REPO_ROOT / "scripts" / "mock" / "src" / "main.py"

# `#[tauri::command]` / `#[tauri::command(...)]` — anchored on '[', so the
# doc/comment lines that merely mention the attribute never match.
COMMAND_ATTR_RE = re.compile(r"^\s*#\[\s*tauri::command(?:\([^)]*\))?\s*\]")
PUB_FN_RE = re.compile(r"^\s*pub\s+(?:async\s+)?fn\s+([A-Za-z0-9_]+)")
# Lines allowed to sit between the attribute and its fn: doc comments,
# other attributes, blanks.
SKIP_RE = re.compile(r"^\s*(//.*|#!?\[.*\]|)$")
# rpc.ts table row: `  name: "name",`
TS_ROW_RE = re.compile(r'^\s*([A-Za-z0-9_]+)\s*:\s*"([A-Za-z0-9_]+)"\s*,?\s*$')
# Mock route decorator: `@app.get("/api/<cmd>")` / `@app.post("/api/<cmd>")`
MOCK_ROUTE_RE = re.compile(r'^@app\.(?:get|post)\("/api/([a-z0-9_]+)"\)')

# How far below a `#[tauri::command]` attribute to look for its `pub fn`
# (doc comments / other attributes may sit in between).
FN_SEARCH_WINDOW = 10


def collect_rust_commands() -> dict[str, str]:
    """Map command name -> `file:line` of its `#[tauri::command]` attribute."""
    commands: dict[str, str] = {}
    for path in sorted(RUST_SRC_DIR.rglob("*.rs")):
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
                    # `#[cfg(not(...))]` pair) are intentional per-target
                    # definitions of one wire command — keep the first.
                    commands.setdefault(name, where)
                    break
                if not SKIP_RE.match(follow):
                    break
            else:
                raise SystemExit(
                    f"error: no `pub fn` found within {FN_SEARCH_WINDOW} lines "
                    f"below {path.relative_to(REPO_ROOT).as_posix()}:{i + 1} — "
                    "extend the parser (FN_SEARCH_WINDOW / PUB_FN_RE)"
                )
    if not commands:
        raise SystemExit(
            f"error: no #[tauri::command] found under "
            f"{RUST_SRC_DIR.relative_to(REPO_ROOT).as_posix()} — parser broken?"
        )
    return commands


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


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate WoWSP Rust/webui/mock RPC command-name parity"
    )
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    rust = collect_rust_commands()
    ts, ts_key_drift = collect_rpc_ts()
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
    stale_mock = sorted(set(mock) - set(rust))
    if stale_mock:
        problems["mock stale (route with no Rust command)"] = [
            f"-{name}  ({mock[name]})" for name in stale_mock
        ]

    if args.json:
        print(
            json.dumps(
                {
                    "rust_commands": len(rust),
                    "ts_entries": len(ts),
                    "mock_routes": len(mock),
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
            f"{len(mock)} mock routes all resolve"
        )

    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
