"""Legacy tag-style CLI formatter for WoWSP dev scripts.

Adapted from shittim-chest's `scripts/utils/cli_format.py`. Respects NO_COLOR
and TERM=dumb.
"""
from __future__ import annotations

import os
import sys
import time

_TAG_COLORS = {
    "ok": "\033[32m",
    "info": "\033[36m",
    "warn": "\033[33m",
    "fail": "\033[31m",
    "pending": "\033[35m",
    "bold": "\033[1m",
    "reset": "\033[0m",
}


def _color_on() -> bool:
    return not os.environ.get("NO_COLOR") and os.environ.get("TERM") != "dumb" and sys.stdout.isatty()


def _tag(tag: str, color_key: str, msg: str) -> None:
    c = _TAG_COLORS.get(color_key, "")
    r = _TAG_COLORS["reset"]
    if _color_on():
        print(f"{c}[ {tag:<5} ]{r} {msg}", flush=True)
    else:
        print(f"[ {tag:<5} ] {msg}", flush=True)


def ok(msg: str) -> None:
    _tag("OK", "ok", msg)


def info(msg: str) -> None:
    _tag("INFO", "info", msg)


def warn(msg: str) -> None:
    _tag("WARN", "warn", msg)


def fail(msg: str) -> None:
    _tag("FAIL", "fail", msg)


err = fail


def pending(msg: str) -> None:
    _tag("...", "pending", msg)


def bold(msg: str) -> None:
    c = _TAG_COLORS["bold"]
    r = _TAG_COLORS["reset"]
    line = f"{c}{msg}{r}" if _color_on() else msg
    print(line, flush=True)


def blank() -> None:
    print(flush=True)


class ProgressTimer:
    def __init__(self, label: str = "") -> None:
        self.label = label
        self.start = time.monotonic()

    def elapsed(self) -> float:
        return time.monotonic() - self.start

    def stop(self) -> float:
        e = self.elapsed()
        if self.label:
            info(f"{self.label} done in {e:.2f}s")
        return e


def section(title: str) -> None:
    blank()
    bold(title)


def header(title: str) -> None:
    section(title)


def step(msg: str) -> None:
    info(msg)
