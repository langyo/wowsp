/**
 * Tests for the replay view's map-name tag hover card: the delayed
 * pointer show anchors the teleported fixed card below the tag, and — the
 * zoom regression — converts the tag's visual-space rect and the viewport
 * clamps into the card's zoomed local space (the root DPI zoom paints the
 * written left/top ×scale).
 *
 * happy-dom measures every box 0×0, so getBoundingClientRect is stubbed
 * per test on the HTMLElement prototype.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({ routerPush: vi.fn() }));

vi.mock("vue-router", () => ({ useRouter: () => ({ push: mocks.routerPush }) }));

import { initLocaleMessages } from "@/i18n";
import { resetAppliedDpiScaleForTest } from "@/theme/dpiPrefs";
import { ANALYSABLE_SPACE_IDS } from "@/utils/tacticsMaps";
import MapNameTag from "./MapNameTag";

enableAutoUnmount(afterEach);

beforeAll(async () => {
  await initLocaleMessages();
});

beforeEach(() => {
  vi.useFakeTimers();
  // happy-dom returns a zero rect; show() would treat it as a vanished
  // anchor and never open the card.
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.dpiScale;
  document.documentElement.style.removeProperty("zoom");
  resetAppliedDpiScaleForTest();
  document.body.innerHTML = "";
});

async function openCard() {
  const wrapper = mount(MapNameTag, {
    props: { spaceId: ANALYSABLE_SPACE_IDS[0], lang: "" },
  });
  await wrapper.find(".map-tag").trigger("pointerenter");
  vi.advanceTimersByTime(300); // the hover-show delay
  await flushPromises(); // show() measures after its nextTick
  return wrapper;
}

describe("MapNameTag placement", () => {
  it("opens the preview card below the tag at scale 1 (Auto)", async () => {
    const wrapper = await openCard();
    const card = document.body.querySelector<HTMLElement>(".map-tag__card");
    expect(card).not.toBeNull();
    expect(card?.style.left).toBe("10px");
    expect(card?.style.top).toBe("38px"); // bottom 30 + 8 gap
    wrapper.unmount();
  });

  it("places the card in the root zoom's local space", async () => {
    // 125% interface scale: unconverted, the card drifted scale× right/
    // down off its tag (the hint family's zoom report).
    document.documentElement.dataset.dpiScale = "125";
    resetAppliedDpiScaleForTest();
    const wrapper = await openCard();
    const card = document.body.querySelector<HTMLElement>(".map-tag__card");
    expect(card).not.toBeNull();
    // Tag left 10 visual / 1.25 → 8 local; bottom 30 / 1.25 = 24 plus the
    // 8px gap → 32.
    expect(card?.style.left).toBe("8px");
    expect(card?.style.top).toBe("32px");
    wrapper.unmount();
  });
});
