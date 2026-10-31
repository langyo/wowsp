import { afterEach, describe, expect, it } from "vitest";

import { h, type VNode } from "vue";

import { enableAutoUnmount, mount } from "@vue/test-utils";

import PlaytimeBreakdownPie from "./PlaytimeBreakdownPie";
import type { BreakdownEntry } from "./battleBreakdown";

/**
 * The mounted presentational contract of one 游玩时间 breakdown donut —
 * same-source migrated onto hikari's HkDonutChart: the wrapper owns the
 * props bridge (title + entries + palettes + the measure-word hint and
 * the legendIconOf slot adapter); the chart beneath supplies the ring,
 * the chunked legend and the hover pairing. These tests pin the WRAPPER's
 * contract through the chart's DOM: per-entry ring paths, dot-led legend
 * rows, the measure-word hint on BOTH views of a slice, the legendIconOf
 * glyph swap (dot + hint stay), 5-row legend columns, and the empty
 * state. The ring geometry itself is hikari's own suite's.
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

function mountPie(
  entries: BreakdownEntry[],
  legendIconOf?: (key: string, label: string, hint: string) => VNode | null,
) {
  return mount(PlaytimeBreakdownPie, {
    props: {
      title: "按舰种",
      entries,
      labelOf: (key: string) => `label-${key}`,
      colorOf: (key: string) => COLORS[key] ?? "#C4BDC9",
      unitLabel: "场",
      legendIconOf,
    },
  });
}

enableAutoUnmount(afterEach);

describe("PlaytimeBreakdownPie (HkDonutChart-backed)", () => {
  it("renders the title, one ring path per entry and dot-led legend rows", () => {
    const w = mountPie(entriesOf([["a", 60], ["b", 30], ["c", 10]]));
    expect(w.find(".playtime-breakdown-pie__title").text()).toBe("按舰种");
    const slices = w.findAll(".hk-donut__slice");
    expect(slices).toHaveLength(3);
    expect(slices[0].attributes("d")).toContain("A"); // ring arcs, not strokes
    const rows = w.findAll(".hk-donut__legend-row");
    expect(rows).toHaveLength(3);
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i].find(".hk-donut__legend-dot").exists()).toBe(true);
      expect(rows[i].text()).toContain(`label-${["a", "b", "c"][i]}`);
    }
  });

  it("hints the measure-word string from a slice and its legend row", () => {
    const w = mountPie(entriesOf([["a", 60], ["b", 30], ["c", 10]]));
    const expectHint = "label-a · 60 场 · 60%";
    expect(w.findAll(".hk-donut__slice")[0].attributes("data-hint")).toBe(expectHint);
    expect(w.findAll(".hk-donut__legend-row")[0].attributes("data-hint")).toBe(expectHint);
    // No native <title> tooltips — the app-wide data-hint convention.
    expect(w.find("title").exists()).toBe(false);
  });

  it("swaps a legendIconOf glyph for the label, keeping the dot and hint", () => {
    const w = mountPie(
      entriesOf([["a", 60], ["b", 40]]),
      // The nation-flag shape: a node keyed off the slice, carrying the
      // row's label and full hint (NationFlag's flag-row contract).
      (key, label, hint) =>
        key === "b" ? h("span", { class: "glyph", "data-label": label, "data-hint": hint }) : null,
    );
    const rows = w.findAll(".hk-donut__legend-row");
    // The glyph replaces the text, not the row: dot and row hint stay.
    expect(rows[1].find(".glyph").exists()).toBe(true);
    expect(rows[1].find(".hk-donut__legend-dot").exists()).toBe(true);
    expect(rows[1].attributes("data-hint")).toBe("label-b · 40 场 · 40%");
    expect(rows[1].find(".glyph").attributes("data-label")).toBe("label-b");
    expect(rows[1].find(".glyph").attributes("data-hint")).toBe("label-b · 40 场 · 40%");
    // A null return keeps the text path untouched.
    expect(rows[0].text()).toContain("label-a");
    expect(rows[0].find(".glyph").exists()).toBe(false);
  });

  it("chunks legend rows into 5-row columns", () => {
    const w = mountPie(
      entriesOf([["a", 5], ["b", 5], ["c", 5], ["d", 5], ["e", 5], ["f", 5], ["g", 5]]),
    );
    const cols = w.findAll(".hk-donut__legend-col");
    expect(cols).toHaveLength(2);
    expect(cols[0].findAll(".hk-donut__legend-row")).toHaveLength(5);
    expect(cols[1].findAll(".hk-donut__legend-row")).toHaveLength(2);
  });

  it("renders the empty state when every entry is zero", () => {
    const w = mountPie(entriesOf([["a", 0]]));
    expect(w.find(".hk-donut--empty").exists()).toBe(true);
    expect(w.findAll(".hk-donut__slice")).toHaveLength(0);
  });
});
