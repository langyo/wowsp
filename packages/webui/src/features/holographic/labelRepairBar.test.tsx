/**
 * Tests for the floating ship label's three-layer HP bar (the Repair-Party
 * queued heal segment). The bar's DOM lives in the shared `@wowsp/holo`
 * HoloLabel the app's map renders — the holo package has no test runner of
 * its own, so its rendering contract is pinned here, from the webui side, with
 * a real mount.
 *
 * The look is a three-layer stack (user spec 2026-11-21):
 *
 *     [ solid green (rounded, on top) ] overlaps
 *         [ light green (queued heal) ] overlaps
 *             [ lost red ]
 *
 *  - the SOLID green segment keeps the bar's full rounding and sits at a
 *    HIGHER z than the queued segment, so its rounded right corner covers the
 *    junction;
 *  - the queued (recoverable) segment is a LIGHT GREEN pre-cover, not grey,
 *    and starts ~2px LEFT of the green's right edge (the seam overlap) with NO
 *    rounding of its own;
 *  - the lost-red segment takes the remainder, square at the junction too;
 *  - a pool wider than the lost HP clamps to the lost remainder;
 *  - a host that passes no pool (older replays, the marketing sandbox) gets
 *    the exact historical two-layer bar — no queued, no red element at all;
 *  - a sunk or ghost label never paints a repair segment.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  const queued = w.find(".holo-label__hp-recover");
  const red = w.find(".holo-label__hp-lost");
  return { w, hpBar, fill, queued, red };
}

function styleOf(el: { element: Element }): CSSStyleDeclaration {
  return (el.element as HTMLElement).style;
}

/** HoloLabel.scss with comments stripped (the prose deliberately names the
 *  selectors and the geometry it pins). vitest runs with packages/webui as
 *  its cwd, the same base the other *.styles.test.ts suites read from. */
const scss = readFileSync(
  join(process.cwd(), "..", "holo", "src", "HoloLabel.scss"),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("HoloLabel repair segment", () => {
  it("paints green | light-green | red and keeps green on the hull's HP", () => {
    const { hpBar, fill, queued, red } = bar({ hpRecoverableFrac: 0.25 });
    expect(hpBar.exists()).toBe(true);
    expect(fill.exists()).toBe(true);
    expect(queued.exists()).toBe(true);
    expect(red.exists()).toBe(true);
    // Green: the current HP fraction, unchanged by the repair pool.
    expect(styleOf(fill).width).toBe("60%");
    // Queued: starts 2px LEFT of the green's right edge (seam overlap) and
    // keeps its right edge where the pool ends.
    expect(styleOf(queued).left).toBe("calc(60% - 2px)");
    expect(styleOf(queued).width).toBe("calc(25% + 2px)");
    // Red: whatever is left, right of the queued layer.
    expect(styleOf(red).left).toBe("85%");
    expect(styleOf(red).width).toBe("15%");
  });

  it("eats the red width, never the green's", () => {
    const { fill, queued, red } = bar({ hpRecoverableFrac: 0.5 });
    expect(styleOf(fill).width).toBe("60%");
    expect(styleOf(queued).left).toBe("calc(60% - 2px)");
    expect(styleOf(queued).width).toBe("calc(40% + 2px)");
    expect(styleOf(red).width).toBe("0%");
  });

  it("keeps the historical two-layer bar without a pool (feature off)", () => {
    for (const label of [
      {},
      { hpRecoverableFrac: null },
      { hpRecoverableFrac: undefined },
    ] as Partial<HoloLabelData>[]) {
      const { hpBar, fill, queued, red } = bar(label);
      expect(hpBar.exists()).toBe(true);
      expect(fill.exists()).toBe(true);
      expect(styleOf(fill).width).toBe("60%");
      // No queued and no red layer is rendered at all — the bar's look is
      // byte-identical to the pre-feature markup.
      expect(queued.exists()).toBe(false);
      expect(red.exists()).toBe(false);
    }
  });

  it("draws green + red only once the pool is exhausted", () => {
    const { queued, red } = bar({ hpRecoverableFrac: 0 });
    // The feature is ON for this hull (the host knows about its repairs),
    // so the red lost rail stays — the queued segment just collapses, and a
    // collapsed queue adds NO seam overlap (there is nothing to pre-cover).
    expect(queued.exists()).toBe(true);
    expect(styleOf(queued).width).toBe("0%");
    expect(styleOf(queued).left).toBe("60%");
    expect(red.exists()).toBe(true);
    expect(styleOf(red).left).toBe("60%");
    expect(styleOf(red).width).toBe("40%");
  });

  it("never paints a repair segment on a sunk or ghost label", () => {
    const dead = bar({ dead: true, hpRecoverableFrac: 0.25 });
    expect(dead.queued.exists()).toBe(false);
    expect(dead.red.exists()).toBe(false);
    const ghost = bar({ ghostText: "gone 12s", hpRecoverableFrac: 0.25 });
    expect(ghost.queued.exists()).toBe(false);
    expect(ghost.red.exists()).toBe(false);
  });

  it("clamps a pool that exceeds the lost HP to the lost remainder", () => {
    const { fill, queued, red } = bar({ hp: 9_000, hpRecoverableFrac: 0.5 });
    expect(styleOf(fill).width).toBe("90%");
    expect(styleOf(queued).left).toBe("calc(90% - 2px)");
    expect(styleOf(queued).width).toBe("calc(10% + 2px)");
    expect(styleOf(red).width).toBe("0%");
  });
});

describe("HoloLabel three-layer stack geometry (stylesheet contract)", () => {
  it("paints the queued layer UNDER the solid green (green on top)", () => {
    // The green's rounded right corner must cover the queued layer's square
    // left edge — the absolute layers otherwise paint over the static fill.
    expect(scss).toMatch(/&__hp-fill\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*2;/s);
    expect(scss).toMatch(/&__hp-recover\s*\{[^}]*z-index:\s*1;/s);
    expect(scss).toMatch(/&__hp-lost\s*\{[^}]*z-index:\s*0;/s);
  });

  it("keeps the green's full rounding and squares the queued/red layers", () => {
    expect(scss).toMatch(/&__hp-fill\s*\{[^}]*border-radius:\s*2px;/s);
    expect(scss).toMatch(
      /&__hp-recover,\s*&__hp-lost\s*\{[^}]*border-radius:\s*0;/s,
    );
  });

  it("keeps the HP readout on top of every layer", () => {
    // The green fill is deliberately raised (z-index 2) to cover the seam, so
    // the numbers need an explicit level above it — an auto z-index would put
    // them UNDER the opaque green.
    expect(scss).toMatch(/&__hp-text\s*\{[^}]*z-index:\s*3;/s);
  });

  it("colors the queued pre-cover a distinct grey, never the lost red", () => {
    const scss = readFileSync(
      join(__dirname, "../../../../holo/src/HoloLabel.scss"),
      "utf8",
    );
    // The queued layer is its OWN grey (distinct from the lost red and the
    // dark track), in both themes.
    expect(scss).toContain("rgb(148 163 184 / 62%)");
    expect(scss).toContain("rgb(100 116 139 / 65%)");
    expect(scss).not.toContain("158 224 168");
    expect(scss).not.toContain("96 174 112");
  });
});
