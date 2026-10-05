import { describe, expect, it } from "vitest";

import {
  bucketDaily,
  buildHeatGrid,
  fmtAxis,
  fmtDuration,
  heatLevel,
  niceMaxSeconds,
  trendBars,
} from "./playtimeAgg";

/**
 * Pinned clock: 2026-10-05 15:00 local — a MONDAY, which makes the
 * Monday-start week / heatmap grid arithmetic exact (the current week's
 * Monday IS today).
 */
const NOW = new Date(2026, 9, 5, 15, 0, 0);

describe("fmtDuration / fmtAxis", () => {
  it("formats compact durations", () => {
    expect(fmtDuration(0)).toBe("0m");
    expect(fmtDuration(59 * 60)).toBe("59m");
    expect(fmtDuration(3600)).toBe("1h 00m");
    expect(fmtDuration(284 * 3600 + 19 * 60)).toBe("284h 19m");
    expect(fmtDuration(-5)).toBe("0m"); // negative input clamps
  });

  it("formats axis ticks as whole hours or minutes", () => {
    expect(fmtAxis(0)).toBe("0m");
    expect(fmtAxis(1800)).toBe("30m");
    expect(fmtAxis(3600)).toBe("1h");
    expect(fmtAxis(4 * 3600)).toBe("4h");
  });
});

describe("niceMaxSeconds", () => {
  it("rounds the window max up to a human tick", () => {
    expect(niceMaxSeconds(0)).toBe(3600);
    expect(niceMaxSeconds(1800)).toBe(1800); // sub-hour floor
    expect(niceMaxSeconds(5400)).toBe(2 * 3600); // 1.5h skips to 2h — halves stay clean
    expect(niceMaxSeconds(3.7 * 3600)).toBe(4 * 3600);
    expect(niceMaxSeconds(25 * 3600)).toBe(2 * 86_400); // multi-day rounds to days
  });
});

describe("bucketDaily", () => {
  const daily = [
    { date: "2026-09-28", seconds: 600 },
    { date: "2026-10-04", seconds: 1200 },
    { date: "2026-10-01", seconds: 300 },
    { date: "2026-09-15", seconds: 700 },
  ];

  it("zero-fills the last 15 days", () => {
    const buckets = bucketDaily(daily, "15d", NOW, "en-US");
    expect(buckets).toHaveLength(15);
    expect(buckets[0].label).toBe("09-21");
    expect(buckets[14].label).toBe("10-05");
    // 10-04 sits two cells before today and nothing else carries data.
    expect(buckets[13].seconds).toBe(1200);
    expect(buckets[14].seconds).toBe(0);
    expect(buckets[0].seconds).toBe(0);
    expect(buckets[13].hint).toBe("10-04 · 20m");
  });

  it("sums Monday-start weeks", () => {
    const buckets = bucketDaily(daily, "12w", NOW, "en-US");
    expect(buckets).toHaveLength(12);
    // The current week's Monday IS 2026-10-05; the previous week starts
    // 09-28 and holds 09-28 (600) + 10-01 (300) + 10-04 (1200).
    expect(buckets[11].label).toBe("10-05");
    expect(buckets[11].seconds).toBe(0);
    expect(buckets[10].label).toBe("09-28");
    expect(buckets[10].seconds).toBe(2100);
    expect(buckets[10].hint).toBe("09-28 ~ 10-04 · 35m");
  });

  it("sums calendar months with localized labels", () => {
    const buckets = bucketDaily(daily, "12m", NOW, "en-US");
    expect(buckets).toHaveLength(12);
    expect(buckets[11].seconds).toBe(300 + 1200); // October: the 1st + the 4th
    expect(buckets[10].seconds).toBe(700 + 600); // September: the 15th + the 28th
    expect(buckets[10].label).toBe("Sep");
    // zh locale labels months as "9月".
    const zh = bucketDaily(daily, "12m", NOW, "zh-CN");
    expect(zh[10].label).toBe("9月");
  });
});

describe("heatLevel", () => {
  it("maps values to quartile levels against the max", () => {
    expect(heatLevel(0, 100)).toBe(0);
    expect(heatLevel(1, 100)).toBe(1);
    expect(heatLevel(50, 100)).toBe(2);
    expect(heatLevel(75, 100)).toBe(3);
    expect(heatLevel(100, 100)).toBe(4);
    expect(heatLevel(150, 100)).toBe(4); // clamped
    expect(heatLevel(10, 0)).toBe(0); // no max → no level
  });
});

describe("buildHeatGrid", () => {
  const daily = [
    { date: "2026-10-05", value: 7200 },
    { date: "2025-10-06", value: 3600 },
  ];

  it("builds 53 Monday-first columns ending with the current week", () => {
    const grid = buildHeatGrid(daily, NOW, "en-US");
    expect(grid.columns).toHaveLength(53);
    expect(grid.columns.every((c) => c.length === 7)).toBe(true);
    // The first cell is the Monday 52 weeks back: 2025-10-06.
    expect(grid.columns[0][0].key).toBe("2025-10-06");
    // Today (Monday) is the last column's FIRST row; the rest of that
    // column is the future and stays blank.
    expect(grid.columns[52][0].key).toBe("2026-10-05");
    expect(grid.columns[52][0].value).toBe(7200);
    expect(grid.columns[52][1].future).toBe(true);
    expect(grid.columns[52][1].key).toBe("");
    expect(grid.maxValue).toBe(7200);
    expect(grid.columns[52][0].level).toBe(4);
    expect(grid.columns[0][0].level).toBe(2); // 3600 of a 7200 max
  });

  it("anchors one month label per month on the day-1 column", () => {
    const grid = buildHeatGrid(daily, NOW, "en-US");
    // The grid starts on 2025-10-06, so 2025-10-01 is BEFORE it — the
    // labels run 2025-11 .. 2026-10, twelve in total.
    expect(grid.months).toHaveLength(12);
    expect(grid.months[0].label).toBe("Nov");
    expect(grid.months[11].label).toBe("Oct");
    // The last label sits on the column containing 2026-10-01.
    const octCol = grid.months[11].col;
    expect(grid.columns[octCol].some((c) => c.key === "2026-10-01")).toBe(true);
  });
});

describe("trendBars", () => {
  it("renders one slot per bucket with rounded-top geometry", () => {
    const layout = trendBars([0, 3600, 1800]);
    expect(layout.bars).toHaveLength(3);
    expect(layout.bars[0].path).toBe(""); // zero bucket draws nothing
    expect(layout.bars[1].path).toContain("Q"); // top corners are rounded
    // Slot + bar metrics: 3 slots over the 640-2×44 plot, capped at 36px.
    expect(layout.bars[1].barWidth).toBe(36);
    expect(layout.bars[1].centerX).toBeCloseTo(44 + ((640 - 88) / 3) * 1.5, 0);
    // Gridlines: 0 / half / nice max.
    expect(layout.gridlines.map((g) => g.seconds)).toEqual([0, 1800, 3600]);
  });

  it("uses a human scale even when all buckets are empty", () => {
    const layout = trendBars([0, 0, 0]);
    expect(layout.gridlines.map((g) => g.seconds)).toEqual([0, 1800, 3600]);
    expect(layout.bars.every((b) => b.path === "")).toBe(true);
  });
});
