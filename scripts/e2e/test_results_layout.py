"""Results-window reading frame: the post-battle matrix starts at the header
divider, not below a dead band, and never ends flush on the window's bottom
edge.

Regression this guards (2026-11-07 report): the results modal stacked its own
HkScrollContainer + inner wrapper padding on top of HkModal's body inset
(24px + 9.6px), leaving a ~34px empty band under the header divider while the
scrolled matrix was clipped exactly at the window's bottom edge. The panel now
mounts straight into HkModal's scroll body: 8px of top gutter, a fixed band
below the scrollport, and the sheet's side inset so the matrix aligns with the
title.

Runs against the FastAPI mock backend (the session fixture boots mock + Vite):
/replay?open=0 opens the fixture dump, whose BattleResults packet renders the
full 12v12 results window. No game client is ever involved (AGENTS.md §0).
"""
from __future__ import annotations

import pytest
from playwright.sync_api import expect

VIEWPORT = {"width": 1760, "height": 1020}
#: The retired double-padding stack measured 33.6px between the header divider
#: and the first content row; 12px + the hairline tolerance keeps a real
#: regression loud while allowing the intentional 8px dense-sheet gutter.
MAX_TOP_GAP_PX = 14.0
#: Fixed blank band between the scrollport and the frame's bottom edge — what
#: stops a scrolled row from ending flush on the window border.
MIN_BOTTOM_GUTTER_PX = 10.0
#: The matrix rides the sheet's horizontal reading inset (24px body padding,
#: 1px frame border) and is aligned with the window title.
SIDE_INSET_PX = 25.0
SIDE_INSET_TOLERANCE_PX = 2.0

MEASURE_JS = r"""
() => {
  const frame = document.querySelector('.replay-view__results-frame');
  const header = frame.querySelector('.hk-modal-header');
  const scroll = frame.querySelector('.hk-modal-body-scroll');
  const panel = frame.querySelector('.replay-view__postbattle');
  const head = panel.querySelector('.replay-view__postbattle-head');
  const fr = frame.getBoundingClientRect();
  const hr = header.getBoundingClientRect();
  const sr = scroll.getBoundingClientRect();
  const pr = panel.getBoundingClientRect();
  const headR = head.getBoundingClientRect();
  return {
    topGap: headR.top - hr.bottom,
    bottomGutter: fr.bottom - sr.bottom,
    sideInset: pr.left - fr.left,
    scrolls: scroll.scrollHeight > scroll.clientHeight,
  };
}
"""


@pytest.mark.ui
def test_results_window_reading_frame(page, vite_base_url):
    page.set_viewport_size(VIEWPORT)
    # Deep link: the mock serves one fixture replay; auto-open it and let the
    # positions/results stream settle before the window is opened.
    page.goto(f"{vite_base_url}/replay?open=0", wait_until="domcontentloaded", timeout=60_000)
    tag = page.locator(".replay-view__results")
    expect(tag.first).to_be_visible(timeout=90_000)
    page.wait_for_function(
        "() => document.querySelector('.replay-view__results--loading') === null",
        timeout=90_000,
    )
    tag.first.click()
    expect(page.locator(".replay-view__results-frame")).to_be_visible(timeout=30_000)
    expect(page.locator(".replay-view__postbattle")).to_be_visible(timeout=30_000)
    # Let the enter transition and the size morph settle before measuring.
    page.wait_for_timeout(600)

    metrics = page.evaluate(MEASURE_JS)
    assert metrics["topGap"] <= MAX_TOP_GAP_PX, metrics
    assert metrics["bottomGutter"] >= MIN_BOTTOM_GUTTER_PX, metrics
    assert abs(metrics["sideInset"] - SIDE_INSET_PX) <= SIDE_INSET_TOLERANCE_PX, metrics
    # The fixture is a 12v12 battle: the matrix must still overflow and
    # scroll at this reading height (the frame is a capped window, not a
    # grow-to-content sheet).
    assert metrics["scrolls"], metrics
