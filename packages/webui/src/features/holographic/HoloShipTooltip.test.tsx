/**
 * Tests for the holographic map's live ship tooltip card: the
 * measure-then-place pass anchors the teleported fixed card beside the
 * hovered roster slot, and — the zoom regression — converts the anchor's
 * visual-space rect and the viewport clamps into the card's zoomed local
 * space (the root DPI zoom paints the written left/top ×scale).
 *
 * The encyclopedia/model DBs stay empty (the identity chain falls back to
 * the vehicle's own shipName), and happy-dom measures every box 0×0, so
 * getBoundingClientRect is stubbed per test on the HTMLElement prototype.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { nextTick } from "vue";

import { initLocaleMessages } from "@/i18n";
import type { VehicleEntry } from "@/api";
import { resetAppliedDpiScaleForTest } from "@/theme/dpiPrefs";
import HoloShipTooltip from "./HoloShipTooltip";

enableAutoUnmount(afterEach);

// A complete `VehicleEntry` — the literal already satisfied the interface, so
// the assertion was pure noise (it only hid a future field being renamed).
const VEHICLE: VehicleEntry = {
  id: 1,
  name: "alpha",
  relation: 1,
  shipId: 4286,
  shipName: "Izumo",
};

beforeAll(async () => {
  await initLocaleMessages();
});

beforeEach(() => {
  // happy-dom returns a zero rect; place() skips zero rects as detached.
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
});

afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.dpiScale;
  document.documentElement.style.removeProperty("zoom");
  resetAppliedDpiScaleForTest();
  document.body.innerHTML = "";
});

function mountTip() {
  setActivePinia(createPinia());
  return mount(HoloShipTooltip, {
    props: {
      vehicle: VEHICLE,
      anchorEl: document.createElement("div"),
      time: 100,
      state: null,
      stats: new Map(),
      encyclopedia: new Map(),
      onCardHover: () => {},
    },
  });
}

function card(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".holo-ship-tip");
}

describe("HoloShipTooltip placement", () => {
  it("anchors beside the slot at scale 1 (Auto)", async () => {
    const wrapper = mountTip();
    await nextTick();
    await nextTick();

    const el = card();
    expect(el).not.toBeNull();
    // The strip hangs below the anchor (bottom 30 + 8 gap), hugging its
    // left edge — the pure placeLiveCard output with the stubbed boxes.
    expect(el?.style.left).toBe("10px");
    expect(el?.style.top).toBe("38px");
    wrapper.unmount();
  });

  it("places the card in the root zoom's local space", async () => {
    // 125% interface scale: unconverted, the card drifted scale× right/
    // down off its slot (the hint family's zoom report).
    document.documentElement.dataset.dpiScale = "125";
    resetAppliedDpiScaleForTest();
    const wrapper = mountTip();
    await nextTick();
    await nextTick();

    const el = card();
    expect(el).not.toBeNull();
    // Anchor left 10 visual / 1.25 → 8 local; bottom 30 / 1.25 = 24, plus
    // the 8px gap → 32.
    expect(el?.style.left).toBe("8px");
    expect(el?.style.top).toBe("32px");
    wrapper.unmount();
  });
});
