"""Chat-window reading frame: the message list owns the scroll, the modal body
does not, and the timeline stays put above it.

Regression this guards (2026-11-07 report): after the 2026-11-03 HkModal
migration, the chat window kept its pre-migration body wrapper. HkModal's body
scrolled the whole window, the wrapper's own padding stacked on HkModal's
gutter (33.6px dead band under the header divider), and the list's hikari
scroller stayed inert — the timeline scrolled away with the messages and the
last row ended flush on the window edge. The frame now hands its height down
to the wrapper: HkModal's body never scrolls, the list scrolls itself, and the
desktop gutters match the results sheet (8px top / fixed 16px bottom).

Runs against the FastAPI mock backend (the session fixture boots mock + Vite);
/replay?open=0 opens the fixture dump, whose 24 chat messages fill the list.
No game client is ever involved (AGENTS.md §0).
"""
from __future__ import annotations

import pytest
from playwright.sync_api import expect

VIEWPORT = {"width": 1760, "height": 1020}
#: Old wrapper padding (9.6px) + HkModal body inset (24px) measured 33.6px.
MAX_TOP_GAP_PX = 14.0
#: The fixed band below the list's scrollport (16px body padding + 1px frame).
MIN_BOTTOM_GUTTER_PX = 10.0
#: Wheel delta over the message list.
WHEEL_DELTA_PX = 420

MEASURE_JS = r"""
() => {
  const frame = document.querySelector('.replay-view__chat-panel');
  const header = frame.querySelector('.hk-modal-header');
  const timeline = frame.querySelector('.replay-view__chat-timeline');
  const bodyScroll = frame.querySelector('.hk-modal-body-scroll');
  const viewport = frame.querySelector(
    '.replay-view__chat-scroll > .hk-scroll-container-viewport',
  );
  const fr = frame.getBoundingClientRect();
  const hr = header.getBoundingClientRect();
  const tr = timeline.getBoundingClientRect();
  const vr = viewport.getBoundingClientRect();
  return {
    topGap: tr.top - hr.bottom,
    bottomGutter: fr.bottom - vr.bottom,
    bodyScrolls: bodyScroll.scrollHeight > bodyScroll.clientHeight + 1,
    bodyScrollTop: bodyScroll.scrollTop,
    listScrolls: viewport.scrollHeight > viewport.clientHeight + 1,
    listScrollTop: viewport.scrollTop,
    timelineTop: tr.top,
  };
}
"""


@pytest.mark.ui
def test_chat_window_reading_frame(page, vite_base_url):
    page.set_viewport_size(VIEWPORT)
    page.goto(f"{vite_base_url}/replay?open=0", wait_until="domcontentloaded", timeout=60_000)
    results_tag = page.locator(".replay-view__results")
    expect(results_tag.first).to_be_visible(timeout=90_000)
    page.wait_for_function(
        "() => document.querySelector('.replay-view__results--loading') === null",
        timeout=90_000,
    )

    page.get_by_text("Battle chat", exact=True).first.click()
    expect(page.locator(".replay-view__chat-panel")).to_be_visible(timeout=30_000)
    page.wait_for_timeout(600)

    before = page.evaluate(MEASURE_JS)
    assert before["topGap"] <= MAX_TOP_GAP_PX, before
    assert before["bottomGutter"] >= MIN_BOTTOM_GUTTER_PX, before
    assert before["listScrolls"] is True, before
    assert before["bodyScrolls"] is False, before

    # The wheel belongs to the message list: it scrolls, the modal body and
    # the timeline stay put.
    box = page.locator(".replay-view__chat-scroll").bounding_box()
    assert box is not None
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.wheel(0, WHEEL_DELTA_PX)
    page.wait_for_timeout(700)

    after = page.evaluate(MEASURE_JS)
    assert after["listScrollTop"] > 0, after
    assert after["bodyScrollTop"] == 0 and after["bodyScrolls"] is False, after
    assert abs(after["timelineTop"] - before["timelineTop"]) <= 1.0, after
