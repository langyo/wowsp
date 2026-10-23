"""Pytest fixtures for WoWSP e2e tests.

Adapted from shittim-chest's `scripts/e2e/conftest.py`. Spins up the FastAPI
mock backend on a free port, then hands a Playwright `page` (pointed at the Vite
dev server) to tests.
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "scripts" / "utils"))
from ports import find_free_port, wait_for_port  # noqa: E402


class _Server:
    def __init__(self, proc: subprocess.Popen, port: int) -> None:
        self.proc = proc
        self.port = port

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


@pytest.fixture(scope="session")
def mock_port() -> int:
    port = find_free_port()
    mock_dir = ROOT / "scripts" / "mock"
    venv_py = mock_dir / ".venv" / ("Scripts" if os.name == "nt" else "bin") / "python"
    py = str(venv_py) if venv_py.is_file() else sys.executable
    env = {**os.environ, "WOWSP_MOCK_PORT": str(port), "PYTHONPATH": str(mock_dir / "src")}
    proc = subprocess.Popen(
        [py, "-m", "uvicorn", "main:app", "--port", str(port)],
        cwd=str(mock_dir),
        env=env,
    )
    if not wait_for_port("127.0.0.1", port, timeout=30):
        proc.terminate()
        pytest.fail(f"mock backend failed to bind :{port}")
    yield port
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture(scope="session")
def mock_url(mock_port: int) -> str:
    return f"http://127.0.0.1:{mock_port}"


@pytest.fixture(scope="session")
def vite_base_url(mock_url: str) -> str:
    """The webui dev server root. An externally-started server wins
    (VITE_URL, mirroring the mock's env override); otherwise this spawns
    `pnpm --filter @wowsp/webui dev` on a free port with /api proxied at
    the session's mock (vite.config.ts reads WOWSP_MOCK_URL), so the e2e
    suite is self-contained: one pytest command boots mock + webui."""
    import os

    if os.environ.get("VITE_URL"):
        return os.environ["VITE_URL"].rstrip("/")

    from ports import find_free_port, wait_for_port

    import shutil

    pnpm = shutil.which("pnpm")
    if not pnpm:
        pytest.fail("pnpm not on PATH — run pnpm install at the repo root first")
    port = find_free_port()
    env = {
        **os.environ,
        "WOWSP_MOCK_URL": mock_url,
    }
    proc = subprocess.Popen(
        # exec (not `dev --`): pnpm forwards a literal "--" to vite, which
        # then swallows the port flags and lands on its default port.
        # --host 127.0.0.1: vite's default "localhost" may bind ::1 only,
        # which the IPv4 port probe below never sees.
        [
            pnpm,
            "--filter",
            "@wowsp/webui",
            "exec",
            "vite",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--strictPort",
        ],
        cwd=str(ROOT),
        env=env,
    )
    if not wait_for_port("127.0.0.1", port, timeout=60):
        _kill_tree(proc)
        pytest.fail(f"vite dev server failed to bind :{port}")
    yield f"http://127.0.0.1:{port}"
    _kill_tree(proc)


def _kill_tree(proc: subprocess.Popen) -> None:
    """Terminate a spawned server AND its children — pnpm wraps node,
    which wraps vite; a bare terminate() orphans the vite child."""
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    if os.name == "nt":
        # /T walks the (possibly orphaned) child tree, /F is required for
        # node processes that swallow console controls.
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            capture_output=True,
            check=False,
        )


@pytest.fixture(scope="session")
def browser():
    """One chromium per session (headless shell is installed with the
    playwright package; `python -m playwright install chromium` adds it
    on a fresh machine). Hand-rolled instead of the pytest-playwright
    plugin so the suite needs no extra dependency."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        chromium = pw.chromium.launch(headless=True)
        yield chromium
        chromium.close()


@pytest.fixture(scope="session", autouse=True)
def _warm_dev_server(browser, vite_base_url):
    """Pay the dev server's cold module transform ONCE per session: the
    first page load transforms hundreds of /src modules and can outrun a
    single test's timeout budget. After this, every test context loads
    warm. Failures here fail the session loudly (the app does not boot
    against the mock at all)."""
    from playwright.sync_api import expect

    context = browser.new_context()
    page = context.new_page()
    page.add_init_script(
        """
        window.localStorage.setItem('wowsp-ui-locale', 'en-US');
        window.localStorage.setItem('wowsp-onboarding-completed', '1');
        """
    )
    try:
        page.goto(vite_base_url, wait_until="domcontentloaded", timeout=90_000)
        expect(page.locator("nav.sidebar__nav")).to_be_visible(timeout=90_000)
    finally:
        context.close()


@pytest.fixture
def page(browser, vite_base_url):
    """One fresh context/page per test — isolation without the session
    paying a browser launch per case. Navigated to the app root with the
    UI locale pinned to en-US (the i18n bootstrap reads
    `wowsp-ui-locale` from localStorage before OS prefs), so label
    assertions are machine-independent."""
    from playwright.sync_api import expect

    context = browser.new_context()
    page = context.new_page()
    page.add_init_script(
        # Deterministic locale + the onboarding wizard dismissed: a fresh
        # profile boots into a four-step modal that covers the sidebar.
        """
        window.localStorage.setItem('wowsp-ui-locale', 'en-US');
        window.localStorage.setItem('wowsp-onboarding-completed', '1');
        """
    )
    # domcontentloaded, not the default "load": the dev server transforms
    # hundreds of modules on first hit, which can outlast the 30s load
    # event; the nav-visibility expect below is the real boot bar.
    page.goto(vite_base_url, wait_until="domcontentloaded")
    # The shell mounts async (router + i18n preload): the sidebar nav is
    # the boot-complete marker every test below builds on.
    expect(page.locator("nav.sidebar__nav")).to_be_visible(timeout=30_000)
    yield page
    context.close()
