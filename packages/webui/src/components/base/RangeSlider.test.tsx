/**
 * Tests for the dual-thumb RangeSlider:
 *  - renders the pair of role=slider thumbs, the corridor fill, per-stop
 *    tick dots, and the host-supplied label row (slot AND function-prop
 *    variants — labels may be arbitrary nodes, the supership ★ included);
 *  - pointer interaction matches hikari's HkSlider: pointerdown on the
 *    track jumps the NEARER thumb to the press (snapped to the step grid)
 *    and the window-level move listeners keep dragging it past the
 *    element bounds until pointerup;
 *  - the pair never crosses: each thumb drags only inside the corridor
 *    the other allows (lo stops at hi, hi stops at lo);
 *  - each thumb is keyboard reachable: arrows walk the step grid,
 *    PageUp/PageDown stride 4 steps, Home/End jump to the corridor's
 *    ends — clamped by the other thumb, never crossing;
 *  - an out-of-order or out-of-range modelValue normalizes silently
 *    (ordered, clamped) without emitting;
 *  - disabled blocks every commit path (pointer and keyboard).
 *
 * Pointer tests mock the track's getBoundingClientRect (jsdom lays out
 * nothing): a 100px track over min 1 / max 11 maps clientX linearly onto
 * tiers (clientX 0 → 1, clientX 100 → 11).
 */
import { h } from "vue";
import { describe, expect, it, vi, afterEach } from "vitest";
import { DOMWrapper, mount, type VueWrapper } from "@vue/test-utils";

import RangeSlider from "./RangeSlider";

type Range = [number, number];

const RECT = { left: 0, top: 0, right: 100, bottom: 18, width: 100, height: 18, x: 0, y: 0 } as DOMRect;

function mountSlider(modelValue: Range = [1, 11], extra: Record<string, unknown> = {}) {
  const wrapper = mount(RangeSlider, {
    props: { modelValue, min: 1, max: 11, step: 1, ...extra },
  });
  const track = wrapper.find(".range-slider__track");
  vi.spyOn(track.element, "getBoundingClientRect").mockReturnValue(RECT);
  return { wrapper, track };
}

/** The last emitted pair (undefined when nothing was ever emitted). */
function lastEmitted(wrapper: VueWrapper): Range | undefined {
  const calls = wrapper.emitted("update:modelValue") ?? [];
  // Each emitted call is the args tuple — here a single Range payload.
  const last = calls[calls.length - 1] as unknown as [Range] | undefined;
  return last ? last[0] : undefined;
}

const move = (clientX: number) =>
  window.dispatchEvent(new MouseEvent("pointermove", { clientX, bubbles: true }));
const up = () => window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RangeSlider render", () => {
  it("renders two role=slider thumbs, the corridor fill and per-stop ticks", () => {
    const { wrapper } = mountSlider([3, 7], { showTicks: true });
    const thumbs = wrapper.findAll(".range-slider__thumb");
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]!.attributes("role")).toBe("slider");
    expect(thumbs[0]!.attributes("data-thumb")).toBe("lo");
    expect(thumbs[1]!.attributes("data-thumb")).toBe("hi");
    // 11 stops → 11 tick dots, the five inside [3,7] active.
    expect(wrapper.findAll(".range-slider__tick")).toHaveLength(11);
    expect(wrapper.findAll(".range-slider__tick[data-active]")).toHaveLength(5);
    // Corridor fill: left 20% (tier 3), width 40% (tiers 3→7 of the 1–11 span).
    const fill = wrapper.find(".range-slider__fill");
    expect(fill.attributes("style")).toContain("left: 20%");
    expect(fill.attributes("style")).toContain("width: 40%");
    // No label row without content supplied.
    expect(wrapper.find(".range-slider__labels").exists()).toBe(false);
  });

  it("renders the label row through the tickLabel prop (text or glyph nodes)", () => {
    const { wrapper } = mountSlider([1, 11], {
      showTickLabels: true,
      tickLabel: (v: number) => (v === 11 ? "★" : String(v)),
    });
    const labels = wrapper.findAll(".range-slider__label");
    expect(labels).toHaveLength(11);
    expect(labels[0]!.text()).toBe("1");
    expect(labels[10]!.text()).toBe("★");
    // Full-range corridor → every label active.
    expect(wrapper.findAll(".range-slider__label[data-active]")).toHaveLength(11);
  });

  it("renders arbitrary VNodes per stop through the tick slot", () => {
    const wrapper = mount(RangeSlider, {
      props: { modelValue: [10, 11], min: 1, max: 11, step: 1, showTickLabels: true },
      slots: {
        // Scoped slot receiving the stop's value — hosts use it for icons
        // and styled glyphs, exactly like the tier rail's gold ★.
        tick: ({ value }: { value: number }) =>
          h("span", { class: "tick-node" }, value === 11 ? "★" : String(value * 10)),
      },
    });
    const labels = wrapper.findAll(".range-slider__label");
    expect(labels).toHaveLength(11);
    expect(labels[0]!.find(".tick-node").text()).toBe("10");
    expect(labels[10]!.find(".tick-node").text()).toBe("★");
    expect(wrapper.findAll(".range-slider__label[data-active]")).toHaveLength(2);
  });

  it("normalizes an out-of-order / out-of-range modelValue without emitting", () => {
    const { wrapper } = mountSlider([9, 4]);
    const thumbs = wrapper.findAll(".range-slider__thumb");
    // Ordered: lo reads 4, hi reads 9.
    expect(thumbs[0]!.attributes("aria-valuenow")).toBe("4");
    expect(thumbs[1]!.attributes("aria-valuenow")).toBe("9");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });
});

describe("RangeSlider pointer", () => {
  it("jumps the nearer thumb on pointerdown and drags via window moves", async () => {
    const { wrapper, track } = mountSlider([3, 7]);
    // clientX 90 → tier 10: nearer to hi (7) than lo (3) → hi jumps to 10.
    await track.trigger("pointerdown", { pointerId: 1, clientX: 90 });
    expect(lastEmitted(wrapper)).toEqual([3, 10]);
    // Window-level drag continues (the gesture left the element bounds).
    move(100);
    await Promise.resolve();
    expect(lastEmitted(wrapper)).toEqual([3, 11]);
    // pointerup ends the drag — further moves commit nothing.
    up();
    move(0);
    await Promise.resolve();
    expect(lastEmitted(wrapper)).toEqual([3, 11]);
  });

  it("grabs the lo thumb for a press before the corridor and hi after it", async () => {
    const { wrapper, track } = mountSlider([4, 8]);
    await track.trigger("pointerdown", { pointerId: 1, clientX: 0 });
    expect(lastEmitted(wrapper)).toEqual([1, 8]);
    up();
    await track.trigger("pointerdown", { pointerId: 1, clientX: 100 });
    expect(lastEmitted(wrapper)).toEqual([4, 11]);
    up();
  });

  it("never crosses: each thumb stops at the other, ties break by side", async () => {
    const { wrapper, track } = mountSlider([4, 8]);
    // Drag lo (grabbed through a mid-corridor press nearer lo) past hi —
    // it clamps at hi and the pair never reorders. The press itself lands
    // exactly on lo's stop, so only the moves commit.
    await track.trigger("pointerdown", { pointerId: 1, clientX: 30 });
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    move(100);
    await Promise.resolve();
    expect(lastEmitted(wrapper)).toEqual([8, 8]);
    up();
    // Coincident thumbs at 8: a press left of them grabs lo (tie by side).
    await track.trigger("pointerdown", { pointerId: 1, clientX: 40 });
    expect(lastEmitted(wrapper)).toEqual([5, 8]);
    up();
  });

  it("snaps off-grid presses onto the step grid", async () => {
    const { wrapper, track } = mountSlider([1, 11]);
    // clientX 45 → 5.5 → snaps to tier 6 (hi is the nearer thumb).
    await track.trigger("pointerdown", { pointerId: 1, clientX: 45 });
    expect(lastEmitted(wrapper)).toEqual([1, 6]);
    up();
  });
});

describe("RangeSlider keyboard", () => {
  const thumb = (wrapper: VueWrapper, which: "lo" | "hi") =>
    new DOMWrapper(
      wrapper.findAll(".range-slider__thumb").find((th) => th.attributes("data-thumb") === which)!.element,
    );

  /** Press a key on a thumb and feed the emitted pair back — the component
   *  is controlled, so a realistic walk mirrors every emit into the prop. */
  async function press(wrapper: VueWrapper, which: "lo" | "hi", key: string): Promise<Range> {
    await thumb(wrapper, which).trigger("keydown", { key });
    const v = lastEmitted(wrapper)!;
    await wrapper.setProps({ modelValue: v });
    return v;
  }

  it("walks the grid with arrows and strides with PageUp/PageDown", async () => {
    const { wrapper } = mountSlider([3, 7]);
    expect(await press(wrapper, "lo", "ArrowRight")).toEqual([4, 7]);
    expect(await press(wrapper, "lo", "PageDown")).toEqual([1, 7]);
    expect(await press(wrapper, "hi", "ArrowLeft")).toEqual([1, 6]);
    expect(await press(wrapper, "hi", "PageUp")).toEqual([1, 10]);
  });

  it("Home/End jump to the corridor ends without crossing", async () => {
    const { wrapper } = mountSlider([3, 7]);
    expect(await press(wrapper, "lo", "End")).toEqual([7, 7]);
    // Home on hi clamps at lo — the pair stays put (no new emit).
    await thumb(wrapper, "hi").trigger("keydown", { key: "Home" });
    expect(lastEmitted(wrapper)).toEqual([7, 7]);
    // Home on lo walks it to min.
    expect(await press(wrapper, "lo", "Home")).toEqual([1, 7]);
  });

  it("blocks every commit path while disabled", async () => {
    const { wrapper, track } = mountSlider([3, 7], { disabled: true });
    await track.trigger("pointerdown", { pointerId: 1, clientX: 100 });
    move(0);
    await Promise.resolve();
    await thumb(wrapper, "lo").trigger("keydown", { key: "ArrowRight" });
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });
});
