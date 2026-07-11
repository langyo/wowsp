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
