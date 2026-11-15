/**
 * Tests for the replay view's map-name tag hover card: the delayed
 * pointer show anchors the teleported fixed card below the tag, and — the
 * zoom regression — converts the tag's visual-space rect and the viewport
 * clamps into the card's zoomed local space (the root DPI zoom paints the
 * written left/top ×scale).
 *
 * happy-dom measures every box 0×0, so getBoundingClientRect is stubbed
 * per test on the HTMLElement prototype.
 *
 * The chip FACE contract rides here too: the tag is AppTag's (soft accent
 * while /tactics can board the map, quiet outline otherwise), which is
 * why the card's anchor comes from the triggering event's currentTarget
 * instead of a template ref to a button this component no longer owns.
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
  mocks.routerPush.mockClear();
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

describe("MapNameTag faces", () => {
  it("presses an analysable map through AppTag's soft accent face", () => {
    const wrapper = mount(MapNameTag, {
      props: { spaceId: ANALYSABLE_SPACE_IDS[0], lang: "" },
    });
    // The host class lands on AppTag's interactive button (the callers'
    // layout hook, and the button the card measures), never the face span.
    const btn = wrapper.find("button.app-tag-btn.map-tag");
    expect(btn.exists()).toBe(true);
    const tag = btn.find("span.hk-tag");
    expect(tag.classes()).toContain("hk-tag-sm");
    expect(tag.classes()).toContain("app-tag");
    expect(tag.classes()).toContain("app-tag--accent");
    expect(tag.classes()).not.toContain("app-tag--outline");
  });

  it("renders a space /tactics cannot board as a plain, static tag", async () => {
    // No tactics board can host this id — the tag must not promise a jump.
    const wrapper = mount(MapNameTag, {
      props: { spaceId: "spaces/00_test_harbor", lang: "" },
    });
    expect(wrapper.find(".app-tag-btn").exists()).toBe(false);
    const tag = wrapper.find("span.map-tag.map-tag--plain");
    expect(tag.exists()).toBe(true);
    expect(tag.classes()).toContain("hk-tag-sm");
    expect(tag.classes()).toContain("app-tag--outline");
    expect(tag.classes()).toContain("app-tag--default");
    // A static tag has no hover card to float.
    await tag.trigger("pointerenter");
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(document.body.querySelector(".map-tag__card")).toBeNull();
  });

  it("jumps to the map's tactics board through AppTag's emitted click", async () => {
    // AppTag routes its click through the declared emit; this pin is the
    // regression guard for the jump's only path (the handler moved into the
    // attr bag the AppTag button now carries).
    const spaceId = ANALYSABLE_SPACE_IDS[0];
    const wrapper = mount(MapNameTag, { props: { spaceId, lang: "" } });
    await wrapper.find("button.app-tag-btn.map-tag").trigger("click");
    expect(mocks.routerPush).toHaveBeenCalledExactlyOnceWith({
      path: "/tactics",
      query: { map: spaceId.replace(/^spaces\//, "") },
    });
  });

  it("keeps a non-analysable space inert on click", async () => {
    const wrapper = mount(MapNameTag, {
      props: { spaceId: "spaces/00_test_harbor", lang: "" },
    });
    await wrapper.find("span.map-tag").trigger("click");
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });
});

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
