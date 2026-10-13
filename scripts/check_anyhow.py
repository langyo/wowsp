#!/usr/bin/env python3
"""anyhow error-policy gate for the WoWSP app crates.

The app crates' error flow is anyhow end-to-end: helpers return
`anyhow::Result<T>`, `#[tauri::command]` functions return
`wowsp_tauri_shared::CommandResult<T>` (the IPC shim whose `Serialize`
emits the Display string), and the ONLY structured exceptions are the
pre-existing wire errors (`lookup_error.rs`'s `LookupError` and
`hardware_info`'s `ElevateErr`). This script keeps that invariant from
regressing one pin at a time.

Checks, over every `.rs` file under `packages/app/tauri/src` and
`packages/app/tauri_shared/src`:

1. No `Result<..., String>` error types. Comments (line `//` including
   `///`/`//!`, and block `/* */` with nesting awareness) are stripped
   before scanning, so doc mentions of the old idiom do not trip. Each
   `Result<` occurrence is parsed to its balanced matching `>` (nested
   generics and `>>` handled), split at the LAST top-level comma, and
   flagged when the error segment is exactly `String`. A `String` VALUE
   type (`Result<HashMap<i64, String>>`) has no top-level comma after the
   value and is not flagged.

2. anyhow-first imports. Any file that references anyhow (a `anyhow::`
   path or an import from it) must have its FIRST `use` statement be a
   `use anyhow...` line, so the error crate stays visually front and
   center. Files that never mention anyhow are exempt.

Output: one `error: <path>:<line>: <detail>` line per violation; exit 1 if
any, else `anyhow policy: OK` and exit 0.

Usage:
    python scripts/check_anyhow.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCAN_ROOTS = [
    REPO_ROOT / "packages" / "app" / "tauri" / "src",
    REPO_ROOT / "packages" / "app" / "tauri_shared" / "src",
]

USE_RE = re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?use\s")
ANYHOW_USE_RE = re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+anyhow\b")
ANYHOW_REF_RE = re.compile(r"\banyhow\b")


def strip_comments(src: str) -> str:
    """Blank out comments (preserving newlines and offsets) so later scans
    see only code. Line comments cover `//`, `///` and `//!`; block
    comments nest per Rust 1.54+ token rules."""
    out: list[str] = []
    i = 0
    n = len(src)
    in_block = 0
    while i < n:
        if in_block:
            if src.startswith("/*", i):
                in_block += 1
                out.append("  ")
                i += 2
            elif src.startswith("*/", i):
                in_block -= 1
                out.append("  ")
                i += 2
            else:
                out.append("\n" if src[i] == "\n" else " ")
                i += 1
        elif src.startswith("/*", i):
            in_block = 1
            out.append("  ")
            i += 2
        elif src.startswith("//", i):
            while i < n and src[i] != "\n":
                out.append(" ")
                i += 1
        else:
            out.append(src[i])
            i += 1
    return "".join(out)


def result_error_is_string(line_no: int, code: str) -> str | None:
    """For one line of comment-stripped code, decide whether it contains a
    `Result<..., String>` error type. Returns the detail string when it
    does. Handles nested generics and `>>` closings by tracking angle
    depth; only commas at depth 1 (inside the outer `Result<...>`) split
    the type arguments."""
    search_from = 0
    while True:
        start = code.find("Result<", search_from)
        if start == -1:
            return None
        i = start + len("Result<")
        depth = 1
        args = ""
        while i < len(code) and depth > 0:
            ch = code[i]
            if ch == "<":
                depth += 1
            elif ch == ">":
                depth -= 1
                if depth == 0:
                    break
            args += ch
            i += 1
        if depth != 0:
            # Unbalanced across this line (e.g. wrapped signature) — skip
            # this occurrence; the signature line above still reports.
            search_from = start + len("Result<")
            continue
        # Split on the LAST top-level comma: `Result<T, E>`'s error
        # segment is everything after it. `Result<HashMap<i64, String>>`
        # has no top-level comma (the comma sits inside HashMap<...>) and
        # is skipped — the value type being String is fine.
        split_depth = 0
        last_comma = -1
        for pos, ch in enumerate(args):
            if ch == "<":
                split_depth += 1
            elif ch == ">":
                split_depth -= 1
            elif ch == "," and split_depth == 0:
                last_comma = pos
        if last_comma != -1 and args[last_comma + 1 :].strip() == "String":
            return "Result<_, String> error type (use anyhow::Result / CommandResult)"
        search_from = i + 1


def check_file(path: Path) -> list[str]:
    errors: list[str] = []
    rel = path.relative_to(REPO_ROOT)
    try:
        raw = path.read_text(encoding="utf-8")
    except Exception as e:
        return [f"error: {rel}: cannot read: {e}"]
    code = strip_comments(raw)
    lines = code.split("\n")

    for idx, line in enumerate(lines, start=1):
        if "Result<" in line:
            detail = result_error_is_string(idx, line)
            if detail:
                errors.append(f"error: {rel}:{idx}: {detail}")

    if ANYHOW_REF_RE.search(code):
        first_use_line = None
        for idx, line in enumerate(lines, start=1):
            if USE_RE.match(line):
                first_use_line = (idx, line.strip())
                break
        if first_use_line is None or not ANYHOW_USE_RE.match(
            # Re-match against the stripped line: USE_RE consumed the
            # leading whitespace already.
            first_use_line[1]
        ):
            where = (
                f"line {first_use_line[0]} is '{first_use_line[1]}'"
                if first_use_line
                else "no use statement found"
            )
            errors.append(
                f"error: {rel}: file references anyhow but its first use "
                f"statement is not `use anyhow...` ({where})"
            )
    return errors


def main() -> int:
    files: list[Path] = []
    for root in SCAN_ROOTS:
        if not root.is_dir():
            print(f"FATAL: scan root {root} missing", file=sys.stderr)
            return 1
        files.extend(sorted(root.rglob("*.rs")))

    errors: list[str] = []
    for path in files:
        errors.extend(check_file(path))

    if errors:
        for e in errors:
            print(e)
        return 1
    print(f"anyhow policy: OK ({len(files)} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
