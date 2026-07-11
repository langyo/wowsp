#!/usr/bin/env python3
"""i18n key parity validator for WoWSP.

Adapted from shittim-chest's `scripts/check_i18n.py` (trimmed). Checks that the
two supported locales (en, zhs) have the same key set across every namespace
JSON under `res/i18n/locales/<lang>/`.

Exit codes: 0 = parity, 1 = missing keys (unless --no-fail).

Usage:
    python scripts/check_i18n.py             # full report
    python scripts/check_i18n.py --quiet     # only failures
    python scripts/check_i18n.py --json      # machine-readable
    python scripts/check_i18n.py --no-fail   # always exit 0
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
LOCALES_DIR = REPO_ROOT / "res" / "i18n" / "locales"
BASELINE_LANGS = ("en", "zhs")


def flatten(obj, prefix="") -> dict:
    out: dict[str, object] = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict):
                out.update(flatten(v, key))
            else:
                out[key] = v
    return out


def load_keys(lang: str) -> set[str]:
    keys: set[str] = set()
    lang_dir = LOCALES_DIR / lang
    if not lang_dir.is_dir():
        return keys
    for p in sorted(lang_dir.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"WARN: failed to parse {p}: {e}", file=sys.stderr)
            continue
        ns = p.stem
        for k in flatten(data):
            keys.add(f"{ns}.{k}")
    return keys


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate WoWSP i18n key parity")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--no-fail", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    keys = {lang: load_keys(lang) for lang in BASELINE_LANGS}
    baseline = keys["en"]

    problems: dict[str, list[str]] = {}
    for lang in BASELINE_LANGS:
        if lang == "en":
            continue
        missing = sorted(baseline - keys[lang])
        extra = sorted(keys[lang] - baseline)
        if missing or extra:
            problems[lang] = missing + [f"+{e}" for e in extra]

    if args.json:
        print(json.dumps({"parity": not problems, "problems": problems}, indent=2))
    elif problems:
        for lang, items in problems.items():
            print(f"[{lang}] {len(items)} key differences:")
            for it in items:
                print(f"  {it}")
    elif not args.quiet:
        print(f"i18n OK: {len(baseline)} keys across {BASELINE_LANGS}")

    return 0 if (not problems or args.no_fail) else 1


if __name__ == "__main__":
    sys.exit(main())
