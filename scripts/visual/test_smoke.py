"""Visual smoke test — drives the running WoWSP app and captures screenshots.

This is the Python replacement for the old frontend-bundled autoTest.ts. The
test flow lives entirely outside the production frontend bundle; it talks to
the dev-only HTTP control server (gated behind the `test-harness` cargo
feature) via WowspDriver.

Prerequisites:
    1. Build the app with the test harness:
           cargo tauri dev --features test-harness
       (or: just test-visual, which does this for you)
    2. The control server writes its port to %APPDATA%/WoWSP/test-harness-port;
       the driver reads it automatically.
    3. Run:
           python -m pytest scripts/visual/test_smoke.py -m visual

The test captures 15 screenshots covering all 5 routes + lookup search + ship
detail 4 tabs + about modal + theme/wallpaper toggles. Verification is visual
(open the PNGs); assertions are on file existence/non-empty size.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from driver import WowspDriver

pytestmark = pytest.mark.visual

# WG API calls can take several seconds; encyclopedia load even longer on
# first run. These waits match the old TS harness.
SETTLE = 2.5
PAGE_LOAD = 2.0
WG_API = 6.0
MODAL_OPEN = 2.0
THEME_TRANSITION = 1.5


@pytest.fixture(scope="module")
def driver():
    """Connect to the running test-harness app. Fails fast if not running."""
    d = WowspDriver.connect(timeout=60.0)
    yield d


def _assert_capture(path: Path, name: str) -> None:
    """Assert the screenshot was saved and is non-trivially sized."""
    assert path.exists(), f"screenshot {name} not saved at {path}"
    size = path.stat().st_size
    assert size > 5000, f"screenshot {name} too small ({size} bytes) — blank capture?"


# ── Phase 1: static page captures (all 5 routes) ─────────────────────────


def test_phase1_static_routes(driver: WowspDriver):
    """Capture all 5 main routes after the app settles."""
    driver.sleep(SETTLE)  # let theme + sidebar settle
    routes = [
        ("01-dashboard", "/"),
        ("02-lookup", "/lookup"),
        ("03-ships", "/ships"),
        ("04-replay", "/replay"),
        ("05-settings", "/settings"),
    ]
    for name, path in routes:
        driver.goto(path)
        driver.sleep(PAGE_LOAD)
        _assert_capture(driver.capture(name), name)


# ── Phase 2: lookup search → StatsCard ───────────────────────────────────


def test_phase2_lookup_search(driver: WowspDriver):
    """Type a nickname, click search, capture the result."""
    driver.goto("/lookup")
    driver.sleep(1.5)
    _assert_capture(driver.capture("06-lookup-empty"), "06-lookup-empty")

    # Type a known public nickname. Use the input field + search button.
    driver.set_input(".lookup-view__input", "iKan")
    driver.sleep(0.5)
    # Click the search button (SButton renders a <button>).
    driver.click(".lookup-view__search button, .s-btn")
    driver.sleep(WG_API)  # WG API call takes 2-5 seconds
    _assert_capture(driver.capture("07-lookup-search-result"), "07-lookup-search-result")


# ── Phase 3: ship card → detail modal 4 tabs ─────────────────────────────


def test_phase3_ship_detail_tabs(driver: WowspDriver):
    """Click first ship card, switch through 4 tabs, capture each."""
    driver.goto("/ships")
    driver.sleep(3.0)  # encyclopedia may still be loading
    _assert_capture(driver.capture("08-ships-loaded"), "08-ships-loaded")

    # Click first ship card → opens detail modal.
    driver.click(".ship-card")
    driver.sleep(MODAL_OPEN)
    _assert_capture(driver.capture("09-ship-detail-specs"), "09-ship-detail-specs")

    # Switch tabs: Armor → My Stats → Community → back to Specs.
    # The new SpecsPanel (player-friendly grouped specs) is the key thing to
    # verify visually here.
    tabs = ["10-ship-detail-armor", "11-ship-detail-mystats", "12-ship-detail-community"]
    for i, name in enumerate(tabs, start=1):
        driver.click(".ship-detail__tab", index=i)
        driver.sleep(1.5)
        _assert_capture(driver.capture(name), name)

    # Back to Specs tab.
    driver.click(".ship-detail__tab", index=0)
    driver.sleep(0.5)

    # Close modal.
    driver.click(".s-modal__close")
    driver.sleep(0.8)


# ── Phase 4: Settings → About modal ──────────────────────────────────────


def test_phase4_about_modal(driver: WowspDriver):
    """Open the About modal and capture it."""
    driver.goto("/settings")
    driver.sleep(1.5)
    driver.click(".settings-view__about-btn")
    driver.sleep(MODAL_OPEN)
    _assert_capture(driver.capture("13-about-modal"), "13-about-modal")

    # Close.
    driver.click(".s-modal__close")
    driver.sleep(0.8)


# ── Phase 5: theme mode toggle → dark ────────────────────────────────────


def test_phase5_theme_toggle(driver: WowspDriver):
    """Toggle to dark mode, capture, toggle back."""
    driver.sleep(0.5)
    driver.click(".settings-view__mode", index=1)  # Dark
    driver.sleep(THEME_TRANSITION)
    _assert_capture(driver.capture("14-settings-dark-mode"), "14-settings-dark-mode")

    # Switch back to auto.
    driver.click(".settings-view__mode", index=0)
    driver.sleep(1.0)


# ── Phase 6: wallpaper toggle ────────────────────────────────────────────


def test_phase6_wallpaper_toggle(driver: WowspDriver):
    """Toggle wallpaper to solid black, capture, toggle back."""
    driver.click(".settings-view__wallpaper", index=1)  # Solid black
    driver.sleep(THEME_TRANSITION)
    _assert_capture(driver.capture("15-settings-wallpaper-black"), "15-settings-wallpaper-black")

    # Back to auto.
    driver.click(".settings-view__wallpaper", index=0)
    driver.sleep(1.0)
