import { afterEach, describe, expect, it } from "vitest";

import { enableAutoUnmount, mount } from "@vue/test-utils";

import PlaytimeBreakdownPie from "./PlaytimeBreakdownPie";
import type { BreakdownEntry } from "./battleBreakdown";

/**
 * The mounted presentational contract of one 游玩时间 breakdown donut —
 * the water-meter charts' (ShipDistCharts) presentation adapted to four
 * blocks per row: path-drawn ring, DOM legend rows UNDER it chunked into
 * 5-row columns, every row leading with the slice-color dot, percents
 * ONLY in the hover hint (never row text), and the slice↔legend hover
 * pairing (entering one side lifts the pair, dims the block's siblings).
 * The ring geometry itself is donutGeometry's, already exact-string
 * covered in ShipDistCharts.test.ts — these tests pin what that file
 * cannot see: how the component wires it into DOM.
 */

const COLORS: Record<string, string> = {
  a: "#4e8fd9",
  b: "#e05263",
  c: "#6dc178",
};
const entriesOf = (counts: [string, number][]): BreakdownEntry[] => {
  const total = counts.reduce((acc, [, n]) => acc + n, 0);
  return counts.map(([key, count]) => ({ key, count, share: count / total }));
};

function mountPie(entries: BreakdownEntry[]) {
  return mount(PlaytimeBreakdownPie, {
    props: {
      title: "按舰种",
      entries,
      labelOf: (key: string) => `label-${key}`,
      colorOf: (key: string) => COLORS[key] ?? "#C4BDC9",
      unitLabel: "场",
    },
  });
}

enableAutoUnmount(afterEach);

describe("PlaytimeBreakdownPie", () => {
  it("draws one ring path per entry and legend rows with dot + label only", () => {
    const w = mountPie(entriesOf([["a", 60], ["b", 30], ["c", 10]]));
    const slices = w.findAll(".playtime-pie__slice");
    expect(slices).toHaveLength(3);
    expect(slices[0].attributes("d")).toContain("A"); // ring arcs, not strokes
    const rows = w.findAll(".playtime-pie__legend-item");
    expect(rows).toHaveLength(3);
    for (let i = 0; i < rows.length; i++) {
      const dot = rows[i].find(".playtime-pie__legend-dot");
      expect(dot.exists()).toBe(true);
      expect(dot.attributes("style")).toContain(`background: ${COLORS[["a", "b", "c"][i]]}`);
      expect(rows[i].text()).toBe(`label-${["a", "b", "c"][i]}`);
      // Percent lives in the hint only, never in the row's text.
      expect(rows[i].text()).not.toContain("%");
    }
  });

  it("hints the same string from a slice and its legend row", () => {
    const w = mountPie(entriesOf([["a", 60], ["b", 30], ["c", 10]]));
    expect(w.findAll(".playtime-pie__slice")[0].attributes("data-hint")).toBe(
      "label-a · 60 场 · 60%",
    );
    expect(w.findAll(".playtime-pie__legend-item")[0].attributes("data-hint")).toBe(
      "label-a · 60 场 · 60%",
    );
    // No native <title> tooltips — the app-wide data-hint convention.
    expect(w.find("title").exists()).toBe(false);
  });

  it("chunks legend rows into 5-row columns", () => {
    const w = mountPie(
      entriesOf([["a", 5], ["b", 5], ["c", 5], ["d", 5], ["e", 5], ["f", 5], ["g", 5]]),
    );
    const cols = w.findAll(".playtime-pie__legend-col");
    expect(cols).toHaveLength(2);
    expect(cols[0].findAll(".playtime-pie__legend-item")).toHaveLength(5);
    expect(cols[1].findAll(".playtime-pie__legend-item")).toHaveLength(2);
  });

  it("pairs a legend row's hover with its slice and dims the siblings", async () => {
    const w = mountPie(entriesOf([["a", 60], ["b", 30], ["c", 10]]));
    await w.findAll(".playtime-pie__legend-item")[1].trigger("mouseenter");
    const rows = w.findAll(".playtime-pie__legend-item");
    expect(rows[1].classes()).toContain("is-hot");
    expect(rows[0].classes()).toContain("is-dim");
    expect(rows[2].classes()).toContain("is-dim");
    const slices = w.findAll(".playtime-pie__slice");
    expect(slices[1].classes()).toContain("is-hot");
    expect(slices[0].classes()).toContain("is-dim");
    // Leaving clears the block's focus entirely.
    await rows[1].trigger("mouseleave");
    expect(w.findAll(".playtime-pie__legend-item")[1].classes()).not.toContain("is-hot");
    expect(slices[1].classes()).not.toContain("is-hot");
  });
});
