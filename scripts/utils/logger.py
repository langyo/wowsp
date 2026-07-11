"""Columnar unified logger for WoWSP dev scripts.

Adapted from shittim-chest's `scripts/utils/logger.py`. Emits aligned
`SOURCE TIME LEVEL MODULE MESSAGE` lines with optional ANSI color. Triple-gated
on isatty + NO_COLOR + TERM=dumb. A process-wide default instance backs the
module-level convenience functions.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime

SOURCE_WIDTH = 13
MODULE_WIDTH = 12
_TIME_FMT = "%H:%M:%S"

_COLOR = {
    "DEBUG": "\033[37m",
    "INFO": "\033[36m",
    "OK": "\033[32m",
    "WARN": "\033[33m",
    "ERROR": "\033[31m",
    "RESET": "\033[0m",
    "DIM": "\033[2m",
}


def _color_enabled() -> bool:
    if os.environ.get("NO_COLOR"):
        return False
    if os.environ.get("TERM") == "dumb":
        return False
    try:
        return sys.stdout.isatty()
    except Exception:
        return False


class Logger:
    def __init__(
        self,
        source: str = "wowsp",
        module: str = "core",
        source_width: int = SOURCE_WIDTH,
        module_width: int = MODULE_WIDTH,
        stream=None,
    ) -> None:
        self.source = source
        self.module = module
        self.source_width = source_width
        self.module_width = module_width
        self.stream = stream or sys.stdout
        self._color = _color_enabled()

    def configure(self, **kwargs) -> "Logger":
        for k, v in kwargs.items():
            setattr(self, k, v)
        self._color = _color_enabled()
        return self

    def _emit(self, level: str, msg: str, module: str | None = None) -> None:
        src = self.source.ljust(self.source_width)[: self.source_width]
        mod = (module or self.module).ljust(self.module_width)[: self.module_width]
        ts = datetime.now().strftime(_TIME_FMT)
        line = f"{src} {ts} {level:<5} {mod} {msg}"
        if self._color:
            c = _COLOR.get(level, "")
            line = f"{c}{line}{_COLOR['RESET']}"
        print(line, file=self.stream, flush=True)

    def debug(self, msg: str, module: str | None = None) -> None:
        self._emit("DEBUG", msg, module)

    def info(self, msg: str, module: str | None = None) -> None:
        self._emit("INFO", msg, module)

    def ok(self, msg: str, module: str | None = None) -> None:
        self._emit("OK", msg, module)

    def warn(self, msg: str, module: str | None = None) -> None:
        self._emit("WARN", msg, module)

    def error(self, msg: str, module: str | None = None) -> None:
        self._emit("ERROR", msg, module)


_default = Logger()


def configure(**kwargs) -> Logger:
    return _default.configure(**kwargs)


def debug(msg: str, module: str | None = None) -> None:
    _default.debug(msg, module)


def info(msg: str, module: str | None = None) -> None:
    _default.info(msg, module)


def ok(msg: str, module: str | None = None) -> None:
    _default.ok(msg, module)


def warn(msg: str, module: str | None = None) -> None:
    _default.warn(msg, module)


def error(msg: str, module: str | None = None) -> None:
    _default.error(msg, module)
