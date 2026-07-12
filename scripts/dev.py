#!/usr/bin/env python3
"""WoWSP development orchestrator.

Adapted from shittim-chest's `scripts/dev.py` (heavily trimmed). WoWSP is a
single-process Tauri desktop app — there is no scepter/backend database — so the
orchestrator only needs to:

* (default)  run `cargo tauri dev`, which itself watches both the Rust sources
  (auto recompile + restart the window) and the webui (Vite HMR). Malkuth's
  DrainController inside the app gives each restart a graceful wind-down.
* `--mock`   additionally start the FastAPI mock backend on :8787 so the webui
  can develop in a browser without the game.
* `webui`    run only the Vite dev server (browser-only, no Tauri shell).
* `--watch`  wrap the dev process in an explicit notify-based file watcher that
  restarts the whole subprocess tree on changes to config files tauri-cli does
  not watch itself (Cargo.toml, tauri.conf.json, justfile, .env). This is the
  same `notify` crate mechanism malkuth's own CLI uses internally.

Usage:
    python scripts/dev.py                # cargo tauri dev (native desktop, full hot reload)
    python scripts/dev.py webui          # browser-only Vite
    python scripts/dev.py --mock         # mock backend + Vite (no Tauri)
    python scripts/dev.py --watch        # cargo tauri dev + explicit config watcher
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

# Files whose changes tauri-cli does NOT watch but should trigger a full dev
# restart. Source files (Rust + webui) are handled by tauri-cli's own watcher
# and Vite HMR respectively, so they are intentionally excluded here.
WATCH_CONFIG_GLOBS = [
    "Cargo.toml",
    "Cargo.lock",
    "packages/app/tauri/Cargo.toml",
    "packages/app/tauri/tauri.conf.json",
    "packages/app/tauri/capabilities/*.json",
    "packages/app/tauri_shared/Cargo.toml",
    "packages/webui/package.json",
    "packages/webui/vite.config.ts",
    "packages/webui/tsconfig*.json",
    "pnpm-workspace.yaml",
    "justfile",
    ".env",
]


def _run(cmd: list[str], cwd: Path = ROOT, env: dict | None = None) -> subprocess.Popen:
    _log.info(f"$ {' '.join(cmd)}", module="spawn")
    # On Windows, `pnpm`/`pnpm.cmd` is a corepack shim that subprocess.Popen
    # can't resolve without a shell (Python 3.13 dropped implicit .cmd
    # resolution for security). shell=True lets the OS resolve shims the same
    # way a terminal would. Commands here are all hardcoded literals, so the
    # shell-injection surface is nil.
    return subprocess.Popen(
        " ".join(cmd),
        cwd=str(cwd),
        env={**os.environ, **(env or {})},
        shell=True,
    )


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


def _watch_configs(stop_event: threading.Event, on_change: threading.Event) -> None:
    """Poll-based config watcher (no `notify` Python dep required).

    tauri-cli already watches Rust/webui source; this only covers the handful of
    config files whose edits would otherwise need a manual restart. Fires
    `on_change` once per modification (debounced 1s).
    """
    snapshots: dict[Path, float] = {}
    paths: list[Path] = []
    for pat in WATCH_CONFIG_GLOBS:
        paths.extend(sorted((ROOT).glob(pat)))
    for p in paths:
        try:
            snapshots[p] = p.stat().st_mtime
        except OSError:
            pass
    _log.info(f"watching {len(snapshots)} config files for restart-triggering changes", module="watch")

    last_fire = 0.0
    while not stop_event.wait(1.0):
        now = time.monotonic()
        changed = False
        for p, mtime in list(snapshots.items()):
            try:
                cur = p.stat().st_mtime
            except OSError:
                continue
            if cur != mtime:
                snapshots[p] = cur
                changed = True
        # Also detect newly-created config files matching the globs.
        for pat in WATCH_CONFIG_GLOBS:
            for p in (ROOT).glob(pat):
                if p not in snapshots:
                    try:
                        snapshots[p] = p.stat().st_mtime
                    except OSError:
                        continue
        if changed and now - last_fire > 1.0:
            last_fire = now
            on_change.set()


def run_with_watcher(cmd: list[str], env: dict | None = None) -> int:
    """Run `cmd`; restart it whenever a watched config file changes.

    On restart the old subprocess receives SIGTERM (Ctrl-C on Windows), which
    the app's malkuth DrainController turns into a graceful drain before exit.
    Ctrl-C in this script tears everything down.
    """
    stop_event = threading.Event()
    on_change = threading.Event()
    watcher = threading.Thread(
        target=_watch_configs, args=(stop_event, on_change), name="wowsp-config-watch", daemon=True
    )
    watcher.start()

    while not stop_event.is_set():
        _log.info("starting dev subprocess (malkuth will graceful-drain on restart)", module="dev")
        proc = _run(cmd, env=env)
        # Wait for either: subprocess exit, config change, or Ctrl-C.
        while proc.poll() is None:
            if on_change.wait(0.5):
                on_change.clear()
                _log.warn("config changed → restarting dev subprocess", module="watch")
                _terminate(proc)
                break
        if proc.poll() is None:
            # We broke out via config change; loop to respawn.
            continue
        # Subprocess exited on its own.
        rc = proc.returncode
        if rc in (0, -2, 130):  # clean exit / Ctrl-C
            break
        _log.warn(f"dev subprocess exited ({rc}) — restarting in 1s", module="dev")
        time.sleep(1.0)

    stop_event.set()
    return 0


def _terminate(proc: subprocess.Popen) -> None:
    """Politely terminate a subprocess: SIGTERM first, SIGKILL on Windows via
    taskkill on the whole tree (Tauri spawns children)."""
    if proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            # taskkill the tree so Vite/cargo children don't linger.
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True,
                timeout=10,
            )
        else:
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=10)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


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
            _terminate(p)
        return 0


def _kill_lingering_wowsp() -> None:
    """Kill any running wowsp.exe processes before starting a new dev session."""
    import shutil
    taskkill = shutil.which("taskkill")
    if not taskkill:
        return
    try:
        subprocess.call(
            [taskkill, "/F", "/IM", "wowsp.exe"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass


def _sync_logo() -> None:
    """Sync docs/logo.webp → all icon assets if the source changed."""
    sync_script = ROOT / "scripts" / "sync_logo.py"
    if not sync_script.exists():
        return
    try:
        subprocess.call(
            [sys.executable, str(sync_script)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass


def run_native(args: argparse.Namespace) -> int:
    try:
        # Kill any lingering wowsp.exe from a previous dev session.
        _kill_lingering_wowsp()

        # Sync the logo from docs/ → all icon assets. Picks up logo changes
        # automatically so the user doesn't need to run `just gen-icons` manually.
        _sync_logo()

        if args.webui_only:
            procs: list[subprocess.Popen] = []
            start_vite(procs)
            procs[0].wait()
            return 0
        cmd = ["cargo", "tauri", "dev"]
        env = None
        if args.mock:
            # Run mock backend alongside, point Vite at it via env.
            procs = []
            start_mock(procs)
            env = {"WOWSP_MOCK_URL": f"http://localhost:{MOCK_PORT}"}
        if args.watch:
            rc = run_with_watcher(cmd, env=env)
            return rc
        # Default: plain cargo tauri dev (tauri-cli's own watcher handles hot reload).
        proc = _run(cmd, env=env)
        proc.wait()
        return proc.returncode or 0
    except KeyboardInterrupt:
        _log.info("shutting down...", module="dev")
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="WoWSP dev orchestrator")
    parser.add_argument("mode", nargs="?", default=None, help="(positional) 'webui' for browser-only")
    parser.add_argument("--mock", action="store_true", help="start the FastAPI mock backend")
    parser.add_argument("--watch", action="store_true", help="wrap dev in a config-file watcher that restarts on change")
    parser.add_argument("--clean", action="store_true", help="reserved for compatibility")
    args, _unknown = parser.parse_known_args()

    args.webui_only = args.mode == "webui"

    if args.mock and args.webui_only:
        return run_mock(args)
    return run_native(args)


if __name__ == "__main__":
    sys.exit(main())
