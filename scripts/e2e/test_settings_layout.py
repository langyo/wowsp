"""Constant-band desktop settings frame: the window keeps ONE height for its
whole life — hikari's shipped --hk-settings-height band, 70vh - 6.5rem —
whatever section is showing.

History (why this file used to assert the opposite): the package's constant
frame left a large dead band under a short section's last card, reported on
2026-11-08 for 玩家标记 (player markers) with "类似的地方也要修"; the fix
(#1834) made the shell HUG the active section's cards (height: auto, the rail
taken out of the intrinsic height with "contain: size", the body-inner pin
dropped so HkModal's size probe could measure a shrinking frame), and
#1940 (2026-11-11) added a "min(24rem, band)" floor because the shortest
sections had collapsed the window into a sliver ("这也太矮了"). The
2026-11-17 direction retires BOTH: "我不希望这个窗口的高度再变化了，直接固定
最大的那个高度算了" — the window must never resize between sections, even at
the price of a bounded dead band under short content. WoWSP declares no
shell-height rule (packages/webui/src/components/settings/SettingsShell.scss),
so hikari's band owns the desktop modal and HkModal's useSizeMorph measures
one constant stack on every section switch. The sheet keeps exactly one host
rule, and the resize case below pins what it buys: the desktop body-inner
unpin (hikari's 100% pin ties the morph's observed box to the PINNED frame,
so a WINDOW resize could never re-measure and the frame would keep the old
viewport's band — clipped on a grow — until reopen).

Asserted here (viewport 1440x900, so the band is 900*0.70 - 6.5*16 = 526px):
  * the exercised section set — the short half of the rail (language,
    account, crash, markers, closeBehavior, gamePath, network, pairing,
    chatTranslate, installCleanup, sharing) AND the long one (appearance) —
    sits at the band: shellHeight and the shell's computed height both equal
    526px, the shell has no max-height cap and no min-height floor, the rail
    is stretched to the shell and scrolls its entries (never crushes them),
    and the modal body itself never scrolls; the freshly opened landing
    section is measured too, before any switch;
  * the window does not move while switching: the frame height AND the
    frame-minus-shell chrome stay within a pixel of the first measurement,
    including the long -> short switch that used to drop the window;
  * short sections fit their cards in the pane (the band's slack is empty
    space, never a clipped card), while the long section scrolls the pane —
    the pane stays the only scrollbar owner;
  * a WINDOW resize retunes the band: the frame follows the shell one-for-one
    (chrome constant), because the desktop body-inner unpin keeps the morph
    observing the live shell instead of the pinned frame.

Runs against the FastAPI mock backend (the session fixtures boot mock + Vite);
no game client is ever involved (AGENTS.md §0).
"""
from __future__ import annotations

import re
import time

import pytest
from playwright.sync_api import Page, expect

VIEWPORT = {"width": 1440, "height": 900}


def _band(viewport_height: int) -> float:
    """hikari's shipped band for a viewport height.

    The ".hk-settings-host .hk-settings" rule is
    "height: var(--hk-settings-height, calc(70vh - 6.5rem))" and the shell
    never sets the variable (WoWSP mounts its own grouped shell, not
    HkSettingsDialog, so no inline --hk-settings-height lands). Derived from
    the viewport (rem at the test root's 16px) so a window resize cannot
    silently stale it: 900 * 0.70 - 6.5 * 16 = 526.
    """
    return viewport_height * 0.70 - 6.5 * 16.0


#: The band the default viewport sits at (see _band).
BAND_PX = _band(VIEWPORT["height"])
#: Measurement noise: rounding (subpixel layout) only — every assertion below
#: compares against a whole-pixel band, and a real frame change is tens of
#: pixels, so this never masks a regression.
TOLERANCE_PX = 1.0
#: The rail entries' authored touch target: "min-height: 2.25rem" (36px).
#: The assertion allows 2px of measurement slack; a CRUSHED entry (the
#: 2026-11-11 squashed-rows report — entries shrinking to ~24px so the rail
#: fits the frame) lands well below this.
RAIL_ENTRY_MIN_PX = 34.0
#: Every section whose cards fit the pane at the test viewport. The band is
#: constant, so "fits" is a property of the section, not of the window.
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
#: The exercised sections, in one pass: the band must hold for the long one
#: exactly like for the short ones. The rail's remaining entries (stats,
#: updates, resources, changelog, overlayCalibration, feedback, about,
#: attributions) cannot change the shell box either — the height is CSS, not
#: content — so they need no per-section Playwright pass.
SECTIONS = SHORT_SECTIONS + (LONG_SECTION,)
#: HkModal's size morph settles on its own clock (150 ms resize debounce + a
#: height transition), so one fixed wait after a section switch is a race; a
#: quiet window in the measurements is not.
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

  const shellStyle = shell ? getComputedStyle(shell) : null;
  const frameRect = rect(frame);
  const shellRect = rect(shell);
  const paneRect = rect(pane);
  // The rail's entries are the row grammar this test protects from the flex
  // column's shrink phase; offsetHeight (not a rect) is the laid-out box.
  const railEntries = rail
    ? Array.from(rail.querySelectorAll(".hk-settings__rail-item")).map(
        (el) => el.offsetHeight,
      )
    : [];
  return {
    frameHeight: frameRect ? frameRect.height : null,
    shellHeight: shellRect ? shellRect.height : null,
    shellComputedHeight: shellStyle ? parseFloat(shellStyle.height) : null,
    shellMax: shellStyle ? shellStyle.maxHeight : null,
    shellMin: shellStyle ? shellStyle.minHeight : null,
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
    railEntryMin: railEntries.length ? Math.min(...railEntries) : null,
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
    measurement (see SETTLE_SAMPLES). With the constant frame the height leg
    is only a liveness witness now; the pane leg is what still moves while a
    section's async rows land."""
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


def _parse_px(value: str | None) -> float:
    """A computed length in px; an unset floor/cap reads as 0.

    getComputedStyle reports an unset min-height/max-height as "0px" or
    "none" depending on the property and engine, and both mean "no floor /
    no cap" for this contract — never a positive number.
    """
    if value is None or value in ("none", "auto", ""):
        return 0.0
    try:
        return float(value.removesuffix("px"))
    except ValueError:
        return 0.0


def _show_section(page: Page, key: str) -> dict:
    """Switch the shell to one section and wait for its frame to settle."""
    item = page.locator(f'.hk-settings__rail-item[data-section="{key}"]')
    item.click()
    expect(item).to_have_class(_ACTIVE_SECTION)
    expect(
        page.locator(".hk-modal-content.hk-settings-host .hk-settings-group").first,
    ).to_be_visible(timeout=30_000)
    return _settle(page)


def _assert_constant_band(
    metrics: dict, key: str, band: float = BAND_PX
) -> None:
    """One section's half of the frame contract: the shell stands at hikari's
    band, with no content-fit clamp and a usable scrolling rail.

    The band argument lets the resize case assert the same contract at a
    different viewport height (see _band). The frame<->shell delta (HkModal's
    header/borders/footer around the shell) is NOT hard-coded here: every
    caller compares against a reference measurement (see _assert_same_frame),
    so a hikari chrome change only has to stay constant, not equal some
    guessed offset.
    """
    # The shell itself: rect, computed height, and the absence of any
    # content-fit clamp. "height: auto" (the 2026-11-08 hug) shows up as a
    # computed height far from the band; a floor/cap shows up in max/min.
    assert metrics["shellHeight"] is not None, (key, metrics)
    assert abs(metrics["shellHeight"] - band) <= TOLERANCE_PX, (key, metrics)
    assert metrics["shellComputedHeight"] is not None, (key, metrics)
    assert abs(metrics["shellComputedHeight"] - band) <= TOLERANCE_PX, (
        key,
        metrics,
    )
    # No cap and no floor may come back: the cap is what #1834 turned the
    # band into, and min(24rem, band) is the #1940 floor.
    assert metrics["shellMax"] == "none", (key, metrics)
    assert _parse_px(metrics["shellMin"]) <= TOLERANCE_PX, (key, metrics)

    # Scroll ownership: the pane scrolls (for long sections), the modal body
    # never does, and the rail is the shell's stretched flex sibling.
    assert metrics["bodyScrolls"] is False, (key, metrics)
    assert abs(metrics["railHeight"] - metrics["shellHeight"]) <= TOLERANCE_PX, (
        key,
        metrics,
    )
    assert metrics["railScrolls"] is True, (key, metrics)
    # ...and its entries keep their authored height while it scrolls.
    assert metrics["railEntryMin"] is not None, (key, metrics)
    assert metrics["railEntryMin"] >= RAIL_ENTRY_MIN_PX, (key, metrics)


def _assert_same_frame(metrics: dict, reference: dict, key: str = "") -> None:
    """The window has not moved since the reference: same frame height AND the
    same frame-minus-shell chrome (so a dropped shell could never hide inside
    an unchanged frame)."""
    assert metrics["frameHeight"] is not None, (key, metrics)
    assert abs(metrics["frameHeight"] - reference["frameHeight"]) <= TOLERANCE_PX, (
        key,
        metrics,
        reference,
    )
    chrome = reference["frameHeight"] - reference["shellHeight"]
    assert (
        abs((metrics["frameHeight"] - metrics["shellHeight"]) - chrome)
        <= TOLERANCE_PX
    ), (key, metrics, reference)


@pytest.mark.ui
def test_every_section_keeps_the_constant_band(page: Page, vite_base_url: str) -> None:
    """The exercised section set — short ones and the long one — stands in the
    same window at the same band height.

    The freshly OPENED landing (账户) is measured before any switch: it must
    already sit at the band, and it is the session's frame reference — the
    frame must not move for any later section, and the frame-minus-shell
    chrome must stay constant too. Short sections additionally have to FIT
    their cards (the band's slack is a dead band, never a clipped card); the
    long one is covered by its own case below.
    """
    _open_settings(page, vite_base_url)
    reference = _settle(page)
    _assert_constant_band(reference, "account")
    for key in SECTIONS:
        metrics = _show_section(page, key)
        _assert_constant_band(metrics, key)
        _assert_same_frame(metrics, reference, key)
        if key == LONG_SECTION:
            # Its content overflows the pane by design (see the long-section
            # case): the last card ends BELOW the pane edge, so a dead-band
            # or fit assertion would describe the overflow, not a layout bug.
            continue
        # The cards fit: the pane's slack is the accepted dead band, and the
        # dead band is measured (never assumed) — it may be large, it may
        # not be negative.
        assert metrics["paneScrollHeight"] <= metrics["paneClientHeight"] + 1, (
            key,
            metrics,
        )
        assert metrics["deadBand"] is not None, (key, metrics)
        assert metrics["deadBand"] >= -1.0, (key, metrics)


@pytest.mark.ui
def test_long_section_keeps_the_band_and_scrolls_the_pane(
    page: Page, vite_base_url: str
) -> None:
    """The long section (appearance) keeps the exact same window height as a
    short one, overflows the pane instead of growing the window, and leaves
    the modal body's own scroller idle (HkModal's floating overlay bar stays
    quiet; the pane's edge bar is the only scrollbar)."""
    _open_settings(page, vite_base_url)
    short = _show_section(page, "language")
    long = _show_section(page, LONG_SECTION)

    _assert_constant_band(long, LONG_SECTION)
    _assert_same_frame(long, short, LONG_SECTION)
    assert long["paneScrollHeight"] > long["paneClientHeight"] + 1, long
    assert long["bodyScrolls"] is False, long
    assert long["railScrolls"] is True, long


@pytest.mark.ui
def test_switching_sections_never_resizes_the_window(
    page: Page, vite_base_url: str
) -> None:
    """The long -> short switch must NOT drop the window.

    This is the path the whole 2026-11-17 direction is about: with the
    content-fit hug, switching from appearance to language (or markers) pulled
    the frame down to the shorter section's hugged (floored) height, and the
    window moved under the user every time they picked another section. The
    constant band makes the drop exactly zero — frame height identical to the
    long section's measurement, shell height at the band — while the short
    section's pane overflow goes away.
    """
    _open_settings(page, vite_base_url)
    long = _show_section(page, LONG_SECTION)
    assert long["paneScrollHeight"] > long["paneClientHeight"] + 1, long

    for key in ("language", "markers"):
        short = _show_section(page, key)
        _assert_constant_band(short, key)
        _assert_same_frame(short, long, key)

        # Zero frame drop across the switch (the regression this guards).
        frame_drop = long["frameHeight"] - short["frameHeight"]
        assert abs(frame_drop) <= TOLERANCE_PX, (long, short)
        assert abs(short["shellHeight"] - long["shellHeight"]) <= TOLERANCE_PX, (
            long,
            short,
        )

        # The swapped-in section's overflow is gone: its cards fit the pane.
        assert short["paneScrollHeight"] <= short["paneClientHeight"] + 1, short
        assert short["deadBand"] is not None, short
        assert short["deadBand"] >= -1.0, short


@pytest.mark.ui
def test_window_resize_retunes_the_band(page: Page, vite_base_url: str) -> None:
    """A WINDOW resize must still retune the frame — the desktop body-inner unpin.

    The band is viewport-derived, so resizing the window changes it. HkModal's
    size morph observes the modal body inner; hikari pins that box at 100%,
    which tracks the PINNED frame instead of the content — under the pin a
    resize never reaches the morph, so the frame keeps the old viewport's band
    until the window is reopened (on a grow the shell then overflows the body
    scroller; a shrink+grow leaves it stuck small). WoWSP's desktop-only unpin
    keeps the probe on the live shell, so the frame must follow the shell
    one-for-one with the chrome constant.
    """
    _open_settings(page, vite_base_url)
    base = _show_section(page, "language")
    _assert_constant_band(base, "language")
    base_chrome = base["frameHeight"] - base["shellHeight"]

    for width, height in ((1280, 720), (1600, 1000)):
        page.set_viewport_size({"width": width, "height": height})
        resized = _settle(page)
        band = _band(height)
        assert abs(resized["shellHeight"] - band) <= TOLERANCE_PX, (
            width,
            height,
            resized,
        )
        assert abs(resized["shellComputedHeight"] - band) <= TOLERANCE_PX, (
            width,
            height,
            resized,
        )
        # The frame MOVED: a pin frozen at the old viewport's band fails here
        # (the exact regression the body-inner unpin exists to prevent).
        assert (
            abs(resized["frameHeight"] - base["frameHeight"]) > TOLERANCE_PX
        ), (width, height, resized, base)
        # ...one-for-one: the chrome around the shell is unchanged, and the
        # frame still wraps the shell (a frame shorter than the shell is the
        # clipped-behind-the-body-scroller tell).
        assert (
            abs(
                (resized["frameHeight"] - resized["shellHeight"]) - base_chrome
            )
            <= TOLERANCE_PX
        ), (width, height, resized, base)
        assert resized["frameHeight"] > resized["shellHeight"], (
            width,
            height,
            resized,
        )
        # The section contract holds at the new band, and switching sections
        # does not move the freshly tuned window.
        for key in ("language", "markers"):
            metrics = _show_section(page, key)
            _assert_constant_band(metrics, key, band=band)
            _assert_same_frame(metrics, resized, key)
