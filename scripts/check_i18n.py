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

Dotted keys (a JSON key containing `.` at any level, e.g. `"kind.gui"`) are
rejected outright: the webui loads these files as vue-i18n namespaces WITHOUT
`flatJson`, so `t("a.b.c")` walks nested objects only — a dotted key can
never resolve, and flatten() makes it parity-invisible against the nested
spelling of the same path (exactly how the dead `resources.json` `kind.*`
duplicates sat unnoticed). Write nested objects instead.

Exit codes: 0 = parity, 1 = missing keys / placeholder drift (unless
--no-fail); dotted keys ALWAYS exit 1 — --no-fail does not cover them, or
the fence could be talked out of failing on exactly the bug it exists for.

Usage:
    python scripts/check_i18n.py             # full report
    python scripts/check_i18n.py --quiet     # only failures
    python scripts/check_i18n.py --json      # machine-readable
    python scripts/check_i18n.py --no-fail   # exit 0 except dotted keys
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


def dotted_key_paths(lang: str) -> list[str]:
    """`<namespace>.json: <path>` for every JSON key carrying a `.` — see
    the module docstring for why these can never resolve."""
    out: list[str] = []
    lang_dir = LOCALES_DIR / lang
    if not lang_dir.is_dir():
        return out
    for p in sorted(lang_dir.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue  # parse failures are reported by the parity loader
        ns = p.stem

        def walk(node: object, prefix: str) -> None:
            if not isinstance(node, dict):
                return
            for k, v in node.items():
                path = f"{prefix}{k}"
                if "." in k:
                    out.append(f"{ns}.json: {path}")
                walk(v, f"{path}.")

        walk(data, "")
    return out


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

    # Dotted keys first — they break resolution itself, so parity below is
    # moot for them (and flatten() would happily compare the unresolvable
    # spelling against the nested one).
    dotted: dict[str, list[str]] = {}
    for lang in langs:
        paths = dotted_key_paths(lang)
        if paths:
            dotted[lang] = paths

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
                {
                    "langs": langs,
                    # Machine consumers get one boolean: dotted keys count
                    # as failures here even though --no-fail softens the
                    # parity exit (see the exit-code contract above).
                    "parity": not problems and not dotted,
                    "problems": problems,
                    "dottedKeys": dotted,
                },
                indent=2,
                ensure_ascii=False,
            )
        )
    elif dotted or problems:
        for lang, paths in dotted.items():
            print(f"[{lang}] {len(paths)} dotted key(s) — unresolvable without flatJson:")
            for it in paths:
                print(f"  {it}")
        for lang, items in problems.items():
            print(f"[{lang}] {len(items)} key differences:")
            for it in items:
                print(f"  {it}")
    elif not args.quiet:
        print(f"i18n OK: {len(baseline_keys)} keys across {tuple(langs)}")

    ok = not dotted and (not problems or args.no_fail)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
