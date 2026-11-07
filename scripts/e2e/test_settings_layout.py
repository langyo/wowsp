"""Content-fit desktop settings frame: the window hugs the active section's
cards instead of standing at hikari's constant 70vh-6.5rem frame.

Regression this guards (2026-11-08 report): the desktop settings window kept
the package's constant frame height whatever the section, so a short section
left a large dead band below its last card — the reported one was 玩家标记
(player markers), whose single card sat in a half-empty window, and the same
band showed in every short section ("类似的地方也要修"). The frame now sizes
itself from the active section's content and only CAPS at the old band: the
rail's "contain: size" stops the long nav list from driving the shell height,
and the body-inner "height: auto" override lets HkModal's size morph measure
the shrinking frame (whose old body-height pin otherwise fed HkModal's content
probe and froze the window).

Asserted here:
  * every non-scrolling section (the short half of the rail — language,
    account, crash, markers, closeBehavior, gamePath, network, pairing,
    chatTranslate, installCleanup, sharing) leaves at most a couple of
    pixels between the pane's bottom edge and the last laid-out card, keeps
    the shell under the cap, fits its content in the pane, and still
    scrolls the rail (every entry stays reachable at the smaller shell
    height);
  * a long section (appearance) keeps the capped shell, scrolls the pane,
    and never scrolls the modal body itself.

Runs against the FastAPI mock backend (the session fixtures boot mock + Vite);
no game client is ever involved (AGENTS.md §0).
"""
from __future__ import annotations

import re
import time

import pytest
from playwright.sync_api import Page, expect

VIEWPORT = {"width": 1440, "height": 900}
#: The shell cap the desktop host keeps — the old 70vh - 6.5rem frame band,
#: derived from the viewport so a viewport change cannot silently stale it.
SHELL_CAP_PX = VIEWPORT["height"] * 0.70 - 6.5 * 16.0
#: The shell now hugs the cards, so the only slack between the pane's bottom
#: edge and the last card is border/subpixel noise.
MAX_DEAD_BAND_PX = 2.0
#: Every section whose content fits the pane at the test viewport (the long,
#: pane-scrolling ones are covered by the capped-frame / shrink cases).
SHORT_SECTIONS = (
    "language",
    "account",
    "crash",
    "markers",
    "closeBehavior",
    "gamePath",
    "network",
    "pairing",
    "chatTranslate",
    "installCleanup",
    "sharing",
)
LONG_SECTION = "appearance"
#: HkModal's size morph settles on its own clock (150 ms resize debounce + a
#: 150 ms height transition), so one fixed wait after a section switch is a
#: race; a quiet window in the measurements is not.
SETTLE_SAMPLES = 6
SETTLE_INTERVAL_MS = 120

_ACTIVE_SECTION = re.compile(r"\bis-active\b")

MEASURE_JS = r"""
() => {
  const q = (s) => document.querySelector(s);
  const rect = (el) => (el ? el.getBoundingClientRect() : null);
  const frame = q(".hk-modal-content.hk-settings-host");
  const shell = frame ? frame.querySelector(".hk-settings") : null;
  const pane = shell ? shell.querySelector(".hk-settings__pane") : null;
  const viewport = pane
    ? pane.querySelector(":scope > .hk-scroll-container-viewport")
    : null;
  const rail = shell ? shell.querySelector(".hk-settings__rail") : null;
  const railViewport = rail
    ? rail.querySelector(":scope > .hk-scroll-container-viewport")
    : null;
  const bodyScroll = frame
    ? frame.querySelector(":scope > .hk-modal-body > .hk-modal-body-scroll")
    : null;

  // Last laid-out box under the pane's viewport. SectionBoundary renders a
  // display:contents host (no box of its own), so walk through those.
  let lastBottom = null;
  if (viewport) {
    const walk = (el) => {
      if (getComputedStyle(el).display === "contents") {
        for (const child of el.children) walk(child);
        return;
      }
      const r = el.getBoundingClientRect();
      if (r.height > 0 || r.width > 0) lastBottom = r.bottom;
    };
    for (const child of viewport.children) walk(child);
  }

  const frameRect = rect(frame);
  const shellRect = rect(shell);
  const paneRect = rect(pane);
  return {
    frameHeight: frameRect ? frameRect.height : null,
    shellHeight: shellRect ? shellRect.height : null,
    shellCap: shell ? parseFloat(getComputedStyle(shell).maxHeight) : null,
    paneBottom: paneRect ? paneRect.bottom : null,
    lastCardBottom: lastBottom,
    deadBand:
      paneRect && lastBottom !== null ? paneRect.bottom - lastBottom : null,
    paneScrollHeight: viewport ? viewport.scrollHeight : null,
    paneClientHeight: viewport ? viewport.clientHeight : null,
    bodyScrolls: bodyScroll
      ? bodyScroll.scrollHeight > bodyScroll.clientHeight + 1
      : null,
    railHeight: rail ? rail.getBoundingClientRect().height : null,
    railScrolls: railViewport
      ? railViewport.scrollHeight > railViewport.clientHeight + 1
      : null,
  };
}
"""


def _open_settings(page: Page, vite_base_url: str) -> None:
    """Open the app-singleton settings window through the sidebar footer's
    account button (its landing section is 账户 / account) and wait for the
    shell."""
    # The desktop modal host only exists at >= 768px width, so the viewport is
    # pinned above (the shared page fixture uses a generic one).
    page.set_viewport_size(VIEWPORT)
    page.goto(vite_base_url, wait_until="domcontentloaded", timeout=60_000)
    account_button = page.locator(".sidebar__footer-btn").filter(has_text="Account")
    expect(account_button).to_be_visible(timeout=30_000)
    account_button.click()
    expect(
        page.locator(".hk-modal-content.hk-settings-host .hk-settings"),
    ).to_be_visible(timeout=30_000)
    expect(
        page.locator('.hk-settings__rail-item[data-section="account"]'),
    ).to_have_class(_ACTIVE_SECTION)


def _settle(page: Page) -> dict:
    """Poll the frame until its height and the pane's content have stopped
    changing for SETTLE_SAMPLES consecutive samples, then return the settled
    measurement (see SETTLE_SAMPLES)."""
    previous = None
    stable = 0
    deadline = time.monotonic() + 15.0
    latest: dict = {}
    while time.monotonic() < deadline:
        latest = page.evaluate(MEASURE_JS)
        fingerprint = (
            latest["frameHeight"],
            latest["shellHeight"],
            latest["paneScrollHeight"],
            latest["paneClientHeight"],
        )
        if previous is not None and fingerprint == previous:
            stable += 1
            if stable >= SETTLE_SAMPLES:
                return latest
        else:
            stable = 0
        previous = fingerprint
        page.wait_for_timeout(SETTLE_INTERVAL_MS)
    raise AssertionError(f"settings frame never settled: {latest}")


def _show_section(page: Page, key: str) -> dict:
    """Switch the shell to one section and wait for its frame to settle."""
    item = page.locator(f'.hk-settings__rail-item[data-section="{key}"]')
    item.click()
    expect(item).to_have_class(_ACTIVE_SECTION)
    expect(
        page.locator(".hk-modal-content.hk-settings-host .hk-settings-group").first,
    ).to_be_visible(timeout=30_000)
    return _settle(page)


@pytest.mark.ui
def test_short_sections_hug_their_cards(page: Page, vite_base_url: str) -> None:
    """A short section's shell ends at its last card: no dead band below it,
    the shell stays under the old cap, the content fits the pane, and the rail
    keeps scrolling its entries (its height now follows the shell)."""
    _open_settings(page, vite_base_url)
    for key in SHORT_SECTIONS:
        metrics = _show_section(page, key)

        # Sanity: the cap is still the old frame band, only moved to
        # max-height.
        assert metrics["shellCap"] is not None, (key, metrics)
        assert abs(metrics["shellCap"] - SHELL_CAP_PX) <= 1.0, (key, metrics)

        # The bug: the pane's bottom edge stood far below the last card.
        assert metrics["deadBand"] is not None, (key, metrics)
        assert metrics["deadBand"] <= MAX_DEAD_BAND_PX, (key, metrics)
        # ...and the content must actually FIT (a "last card below the pane
        # edge" would make the band negative instead of small).
        assert metrics["paneScrollHeight"] <= metrics["paneClientHeight"] + 1, (
            key,
            metrics,
        )
        assert metrics["deadBand"] >= -1.0, (key, metrics)

        # The shell is content-sized, so it must sit below the cap it keeps.
        assert metrics["shellHeight"] < metrics["shellCap"] - 1.0, (key, metrics)

        # The rail no longer drives the shell height but is stretched to it,
        # and its own scroller keeps every entry reachable.
        assert abs(metrics["railHeight"] - metrics["shellHeight"]) <= 1.0, (
            key,
            metrics,
        )
        assert metrics["railScrolls"] is True, (key, metrics)


@pytest.mark.ui
def test_long_section_keeps_the_capped_frame(page: Page, vite_base_url: str) -> None:
    """A content-heavy section still caps at the old frame band, the pane is
    the only scroller, and the modal body itself never scrolls (HkModal's
    floating overlay bar stays idle)."""
    _open_settings(page, vite_base_url)
    metrics = _show_section(page, LONG_SECTION)

    assert abs(metrics["shellCap"] - SHELL_CAP_PX) <= 1.0, metrics
    assert abs(metrics["shellHeight"] - metrics["shellCap"]) <= 1.0, metrics
    assert metrics["paneScrollHeight"] > metrics["paneClientHeight"] + 1, metrics
    assert metrics["bodyScrolls"] is False, metrics
    assert abs(metrics["railHeight"] - metrics["shellHeight"]) <= 1.0, metrics


@pytest.mark.ui
def test_capped_to_content_switch_shrinks_the_frame(
    page: Page, vite_base_url: str
) -> None:
    """The long-to-short switch must actually SHRINK the window.

    This is the path the body-inner height override exists for: with hikari's
    100% pin, the size morph's content probe keeps reading the OLD body height,
    so the frame stays capped after a short section lands and the dead band
    comes back. A freshly opened short section never exercises that remeasure
    path, so the switch is asserted explicitly: the capped frame/shell must
    drop by a large margin, the swapped-in section must still end flush with
    its last card, and the pane must stop overflowing.
    """
    _open_settings(page, vite_base_url)
    capped = _show_section(page, LONG_SECTION)
    assert capped["paneScrollHeight"] > capped["paneClientHeight"] + 1, capped

    short = _show_section(page, "language")

    # The shrink itself — the whole window (frame pin AND content-fit shell)
    # must follow the content down, not only the inner scroll region.
    assert capped["shellHeight"] - short["shellHeight"] > 200.0, (capped, short)
    assert capped["frameHeight"] - short["frameHeight"] > 200.0, (capped, short)

    # The swapped-in section ends flush with its last card...
    assert short["deadBand"] is not None, short
    assert short["deadBand"] <= MAX_DEAD_BAND_PX, short
    # ...and its content fits the pane again (the long section's overflow is
    # gone).
    assert short["paneScrollHeight"] <= short["paneClientHeight"] + 1, short
