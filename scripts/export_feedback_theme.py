#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Export the /feedback page's hikari design-token sheet.

The Worker feedback page (relay-core `feedback_page`) is a dependency-free
HTML string served from Cloudflare — it cannot import the
`@celestia-island/hikari` npm package at runtime, and the relay CI job has
no Node toolchain to compile SCSS. Instead this script vendors the design
language into `res/theme/feedback-hikari.css`, which relay-core embeds via
`include_str!`:

  1. hikari's channel palette + scale tokens, compiled with the very sass
     the webui package ships (`styles/theme/channels.scss` and
     `styles/theme/scale.scss` — pure `:root` blocks, no component rules);
  2. the `default` theme preset's light/dark color maps parsed from
     `theme/presets.ts` — the same pair `initTheme()` injects at runtime in
     the desktop app, so the page matches the app's actual look. Dark is
     emitted twice: once behind `prefers-color-scheme` (no-JS default) and
     once behind `html[data-mode="dark"]` (the page's tiny runtime mirrors
     hikari's own data-mode attribute, and the selector doubles as a test
     hook).

Usage:
  python scripts/export_feedback_theme.py           # regenerate the file
  python scripts/export_feedback_theme.py --check   # CI: fail on drift

The webui package must have its dependencies installed (`pnpm install`).
CI runs `--check` in the frontend job so a hikari bump that changes any
token forces a conscious re-export here.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_FILE = ROOT / "res" / "theme" / "feedback-hikari.css"
WEBUI = ROOT / "packages" / "webui"

# preset key (camelCase, presets.ts) -> CSS custom property
PRESET_KEYS = {
    "primary": "--color-primary",
    "secondary": "--color-secondary",
    "accent": "--color-accent",
    "text": "--color-text",
    "muted": "--color-muted",
    "border": "--color-border",
    "focusedBorder": "--color-focused-border",
    "background": "--color-background",
    "surface": "--color-surface",
    "selectedBackground": "--color-selected-bg",
    "selectedText": "--color-selected-text",
    "statusBarBackground": "--color-status-bar-bg",
    "success": "--color-success",
    "error": "--color-error",
    "warning": "--color-warning",
    "info": "--color-info",
    "onSolidText": "--color-on-solid-text",
    "onSolidIcon": "--color-on-solid-icon",
}

ENTRY_SCSS = """@use "@celestia-island/hikari/src/styles/theme/channels.scss";
@use "@celestia-island/hikari/src/styles/theme/scale.scss";
"""


def die(msg: str) -> None:
    print(f"export_feedback_theme: {msg}", file=sys.stderr)
    sys.exit(1)


def hikari_dir() -> Path:
    d = WEBUI / "node_modules" / "@celestia-island" / "hikari"
    if not d.is_dir():
        die(
            "hikari not found at packages/webui/node_modules/@celestia-island/hikari "
            "— run `pnpm install` first"
        )
    return d


def compile_tokens() -> str:
    """Compile channels+scale with the webui package's sass."""
    sass_js = WEBUI / "node_modules" / "sass" / "sass.js"
    if not sass_js.is_file():
        die("sass not found under packages/webui — run `pnpm install` first")
    with tempfile.NamedTemporaryFile(
        "w", suffix=".scss", delete=False, encoding="utf-8"
    ) as f:
        f.write(ENTRY_SCSS)
        entry = f.name
    try:
        r = subprocess.run(
            [
                "node",
                str(sass_js),
                "--no-source-map",
                "--load-path",
                str(WEBUI / "node_modules"),
                entry,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=120,
        )
    finally:
        os.unlink(entry)
    if r.returncode != 0:
        die(f"sass failed:\n{r.stderr}")
    css = r.stdout.strip()
    # @charset is meaningless once inlined into the page's <style>; the
    # page document itself carries <meta charset="utf-8">.
    css = re.sub(r'^@charset[^;]+;\s*', "", css)
    return css + "\n"


def parse_preset(presets_ts: Path) -> tuple[dict[str, str], dict[str, str]]:
    """Extract the `default` preset's dark/light maps from presets.ts."""
    src = presets_ts.read_text(encoding="utf-8")
    m = re.search(r"default:\s*\{(.*?)\n  \},\n\};", src, re.S)
    if not m:
        die("cannot locate the `default` preset block in theme/presets.ts")
    block = m.group(1)

    def side(name: str) -> dict[str, str]:
        s = re.search(rf"{name}:\s*\{{(.*?)\n    \}},", block, re.S)
        if not s:
            die(f"cannot locate the `{name}` map of the default preset")
        out: dict[str, str] = {}
        found: set[str] = set()
        for key, r_, g_, b_ in re.findall(
            r"(\w+):\s*rgb\((\d+),\s*(\d+),\s*(\d+)\)", s.group(1)
        ):
            found.add(key)
            css = PRESET_KEYS.get(key)
            if css:
                out[css] = f"{r_} {g_} {b_}"
        missing = set(PRESET_KEYS.values()) - set(out)
        if missing:
            die(f"preset map is missing tokens: {sorted(missing)}")
        # A hikari update that ADDS a color channel must fail loudly here,
        # not ship a sheet that silently lacks it.
        unknown = found - set(PRESET_KEYS)
        if unknown:
            die(
                "preset map carries unknown keys "
                f"{sorted(unknown)} — extend PRESET_KEYS in "
                "scripts/export_feedback_theme.py"
            )
        # tokensToCSSVars also derives --color-on-solid from onSolidText
        # (presets.ts), so buttons' solid-fill ink flips with the scheme.
        out["--color-on-solid"] = out["--color-on-solid-text"]
        return out

    return side("dark"), side("light")


def vars_block(selector: str, values: dict[str, str], indent: str = "  ") -> str:
    lines = [f"{selector} {{"]
    lines += [f"{indent}{k}: {v};" for k, v in values.items()]
    lines.append("}")
    return "\n".join(lines)


def build() -> str:
    hk = hikari_dir()
    version = json.loads((hk / "package.json").read_text(encoding="utf-8"))["version"]
    dark, light = parse_preset(hk / "src" / "theme" / "presets.ts")
    header = (
        "/* GENERATED FILE — do not edit by hand.\n"
        " * Source: @celestia-island/hikari " + version + " (webui dependency)\n"
        " *   - src/styles/theme/channels.scss + src/styles/theme/scale.scss\n"
        " *     (compiled with the webui package's sass; :root token blocks only)\n"
        " *   - src/theme/presets.ts `default` light/dark maps — the pair the\n"
        " *     desktop app's initTheme() injects at runtime, so this standalone\n"
        " *     page renders in the app's actual palette.\n"
        " * Regenerate: python scripts/export_feedback_theme.py\n"
        " * Drift guard: CI runs the same script with --check.\n"
        " * Consumed by relay-core feedback_page() via include_str!.\n"
        " */\n"
    )
    parts = [header, compile_tokens()]
    parts.append(
        "\n/* ── App palette: hikari `default` preset, light scheme ─────────── */\n"
        + vars_block(":root", light)
    )
    dark_block = vars_block(":root", dark)
    parts.append(
        "\n/* ── App palette: hikari `default` preset, dark scheme ──────────── */\n"
        "@media (prefers-color-scheme: dark) {\n"
        + vars_block(":root", dark, "  ")
        + "\n}\n\n"
        "/* The page's runtime sets data-mode like hikari's useTheme does; this\n"
        " * selector also outranks the media query so it can be toggled for\n"
        " * testing. */\n"
        + vars_block('html[data-mode="dark"]', dark)
    )
    return "\n".join(parts) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="verify the file is current")
    args = ap.parse_args()

    content = build()
    if args.check:
        current = (
            OUT_FILE.read_text(encoding="utf-8") if OUT_FILE.is_file() else ""
        )
        if current != content:
            print(
                "export_feedback_theme: res/theme/feedback-hikari.css is out of "
                "date with the installed hikari package.\n"
                "Regenerate with: python scripts/export_feedback_theme.py",
                file=sys.stderr,
            )
            sys.exit(1)
        print("feedback theme tokens OK (in sync with installed hikari)")
        return

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(content, encoding="utf-8", newline="\n")
    print(f"wrote {OUT_FILE.relative_to(ROOT)} ({len(content)} bytes)")


if __name__ == "__main__":
    main()
