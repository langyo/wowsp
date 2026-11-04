"""Batch-capture localized UI screenshots for docs/<lang>/screenshots.

Drives the running WoWSP app through the dev-only test control server
(same transport as test_smoke.py): switches the UI language AND the colour
mode via localStorage + reload, navigates to each view (sidebar-link clicks
where possible, history navigation for query URLs), interacts where it
helps (opens a replay on the 3D map, URL-jumps a player lookup, selects a
mod), and captures the native window per (language, theme, view).

Theme matrix: every view is captured twice — **light** (the docs default,
the plain `<stem>.webp` name the markdown references) and **dark**
(`<stem>.dark.webp`). The markdown then carries a pair of images with the
fragment convention GitHub and lagrange render (see the guides):
`#gh-light-mode-only` / `#gh-dark-mode-only`, so one file serves light and
dark readers without JavaScript.

Waiting is deterministic AND data-aware: /eval is fire-and-forget, so this
script runs a tiny local HTTP listener and evals in-page pollers that ping
it once a DOM readiness condition becomes true (see Signals.wait_for). The
conditions for the request-backed views require the DATA, not just the
shell — the dashboard waits for its per-ship section (fed by the WG API
round-trips; the cached cold-start frame alone is not enough), the player
lookup waits for a resolved career card WITH ship rows and no pending row,
the mod hub waits for catalog rows (a network fetch) before selecting one,
and the replay waits for the parsed 3D stage instead of a blind sleep. A
view that never fills in still falls back to a plain capture once the
timeout expires, and the log says so.

The raw PNGs land in %APPDATA%/WoWSP/screenshots/ (the Rust side decides);
this script then converts them to WebP under docs/<lang>/screenshots/.

Prerequisites:
    1. The app must be running with the test harness:
           cargo tauri dev --features test-harness      # == just dev test
       Its window should be the docs size — 1280x820 logical, which the
       capture reads as a 2560x1640 client-area bitmap at DPR 2.
    2. A game install with replays + a bound account (the real dev
       appdata) so the views render meaningful data.
    3. Pillow for the WebP conversion step (scripts/requirements.txt).

Usage (from the repo root):
    python scripts/visual/shoot_docs.py                     # everything
    python scripts/visual/shoot_docs.py --locales en-US ja-JP
    python scripts/visual/shoot_docs.py --themes light      # light only
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

# (theme-mode value persisted to `wowsp-theme-mode`, output filename suffix,
# human label). Light is the documentation default and keeps the plain
# `<stem>.webp` name — a doc that ships a single image references it and the
# dark variant stays optional. Dark lands beside it as `<stem>.dark.webp`.
THEMES: list[tuple[str, str, str]] = [
    ("light", "", "light"),
    ("dark", ".dark", "dark"),
]

# Per-view capture plans — every view gets its OWN way of getting there and
# its OWN recognition of "this page is up and its data landed". Generic keys:
#   route      sidebar-style navigation target (query URLs go through
#              goto_url(); absent when the view opens bespoke, see "open").
#   open       bespoke opener fn(d, sig, label) — for views a URL can't
#              reach (the desktop settings MODAL — the /settings route is
#              the phone-layout page).
#   ready      JS condition: the page is THE page we want, with its data.
#   extra      post-readiness interaction fn(d, sig, label) (open a replay,
#              pick a mod, switch the settings section...).
#   post_ready JS condition checked after `extra` (the interaction's own
#              result landed).
#   settle     extra seconds after post_ready (3D streaming etc.).
#   timeout    readiness budget (generous: cold locale loads compile Vite
#              chunks and the WG API round-trips run ~6 s each).
VIEWS: list[dict] = [
    # .dash-ship-table__row is the REAL data signal: the content shell, the
    # KPI card and the section wrappers all render (with an empty note)
    # before the WG round-trips land — a shell-only condition matches a
    # "0 ships · 0 battles" frame. A table row only exists with loaded
    # ships, and the donut proves the distribution block drew.
    {
        "stem": "dashboard",
        "route": "/",
        "ready": "document.querySelector('.dashboard-view__content') !== null"
                 " && document.querySelector('.dash-ship-table__row') !== null"
                 " && document.querySelector('.dashboard-view__dist .hk-donut') !== null",
        "timeout": 180.0,
    },
    # The career card exists only after the request resolved, the pending
    # row must be gone, and a ship row proves the per-ship list rendered
    # from that result.
    {
        "stem": "lookup",
        "route": "/lookup?name=langyo&realm=asia",
        "ready": "document.querySelector('.lookup-view__result') !== null"
                 " && document.querySelector('.lookup-view__pending') === null"
                 " && document.querySelector('.lookup-view__shiplist .lookup-view__ship') !== null",
        "timeout": 150.0,
    },
    # tech-tree is the default mode; .ship-card only exists in grid mode.
    {
        "stem": "ships",
        "route": "/ships",
        "ready": "document.querySelector('.tech-tree-v3:not(.tech-tree-v3--empty), .ship-card') !== null",
        "timeout": 120.0,
    },
    # Docs show the STANDBY guide, so recognition requires it: a live
    # battle would render a roster instead (never ship that into docs).
    {
        "stem": "live",
        "route": "/live",
        "ready": "document.querySelector('.live-view') !== null"
                 " && document.querySelector('.live-idle-guide') !== null",
        "timeout": 60.0,
    },
    # .replay-card means the replay scan finished; the 3D stage is opened
    # (and awaited) by extra/post_ready below.
    {
        "stem": "replay",
        "route": "/replay",
        "ready": "document.querySelector('.replay-card') !== null",
        "extra": "open_first_replay",
        "post_ready": "document.querySelector('.replay-view__detail') !== null"
                      " && document.querySelector('.replay-view__results--loading') === null",
        "settle": 6.0,
        "timeout": 120.0,
    },
    # The tactics board's root is .tac-page (the old .tactics-view selector
    # never matched — the view only got captured after the timeout).
    {
        "stem": "tactics",
        "route": "/tactics",
        "ready": "document.querySelector('.tac-page') !== null"
                 " && document.querySelector('.tac-workspace__stage') !== null",
        "timeout": 90.0,
    },
    # The catalog is a network fetch; .mod-row means it arrived. The foot
    # interaction selects the first row; the detail pane's title proves the
    # pane populated.
    {
        "stem": "resources",
        "route": "/resources",
        "ready": "document.querySelector('.resources-view') !== null"
                 " && document.querySelector('.mod-row') !== null",
        "extra": "open_first_mod",
        "post_ready": "document.querySelector('.mod-detail__name') !== null",
        "settle": 1.5,
        "timeout": 120.0,
    },
    # DESKTOP settings is the MODAL opened by the title-bar gear (the
    # /settings route is the phone-layout page — capturing it on a desktop
    # window shows a phone surface embedded in the content column, which is
    # exactly the "why is settings not a second-level window" report). The
    # modal lands on the LAST section used, so extra clicks the Appearance
    # rail entry (data-section is the stable, unlocalized handle) and
    # post_ready proves that section is active with its theme cards drawn.
    # Kept LAST: the modal blocks the chrome, and the next session starts
    # with a reload anyway.
    {
        "stem": "settings",
        "open": "open_settings_modal",
        "ready": "(function(){var el=document.querySelector('.hk-modal-content.hk-settings-host');"
                 "if(!el)return false;"
                 "var s=getComputedStyle(el);"
                 "if(s.display==='none'||s.visibility==='hidden'||parseFloat(s.opacity)<0.5)return false;"
                 "var o=el.closest('.hk-modal-overlay');"
                 "if(o){var so=getComputedStyle(o);"
                 "if(so.display==='none'||parseFloat(so.opacity)<0.5)return false;}"
                 "return true;})()",
        "extra": "open_settings_appearance",
        "post_ready": "document.querySelector('.hk-settings__rail-item.is-active[data-section=\"appearance\"]') !== null"
                      " && document.querySelector('.settings-modal__themes') !== null",
        "settle": 1.5,
        "timeout": 60.0,
    },
]

# Fixed settle after the readiness condition fires (animations, lazy panels,
# charts drawing themselves).
POST_SETTLE = 2.0

# True once the Vue app has mounted (index.html dismisses #loading-screen).
MOUNTED = "document.querySelector('#loading-screen.hidden, .sidebar') !== null"

# True while no title-bar loading chip is up. The dashboard's WG round-trips
# and the lookup's search both surface there; a screenshot taken while one
# is visible would capture a half-loaded view.
LOADING_CLEAR = (
    "document.querySelector('.titlebar-loading-slot .hk-persistent-toast') === null"
)


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


# ── session switching ───────────────────────────────────────────────────


def switch_session(d: WowspDriver, sig: Signals, ui_locale: str, theme_mode: str) -> None:
    """Persist UI/data language + theme mode, reload, wait until the app is
    back up and painting the requested colour scheme."""
    d.eval(
        "(function() {"
        f"localStorage.setItem('wowsp-ui-locale', {json.dumps(ui_locale)});"
        f"localStorage.setItem('wowsp-data-language', {json.dumps(ui_locale)});"
        f"localStorage.setItem('wowsp-theme-mode', {json.dumps(theme_mode)});"
        # hikari's own key too: its pre-boot restore picks it up, and the
        # app's authoritative `wowsp-theme-mode` re-applies right after.
        f"localStorage.setItem('hikari-theme-mode', {json.dumps(theme_mode)});"
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
    # hikari paints the scheme onto <html data-mode>; requirable and cheap.
    sig.wait_for(
        d,
        "document.documentElement.getAttribute('data-mode') === "
        + json.dumps(theme_mode),
        timeout=30.0,
        label=f"{ui_locale}/{theme_mode} colour mode applied",
    )


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


def open_first_replay(d: WowspDriver, sig: Signals, label: str) -> None:
    """Click the first replay card; the view's post_ready waits for the
    parsed stage. Best-effort: with an empty list the plain list view is
    captured instead."""
    d.eval(
        "(function() {"
        "var cards = document.querySelectorAll('.replay-card');"
        "if (cards.length) cards[0].click();"
        "})()"
    )


def open_first_mod(d: WowspDriver, sig: Signals, label: str) -> None:
    """Select the first mod row; post_ready waits for the detail pane."""
    d.eval(
        "(function() {"
        "var rows = document.querySelectorAll('.mod-row');"
        "if (rows.length) rows[0].click();"
        "})()"
    )


def open_settings_modal(d: WowspDriver, sig: Signals, label: str) -> None:
    """Open the DESKTOP settings surface: the modal from the title-bar gear.

    The /settings route is the phone-layout page — on a desktop window it
    renders a phone surface embedded in the content column. Idempotent: an
    already-open modal is left alone (the retry path re-runs this)."""
    # The titlebar can mount AFTER the sidebar (the mount gate only checks
    # .sidebar) — poll for the gear in-page instead of clicking a ghost.
    d.eval(
        "(function() {"
        "var n = 0;"
        "(function p() {"
        "var b = document.querySelector('.hk-titlebar-actions .hk-titlebar-btn');"
        "if (b) { b.click(); return; }"
        "if (++n < 60) setTimeout(p, 150);"
        "})();"
        "})()"
    )


def open_settings_appearance(d: WowspDriver, sig: Signals, label: str) -> None:
    """Land the open modal on the Appearance section (data-section is the
    stable, unlocalized handle on the rail entry)."""
    d.eval(
        "(function() {"
        "var b = document.querySelector('.hk-settings__rail-item[data-section=\"appearance\"]');"
        "if (b) b.click();"
        "})()"
    )


# Readiness conditions that never held during a run — printed as a summary at
# the end so a weak screenshot (empty state captured after the timeout) is easy
# to spot instead of hiding among 128 good ones.
MISSED: list[str] = []


# ── naming ──────────────────────────────────────────────────────────────


def raw_stem(docs_lang: str, stem: str, theme_suffix: str) -> str:
    """PNG name the Rust capture endpoint saves (alnum/dash/underscore only,
    so the dark variant uses a plain `_dark` suffix, never a dot)."""
    return f"{docs_lang}_{stem}" + ("_dark" if theme_suffix else "")


def webp_name(stem: str, theme_suffix: str) -> str:
    """Sibling WebP name under docs/<lang>/screenshots."""
    return f"{stem}{theme_suffix}.webp"


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
    first_size = first.stat().st_size if first.exists() else 0
    second_size = second.stat().st_size if second.exists() else 0
    if second.exists() and second_size > first_size:
        shutil.move(str(second), str(first))
    elif second.exists():
        second.unlink()
    return first


EXTRA_FNS: dict[str, object] = {
    "open_first_replay": open_first_replay,
    "open_first_mod": open_first_mod,
    "open_settings_modal": open_settings_modal,
    "open_settings_appearance": open_settings_appearance,
}


def capture_view(d: WowspDriver, sig: Signals, docs_lang: str, view: dict,
                 theme_suffix: str) -> Path:
    stem = view["stem"]
    label = f"{docs_lang}/{stem}{theme_suffix or ''}"
    open_name = view.get("open")
    opener = EXTRA_FNS[open_name] if open_name else None

    def reach() -> None:
        if opener is not None:
            opener(d, sig, label)
        else:
            route = view["route"]
            if "?" in route:
                goto_url(d, route)
            else:
                d.goto(route)

    reach()
    cond = f"({view['ready']}) && ({MOUNTED}) && ({LOADING_CLEAR})"
    timeout = view.get("timeout", 120.0)
    ok = sig.wait_for(d, cond, timeout=timeout, label=f"{label} ready")
    if not ok:
        # One re-attempt: a cold chunk or a dropped API request should not
        # cost a whole locale its screenshot. Re-run the opener so the view
        # remounts and retries its own loads.
        reach()
        ok = sig.wait_for(
            d, cond, timeout=min(timeout, 120.0), label=f"{label} ready (retry)"
        )
        if not ok:
            MISSED.append(label)
    time.sleep(POST_SETTLE)
    extra_name = view.get("extra")
    if extra_name:
        EXTRA_FNS[extra_name](d, sig, label)
        post = view.get("post_ready")
        if post:
            ok2 = sig.wait_for(
                d,
                f"({post}) && ({LOADING_CLEAR})",
                timeout=90.0,
                label=f"{label} settled",
            )
            if not ok2:
                MISSED.append(f"{label} (post)")
    time.sleep(view.get("settle", 0.0))
    path = capture_best(d, raw_stem(docs_lang, stem, theme_suffix))
    size = path.stat().st_size if path.exists() else 0
    print(f"   {stem:<10}{theme_suffix or '':<6} {path.name}  {size / 1024:.0f} KB", flush=True)
    return path


def capture_all(d: WowspDriver, locales: dict[str, str],
                themes: list[tuple[str, str, str]],
                views: list[dict] | None = None) -> None:
    sig = Signals()
    views = views or VIEWS
    for ui_locale, docs_lang in locales.items():
        for theme_mode, theme_suffix, theme_label in themes:
            print(
                f"== {ui_locale} → docs/{docs_lang}/screenshots  [{theme_label}]",
                flush=True,
            )
            switch_session(d, sig, ui_locale, theme_mode)
            for view in views:
                capture_view(d, sig, docs_lang, view, theme_suffix)
    if MISSED:
        print(
            f"!! readiness missed for {len(MISSED)} capture(s): "
            + ", ".join(MISSED),
            flush=True,
        )


def raw_screenshot_dir() -> Path:
    import os

    base = os.environ.get("APPDATA") or str(Path.home())
    return Path(base) / "WoWSP" / "screenshots"


def convert_all(locales: dict[str, str], themes: list[tuple[str, str, str]],
                repo_root: Path,
                views: list[dict] | None = None) -> None:
    from PIL import Image
    views = views or VIEWS

    raw_dir = raw_screenshot_dir()
    total = 0
    for docs_lang in locales.values():
        out_dir = repo_root / "docs" / docs_lang / "screenshots"
        out_dir.mkdir(parents=True, exist_ok=True)
        for _, theme_suffix, _ in themes:
            for view in views:
                stem = view["stem"]
                src = raw_dir / f"{raw_stem(docs_lang, stem, theme_suffix)}.png"
                if not src.exists():
                    print(f"   !! missing {src}", file=sys.stderr)
                    continue
                dst = out_dir / webp_name(stem, theme_suffix)
                with Image.open(src) as img:
                    img.save(dst, "WEBP", quality=90, method=6)
                    size = img.size
                total += dst.stat().st_size
                print(
                    f"   {dst.relative_to(repo_root)}  {size[0]}x{size[1]}"
                    f"  {dst.stat().st_size / 1024:.0f} KB"
                )
    print(f"total webp: {total / 1024 / 1024:.1f} MB")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--locales", nargs="*", default=None,
                    help="subset of app locales to capture (default: all)")
    ap.add_argument("--themes", nargs="*", default=None, choices=["light", "dark"],
                    help="subset of colour modes to capture (default: both)")
    ap.add_argument("--views", nargs="*", default=None,
                    help="subset of view stems to capture (default: all)")  # noqa: OK
    ap.add_argument("--skip-capture", action="store_true", help="only convert")
    ap.add_argument("--skip-convert", action="store_true", help="only capture")
    args = ap.parse_args()

    locales = LOCALES
    if args.locales:
        bad = [l for l in args.locales if l not in LOCALES]
        if bad:
            ap.error(f"unknown locales {bad}; known: {list(LOCALES)}")
        locales = {l: LOCALES[l] for l in args.locales}

    views = VIEWS
    if args.views:
        known = [v["stem"] for v in VIEWS]
        bad = [v for v in args.views if v not in known]
        if bad:
            ap.error(f"unknown views {bad}; known: {known}")
        wanted = set(args.views)
        views = [v for v in VIEWS if v["stem"] in wanted]

    themes = THEMES
    if args.themes:
        wanted = set(args.themes)
        themes = [t for t in THEMES if t[0] in wanted]

    repo_root = Path(__file__).resolve().parents[2]

    if not args.skip_capture:
        d = WowspDriver.connect(timeout=120.0)
        capture_all(d, locales, themes, views)
    if not args.skip_convert:
        convert_all(locales, themes, repo_root, views)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
