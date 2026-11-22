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

The child-process lifecycle and the port guard are NOT implemented here: they
come from `celestia_devtools.devguard`, the shared module promoted from this
repository's #2095 fix (tracked-child tree kill on every exit path, the
poll-loop wait that lets a console SIGINT dispatch, and the UTF-8-safe pid
describer behind the port guard). What stays in this file is WoWSP POLICY —
which port this repo owns, the sentence that explains what a foreign listener
would do to this window, the logger/console shaping, and the `--mock`/`--watch`
gates.

Usage:
    python scripts/dev.py                # cargo tauri dev (native desktop, full hot reload)
    python scripts/dev.py webui          # browser-only Vite
    python scripts/dev.py --mock         # mock backend + Vite (no Tauri)
    python scripts/dev.py --watch        # cargo tauri dev + explicit config watcher
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

try:
    from celestia_devtools import devguard
except ImportError as exc:  # pragma: no cover - environment bootstrap
    raise SystemExit(
        "scripts/dev.py needs celestia-devtools (the shared devguard module): run "
        "`just ensure`, or `python -m pip install -U "
        "git+https://github.com/celestia-island/celestia-devtools.git`, then retry."
    ) from exc

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts" / "utils"))
import logger as _log  # noqa: E402

_log.configure(source="wowsp", module="dev")

MOCK_PORT = int(os.environ.get("WOWSP_MOCK_PORT", "8787"))
# WoWSP's DEDICATED dev port. Deliberately not Vite's shared default 5173:
# neighboring projects claim that one (2026-10-30 incident), and this port is
# pinned in lockstep with packages/app/tauri/tauri.conf.json's devUrl and
# packages/webui/vite.config.ts (src/devPort.contract.test.ts enforces it).
VITE_PORT = 5199

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


# ── child-process lifecycle ───────────────────────────────────────────
#
# The mechanism — tracked-children registry, per-platform tree kill, atexit +
# SIGINT/SIGBREAK/SIGTERM/SIGHUP handlers, poll-loop wait — lives in
# celestia_devtools.devguard, shared with every sibling repository since the
# #2095 promotion. This file keeps only the policy: what gets spawned, and
# which exit paths tear it down.
#
# Why the shared shape is the right one for THIS script:
# * every child is spawned through shell=True (pnpm/cargo shims do not resolve
#   otherwise), so Popen.pid is a cmd.exe wrapper and ONLY a tree kill reaches
#   the pnpm/Vite/cargo grandchildren;
# * devguard.spawn_kwargs() gives POSIX children their own session, so the
#   group kill reaches the tree without ever signalling dev.py itself;
# * a child whose kill cannot be confirmed stays tracked, so a later
#   atexit/signal pass retries it instead of dropping the tree;
# * known gaps, documented rather than papered over: no Python runs on a hard
#   kill of dev.py itself (taskkill /F) or on a console-close
#   (CTRL_CLOSE_EVENT) that pre-empts the handler, and a Ctrl+C that reaches
#   the whole console group at once can leave `taskkill /T` with no tree root
#   to walk (a grandchild that ignored Ctrl+C is then out of reach, and a bare
#   pid kill would be unsafe: PID reuse). A ctypes Job Object with
#   JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE would close both; devguard keeps
#   taskkill because it is dependency-free and a dev script's orderly exit is
#   the routine path.
#
# Regression this keeps fixed: the maintainer's every-other-`just dev` failed
# with "something is already listening on :5199". Run N spawned Vite, then
# left through a path that did not kill it (Ctrl+C in the webui branch, a
# subprocess failure, an exception before the cleanup join); the orphan held
# :5199 and run N+1's guard refused. Every exit path now tree-kills, so the
# routine Ctrl+C no longer orphans Vite.


def _run(cmd: list[str], cwd: Path = ROOT, env: dict | None = None) -> subprocess.Popen:
    _log.info(f"$ {' '.join(cmd)}", module="spawn")
    # On Windows, `pnpm`/`pnpm.cmd` is a corepack shim that subprocess.Popen
    # can't resolve without a shell (Python 3.13 dropped implicit .cmd
    # resolution for security). shell=True lets the OS resolve shims the same
    # way a terminal would. Commands here are all hardcoded literals, so the
    # shell-injection surface is nil.
    #
    # On POSIX the shell child leads its own session so the cleanup hooks can
    # signal the whole tree with killpg instead of leaking node/cargo.
    proc: subprocess.Popen | None = None
    try:
        proc = subprocess.Popen(
            " ".join(cmd),
            cwd=str(cwd),
            env={**os.environ, **(env or {})},
            shell=True,
            **devguard.spawn_kwargs(),
        )
        devguard.track(proc.pid, proc)
        return proc
    except BaseException:
        # A signal handler can raise between Popen returning and the registry
        # insert; the handler does not know this child yet, so kill it here
        # before the exception unwinds.
        if proc is not None:
            devguard.tree_kill(proc.pid)
        raise


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


# ── port guard (WoWSP policy; mechanism in celestia_devtools.devguard) ──


def _describe_pid(pid: str) -> str:
    """Best-effort identity suffix for a listener pid (", <command line>").

    The shared describer does the platform work (UTF-8-pinned PowerShell read,
    tasklist fallback, POSIX ps); the ", " prefix is this guard's policy so the
    sentence below reads as one clause."""
    identity = devguard.describe_pid(pid)
    return f", {identity}" if identity else ""


def _port_occupied_by(port: int) -> devguard.PortOwner | None:
    """Return who listens on `port` (pid + best-effort identity), or None when
    the port is free. Guards against the nasty failure where ANOTHER project's
    dev server holds the port: `_wait_port` would then see it as 'Vite ready'
    and Tauri would load that foreign app in our window."""
    if not devguard.port_in_use(port):
        return None  # connect refused → free
    pid = devguard.port_listener_pid(port)
    if pid is None:
        return devguard.PortOwner(None, "")
    return devguard.PortOwner(pid, _describe_pid(pid))


def _console_safe(text: str) -> str:
    """Make a hint printable on the host console.

    The process hint can carry a path from another project; on Windows the
    console is commonly GBK and the logger prints through it with no encoding
    fallback, so an unencodable character would turn the guard itself into a
    UnicodeEncodeError traceback (the 2026-10-30 fix initially did exactly
    that). The shared helper does the encode/decode; this wrapper supplies THIS
    repo's log stream, which is why it stays here."""
    stream = getattr(getattr(_log, "_default", None), "stream", None)
    return devguard.console_safe(text, stream)


def _require_vite_port_free() -> None:
    """Fail LOUDLY when :5199 is held by another process — the dev-server
    isolation contract.

    2026-10-30 incident: a neighboring project's Vite server held Vite's shared
    default :5173, WoWSP's Vite silently fell back to :5174 while
    tauri.conf.json's devUrl stayed on :5173, so the WoWSP window loaded that
    foreign app. WoWSP now owns :5199 and this guard runs on EVERY script launch
    path (all `just dev` modes including the default native one), naming the
    offending pid/command before Tauri can open; Vite itself is also pinned with
    host 127.0.0.1 + strictPort so a fallback cannot happen even when the script
    is bypassed (cargo tauri dev directly).

    The refusal text and the SystemExit come from devguard.require_port_free;
    the words below are WoWSP's policy."""
    devguard.require_port_free(
        VITE_PORT,
        "This is NOT WoWSP's dev server — Tauri would load that foreign app into the "
        "WoWSP window. Stop it, or move that project to its own dev port, then rerun "
        "`just dev`.",
        owner_lookup=_port_occupied_by,
        report=lambda message: _log.error(_console_safe(message), module="vite"),
    )


def start_vite(procs: list[subprocess.Popen], extra_env: dict | None = None) -> None:
    _require_vite_port_free()
    pnpm = "pnpm"
    env = extra_env or {}
    p = _run([pnpm, "--filter", "@wowsp/webui", "dev"], env=env)
    procs.append(p)
    if _wait_port(VITE_PORT):
        _log.ok(f"Vite ready at http://127.0.0.1:{VITE_PORT}", module="vite")
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

    proc: subprocess.Popen | None = None
    try:
        while not stop_event.is_set():
            _log.info("starting dev subprocess (malkuth will graceful-drain on restart)", module="dev")
            proc = _run(cmd, env=env)
            # Wait for either: subprocess exit, config change, or Ctrl-C.
            while proc.poll() is None:
                if on_change.wait(0.5):
                    on_change.clear()
                    _log.warn("config changed → restarting dev subprocess", module="watch")
                    devguard.tree_kill(proc.pid)
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
    finally:
        # Ctrl-C during the wait must not leave cargo/Vite behind.
        stop_event.set()
        if proc is not None:
            devguard.tree_kill(proc.pid)
    return 0


def run_mock(args: argparse.Namespace) -> int:
    procs: list[subprocess.Popen] = []
    try:
        start_mock(procs)
        start_vite(procs, extra_env={"WOWSP_MOCK_URL": f"http://localhost:{MOCK_PORT}"})
        _log.info("WoWSP dev (mock) running — Ctrl-C to stop.", module="ready")
        for p in procs:
            devguard.wait_poll(p)
    except KeyboardInterrupt:
        _log.info("shutting down...", module="dev")
    finally:
        # A finally-return here would swallow the port guard's SystemExit(1).
        for p in procs:
            devguard.tree_kill(p.pid)
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
    procs: list[subprocess.Popen] = []
    try:
        # Port isolation FIRST: a foreign dev server on :5199 makes Tauri load
        # ITS page into the WoWSP window (2026-10-30 incident). Fail before
        # touching any process; Vite's strictPort pin is the second defense.
        _require_vite_port_free()

        # Kill any lingering wowsp.exe from a previous dev session.
        _kill_lingering_wowsp()

        # Sync the logo from docs/ → all icon assets. Picks up logo changes
        # automatically so the user doesn't need to run `just gen-icons` manually.
        _sync_logo()

        if args.webui_only:
            # Browser-only session: no mock backend runs, so the webui's
            # transport must fail fast instead of fetching every RPC into a
            # dead proxy target (one ECONNREFUSED stack per call flooded the
            # dev terminal — 2026-11-07 report). `just dev mock` omits the
            # flag and serves the FastAPI backend as before.
            start_vite(procs, extra_env={"WOWSP_NO_BACKEND": "1"})
            devguard.wait_poll(procs[0])
            return 0
        cmd = ["cargo", "tauri", "dev"]
        env = None
        if args.mock:
            # Run mock backend alongside, point Vite at it via env.
            start_mock(procs)
            env = {"WOWSP_MOCK_URL": f"http://localhost:{MOCK_PORT}"}
        if args.watch:
            return run_with_watcher(cmd, env=env)
        # Default: plain cargo tauri dev (tauri-cli's own watcher handles hot reload).
        procs.append(_run(cmd, env=env))
        devguard.wait_poll(procs[-1])
        return procs[-1].returncode or 0
    except KeyboardInterrupt:
        _log.info("shutting down...", module="dev")
        return 0
    finally:
        # Every exit path (Ctrl-C in the webui branch above, a subprocess
        # failure, any exception between spawn and join) tree-kills the
        # children; the shared atexit/signal hooks cover the paths that skip
        # this frame.
        for proc in procs:
            devguard.tree_kill(proc.pid)


def _notify_signal(message: str) -> None:
    """Route devguard's teardown line through this script's logger."""
    try:
        _log.warn(message, module="dev")
    except Exception:
        pass  # logging must never be able to skip the cleanup itself


def main() -> int:
    # Cleanup must exist BEFORE the first spawn: Ctrl-C (or any exception)
    # between spawn and an explicit join used to orphan Vite on :5199.
    devguard.install_exit_hooks(_notify_signal)
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
