"""Batch-capture localized UI screenshots for docs/<lang>/screenshots.

Drives the running WoWSP app through the dev-only test control server
(same transport as test_smoke.py): switches the UI language via
localStorage + reload, navigates to each view (sidebar-link clicks where
possible, history navigation for query URLs), interacts where it helps
(opens a replay on the 3D map, URL-jumps a player lookup, selects a mod),
and captures the native window per (language, view).

Waiting is deterministic: /eval is fire-and-forget, so this script runs a
tiny local HTTP listener and evals in-page pollers that ping it once a
DOM readiness condition becomes true (see Signals.wait_for).

The raw PNGs land in %APPDATA%/WoWSP/screenshots/ (the Rust side decides);
this script then converts them to WebP under docs/<lang>/screenshots/.

Prerequisites:
    1. The app must be running with the test harness:
           cargo tauri dev --features test-harness      # == just dev test
    2. A game install with replays + a bound account (the real dev
       appdata) so the views render meaningful data.
    3. Pillow for the WebP conversion step (scripts/requirements.txt).

Usage (from the repo root):
    python scripts/visual/shoot_docs.py                     # everything
    python scripts/visual/shoot_docs.py --locales en-US ja-JP
    python scripts/visual/shoot_docs.py --skip-capture      # convert only
    python scripts/visual/shoot_docs.py --skip-convert      # capture only
"""
from __future__ import annotations

import argparse
import http.server
import json
import shutil
import socket
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from driver import WowspDriver  # noqa: E402

# ── capture plan ────────────────────────────────────────────────────────

# app UI locale → docs language folder it feeds.
LOCALES: dict[str, str] = {
    "en-US": "en",
    "zh-CN": "zh-CN",
    "zh-TW": "zh-TW",
    "ja-JP": "ja",
    "ko-KR": "ko",
    "ru-RU": "ru",
    "fr-FR": "fr",
    "es-ES": "es",
}

# (docs file stem, route, readiness DOM condition, readiness timeout s).
# The route may carry a query — query URLs navigate via goto_url() below
# (the sidebar links have no query). Timeouts are generous on purpose:
# cold loads after a locale reload genuinely take tens of seconds (Vite
# compiles the locale chunk, the WG API round-trips run ~6 s each).
VIEWS: list[tuple[str, str, str, float]] = [
    ("dashboard", "/", ".dashboard-view__content", 120.0),
    ("lookup", "/lookup?name=langyo&realm=asia", ".lookup-view__result", 110.0),
    # tech-tree is the default mode; .ship-card only exists in grid mode.
    ("ships", "/ships", ".tech-tree-v3:not(.tech-tree-v3--empty), .ship-card", 90.0),
    ("live", "/live", ".live-view", 20.0),
    ("replay", "/replay", ".replay-card", 90.0),
    ("tactics", "/tactics", ".tactics-view", 30.0),
    ("resources", "/resources", ".resources-view", 30.0),
    ("settings", "/settings?section=appearance", ".settings-page", 20.0),
]

# Fixed settle after the readiness condition fires (animations, lazy
# panels, charts drawing themselves).
POST_SETTLE = 2.0

# True once the Vue app has mounted (index.html dismisses #loading-screen).
MOUNTED = "document.querySelector('#loading-screen.hidden, .sidebar') !== null"


# ── readback channel ────────────────────────────────────────────────────


class Signals:
    """Tiny HTTP listener the webview pings — the only JS→Python channel.

    The control server's /eval never returns a value, so wait_for() evals
    an in-page poller that fetches this listener when its condition
    becomes true (or when its own attempt budget runs out).

    The listener answers on `localhost` (dual-stack) — the app's CSP
    allows connect-src http://localhost:* but NOT http://127.0.0.1:*.
    """

    def __init__(self) -> None:
        self._hits: dict[int, str] = {}
        self._cond = threading.Condition()
        self._token = 0
        hits, cond = self._hits, self._cond

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - http.server API
                kind = "hit" if self.path.startswith("/hit") else "miss"
                try:
                    token = int(self.path.split("k=")[1])
                except (IndexError, ValueError):
                    token = -1
                with cond:
                    hits[token] = kind
                    cond.notify_all()
                self.send_response(204)
                self.end_headers()

            def log_message(self, *args) -> None:  # silence the default spam
                pass

        class DualStackServer(http.server.ThreadingHTTPServer):
            address_family = socket.AF_INET6

            def server_bind(self) -> None:
                self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
                super().server_bind()

        srv = DualStackServer(("::", 0), Handler)
        self.port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()

    def wait_for(self, d: WowspDriver, cond_js: str, timeout: float, label: str) -> bool:
        """Eval an in-page poller for cond_js; True once it holds."""
        with self._cond:
            self._token += 1
            token = self._token
        attempts = int(timeout / 0.25)
        poller = (
            "(function(){var n=0;(function p(){"
            "try{if(" + cond_js + "){"
            f"fetch('http://localhost:{self.port}/hit?k={token}',{{mode:'no-cors'}});"
            # two closing braces: if-block and try-block
            "return;}}catch(e){}"
            f"if(++n>={attempts}){{fetch('http://localhost:{self.port}/miss?k={token}',"
            "{mode:'no-cors'});return;}"
            "setTimeout(p,250);"
            "})();})()"
        )
        d.eval(poller)
        deadline = time.monotonic() + timeout + 5.0
        with self._cond:
            while token not in self._hits:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not self._cond.wait(remaining):
                    print(f"   ?? {label}: no signal within {timeout:.0f}s (continuing)")
                    return False
            ok = self._hits[token] == "hit"
        if not ok:
            print(f"   ?? {label}: condition not met within {timeout:.0f}s (continuing)")
        return ok


# ── interactions ────────────────────────────────────────────────────────


def switch_locale(d: WowspDriver, sig: Signals, ui_locale: str) -> None:
    """Persist UI + data language, reload, wait until the app is back up."""
    d.eval(
        "(function() {"
        f"localStorage.setItem('wowsp-ui-locale', {json.dumps(ui_locale)});"
        f"localStorage.setItem('wowsp-data-language', {json.dumps(ui_locale)});"
        "localStorage.setItem('wowsp-onboarding-completed', 'true');"
        "location.reload();"
        "})()"
    )
    # The old page still has a .sidebar, so a poller eval'd immediately
    # would "hit" from the PRE-reload document and then die with it.
    # Wait out the unload so the poller lands on the fresh document
    # (whose #loading-screen only gains .hidden once the app mounts).
    time.sleep(4.0)
    # First load of each locale makes Vite compile its message chunks, so
    # the mount can genuinely take tens of seconds in dev mode.
    sig.wait_for(d, MOUNTED, timeout=150.0, label=f"{ui_locale} app mounted")


def goto_url(d: WowspDriver, url: str) -> None:
    """Navigate to a route WITH a query string via history + popstate.

    The sidebar links carry no query, so query URLs (e.g.
    /lookup?name=...&realm=...) drive vue-router's history mode directly.
    The target view must remount to read the query on mount, so callers
    must ensure the current route differs.
    """
    d.eval(
        f"(function() {{"
        f"window.history.pushState({{}}, '', {json.dumps(url)});"
        f"window.dispatchEvent(new PopStateEvent('popstate'));"
        f"}})()"
    )


def open_first_replay(d: WowspDriver) -> None:
    """Click the first replay card so the 3D holographic map starts rendering.

    Best-effort: if no card is present (empty replay list) the plain list
    view is captured instead.
    """
    d.eval(
        "(function() {"
        "var cards = document.querySelectorAll('.replay-card');"
        "if (cards.length) cards[0].click();"
        "})()"
    )
    time.sleep(9.0)  # replay parse + 3D scene + model load


def open_first_mod(d: WowspDriver) -> None:
    """Select the first mod row so the right-hand detail pane is populated."""
    d.eval(
        "(function() {"
        "var rows = document.querySelectorAll('.mod-row');"
        "if (rows.length) rows[0].click();"
        "})()"
    )
    time.sleep(2.0)


# Per-view extra interaction, run after readiness and before capture.
EXTRA: dict[str, object] = {
    "replay": open_first_replay,
    "resources": open_first_mod,
}


# ── main phases ─────────────────────────────────────────────────────────


def capture_best(d: WowspDriver, name: str, gap: float = 4.0) -> Path:
    """Capture twice and keep the larger PNG.

    A loading/boot screen is mostly flat colour and compresses far smaller
    than a populated view, so file size is a cheap "did it finish
    rendering" oracle — and the second shot also covers mid-transition
    captures (theme fades, popover animations).
    """
    first = d.capture(name)
    time.sleep(gap)
    second = d.capture(f"{name}__b")
    a = first.stat().st_size if first.exists() else 0
    b = second.stat().st_size if second.exists() else 0
    winner, loser = (second, first) if b > a else (first, second)
    if winner != first and first.exists():
        shutil.copyfile(second, first)
    if loser.exists() and loser != first:
        loser.unlink()
    return first


def capture_all(d: WowspDriver, locales: dict[str, str]) -> None:
    sig = Signals()
    for ui_locale, docs_lang in locales.items():
        print(f"== {ui_locale} → docs/{docs_lang}/screenshots", flush=True)
        switch_locale(d, sig, ui_locale)
        for stem, route, ready, timeout in VIEWS:
            if "?" in route:
                goto_url(d, route)
            else:
                d.goto(route)
            # `ready` entries are bare CSS selector lists (MOUNTED is a
            # full expression) — wrap them into a real JS condition.
            sig.wait_for(
                d,
                f'document.querySelector("{ready}") !== null',
                timeout=timeout,
                label=f"{docs_lang}/{stem} ready",
            )
            time.sleep(POST_SETTLE)
            extra = EXTRA.get(stem)
            if extra is not None:
                extra(d)
            path = capture_best(d, f"{docs_lang}_{stem}")
            size = path.stat().st_size if path.exists() else 0
            print(f"   {stem:<10} {path.name}  {size / 1024:.0f} KB", flush=True)


def raw_screenshot_dir() -> Path:
    import os

    base = os.environ.get("APPDATA") or str(Path.home())
    return Path(base) / "WoWSP" / "screenshots"


def convert_all(locales: dict[str, str], repo_root: Path) -> None:
    from PIL import Image

    raw_dir = raw_screenshot_dir()
    total = 0
    for docs_lang in locales.values():
        out_dir = repo_root / "docs" / docs_lang / "screenshots"
        out_dir.mkdir(parents=True, exist_ok=True)
        for stem, _, _, _ in VIEWS:
            src = raw_dir / f"{docs_lang}_{stem}.png"
            if not src.exists():
                print(f"   !! missing {src}", file=sys.stderr)
                continue
            dst = out_dir / f"{stem}.webp"
            with Image.open(src) as img:
                img.save(dst, "WEBP", quality=90, method=6)
            total += dst.stat().st_size
            print(f"   {dst.relative_to(repo_root)}  {dst.stat().st_size / 1024:.0f} KB")
    print(f"total webp: {total / 1024 / 1024:.1f} MB")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--locales", nargs="*", default=None,
                    help="subset of app locales to capture (default: all)")
    ap.add_argument("--skip-capture", action="store_true", help="only convert")
    ap.add_argument("--skip-convert", action="store_true", help="only capture")
    args = ap.parse_args()

    locales = LOCALES
    if args.locales:
        bad = [l for l in args.locales if l not in LOCALES]
        if bad:
            ap.error(f"unknown locales {bad}; known: {list(LOCALES)}")
        locales = {l: LOCALES[l] for l in args.locales}

    repo_root = Path(__file__).resolve().parents[2]

    if not args.skip_capture:
        d = WowspDriver.connect(timeout=120.0)
        capture_all(d, locales)
    if not args.skip_convert:
        convert_all(locales, repo_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
