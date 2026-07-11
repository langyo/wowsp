#!/usr/bin/env python3
"""WoWSP development orchestrator.

Adapted from shittim-chest's `scripts/dev.py` (heavily trimmed). WoWSP has no
backend database / Docker stack / scepter, so the orchestrator only needs to:

* `--mock`   — start the FastAPI mock backend + the Vite dev server
* `--native` — start the Vite dev server (+ optionally `cargo tauri dev`)
* (default)  — alias for `--native tauri`

Usage:
    python scripts/dev.py                # native tauri (Vite + cargo tauri dev)
    python scripts/dev.py --native       # browser only (Vite)
    python scripts/dev.py --mock         # mock backend + Vite (no Tauri)
    python scripts/dev.py watch          # file watcher: rebuild on change
"""
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts" / "utils"))
import logger as _log  # noqa: E402

_log.configure(source="wowsp", module="dev")

MOCK_PORT = int(os.environ.get("WOWSP_MOCK_PORT", "8787"))
VITE_PORT = 5173


def _run(cmd: list[str], cwd: Path = ROOT, env: dict | None = None) -> subprocess.Popen:
    _log.info(f"$ {' '.join(cmd)}", module="spawn")
    return subprocess.Popen(cmd, cwd=str(cwd), env={**os.environ, **(env or {})})


def _wait_port(port: int, timeout: float = 20.0) -> bool:
    import socket

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            try:
                s.connect(("127.0.0.1", port))
                return True
            except OSError:
                time.sleep(0.3)
    return False


def start_mock(procs: list[subprocess.Popen]) -> None:
    mock_dir = ROOT / "scripts" / "mock"
    venv = mock_dir / ".venv"
    if venv.is_dir():
        py = str(venv / ("Scripts" if os.name == "nt" else "bin") / "python")
    else:
        py = sys.executable
    env = {"WOWSP_MOCK_PORT": str(MOCK_PORT), "PYTHONPATH": str(mock_dir / "src")}
    p = _run([py, "-m", "uvicorn", "main:app", "--port", str(MOCK_PORT)], cwd=mock_dir, env=env)
    procs.append(p)
    if _wait_port(MOCK_PORT):
        _log.ok(f"mock backend ready at http://localhost:{MOCK_PORT}", module="mock")
    else:
        _log.warn(f"mock backend did not bind :{MOCK_PORT} in time", module="mock")


def start_vite(procs: list[subprocess.Popen], extra_env: dict | None = None) -> None:
    pnpm = "pnpm"
    env = extra_env or {}
    p = _run([pnpm, "--filter", "@wowsp/webui", "dev"], env=env)
    procs.append(p)
    if _wait_port(VITE_PORT):
        _log.ok(f"Vite ready at http://localhost:{VITE_PORT}", module="vite")
    else:
        _log.warn(f"Vite did not bind :{VITE_PORT} in time", module="vite")


def start_tauri(procs: list[subprocess.Popen]) -> None:
    p = _run(["cargo", "tauri", "dev"])
    procs.append(p)


def run_mock(args: argparse.Namespace) -> int:
    procs: list[subprocess.Popen] = []
    try:
        start_mock(procs)
        start_vite(procs, extra_env={"WOWSP_MOCK_URL": f"http://localhost:{MOCK_PORT}"})
        _log.info("WoWSP dev (mock) running — Ctrl-C to stop.", module="ready")
        for p in procs:
            p.wait()
    except KeyboardInterrupt:
        _log.info("shutting down...", module="dev")
    finally:
        for p in procs:
            if p.poll() is None:
                p.terminate()
        return 0


def run_native(args: argparse.Namespace) -> int:
    procs: list[subprocess.Popen] = []
    try:
        if args.tauri:
            # Vite is launched by tauri's beforeDevCommand; just run cargo tauri dev.
            start_tauri(procs)
            procs[0].wait()
        else:
            start_vite(procs)
            procs[0].wait()
    except KeyboardInterrupt:
        _log.info("shutting down...", module="dev")
    finally:
        for p in procs:
            if p.poll() is None:
                p.terminate()
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="WoWSP dev orchestrator")
    parser.add_argument("mode", nargs="?", default=None, help="watch | tauri (positional, optional)")
    parser.add_argument("--mock", action="store_true", help="start the FastAPI mock backend + Vite")
    parser.add_argument("--native", action="store_true", help="host-process dev (Vite, +Tauri if 'tauri' given)")
    parser.add_argument("--clean", action="store_true", help="reserved for compatibility")
    args, _unknown = parser.parse_known_args()

    # Normalize: a bare `tauri` positional implies --native tauri.
    if args.mode == "tauri":
        args.tauri = True
        args.native = True
    else:
        args.tauri = False
    if args.mode == "watch":
        # watch mode is the same as default native for WoWSP.
        args.native = True

    if args.mock:
        return run_mock(args)
    if not args.native and not args.mock:
        args.native = True
        args.tauri = True
    return run_native(args)


if __name__ == "__main__":
    sys.exit(main())
