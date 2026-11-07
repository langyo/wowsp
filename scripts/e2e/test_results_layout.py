"""Results-window reading frame: the post-battle panel's first content starts
at the header divider, not below a dead band, and the matrix never ends flush
on the window's bottom edge. The mode/map head row was retired 2026-11-07, so
the share toolbar is that first content — a future row re-added above it must
move the top-gap anchor below with it.

Regression this guards (2026-11-07 report): the results modal stacked its own
HkScrollContainer + inner wrapper padding on top of HkModal's body inset
(24px + 9.6px), leaving a ~34px empty band under the header divider while the
scrolled matrix was clipped exactly at the window's bottom edge. The panel now
mounts straight into HkModal's scroll body: 8px of top gutter, a fixed band
below the scrollport, and the sheet's side inset so the matrix aligns with the
title.

The two top rows are also pinned (2026-11-07 follow-up): the share toolbar
and the team column-header grid ride ONE sticky block at the panel's top
(the matrix columns carry rows only), with an opaque surface background so
the rows scroll underneath it. The test scrolls the results body and proves
the block stays at the scrollport's top edge while the first matrix row
slides under it.

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
#: How far the results body is scrolled to prove the two top rows stay pinned.
STICKY_SCROLL_PX = 260
#: Geometry tolerance for the pinned block (sub-pixel layout jitter only).
STICKY_TOLERANCE_PX = 1.5
#: The sticky block's background must be fully opaque — a translucent band
#: would let the scrolled rows show through the pinned toolbar/header.
STICKY_BG_ALPHA = 1.0

#: Narrow-desktop viewport: PR #1820 stacks the matrix into ONE column at
#: ≤960px, the same breakpoint the panel uses to move the team titles back
#: into their columns. Measured here in a real browser because the unit pins
#: cannot see layout.
STACKED_VIEWPORT = {"width": 900, "height": 1020}

#: Stacked-layout contract: no hoisted header grid, only the toolbar in the
#: sticky block, and each team title back as its own column's first child
#: above that team's rows. Also proves the pinned toolbar still holds.
STACKED_JS = r"""
() => {
  const frame = document.querySelector('.replay-view__results-frame');
  const scroll = frame.querySelector('.hk-modal-body-scroll');
  const panel = frame.querySelector('.replay-view__postbattle');
  const sticky = panel.querySelector('.replay-view__postbattle-sticky');
  if (!sticky) throw new Error('post-battle sticky head block not found');
  const toolbar = sticky.querySelector('.replay-view__postbattle-toolbar');
  if (!toolbar) throw new Error('the share toolbar is not inside the sticky block');
  if (panel.querySelector('.replay-view__postbattle-thead')) {
    throw new Error('a hoisted header grid exists on the stacked matrix');
  }
  const headerSeat = sticky.classList.contains('replay-view__postbattle-sticky--with-head');
  const matrix = panel.querySelector('.replay-view__postbattle-matrix');
  if (!matrix) throw new Error('post-battle matrix not found');
  const cols = [...matrix.querySelectorAll('.replay-view__postbattle-col__inner')];
  if (cols.length !== 2) throw new Error('expected two team columns');
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };
  const titles = cols.map((col) => {
    const first = col.firstElementChild;
    if (!first || !first.classList.contains('replay-view__postbattle-col-title')) {
      throw new Error('team title is not the column first child');
    }
    return { title: rect(first), col: rect(col), rows: col.children.length - 1 };
  });
  const scrollRect = scroll.getBoundingClientRect();
  const before = rect(sticky);
  const target = scroll.scrollHeight - scroll.clientHeight;
  scroll.scrollTop = target;
  const after = rect(sticky);
  return {
    headerSeat,
    containsToolbar: sticky.contains(toolbar),
    stickyTopAtRest: before.top,
    stickyTopScrolled: after.top,
    scrollportTop: scrollRect.top,
    scrollTop: scroll.scrollTop,
    maxScroll: target,
    titles,
  };
}
"""

MEASURE_JS = r"""
() => {
  const frame = document.querySelector('.replay-view__results-frame');
  const header = frame.querySelector('.hk-modal-header');
  const scroll = frame.querySelector('.hk-modal-body-scroll');
  const panel = frame.querySelector('.replay-view__postbattle');
  // The share toolbar is the panel's first content row: the battle-identity
  // mode/map head that used to sit above it was retired 2026-11-07, so the
  // no-dead-band guard anchors here. A future row re-added above the toolbar
  // must move this anchor again.
  const firstRow = panel.querySelector('.replay-view__postbattle-toolbar');
  if (!firstRow) throw new Error('post-battle toolbar not found in results frame');
  const fr = frame.getBoundingClientRect();
  const hr = header.getBoundingClientRect();
  const sr = scroll.getBoundingClientRect();
  const pr = panel.getBoundingClientRect();
  const firstRowR = firstRow.getBoundingClientRect();
  return {
    topGap: firstRowR.top - hr.bottom,
    bottomGutter: fr.bottom - sr.bottom,
    sideInset: pr.left - fr.left,
    scrolls: scroll.scrollHeight > scroll.clientHeight,
  };
}
"""

#: Sticky-head contract: the toolbar and the hoisted team header grid must
#: ride ONE block with an opaque surface while the matrix rows scroll under
#: it. Measured twice (at rest, then after scrolling the body), so the test
#: can compare the pinned block's stability against the moving rows.
STICKY_JS = r"""
() => {
  const frame = document.querySelector('.replay-view__results-frame');
  const scroll = frame.querySelector('.hk-modal-body-scroll');
  const panel = frame.querySelector('.replay-view__postbattle');
  const sticky = panel.querySelector('.replay-view__postbattle-sticky');
  if (!sticky) throw new Error('post-battle sticky head block not found');
  const toolbar = sticky.querySelector('.replay-view__postbattle-toolbar');
  if (!toolbar) throw new Error('the share toolbar is not inside the sticky block');
  const thead = sticky.querySelector('.replay-view__postbattle-thead');
  if (!thead) throw new Error('the column-header grid is not inside the sticky block');
  const matrix = panel.querySelector('.replay-view__postbattle-matrix');
  if (!matrix) throw new Error('post-battle matrix not found');
  const cols = [...matrix.querySelectorAll('.replay-view__postbattle-col__inner')];
  const firstRow = cols.length > 0 ? cols[0].firstElementChild : null;
  if (!firstRow) throw new Error('the matrix has no first row');
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };
  const bg = getComputedStyle(sticky).backgroundColor;
  // "rgb(r, g, b)" / "rgba(r, g, b, a)" — sliced, not regexed, so this raw
  // Python string literal needs no backslash escapes.
  const open = bg.indexOf('(');
  const close = bg.indexOf(')');
  const channels =
    open >= 0 && close > open
      ? bg.slice(open + 1, close).split(',').map((s) => s.trim())
      : [];
  const bgAlpha = channels.length === 4 ? parseFloat(channels[3])
    : (channels.length === 3 ? 1 : 0);
  const scrollRect = scroll.getBoundingClientRect();
  return {
    position: getComputedStyle(sticky).position,
    bgAlpha,
    containsToolbar: sticky.contains(toolbar),
    containsThead: sticky.contains(thead),
    scrollTop: scroll.scrollTop,
    maxScroll: scroll.scrollHeight - scroll.clientHeight,
    scrollportTop: scrollRect.top,
    sticky: rect(sticky),
    toolbar: rect(toolbar),
    thead: rect(thead),
    firstRow: rect(firstRow),
    titleRects: [...thead.querySelectorAll('.replay-view__postbattle-col-title')].map(rect),
    colRects: cols.map(rect),
    theadTemplate: getComputedStyle(thead).gridTemplateColumns,
    matrixTemplate: getComputedStyle(matrix).gridTemplateColumns,
    theadGap: getComputedStyle(thead).gap,
    matrixGap: getComputedStyle(matrix).gap,
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

    # ── The toolbar + team header rows are ONE sticky block ───────────────
    at_rest = page.evaluate(STICKY_JS)
    # Both top rows ride the same block, and it is actually position: sticky
    # (the panel's first child — see PostBattlePanel.tsx).
    assert at_rest["position"] == "sticky", at_rest
    assert at_rest["containsToolbar"], at_rest
    assert at_rest["containsThead"], at_rest
    # An OPAQUE surface: the scrolled rows must vanish under the pinned block
    # rather than show through a translucent band.
    assert at_rest["bgAlpha"] == pytest.approx(STICKY_BG_ALPHA), at_rest
    # The hoisted header grid mirrors the matrix grid exactly (template and
    # gap), so each title cell sits on its matrix column's track...
    assert at_rest["theadTemplate"] == at_rest["matrixTemplate"], at_rest
    assert at_rest["theadGap"] == at_rest["matrixGap"], at_rest
    assert len(at_rest["titleRects"]) == 2, at_rest
    assert len(at_rest["colRects"]) == 2, at_rest
    for title_rect, col_rect in zip(at_rest["titleRects"], at_rest["colRects"]):
        assert abs(title_rect["left"] - col_rect["left"]) <= STICKY_TOLERANCE_PX, at_rest
        assert abs(title_rect["right"] - col_rect["right"]) <= STICKY_TOLERANCE_PX, at_rest
    # ...and the header still sits above the first matrix row with the
    # pre-sticky rhythm: the toolbar's 8px margin and the header's 4px seat
    # live INSIDE the sticky block, so at-rest gaps are unchanged.
    assert abs(at_rest["thead"]["top"] - at_rest["toolbar"]["bottom"] - 8.0) <= (
        STICKY_TOLERANCE_PX
    ), at_rest
    assert abs(at_rest["firstRow"]["top"] - at_rest["thead"]["bottom"] - 4.0) <= (
        STICKY_TOLERANCE_PX
    ), at_rest
    assert at_rest["toolbar"]["top"] >= at_rest["sticky"]["top"] - STICKY_TOLERANCE_PX, at_rest
    assert (
        at_rest["thead"]["bottom"] <= at_rest["sticky"]["bottom"] + STICKY_TOLERANCE_PX
    ), at_rest
    assert (
        at_rest["firstRow"]["top"] >= at_rest["sticky"]["bottom"] - STICKY_TOLERANCE_PX
    ), at_rest

    # ── Scroll the body: the block pins, the rows slide underneath ────────
    # The matrix is only slightly taller than this reading frame (the 1760×
    # 1020 test viewport leaves ~41px of overflow), so the request below
    # clamps at the scrollport's own maximum — the assertions compare
    # against min(request, maxScroll) instead of assuming the full 260px.
    page.evaluate(
        "(px) => { document.querySelector("
        "'.replay-view__results-frame .hk-modal-body-scroll').scrollTop = px; }",
        STICKY_SCROLL_PX,
    )
    page.wait_for_timeout(250)
    scrolled = page.evaluate(STICKY_JS)
    # The body really scrolled (the request clamps at the matrix's extent).
    assert scrolled["scrollTop"] == pytest.approx(
        min(STICKY_SCROLL_PX, scrolled["maxScroll"]), abs=STICKY_TOLERANCE_PX
    ), scrolled
    assert scrolled["scrollTop"] > 0, scrolled
    # Pinned: the block's top edge now sits exactly at the scrollport's top
    # edge and has not moved from its at-rest position.
    assert abs(scrolled["sticky"]["top"] - scrolled["scrollportTop"]) <= (
        STICKY_TOLERANCE_PX
    ), scrolled
    assert abs(scrolled["sticky"]["top"] - at_rest["sticky"]["top"]) <= (
        STICKY_TOLERANCE_PX
    ), scrolled
    # The toolbar and the header grid travel WITH the pinned block: both stay
    # inside its rect at the same offsets they had at rest, and above the
    # block's bottom edge (where the rows pass underneath).
    assert scrolled["toolbar"]["top"] >= scrolled["sticky"]["top"] - STICKY_TOLERANCE_PX, scrolled
    assert (
        scrolled["thead"]["bottom"] <= scrolled["sticky"]["bottom"] + STICKY_TOLERANCE_PX
    ), scrolled
    for key in ("toolbar", "thead"):
        assert abs(
            (scrolled[key]["top"] - scrolled["sticky"]["top"])
            - (at_rest[key]["top"] - at_rest["sticky"]["top"])
        ) <= STICKY_TOLERANCE_PX, scrolled
    # The first row scrolled UP under the block (its top is above the pinned
    # block's bottom edge — the opaque background paints over it) and it
    # moved by exactly the scroll delta: the matrix is what scrolls.
    assert scrolled["firstRow"]["top"] < scrolled["sticky"]["bottom"], scrolled
    row_delta = at_rest["firstRow"]["top"] - scrolled["firstRow"]["top"]
    assert abs(row_delta - scrolled["scrollTop"]) <= STICKY_TOLERANCE_PX, scrolled


@pytest.mark.ui
def test_stacked_results_keep_team_titles_in_their_columns(page, vite_base_url):
    """Narrow desktop (≤960px): the matrix stacks into ONE column, so the team
    titles must ride their own columns instead of a hoisted shared header —
    otherwise the ENEMY title would cap the ALLIES rows — while the share
    toolbar stays pinned at the scrollport's top edge."""
    page.set_viewport_size(STACKED_VIEWPORT)
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
    page.wait_for_timeout(600)

    stacked = page.evaluate(STACKED_JS)
    # Only the toolbar rides the sticky block, and the header seat is gone.
    assert stacked["containsToolbar"], stacked
    assert not stacked["headerSeat"], stacked
    # The body really scrolled — otherwise the pinned-after-scroll claim
    # below would pass vacuously on a body that fits the frame.
    assert stacked["scrollTop"] > 0, stacked
    assert abs(stacked["scrollTop"] - stacked["maxScroll"]) <= STICKY_TOLERANCE_PX, stacked
    # Both team titles are back at the top of their OWN stacked column,
    # followed by that team's rows.
    titles = stacked["titles"]
    assert len(titles) == 2, stacked
    for entry in titles:
        assert abs(entry["title"]["left"] - entry["col"]["left"]) <= STICKY_TOLERANCE_PX, entry
        assert abs(entry["title"]["top"] - entry["col"]["top"]) <= STICKY_TOLERANCE_PX, entry
        assert entry["rows"] > 0, entry
    # The two columns stack: the second team's column starts below the first.
    assert titles[1]["col"]["top"] >= titles[0]["col"]["bottom"] - STICKY_TOLERANCE_PX, stacked
    # The toolbar block still pins exactly at the scrollport's top edge.
    assert abs(stacked["stickyTopScrolled"] - stacked["scrollportTop"]) <= STICKY_TOLERANCE_PX, stacked
    assert abs(stacked["stickyTopScrolled"] - stacked["stickyTopAtRest"]) <= STICKY_TOLERANCE_PX, stacked
