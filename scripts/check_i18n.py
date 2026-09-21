#!/usr/bin/env python3
"""i18n key parity validator for WoWSP.

Adapted from shittim-chest's `scripts/check_i18n.py`. Checks that EVERY locale
directory under `res/i18n/locales/<lang>/` carries the same key set as the
en-US baseline across every namespace JSON, and that `{placeholder}` sets
match per key (a translation that drops `{name}` breaks vue-i18n params at
runtime, not at build time).

Link URLs (baseline values matching `^https?://`) are language-invariant:
they are required only in the en-US baseline — other locales may omit them
(every locale falls back to en-US at runtime) but must copy the baseline
value verbatim when present.

Exit codes: 0 = parity, 1 = missing keys / placeholder drift (unless --no-fail).

Usage:
    python scripts/check_i18n.py             # full report
    python scripts/check_i18n.py --quiet     # only failures
    python scripts/check_i18n.py --json      # machine-readable
    python scripts/check_i18n.py --no-fail   # always exit 0
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
LOCALES_DIR = REPO_ROOT / "res" / "i18n" / "locales"
BASELINE_LANG = "en-US"
PLACEHOLDER_RE = re.compile(r"\{\w+\}")
URL_VALUE_RE = re.compile(r"^https?://")


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


def load_namespace_values(lang: str) -> dict[str, object]:
    """Flattened key → raw message value for one locale."""
    values: dict[str, object] = {}
    lang_dir = LOCALES_DIR / lang
    if not lang_dir.is_dir():
        return values
    for p in sorted(lang_dir.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"WARN: failed to parse {p}: {e}", file=sys.stderr)
            continue
        ns = p.stem
        for k, v in flatten(data).items():
            values[f"{ns}.{k}"] = v
    return values


def discover_langs() -> list[str]:
    if not LOCALES_DIR.is_dir():
        return []
    return sorted(d.name for d in LOCALES_DIR.iterdir() if d.is_dir())


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate WoWSP i18n key parity")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--no-fail", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    langs = discover_langs()
    if BASELINE_LANG not in langs:
        print(f"FATAL: baseline locale dir {BASELINE_LANG} missing", file=sys.stderr)
        return 1

    values = {lang: load_namespace_values(lang) for lang in langs}
    baseline = values[BASELINE_LANG]
    baseline_keys = set(baseline)

    problems: dict[str, list[str]] = {}
    for lang in langs:
        if lang == BASELINE_LANG:
            continue
        lang_keys = set(values[lang])
        # Link URLs are language-invariant (see module docstring): exempt
        # from the missing-key requirement, but pinned to the baseline
        # value whenever a locale does carry them.
        missing = [
            k
            for k in baseline_keys - lang_keys
            if not URL_VALUE_RE.match(str(baseline[k]))
        ]
        items = sorted(missing) + sorted(
            f"+{k}" for k in lang_keys - baseline_keys
        )
        # Placeholder drift: the translation must interpolate the same names.
        for key in sorted(baseline_keys & lang_keys):
            if URL_VALUE_RE.match(str(baseline[key])):
                if values[lang][key] != baseline[key]:
                    items.append(f"~{key}: link URL differs from baseline")
                continue
            want = sorted(PLACEHOLDER_RE.findall(str(baseline[key])))
            got = sorted(PLACEHOLDER_RE.findall(str(values[lang][key])))
            if want != got:
                items.append(f"~{key}: placeholders {got} != {want}")
        if items:
            problems[lang] = items

    if args.json:
        print(
            json.dumps(
                {"langs": langs, "parity": not problems, "problems": problems},
                indent=2,
                ensure_ascii=False,
            )
        )
    elif problems:
        for lang, items in problems.items():
            print(f"[{lang}] {len(items)} key differences:")
            for it in items:
                print(f"  {it}")
    elif not args.quiet:
        print(f"i18n OK: {len(baseline_keys)} keys across {tuple(langs)}")

    return 0 if (not problems or args.no_fail) else 1


if __name__ == "__main__":
    sys.exit(main())
