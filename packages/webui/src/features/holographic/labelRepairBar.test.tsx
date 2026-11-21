/**
 * Tests for the floating ship label's three-layer HP bar (the Repair-Party
 * grey recoverable segment). The bar's DOM lives in the shared
 * `@wowsp/holo` HoloLabel the app's map renders — the holo package has no
 * test runner of its own, so its rendering contract is pinned here, from the
 * webui side, with a real mount:
 *
 *  - with a recoverable pool the bar paints green | grey | red, the grey
 *    sized by the pool and the red by whatever is left;
 *  - the grey eats the RED width — the green fill keeps the hull's HP
 *    fraction untouched;
 *  - a pool wider than the lost HP clamps to the lost remainder;
 *  - a host that passes no pool (older replays, the marketing sandbox) gets
 *    the exact historical two-layer bar — no grey, no red element at all;
 *  - a sunk or ghost label never paints a repair segment.
 */
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import { HoloLabel, type HoloLabelData } from "@wowsp/holo";

const BASE: HoloLabelData = {
  key: 1,
  x: 0,
  y: 0,
  role: "ally",
  name: "p01",
  shipName: "Ship",
  hp: 6_000,
  maxHp: 10_000,
};

function bar(label: Partial<HoloLabelData>) {
  const w = mount(HoloLabel, { props: { label: { ...BASE, ...label } } });
  const hpBar = w.find(".holo-label__hp-bar");
  const fill = w.find(".holo-label__hp-fill");
  const gray = w.find(".holo-label__hp-recover");
  const red = w.find(".holo-label__hp-lost");
  return { w, hpBar, fill, gray, red };
}

function styleOf(el: { element: Element }): CSSStyleDeclaration {
  return (el.element as HTMLElement).style;
}

describe("HoloLabel repair segment", () => {
  it("paints green | grey | red and keeps green on the hull's HP", () => {
    const { hpBar, fill, gray, red } = bar({ hpRecoverableFrac: 0.25 });
    expect(hpBar.exists()).toBe(true);
    expect(fill.exists()).toBe(true);
    expect(gray.exists()).toBe(true);
    expect(red.exists()).toBe(true);
    // Green: the current HP fraction, unchanged by the repair pool.
    expect(styleOf(fill).width).toBe("60%");
    // Grey: starts where green ends, spans the recoverable share.
    expect(styleOf(gray).left).toBe("60%");
    expect(styleOf(gray).width).toBe("25%");
    // Red: whatever is left, right of the grey.
    expect(styleOf(red).left).toBe("85%");
    expect(styleOf(red).width).toBe("15%");
  });

  it("eats the red width, never the green's", () => {
    const { fill, gray, red } = bar({ hpRecoverableFrac: 0.5 });
    expect(styleOf(fill).width).toBe("60%");
    expect(styleOf(gray).left).toBe("60%");
    expect(styleOf(gray).width).toBe("40%");
    expect(styleOf(red).width).toBe("0%");
  });

  it("keeps the historical two-layer bar without a pool (feature off)", () => {
    for (const label of [
      {},
      { hpRecoverableFrac: null },
      { hpRecoverableFrac: undefined },
    ] as Partial<HoloLabelData>[]) {
      const { hpBar, fill, gray, red } = bar(label);
      expect(hpBar.exists()).toBe(true);
      expect(fill.exists()).toBe(true);
      expect(styleOf(fill).width).toBe("60%");
      // No grey and no red layer is rendered at all — the bar's look is
      // byte-identical to the pre-feature markup.
      expect(gray.exists()).toBe(false);
      expect(red.exists()).toBe(false);
    }
  });

  it("draws green + red only once the pool is exhausted", () => {
    const { gray, red } = bar({ hpRecoverableFrac: 0 });
    // The feature is ON for this hull (the host knows about its repairs),
    // so the red lost rail stays — the grey segment just collapses.
    expect(gray.exists()).toBe(true);
    expect(styleOf(gray).width).toBe("0%");
    expect(red.exists()).toBe(true);
    expect(styleOf(red).left).toBe("60%");
    expect(styleOf(red).width).toBe("40%");
  });

  it("never paints a repair segment on a sunk or ghost label", () => {
    const dead = bar({ dead: true, hpRecoverableFrac: 0.25 });
    expect(dead.gray.exists()).toBe(false);
    expect(dead.red.exists()).toBe(false);
    const ghost = bar({ ghostText: "gone 12s", hpRecoverableFrac: 0.25 });
    expect(ghost.gray.exists()).toBe(false);
    expect(ghost.red.exists()).toBe(false);
  });

  it("clamps a pool that exceeds the lost HP to the lost remainder", () => {
    const { fill, gray, red } = bar({ hp: 9_000, hpRecoverableFrac: 0.5 });
    expect(styleOf(fill).width).toBe("90%");
    expect(styleOf(gray).left).toBe("90%");
    expect(styleOf(gray).width).toBe("10%");
    expect(styleOf(red).width).toBe("0%");
  });
});
