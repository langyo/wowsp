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
import atexit
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import NamedTuple

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

# Windows PowerShell writes its *redirected* stdout in the console codepage
# (GBK/cp936 on the maintainer's host), so CJK paths came back mojibake
# (`D:/Դ????/...`) even though the pipe is read as utf-8. Forcing the console
# output encoding inside the session makes the producer match the consumer;
# every powershell invocation that reads process metadata must prefix its
# -Command with this (see _describe_pid_command).
_PS_UTF8_PREFIX = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; "

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
# Kill-chain design: `taskkill /PID <pid> /T /F` per spawned child on Windows
# (POSIX: process-group SIGTERM, then SIGKILL). taskkill is chosen over a
# ctypes Job Object because it is dependency-free, is already this repo's
# Windows primitive (`_kill_lingering_wowsp` and the old `_terminate`), and it
# covers the actual failure mode: every child is spawned through shell=True,
# so Popen.pid is a cmd.exe wrapper and ONLY a tree kill reaches
# pnpm/Vite/cargo. A Job Object would additionally survive dev.py itself being
# force-killed, but needs ctypes plumbing and one handle per child for a dev
# script whose own orderly exit is the routine path.
#
# Regression: the maintainer's every-other-`just dev` failed with "something
# is already listening on :5199". Run N spawned Vite, then left through a path
# that did not kill it (Ctrl+C in the `webui` branch, a subprocess failure, an
# exception before the cleanup join); the orphan held :5199 and run N+1's guard
# refused. Every exit path now runs the tree kill, so the routine Ctrl+C no
# longer orphans Vite. Known gaps, documented rather than papered over:
# (a) no Python runs on a hard kill of dev.py itself (taskkill /F) or on a
#     console-close (CTRL_CLOSE_EVENT) that pre-empts the handler;
# (b) Ctrl+C reaches the whole console group at once, so if cmd.exe dies before
#     our taskkill runs, /T has no tree root left to walk and a grandchild that
#     ignored Ctrl+C is out of reach (taskkill on the recorded pid would be
#     unsafe: PID reuse).
# A ctypes Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE would close both
# (the kernel kills the whole job when its last handle closes, even when dev.py
# is hard-killed) and is the intended next step if a residual orphan is ever
# observed; taskkill was chosen now to keep this dev script free of ctypes job
# plumbing. Whatever the route, a child whose kill cannot be confirmed stays
# tracked so a later atexit/signal pass can retry it.
_LIVE_CHILDREN: dict[int, subprocess.Popen] = {}
_LIVE_LOCK = threading.RLock()
_CLEANUP_IN_PROGRESS = False
_EXIT_HOOKS_INSTALLED = False


def _track_child(proc: subprocess.Popen) -> None:
    """Remember a spawned child so the exit hooks can tree-kill it."""
    with _LIVE_LOCK:
        for pid in [pid for pid, p in _LIVE_CHILDREN.items() if p.poll() is not None]:
            _LIVE_CHILDREN.pop(pid, None)
        _LIVE_CHILDREN[proc.pid] = proc


def _untrack_child(proc: subprocess.Popen) -> None:
    with _LIVE_LOCK:
        _LIVE_CHILDREN.pop(proc.pid, None)


def _kill_command(pid: str | int) -> str:
    """Copy-pasteable one-liner that stops `pid` (with its tree on Windows)."""
    if os.name == "nt":
        return f"taskkill /PID {pid} /T /F"
    return f"kill -TERM {pid}"


def _proc_group(proc: subprocess.Popen) -> int | None:
    """The child's process group when it leads its own session, else None.

    `_run` starts POSIX children in a new session, so killpg reaches the whole
    tree; a child that shares dev.py's own group must never be group-killed
    (that would kill dev.py itself)."""
    if os.name == "nt":
        return None
    try:
        pgid = os.getpgid(proc.pid)
        return pgid if pgid != os.getpgid(0) else None
    except OSError:
        return None


def _terminate(proc: subprocess.Popen) -> bool:
    """Tree-terminate one child: SIGTERM first, then SIGKILL on POSIX;
    `taskkill /T /F` on Windows (no signal-based graceful stop reaches the
    grandchildren of a shell-spawned process there). Idempotent, never raises.

    Returns True once the child is confirmed gone and untracked; a kill that
    cannot be confirmed leaves it tracked so the next atexit/signal cleanup
    pass retries instead of silently dropping the tree."""
    if proc.poll() is not None:
        _untrack_child(proc)
        return True
    try:
        if os.name == "nt":
            # taskkill the tree so pnpm/Vite/cargo children don't linger.
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True,
                timeout=10,
            )
        else:
            pgid = _proc_group(proc)
            if pgid is not None:
                os.killpg(pgid, signal.SIGTERM)
            else:
                proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
            if pgid is not None:
                # A descendant can outlive the group leader, so a clean leader
                # exit must not end the cleanup; SIGKILL the whole group (a
                # gone group raises ESRCH, which is fine).
                try:
                    os.killpg(pgid, signal.SIGKILL)
                except OSError:
                    pass
            elif proc.poll() is None:
                proc.kill()
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    finally:
        try:
            proc.wait(timeout=1)  # reap, don't leave a zombie on POSIX
        except Exception:
            pass
    if proc.poll() is not None:
        _untrack_child(proc)
        return True
    return False


def _cleanup_children() -> None:
    """Tree-kill every live child. Runs on atexit, on SIGINT/SIGBREAK/SIGTERM/
    SIGHUP, and from the explicit shutdown paths. Never raises; reentrant-safe.

    Untracking happens inside `_terminate` only on a confirmed kill, so a
    failed or aborted pass (second Ctrl+C, taskkill timeout) leaves the
    survivors in the registry for the next pass."""
    global _CLEANUP_IN_PROGRESS
    with _LIVE_LOCK:
        if _CLEANUP_IN_PROGRESS:
            return
        _CLEANUP_IN_PROGRESS = True
        procs = list(_LIVE_CHILDREN.values())
    try:
        for proc in procs:
            _terminate(proc)
    finally:
        with _LIVE_LOCK:
            _CLEANUP_IN_PROGRESS = False


def _on_signal(signum: int, _frame) -> None:
    """Kill the spawned trees BEFORE unwinding, so Ctrl+C cannot orphan Vite."""
    try:
        name = signal.Signals(signum).name
    except ValueError:
        name = str(signum)
    try:
        _log.warn(f"received {name} — stopping child process trees", module="dev")
    except Exception:
        pass  # logging must never be able to skip the cleanup below
    _cleanup_children()
    if signum in (getattr(signal, "SIGINT", None), getattr(signal, "SIGBREAK", None)):
        raise KeyboardInterrupt
    raise SystemExit(128 + signum)


def _install_exit_hooks() -> None:
    """Register the atexit + signal cleanup exactly once."""
    global _EXIT_HOOKS_INSTALLED
    if _EXIT_HOOKS_INSTALLED:
        return
    _EXIT_HOOKS_INSTALLED = True
    atexit.register(_cleanup_children)
    for name in ("SIGINT", "SIGBREAK", "SIGTERM", "SIGHUP"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue
        try:
            signal.signal(sig, _on_signal)
        except (OSError, ValueError, RuntimeError):
            # e.g. called from a non-main thread; atexit still covers us.
            pass


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
    popen_kwargs: dict = {}
    if os.name != "nt":
        popen_kwargs["start_new_session"] = True
    proc: subprocess.Popen | None = None
    try:
        proc = subprocess.Popen(
            " ".join(cmd),
            cwd=str(cwd),
            env={**os.environ, **(env or {})},
            shell=True,
            **popen_kwargs,
        )
        _track_child(proc)
        return proc
    except BaseException:
        # A signal handler can raise between Popen returning and the registry
        # insert; the handler does not know this child yet, so kill it here
        # before the exception unwinds.
        if proc is not None:
            _terminate(proc)
        raise


def _wait_proc(proc: subprocess.Popen, interval: float = 0.25) -> int | None:
    """Wait for a child in short polls, never in one blocking `proc.wait()`.

    This is what makes the Ctrl-C guarantee real: on Windows `Popen.wait()`
    parks the main thread in WaitForSingleObject(INFINITE), which the console
    SIGINT handler cannot interrupt, so the handler would only run after the
    child exits — a pnpm/Vite tree that ignores Ctrl+C would then survive the
    script and keep holding :5199. Polling lets the pending handler run within
    one interval and tree-kill the still-live child."""
    while proc.poll() is None:
        time.sleep(interval)
    return proc.returncode


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


class _PortOwner(NamedTuple):
    """Who holds a port: the netstat pid (None when netstat failed) plus a
    best-effort identity suffix (", <command line>"), empty when unknown."""

    pid: str | None
    detail: str


def _busy_port_message(port: int, owner: _PortOwner) -> str:
    """The guard's headline, ending in a COPY-PASTEABLE kill one-liner with the
    resolved pid (no placeholder the user has to fill in)."""
    msg = f"something is already listening on :{port}"
    if owner.pid:
        msg += f" (pid {owner.pid}{owner.detail})"
        msg += f". Stop that process tree with `{_kill_command(owner.pid)}`"
    else:
        msg += f". Find it with `netstat -ano | findstr :{port}`"
    return msg


def _port_occupied_by(port: int) -> _PortOwner | None:
    """Return who listens on `port` (pid + best-effort identity), or None when
    the port is free. Guards against the nasty failure where ANOTHER project's
    dev server holds the port: `_wait_port` would then see it as 'Vite ready'
    and Tauri would load that foreign app in our window."""
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if s.connect_ex(("127.0.0.1", port)) != 0:
            return None  # connect failed → free
    pid = None
    try:
        out = subprocess.run(
            ["netstat", "-ano"], capture_output=True, text=True, errors="replace", timeout=10
        ).stdout
        for line in out.splitlines():
            parts = line.split()
            # Match ANY local address on the port (0.0.0.0 / 127.0.0.1 / [::]):
            # Vite typically binds 0.0.0.0, so an exact 127.0.0.1 comparison
            # would detect the conflict but lose the pid from the message.
            if len(parts) >= 5 and parts[1].endswith(f":{port}") and parts[3] == "LISTENING":
                # The pid is interpolated into a PowerShell -Command string
                # and printed as a kill one-liner; refuse anything non-numeric.
                if parts[4].isdigit():
                    pid = parts[4]
                    break
    except (OSError, subprocess.SubprocessError):
        pass
    if not pid:
        return _PortOwner(None, "")
    return _PortOwner(pid, _describe_pid(pid))


def _describe_pid_command(pid: str) -> list[str]:
    """PowerShell argv that reads a pid's command line as UTF-8 text.

    The _PS_UTF8_PREFIX is mandatory: powershell.exe writes its redirected
    stdout in the console codepage (GBK/cp936 on the maintainer's host), so a
    CJK repo path (this repo lives under 源代码/工程项目/个人站点) came back as
    `D:/Դ????/...` even though the pipe is read with encoding="utf-8". Forcing
    [Console]::OutputEncoding makes the producer match the consumer."""
    return [
        "powershell",
        "-NoProfile",
        "-Command",
        _PS_UTF8_PREFIX + f"(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine",
    ]


def _describe_pid(pid: str) -> str:
    """Best-effort one-line identity for a listener pid (process name / command
    line), so the port guard can name the FOREIGN project instead of a bare
    port number — the 2026-10-30 incident had a neighboring site's Vite server
    on Vite's shared default :5173 and the old message gave the user nothing to
    act on. Never raises; an unknown pid yields an empty string."""
    try:
        if os.name == "nt":
            out = subprocess.run(
                _describe_pid_command(pid),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=6,
            ).stdout.strip()
            if not out:
                lines = subprocess.run(
                    ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=5,
                ).stdout.strip().splitlines()
                fallback = lines[0] if lines else ""
                # tasklist answers a dead pid with "INFO: No tasks are running
                # which match the specified criteria." — not an identity.
                out = "" if fallback.startswith("INFO:") else fallback
            return f", {out[:160]}" if out else ""
        out = subprocess.run(
            ["ps", "-p", pid, "-o", "command="],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
        ).stdout.strip()
        return f", {out[:160]}" if out else ""
    except (OSError, subprocess.SubprocessError, IndexError):
        return ""


def _console_safe(text: str) -> str:
    """Make a hint printable on the host console.

    The process hint can carry a path from another project; on Windows the
    console is commonly GBK and the logger prints through it with no encoding
    fallback, so an unencodable character would turn the guard itself into a
    UnicodeEncodeError traceback (the 2026-10-30 fix initially did exactly
    that). Encode/decode against the stream's own encoding, replacing what it
    cannot represent."""
    stream = getattr(getattr(_log, "_default", None), "stream", None) or sys.stdout
    encoding = getattr(stream, "encoding", None) or "utf-8"
    try:
        return text.encode(encoding, errors="replace").decode(encoding)
    except (LookupError, UnicodeError):
        return text.encode("ascii", errors="replace").decode("ascii")


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
    is bypassed (`cargo tauri dev` directly)."""
    owner = _port_occupied_by(VITE_PORT)
    if owner is None:
        return
    _log.error(
        _console_safe(
            _busy_port_message(VITE_PORT, owner) + ". This is NOT WoWSP's dev server — "
            "Tauri would load that foreign app into the WoWSP window. Stop it, or move that "
            "project to its own dev port, then rerun `just dev`."
        ),
        module="vite",
    )
    raise SystemExit(1)


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
    finally:
        # Ctrl-C during the wait must not leave cargo/Vite behind.
        stop_event.set()
        if proc is not None:
            _terminate(proc)
    return 0


def run_mock(args: argparse.Namespace) -> int:
    procs: list[subprocess.Popen] = []
    try:
        start_mock(procs)
        start_vite(procs, extra_env={"WOWSP_MOCK_URL": f"http://localhost:{MOCK_PORT}"})
        _log.info("WoWSP dev (mock) running — Ctrl-C to stop.", module="ready")
        for p in procs:
            _wait_proc(p)
    except KeyboardInterrupt:
        _log.info("shutting down...", module="dev")
    finally:
        # A finally-return here would swallow the port guard's SystemExit(1).
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
            _wait_proc(procs[0])
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
        _wait_proc(procs[-1])
        return procs[-1].returncode or 0
    except KeyboardInterrupt:
        _log.info("shutting down...", module="dev")
        return 0
    finally:
        # Every exit path (Ctrl-C in the webui branch above, a subprocess
        # failure, any exception between spawn and join) tree-kills the
        # children; atexit/signal hooks cover the paths that skip this frame.
        for proc in procs:
            _terminate(proc)


def main() -> int:
    # Cleanup must exist BEFORE the first spawn: Ctrl-C (or any exception)
    # between spawn and an explicit join used to orphan Vite on :5199.
    _install_exit_hooks()
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
