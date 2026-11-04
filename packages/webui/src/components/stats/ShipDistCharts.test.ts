/** Column math, SVG geometry and the mounted DOM legend for the
 *  ship-distribution charts. chunkLegendItems must be pure, order-
 *  preserving and fully deterministic — the number of columns a donut's
 *  legend shows depends only on it (5 rows per column: 6 ship types →
 *  5+1 over two columns, 14 nations → 5+5+4 over three). donutSlices
 *  generates the ring arcs, so its angle math, radii and the degenerate
 *  full-circle arc all carry exact-string coverage here (the tier
 *  histogram renders hikari's HkBarChart since the #1736 chart wave);
 *  the percentInt tests pin the
 *  legend-hint/tooltip integer agreement against double rounding (legend
 *  rows show no percent text — percents live in the hover hint only).
 *
 *  The mounted tests stub the offline ship DB (shipOfflineEntry) and pin
 *  the presentational contract the pure helpers cannot see: EVERY legend
 *  row of both donuts leads with the slice-color dot — paired with the
 *  localized name for ship types, the nation flag for nations (a flag
 *  row without its dot gives no cue which ring slice the nation owns). */
import { afterEach, describe, expect, it, vi } from "vitest";

import { enableAutoUnmount, mount } from "@vue/test-utils";

import { t } from "@/i18n";
import ShipDistCharts, {
  chunkLegendItems,
  donutSlices,
  sliceHint,
  toLegendItems,
  type DistDatum,
} from "./ShipDistCharts";

// The mounted tests below aggregate through shipOfflineEntry; stubbing the
// module keeps the real bundled game-data DB (and its shifting ship IDs)
// out of the test. Three classes across three canonical nations fill both
// legends deterministically (battles-desc is the input order); the tier-11
// supership entry mounts only in the tier-histogram star test.
const OFFLINE_DB = vi.hoisted(() => {
  const entry = (index: string, tier: number, type: string, nation: string) => ({
    index,
    tier,
    type,
    nation,
    names: {},
  });
  return {
    11: entry("A11", 10, "AirCarrier", "japan"),
    22: entry("B22", 8, "Battleship", "usa"),
    33: entry("D33", 6, "Destroyer", "germany"),
    44: entry("S44", 11, "Cruiser", "usa"),
  } as Record<string, ReturnType<typeof entry>>;
});

vi.mock("@/features/holographic/modelLoader", () => ({
  shipOfflineEntry: (shipId: number | string | undefined) =>
    shipId == null ? null : (OFFLINE_DB[String(shipId)] ?? null),
  nationNameFromDb: () => null,
}));

/** Shorthand: the per-column item counts for a chunking run. */
function shape(items: number[], size: number): number[] {
  return chunkLegendItems(items, size).map((col) => col.length);
}

describe("chunkLegendItems", () => {
  it("returns no columns for an empty legend", () => {
    expect(chunkLegendItems([], 5)).toEqual([]);
  });

  it("keeps up to `size` items in a single column", () => {
    expect(chunkLegendItems(["a"], 5)).toEqual([["a"]]);
    expect(chunkLegendItems([1, 2, 3, 4, 5], 5)).toEqual([[1, 2, 3, 4, 5]]);
  });

  it("spills overflow into further columns of the same height", () => {
    // 6 ship types → 2 columns.
    expect(chunkLegendItems([1, 2, 3, 4, 5, 6], 5)).toEqual([
      [1, 2, 3, 4, 5],
      [6],
    ]);
    // 14 nations → 3 columns.
    expect(shape(Array.from({ length: 14 }, (_, i) => i), 5)).toEqual([5, 5, 4]);
  });

  it("fills columns top-to-bottom in input order", () => {
    const columns = chunkLegendItems(["a", "b", "c", "d", "e", "f", "g"], 3);
    expect(columns).toEqual([
      ["a", "b", "c"],
      ["d", "e", "f"],
      ["g"],
    ]);
  });

  it("clamps a non-positive column size to one row per column", () => {
    expect(chunkLegendItems(["a", "b"], 0)).toEqual([["a"], ["b"]]);
    expect(chunkLegendItems(["a", "b"], -3)).toEqual([["a"], ["b"]]);
  });
});

/** Identity label/color resolvers so passthrough is observable. */
const identity = {
  labelOf: (code: string) => `L(${code})`,
  colorOf: (code: string) => `C(${code})`,
};

describe("donutSlices", () => {
  it("returns no slices for empty or all-zero input", () => {
    expect(donutSlices([], identity)).toEqual([]);
    expect(
      donutSlices(
        [
          ["a", 0],
          ["b", -3],
        ],
        identity,
      ),
    ).toEqual([]);
  });

  it("drops non-positive entries but keeps the share base consistent", () => {
    // 0/-3 filtered; 75/25 of the SHOWN sum.
    const slices = donutSlices(
      [
        ["a", 75],
        ["b", 25],
        ["dead", 0],
      ],
      identity,
    );
    expect(slices.map((s) => s.percent)).toEqual([75, 25]);
  });

  it("starts at 12 o'clock and lays slices out clockwise", () => {
    // 150 viewBox → center (75,75), outer 51, inner 30. First slice 75%
    // sweeps 270°: M at the top point, large-arc flag set, and the outer
    // arc lands on the LEFT extreme (angle -90+270 = 180°).
    const [big, small] = donutSlices(
      [
        ["a", 75],
        ["b", 25],
      ],
      identity,
    );
    expect(big!.path).toBe(
      "M 75 24 A 51 51 0 1 1 24 75 L 45 75 A 30 30 0 1 0 75 45 Z",
    );
    // The 25% slice starts exactly where the big one ended (left extreme)
    // and its 90° small arc closes the ring back at the 12 o'clock point.
    expect(small!.path).toBe(
      "M 24 75 A 51 51 0 0 1 75 24 L 75 45 A 30 30 0 0 0 45 75 Z",
    );
  });

  it("passes code/label/value/fill through", () => {
    const slices = donutSlices([["cruiser", 10]], identity);
    expect(slices[0]).toMatchObject({
      code: "cruiser",
      label: "L(cruiser)",
      value: 10,
      percent: 100,
      percentInt: 100,
      fill: "C(cruiser)",
    });
  });

  it("rounds percents to two decimals", () => {
    const slices = donutSlices(
      [
        ["a", 1],
        ["b", 2],
      ],
      identity,
    );
    expect(slices.map((s) => s.percent)).toEqual([33.33, 66.67]);
    expect(slices.map((s) => s.percentInt)).toEqual([33, 67]);
  });

  it("keeps percents out of legend text and reuses sliceHint verbatim", () => {
    // 33496/100000 = 33.496%: the 2-decimal display value is 33.5, so
    // re-rounding IT would show 34 while the raw share rounds to 33.
    // percentInt is rounded once from the raw share; legend rows carry NO
    // percent text — the row's hover hint IS sliceHint, the exact string
    // the slice tooltip renders.
    expect(toLegendItems([])).toEqual([]);
    const slices = donutSlices(
      [
        ["a", 33496],
        ["b", 66504],
      ],
      identity,
    );
    expect(slices[0]!.percent).toBe(33.5);
    expect(slices[0]!.percentInt).toBe(33);
    const [legendItem] = toLegendItems(slices);
    expect(legendItem!.text).toBe("L(a)");
    expect(legendItem!.text).not.toContain("33");
    // Expected hint built with the SAME t() so the assertion holds whether
    // or not another test already loaded the locale messages.
    expect(legendItem!.hint).toBe(`L(a) · ${t("stats.dist.battles")} 33496 · 33%`);
    expect(sliceHint(slices[0]!)).toBe(legendItem!.hint);
  });

  it("honors custom viewBox and radii", () => {
    const slices = donutSlices([["a", 60], ["b", 40]], {
      ...identity,
      viewBox: 200,
      outerR: 90,
      innerR: 50,
    });
    // Center (100,100): top point at 100-90, first sweep 216° → large arc.
    expect(slices[0]!.path).toContain("M 100 10 A 90 90 0 1 1 ");
    expect(slices[0]!.path).toContain("A 50 50 0 1 0 ");
  });

  it("draws a 100% slice as two 180° half-arcs, not a degenerate arc", () => {
    const [slice] = donutSlices([["only", 42]], identity);
    // A single 360° arc would have start == end and render nothing; the
    // ring is split at 0°/180° into two well-formed subpaths.
    const subpaths = slice!.path.split("M ").filter(Boolean);
    expect(subpaths).toHaveLength(2);
    // Right extreme → left extreme (bottom half), then left → right (top
    // half): both outer arcs sweep clockwise, both inner arcs sweep back.
    expect(slice!.path).toBe(
      "M 126 75 A 51 51 0 0 1 24 75 L 45 75 A 30 30 0 0 0 105 75 Z " +
        "M 24 75 A 51 51 0 0 1 126 75 L 105 75 A 30 30 0 0 0 45 75 Z",
    );
    // No zero-length arc: every arc endpoint pair differs.
    expect(slice!.path).not.toMatch(/A (\d+) (\d+) 0 [01] 1 (\d+) \3 /);
  });
});

describe("mounted DOM legend", () => {
  enableAutoUnmount(afterEach);

  const ships: DistDatum[] = [
    { shipId: 11, battles: 10 },
    { shipId: 22, battles: 8 },
    { shipId: 33, battles: 4 },
  ];

  it("leads every legend row of both donuts with the slice-color dot", () => {
    const wrapper = mount(ShipDistCharts, { props: { ships } });
    // Three ship types + three nations → three rows per legend, six total.
    const rows = wrapper.findAll(".hk-donut__legend-row");
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      // The dot paints the slice color inline — without it a flag row
      // gives no cue which ring slice the nation owns.
      const dot = row.find(".hk-donut__legend-dot");
      expect(dot.exists()).toBe(true);
      expect(dot.attributes("style")).toContain("background");
    }
    // Both aggregations produced visible slices for the rows to map onto.
    expect(wrapper.findAll(".hk-donut__slice")).toHaveLength(6);
  });

  it("pairs the dot with the name for ship types and with the flag for nations", () => {
    const wrapper = mount(ShipDistCharts, { props: { ships } });
    const [typeBody, nationBody] = wrapper.findAll(".ship-dist-charts__pie-body");
    // hikari's legend row owns the dot + label cell; the legendIcon slot
    // replaces the label's TEXT with the nation flag (NationFlag's
    // flag-row contract), so the two blocks differ in the label cell only.
    const typeRows = typeBody!.findAll(".hk-donut__legend-row");
    const nationRows = nationBody!.findAll(".hk-donut__legend-row");
    expect(typeRows).toHaveLength(3);
    expect(nationRows).toHaveLength(3);
    for (const row of typeRows) {
      expect(row.find(".hk-donut__legend-label").exists()).toBe(true);
      expect(row.find(".nation-flag").exists()).toBe(false);
    }
    for (const row of nationRows) {
      expect(row.find(".hk-donut__legend-label .nation-flag").exists()).toBe(true);
    }
  });

  it("counts supership battles in the tier-11 slot, star-marked", () => {
    const wrapper = mount(ShipDistCharts, {
      props: { ships: [{ shipId: 44, battles: 3 }] },
    });
    // The supership's battles reach the eleventh bin: one bar renders,
    // and its hint keeps the numeric tier so the star mark stays
    // self-explanatory.
    const bars = wrapper.findAll(".hk-bar-chart__bar");
    expect(bars).toHaveLength(1);
    expect(bars[0]!.attributes("data-hint")).toBe(
      `${t("ships.tier")} 11 · ${t("stats.dist.battles")} 3`,
    );
    // Tiers 1–10 keep their numeral; the supership slot swaps the numeral
    // for the lucide Star icon via hikari's icon normalization — a nested
    // <svg> centered on the slot, never a text ★ glyph.
    expect(wrapper.findAll(".hk-bar-chart__x")).toHaveLength(10);
    const star = wrapper.find(".hk-bar-chart__xmark");
    expect(star.exists()).toBe(true);
    expect(star.element.tagName.toLowerCase()).toBe("svg");
  });

  it("hovering a bar raises it and dims its siblings via activeIndex", async () => {
    const wrapper = mount(ShipDistCharts, { props: { ships } });
    const bars = wrapper.findAll(".hk-bar-chart__bar");
    await bars[1]!.trigger("mouseenter");
    expect(bars[1]!.attributes("data-hot")).toBeDefined();
    expect(bars[0]!.attributes("data-dim")).toBeDefined();
    expect(bars[2]!.attributes("data-dim")).toBeDefined();
    // The value labels do not dim (hikari renders them statically);
    // mouseleave clears the pair.
    await bars[1]!.trigger("mouseleave");
    expect(bars[1]!.attributes("data-hot")).toBeUndefined();
    expect(bars[0]!.attributes("data-dim")).toBeUndefined();
  });
  it("carries the forced-row modifier class only when the prop is set", () => {
    // The class is the whole contract: the forced variant's root becomes
    // hikari's horizontal scroll container (ShipDistCharts.scss hangs the
    // one-row layout + overlay-bar region on it), so a lost binding would
    // silently return the lookup screen to the stacked narrow layout.
    const stacked = mount(ShipDistCharts, { props: { ships } });
    expect(stacked.classes()).not.toContain("ship-dist-charts--forced-row");
    const forced = mount(ShipDistCharts, { props: { ships, forcedRow: true } });
    expect(forced.classes()).toContain("ship-dist-charts--forced-row");
    // The base class must coexist on the same element — the container's
    // own row-host rules (width, gap, stretch) ride on it.
    expect(forced.classes()).toContain("ship-dist-charts");
  });

  // Hover focus contract: the hovered shape (bar / slice / legend row)
  // gets is-hot, its siblings in the SAME block get is-dim, and nothing
  // ever leaks across blocks. Class-level only here — the paint (opacity/
  // filter) is SCSS; geometry stays frozen by contract.

  it("hovering a slice lifts it, dims its siblings and lights its legend row", async () => {
    const wrapper = mount(ShipDistCharts, { props: { ships } });
    const [typeBody, nationBody] = wrapper.findAll(".ship-dist-charts__pie-body");
    const slices = typeBody!.findAll(".hk-donut__slice");
    const rows = typeBody!.findAll(".hk-donut__legend-row");
    await slices[0]!.trigger("mouseenter");
    expect(slices[0]!.classes()).toContain("is-hot");
    expect(slices[1]!.classes()).toContain("is-dim");
    expect(slices[2]!.classes()).toContain("is-dim");
    // The legend row of the same block follows the slice…
    expect(rows[0]!.classes()).toContain("is-hot");
    expect(rows[1]!.classes()).toContain("is-dim");
    // …and the other blocks stay untouched (no cross-block leaking:
    // each HkDonutChart owns its own focus state).
    const nationSlices = nationBody!.findAll(".hk-donut__slice");
    for (const slice of nationSlices) {
      expect(slice.classes()).not.toContain("is-hot");
      expect(slice.classes()).not.toContain("is-dim");
    }
    await slices[0]!.trigger("mouseleave");
    expect(slices[0]!.classes()).not.toContain("is-hot");
    expect(slices[1]!.classes()).not.toContain("is-dim");
  });

  it("hovering a legend row highlights its ring slice back", async () => {
    const wrapper = mount(ShipDistCharts, { props: { ships } });
    const [typeBody, nationBody] = wrapper.findAll(".ship-dist-charts__pie-body");
    const rows = typeBody!.findAll(".hk-donut__legend-row");
    await rows[2]!.trigger("mouseenter");
    expect(rows[2]!.classes()).toContain("is-hot");
    expect(rows[0]!.classes()).toContain("is-dim");
    const slices = typeBody!.findAll(".hk-donut__slice");
    expect(slices[2]!.classes()).toContain("is-hot");
    expect(slices[0]!.classes()).toContain("is-dim");
    // Nation block untouched by a type-block hover.
    for (const slice of nationBody!.findAll(".hk-donut__slice")) {
      expect(slice.classes()).not.toContain("is-dim");
    }
  });

  it("a data swap under a held pointer clears the dead hover key", async () => {
    // The hovered element can unmount without firing mouseleave (browsers
    // skip removed nodes); HkDonutChart's entries watch resets the block's
    // key (0.55.261+), or every surviving row would stay stuck at is-dim.
    const wrapper = mount(ShipDistCharts, { props: { ships } });
    const slices = wrapper.findAll(".hk-donut__slice");
    await slices[0]!.trigger("mouseenter");
    expect(slices[1]!.classes()).toContain("is-dim");
    await wrapper.setProps({ ships: [{ shipId: 33, battles: 4 }] });
    // Scope to the type donut — the wrapper-wide query would count the
    // nation donut's surviving slice too.
    const after = wrapper
      .findAll(".ship-dist-charts__pie-body")[0]!
      .findAll(".hk-donut__slice");
    // Only the destroyer survives — the vanished carrier key must not
    // dim it (nor leave it hot).
    expect(after).toHaveLength(1);
    expect(after[0]!.classes()).not.toContain("is-dim");
    expect(after[0]!.classes()).not.toContain("is-hot");
  });
});
