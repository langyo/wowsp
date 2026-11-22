"""Tests for `scripts/dev.py`'s child-tree cleanup and port guard.

Run standalone (not part of the visual/e2e suites):

    python -m pytest scripts/test_dev.py -q

Covers the two regressions behind the maintainer's every-other-`just dev`:

* an orphaned Vite on :5199 (run N left its child alive; run N+1's guard refused)
  — the process-level tests spawn a REAL child tree (wrapper → port-holding
  grandchild) and assert the tree kill frees the port;
* the guard's mojibake on CJK paths — the PowerShell command must force UTF-8
  console output, and the error line must carry a copy-pasteable kill command.

MANUAL CHECK (OS-level Ctrl-C delivery, not simulated here because sending
CTRL_C_EVENT to a console process group would also interrupt the test runner):
run `just dev webui` in a terminal whose codepage is 936 (the maintainer's
console), press Ctrl-C once, then confirm the child really died:

    netstat -ano | findstr :5199      # must print nothing
    python scripts/dev.py webui       # must pass the guard immediately

and repeat run→Ctrl-C three times; none may report "something is already
listening on :5199".
"""

from __future__ import annotations

import atexit
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import types

import pytest

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


# ── pure helpers: kill command + mojibake fix ─────────────────────────

def test_kill_command_matches_platform() -> None:
    if os.name == "nt":
        assert dev._kill_command("44060") == "taskkill /PID 44060 /T /F"
    else:
        assert dev._kill_command("44060") == "kill -TERM 44060"


def test_describe_pid_command_forces_utf8_console_output() -> None:
    argv = dev._describe_pid_command("44060")
    assert argv[:2] == ["powershell", "-NoProfile"]
    assert argv[-2] == "-Command"
    command = argv[-1]
    assert command.startswith("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ")
    assert "ProcessId=44060" in command
    # The prefix must end with '; ' so it cannot glue onto the expression.
    assert dev._PS_UTF8_PREFIX.endswith("; ")


def test_busy_port_message_names_pid_and_copy_pasteable_command() -> None:
    owner = dev._PortOwner("44060", ", node.exe vite")
    message = dev._busy_port_message(dev.VITE_PORT, owner)
    assert "something is already listening on :5199" in message
    assert "(pid 44060, node.exe vite)" in message
    assert dev._kill_command("44060") in message


def test_busy_port_message_falls_back_to_netstat_without_pid() -> None:
    message = dev._busy_port_message(dev.VITE_PORT, dev._PortOwner(None, ""))
    assert "something is already listening on :5199" in message
    assert "netstat -ano | findstr :5199" in message
    assert "taskkill" not in message


def test_guard_error_exits_with_kill_command(monkeypatch) -> None:
    log = _RecordingLog()
    monkeypatch.setattr(dev, "_log", log)
    monkeypatch.setattr(
        dev, "_port_occupied_by", lambda port: dev._PortOwner("44060", ", node.exe vite")
    )
    with pytest.raises(SystemExit) as excinfo:
        dev._require_vite_port_free()
    assert excinfo.value.code == 1
    assert log.messages, "the guard must log before exiting"
    line = log.messages[-1]
    assert dev._kill_command("44060") in line
    assert "NOT WoWSP's dev server" in line


def test_describe_pid_ignores_tasklist_info_line(monkeypatch) -> None:
    """A dead pid must yield an empty identity: the CIM query comes back empty
    and tasklist's "INFO: No tasks..." line is not an identity."""
    if os.name != "nt":
        pytest.skip("the tasklist fallback is Windows-only")

    calls: list[list[str]] = []

    class _Result:
        def __init__(self, stdout: str) -> None:
            self.stdout = stdout

    def fake_run(argv, **kwargs):
        calls.append(argv)
        if argv[0] == "powershell":
            return _Result("")
        return _Result("INFO: No tasks are running which match the specified criteria.\n")

    monkeypatch.setattr(dev.subprocess, "run", fake_run)
    assert dev._describe_pid("999999") == ""
    assert [argv[0] for argv in calls] == ["powershell", "tasklist"]


def test_console_safe_preserves_cjk_on_gbk_console(monkeypatch) -> None:
    # The reporter's console is GBK: a CJK command line must survive it intact.
    monkeypatch.setattr(dev, "_log", _RecordingLog(encoding="gbk"))
    text = "D:/源代码/工程项目/个人站点/wowsp"
    assert dev._console_safe(text) == text


def test_console_safe_replaces_unencodable_characters(monkeypatch) -> None:
    monkeypatch.setattr(dev, "_log", _RecordingLog(encoding="ascii"))
    assert dev._console_safe("源") == "?"


# ── process-level: the real tree kill ────────────────────────────────

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


def test_sigint_handler_tree_kills_port_holder(tmp_path) -> None:
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
        assert proc.pid in dev._LIVE_CHILDREN, "spawned children must be tracked for exit cleanup"
        assert _wait_until(lambda: _port_open(port)), "grandchild never bound the port"
        assert proc.poll() is None

        with pytest.raises(KeyboardInterrupt):
            dev._on_signal(signal.SIGINT, None)

        assert _wait_until(lambda: not _port_open(port)), "SIGINT path left an orphan on the port"
        assert _wait_until(lambda: proc.poll() is not None), "SIGINT path left the direct child alive"
        assert proc.pid not in dev._LIVE_CHILDREN
    finally:
        # Tree-kill, not proc.kill(): a failed assertion must not leave the
        # 300 s port holder running.
        dev._terminate(proc)
        dev._cleanup_children()


def test_cleanup_children_is_idempotent(tmp_path) -> None:
    sleeper = tmp_path / "sleeper.py"
    sleeper.write_text("import time; time.sleep(300)\n", encoding="utf-8")
    proc = dev._run([_q(sys.executable), _q(sleeper)])
    try:
        assert proc.poll() is None
        dev._cleanup_children()
        dev._cleanup_children()  # second call (atexit after signal) must be a no-op
        assert _wait_until(lambda: proc.poll() is not None), "cleanup did not kill the long sleep"
        assert not dev._LIVE_CHILDREN
    finally:
        dev._terminate(proc)
        dev._cleanup_children()


def test_wait_proc_returns_exit_code(tmp_path) -> None:
    script = tmp_path / "exit3.py"
    script.write_text("raise SystemExit(3)\n", encoding="utf-8")
    proc = dev._run([_q(sys.executable), _q(script)])
    try:
        assert dev._wait_proc(proc) == 3
    finally:
        dev._terminate(proc)


def _raise_keyboard_interrupt(signum, frame) -> None:
    raise KeyboardInterrupt


def test_wait_proc_dispatches_signal_while_child_alive(tmp_path) -> None:
    """The poll loop is what lets a signal handler tree-kill a child that
    ignores Ctrl+C; a blocking Popen.wait() would only run the handler after
    the child exits."""
    sleeper = tmp_path / "waitsleeper.py"
    sleeper.write_text("import time; time.sleep(300)\n", encoding="utf-8")
    proc = dev._run([_q(sys.executable), _q(sleeper)])
    previous = signal.signal(signal.SIGINT, _raise_keyboard_interrupt)
    timer = threading.Timer(1.0, signal.raise_signal, args=(signal.SIGINT,))
    timer.start()
    try:
        started = time.monotonic()
        with pytest.raises(KeyboardInterrupt):
            dev._wait_proc(proc)
        assert time.monotonic() - started < 5.0, "the wait must not block until the child exits"
        assert proc.poll() is None, "the handler must run while the child is still alive"
    finally:
        timer.cancel()
        timer.join()
        signal.signal(signal.SIGINT, previous)
        dev._terminate(proc)


def test_install_exit_hooks_is_idempotent(monkeypatch) -> None:
    saved = {}
    for name in ("SIGINT", "SIGBREAK", "SIGTERM", "SIGHUP"):
        sig = getattr(signal, name, None)
        if sig is not None:
            saved[sig] = signal.getsignal(sig)
    monkeypatch.setattr(dev, "_EXIT_HOOKS_INSTALLED", False)
    try:
        dev._install_exit_hooks()
        dev._install_exit_hooks()  # must not raise or double-register
        for sig in saved:
            assert signal.getsignal(sig) is dev._on_signal
    finally:
        for sig, handler in saved.items():
            signal.signal(sig, handler)
        atexit.unregister(dev._cleanup_children)
