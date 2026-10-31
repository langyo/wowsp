/**
 * Tests for the tactical board's replay-sources hover panel: the chip's
 * pointer show anchors the teleported fixed panel below the chip, and —
 * the zoom regression — converts the chip's visual-space rect and the
 * viewport clamps into the panel's zoomed local space (the root DPI zoom
 * paints the written left/top ×scale).
 *
 * happy-dom measures every box 0×0, so getBoundingClientRect is stubbed
 * per test on the HTMLElement prototype.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import { initLocaleMessages } from "@/i18n";
import type { LearnedReplaySource } from "@/api";
import { resetAppliedDpiScaleForTest } from "@/theme/dpiPrefs";
import ReplaySourcesTip from "./ReplaySourcesTip";

enableAutoUnmount(afterEach);

const REPLAYS: LearnedReplaySource[] = [{ name: "20260101_101010.wowsreplay", time: "12:34" }];

beforeAll(async () => {
  await initLocaleMessages();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.dpiScale;
  document.documentElement.style.removeProperty("zoom");
  resetAppliedDpiScaleForTest();
  document.body.innerHTML = "";
});

function mountTip() {
  return mount(ReplaySourcesTip, {
    props: { label: "Sources (1)", replays: REPLAYS },
  });
}

describe("ReplaySourcesTip placement", () => {
  it("opens the panel below the chip at scale 1 (Auto)", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 120,
      height: 20,
      top: 10,
      left: 10,
      right: 130,
      bottom: 30,
      x: 10,
      y: 10,
      toJSON: () => ({}),
    } as DOMRect);
    const wrapper = mountTip();
    await wrapper.find(".rs-tip").trigger("pointerenter");
    await flushPromises();

    const panel = document.body.querySelector<HTMLElement>(".rs-tip__panel");
    expect(panel).not.toBeNull();
    expect(panel?.style.left).toBe("10px");
    expect(panel?.style.top).toBe("38px"); // bottom 30 + 8 gap
    wrapper.unmount();
  });

  it("places the panel in the root zoom's local space", async () => {
    // 125% interface scale: unconverted, the panel drifted scale× right/
    // down off its chip (the hint family's zoom report).
    document.documentElement.dataset.dpiScale = "125";
    resetAppliedDpiScaleForTest();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 120,
      height: 20,
      top: 10,
      left: 10,
      right: 130,
      bottom: 30,
      x: 10,
      y: 10,
      toJSON: () => ({}),
    } as DOMRect);
    const wrapper = mountTip();
    await wrapper.find(".rs-tip").trigger("pointerenter");
    await flushPromises();

    const panel = document.body.querySelector<HTMLElement>(".rs-tip__panel");
    expect(panel).not.toBeNull();
    // Chip left 10 visual / 1.25 → 8 local; bottom 30 / 1.25 = 24 plus
    // the 8px gap → 32.
    expect(panel?.style.left).toBe("8px");
    expect(panel?.style.top).toBe("32px");
    wrapper.unmount();
  });
});
