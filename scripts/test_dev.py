"""Tests for `scripts/dev.py`'s port-guard policy and its devguard wiring.

Run standalone (not part of the visual/e2e suites):

    python -m pytest scripts/test_dev.py -q

The MECHANISM these tests used to cover in place now lives in
`celestia_devtools.devguard` — the shared module promoted from this repository's
#2095 fix — and is tested there (`celestia-devtools/tests/test_devguard.py`) on
both of the org's runner families. What stays here is the half that is
WoWSP's own policy: the :5199 sentence, the console-safe logging path, the
wiring that makes the guard name the offender, and two adoption tests proving
the shared track/tree-kill/poll path really drives a Vite-shaped child tree
spawned by this script.

MANUAL CHECK (OS-level Ctrl-C delivery, not simulated here because sending
CTRL_C_EVENT to a console process group would also interrupt the test runner):
run `just dev webui` in a terminal whose codepage is 936 (the maintainer's
console), press Ctrl-C once, then confirm the child really died:

    netstat -ano | findstr :5199      # must print nothing
    python scripts/dev.py webui       # must pass the guard immediately

and repeat run -> Ctrl-C three times; none may report "something is already
listening on :5199".
"""

from __future__ import annotations

import os
import signal
import socket
import sys
import time
import types
from pathlib import Path

import pytest

try:
    from celestia_devtools import devguard
except ImportError:  # pragma: no cover - environment bootstrap
    pytest.skip(
        "scripts/dev.py needs celestia-devtools with the shared devguard module: "
        "pip install -U git+https://github.com/celestia-island/celestia-devtools.git",
        allow_module_level=True,
    )

import dev


# ── helpers ───────────────────────────────────────────────────────────

def _q(value: str | os.PathLike) -> str:
    """Quote one argv element: dev._run joins argv with spaces (shell=True),
    so a path such as "C:\\Program Files\\...\\python.exe" needs quoting."""
    text = str(value)
    return f'"{text}"' if " " in text else text


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _wait_until(predicate, timeout: float = 20.0, interval: float = 0.1) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


class _RecordingLog:
    """Stand-in for scripts/utils/logger.py so the guard's output is assertable
    without depending on pytest's stream capture (the module logger binds its
    stream at import time)."""

    def __init__(self, encoding: str = "utf-8") -> None:
        self.messages: list[str] = []
        self._default = types.SimpleNamespace(
            stream=types.SimpleNamespace(encoding=encoding)
        )

    def error(self, msg: str, module: str | None = None) -> None:
        self.messages.append(msg)

    def info(self, msg: str, module: str | None = None) -> None:  # pragma: no cover
        self.messages.append(msg)

    def warn(self, msg: str, module: str | None = None) -> None:  # pragma: no cover
        self.messages.append(msg)

    def ok(self, msg: str, module: str | None = None) -> None:  # pragma: no cover
        self.messages.append(msg)


# ── policy: the :5199 guard's wording and exit ────────────────────────

def test_guard_refusal_names_pid_and_copy_pasteable_command(monkeypatch) -> None:
    log = _RecordingLog()
    monkeypatch.setattr(dev, "_log", log)
    monkeypatch.setattr(
        dev, "_port_occupied_by", lambda port: devguard.PortOwner("44060", ", node.exe vite")
    )
    with pytest.raises(SystemExit) as excinfo:
        dev._require_vite_port_free()
    assert excinfo.value.code == 1
    assert log.messages, "the guard must log before exiting"
    line = log.messages[-1]
    assert ":5199" in line
    assert devguard.kill_command("44060") in line
    assert "NOT WoWSP's dev server" in line
    assert "Tauri would load that foreign app" in line


def test_guard_passes_when_the_port_is_free(monkeypatch) -> None:
    monkeypatch.setattr(dev, "_port_occupied_by", lambda port: None)
    dev._require_vite_port_free()  # must not raise


# ── policy wiring: the guard names the offender through shared attribution ──

def test_port_occupied_by_names_the_listener(monkeypatch) -> None:
    monkeypatch.setattr(devguard, "port_in_use", lambda port: True)
    monkeypatch.setattr(devguard, "port_listener_pid", lambda port: "44060")
    monkeypatch.setattr(devguard, "describe_pid", lambda pid: "node.exe vite")
    assert dev._port_occupied_by(dev.VITE_PORT) == devguard.PortOwner("44060", ", node.exe vite")


def test_port_occupied_by_reports_a_free_port(monkeypatch) -> None:
    monkeypatch.setattr(devguard, "port_in_use", lambda port: False)
    assert dev._port_occupied_by(dev.VITE_PORT) is None


def test_port_occupied_by_without_attribution(monkeypatch) -> None:
    # A listener the lookup cannot attribute still refuses; the message then
    # falls back to the lookup command instead of inventing a pid.
    monkeypatch.setattr(devguard, "port_in_use", lambda port: True)
    monkeypatch.setattr(devguard, "port_listener_pid", lambda port: None)
    assert dev._port_occupied_by(dev.VITE_PORT) == devguard.PortOwner(None, "")


def test_describe_pid_wraps_the_shared_identity(monkeypatch) -> None:
    monkeypatch.setattr(devguard, "describe_pid", lambda pid: "node.exe vite")
    assert dev._describe_pid("44060") == ", node.exe vite"
    monkeypatch.setattr(devguard, "describe_pid", lambda pid: "")
    assert dev._describe_pid("44060") == ""


def test_console_safe_preserves_cjk_on_gbk_console(monkeypatch) -> None:
    # The reporter's console is GBK: a CJK command line must survive it intact.
    monkeypatch.setattr(dev, "_log", _RecordingLog(encoding="gbk"))
    text = "D:/源代码/工程项目/个人站点/wowsp"
    assert dev._console_safe(text) == text


def test_console_safe_replaces_unencodable_characters(monkeypatch) -> None:
    monkeypatch.setattr(dev, "_log", _RecordingLog(encoding="ascii"))
    assert dev._console_safe("源") == "?"


# ── the adoption: dev.py drives the shared track/kill/poll path ───────

_HOLDER = """\
import socket, sys, time

port = int(sys.argv[1])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port))
s.listen(1)
print("bound", flush=True)
time.sleep(300)
"""

_WRAPPER = """\
import subprocess, sys, time

child = subprocess.Popen([sys.executable, sys.argv[1], sys.argv[2]])
print(child.pid, flush=True)
time.sleep(300)
"""


def test_run_tracks_the_tree_and_the_sigint_path_frees_the_port(tmp_path) -> None:
    """The regression: a wrapper spawns a grandchild that holds the port; the
    SIGINT path must tree-kill BOTH and free the port (an orphan here is the
    every-other-run :5199 block)."""
    holder = tmp_path / "holder.py"
    holder.write_text(_HOLDER, encoding="utf-8")
    wrapper = tmp_path / "wrapper.py"
    wrapper.write_text(_WRAPPER, encoding="utf-8")
    port = _free_port()

    proc = dev._run([_q(sys.executable), _q(wrapper), _q(holder), str(port)])
    try:
        assert proc.pid in devguard.tracked(), "spawned children must be tracked for exit cleanup"
        assert _wait_until(lambda: _port_open(port)), "grandchild never bound the port"
        assert proc.poll() is None

        with pytest.raises(KeyboardInterrupt):
            devguard._on_signal(signal.SIGINT, None)

        assert _wait_until(lambda: not _port_open(port)), "SIGINT path left an orphan on the port"
        assert _wait_until(lambda: proc.poll() is not None), "SIGINT path left the direct child alive"
        assert proc.pid not in devguard.tracked()
    finally:
        # Tree-kill, not proc.kill(): a failed assertion must not leave the
        # 300 s port holder running.
        devguard.tree_kill(proc.pid)
        devguard.cleanup_children()


def test_run_pairs_with_the_shared_poll_loop(tmp_path) -> None:
    script = tmp_path / "exit3.py"
    script.write_text("raise SystemExit(3)\n", encoding="utf-8")
    proc = dev._run([_q(sys.executable), _q(script)])
    try:
        assert devguard.wait_poll(proc) == 3
    finally:
        devguard.tree_kill(proc.pid)


def test_main_installs_the_shared_exit_hooks(monkeypatch) -> None:
    installed: list = []
    monkeypatch.setattr(devguard, "install_exit_hooks", lambda notify=None: installed.append(notify))
    monkeypatch.setattr(dev, "run_native", lambda args: 0)
    assert dev.main() == 0
    assert installed == [dev._notify_signal], "main() must install devguard's hooks with this repo's logger"


def test_dev_py_keeps_no_private_child_registry() -> None:
    """The duplication the promotion removed must not creep back: a local
    registry/tree-kill/port-guard copy would silently diverge from the shared
    module again."""
    source = Path(dev.__file__).read_text(encoding="utf-8")
    for gone in ("_LIVE_CHILDREN", "def _track_child", "def _terminate(", "def _install_exit_hooks", "def _busy_port_message", "_PS_UTF8_PREFIX"):
        assert gone not in source, f"{gone} should live in celestia_devtools.devguard now"
