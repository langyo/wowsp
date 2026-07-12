"""WowspDriver — HTTP client for the WoWSP dev-only test control server.

Talks to the Rust control server (packages/app/tauri/src/test_harness.rs, gated
behind the `test-harness` cargo feature) to drive a running Tauri app from a
Python script. The driver never touches the webview's internals directly; it
POSTs JS to the control server, which eval()s it in the webview.

Lifecycle:
    1. `cargo tauri dev --features test-harness` starts the app + control server.
    2. The server binds 127.0.0.1:<port> and writes the port to
       %APPDATA%/WoWSP/test-harness-port.
    3. Python reads that file, constructs a WowspDriver, calls wait_ready().
    4. The test script calls goto/click/capture in sequence.

This module is test-only infrastructure and is never imported by the app.
"""
from __future__ import annotations

import json
import time
import urllib.request
import urllib.error
from pathlib import Path

DEFAULT_TIMEOUT = 30.0


def discover_port(timeout: float = DEFAULT_TIMEOUT) -> int:
    """Read the port the control server bound to.

    The Rust side writes %APPDATA%/WoWSP/test-harness-port after binding.
    Polls until the file appears (the app may still be starting).
    """
    port_file = _port_file()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            return int(port_file.read_text().strip())
        except (FileNotFoundError, ValueError):
            time.sleep(0.3)
    raise RuntimeError(
        f"test-harness port file not found at {port_file} within {timeout}s — "
        "is the app running with --features test-harness?"
    )


def _port_file() -> Path:
    import os

    base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return Path(base) / "WoWSP" / "test-harness-port"


class WowspDriver:
    """Drives a running WoWSP app via the dev-only HTTP control server."""

    def __init__(self, port: int | None = None, base_url: str | None = None):
        self.base_url = base_url or f"http://127.0.0.1:{port}"

    @classmethod
    def connect(cls, timeout: float = DEFAULT_TIMEOUT) -> "WowspDriver":
        """Discover the port and wait for the server to respond."""
        port = discover_port(timeout)
        driver = cls(port=port)
        driver.wait_ready(timeout)
        return driver

    # ── low-level HTTP ──────────────────────────────────────────────────

    def _post(self, path: str, payload: dict) -> dict:
        data = json.dumps(payload).encode()
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            body = e.read().decode()
            raise RuntimeError(f"POST {path} → {e.code}: {body}") from e

    def _get(self, path: str) -> dict:
        req = urllib.request.Request(f"{self.base_url}{path}", method="GET")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())

    # ── public API ──────────────────────────────────────────────────────

    def wait_ready(self, timeout: float = DEFAULT_TIMEOUT) -> None:
        """Poll GET /health until the control server responds."""
        deadline = time.monotonic() + timeout
        last_err = None
        while time.monotonic() < deadline:
            try:
                if self._get("/health").get("ok"):
                    return
            except Exception as e:  # noqa: BLE001 — connection refused while app boots
                last_err = e
            time.sleep(0.5)
        raise RuntimeError(f"control server not ready within {timeout}s: {last_err}")

    def eval(self, code: str) -> dict:
        """Eval arbitrary JS in the webview. Returns the server's response.

        Note: Tauri 2's win.eval() is fire-and-forget — it does NOT return the
        JS value. So this method only confirms the eval was dispatched, not its
        result. Existence/state assertions must be done visually via capture().
        """
        return self._post("/eval", {"code": code})

    def goto(self, path: str) -> None:
        """Navigate to a route by clicking the matching sidebar link.

        Uses DOM click() on the sidebar <a> rather than router.push() so the
        navigation exercises the same code path a real user does. Falls back to
        history.pushState if no matching link exists.
        """
        # Click the sidebar link whose href ends with the path. RouterLink
        # renders <a href> so this is reliable.
        self.eval(
            f"""
            (function() {{
                var links = document.querySelectorAll('.sidebar__link');
                for (var i = 0; i < links.length; i++) {{
                    var href = links[i].getAttribute('href') || '';
                    if (href === {json.dumps(path)} || href.endsWith({json.dumps(path)})) {{
                        links[i].click();
                        return;
                    }}
                }}
                // Fallback: direct history navigation.
                window.history.pushState({{}}, '', {json.dumps(path)});
                window.dispatchEvent(new PopStateEvent('popstate'));
            }})()
            """
        )

    def click(self, selector: str, index: int = 0) -> None:
        """Click the nth element matching a CSS selector."""
        self.eval(
            f"""
            (function() {{
                var els = document.querySelectorAll({json.dumps(selector)});
                if (els.length > {index}) els[{index}].click();
            }})()
            """
        )

    def set_input(self, selector: str, value: str) -> None:
        """Set an <input>'s value and dispatch the input event so Vue reacts."""
        self.eval(
            f"""
            (function() {{
                var el = document.querySelector({json.dumps(selector)});
                if (!el) return;
                el.focus();
                el.value = {json.dumps(value)};
                el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                el.dispatchEvent(new Event('change', {{ bubbles: true }}));
            }})()
            """
        )

    def capture(self, name: str, retries: int = 2) -> Path:
        """Screenshot the main window, saved as screenshots/<name>.png.

        Returns the absolute path of the saved PNG. The Rust side sanitises the
        name (alnum/dash/underscore only) and saves under
        %APPDATA%/WoWSP/screenshots/.

        Retries on failure (blank/too-small capture) — PrintWindow occasionally
        grabs a stale or partial surface if the window is mid-transition
        (e.g. right after a wallpaper toggle). A retry after a short wait
        reliably gets the full window.
        """
        last_path = None
        for attempt in range(retries + 1):
            resp = self._post("/capture", {"name": name})
            if not resp.get("path"):
                if attempt < retries:
                    time.sleep(1.0)
                    continue
                raise RuntimeError(f"capture '{name}' returned no path: {resp}")
            last_path = Path(resp["path"])
            # Detect a degenerate capture (blank/partial surface). PrintWindow
            # sometimes returns a tiny surface when the window is mid-transition.
            if last_path.exists() and last_path.stat().st_size > 5000:
                return last_path
            if attempt < retries:
                time.sleep(1.0)
                continue
        return last_path  # last attempt even if still small (caller can assert)

    @staticmethod
    def sleep(seconds: float) -> None:
        time.sleep(seconds)
