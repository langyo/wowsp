import { describe, expect, it } from "vitest";

import {
  bucketDaily,
  buildHeatGrid,
  fmtAxis,
  fmtDuration,
  heatLevel,
  heatWeeks,
  HEAT_MAX_WEEKS,
  HEAT_MIN_WEEKS,
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
    const grid = buildHeatGrid(daily, NOW, "en-US", "all");
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
    const grid = buildHeatGrid(daily, NOW, "en-US", "all");
    // The grid starts on 2025-10-06, so 2025-10-01 is BEFORE it — the
    // labels run 2025-11 .. 2026-10, twelve in total.
    expect(grid.months).toHaveLength(12);
    expect(grid.months[0].label).toBe("Nov");
    expect(grid.months[11].label).toBe("Oct");
    // The last label sits on the column containing 2026-10-01.
    const octCol = grid.months[11].col;
    expect(grid.columns[octCol].some((c) => c.key === "2026-10-01")).toBe(true);
  });

  it("extends the window back to a point older than 52 weeks", () => {
    // 2025-06-22 is a Sunday; its Monday anchor is 2025-06-16, 68 weeks
    // before 2026-10-05 → 69 columns, and the point's own cell lands on
    // the first column's Sunday row. A fixed 53-week window would have
    // dropped this day off its left edge entirely.
    const grid = buildHeatGrid(
      [
        { date: "2025-06-22", value: 2 },
        { date: "2026-10-05", value: 4 },
      ],
      NOW,
      "en-US",
      "all",
    );
    expect(grid.columns).toHaveLength(69);
    expect(grid.columns[0][0].key).toBe("2025-06-16");
    expect(grid.columns[0][6].key).toBe("2025-06-22");
    expect(grid.columns[0][6].value).toBe(2);
    expect(grid.columns[68][0].value).toBe(4);
  });

  it("caps the window at three years and drops what falls outside", () => {
    const grid = buildHeatGrid([{ date: "2010-01-04", value: 1 }], NOW, "en-US", "all");
    expect(grid.columns).toHaveLength(HEAT_MAX_WEEKS);
    // The 2010 point predates even the capped window: no cell carries it.
    expect(grid.columns.every((c) => c.every((cell) => cell.value === 0))).toBe(true);
  });

  it("defaults to the rolling past year regardless of older points", () => {
    // A 2023 point would stretch the "all" window to its 156-week cap —
    // the null selection stays the fixed 53-week GitHub year and drops
    // what falls off its left edge.
    const grid = buildHeatGrid(
      [
        { date: "2023-03-01", value: 1 },
        { date: "2026-10-05", value: 3 },
      ],
      NOW,
      "en-US",
      null,
    );
    expect(grid.columns).toHaveLength(HEAT_MIN_WEEKS);
    expect(grid.columns[0][0].key).toBe("2025-10-06");
    expect(grid.columns[52][0].key).toBe("2026-10-05");
    // The 2023 point fell off the left edge: only the 2026-10-05 cell is
    // hot.
    const hot = grid.columns.flat().filter((c) => c.value > 0);
    expect(hot.map((c) => c.key)).toEqual(["2026-10-05"]);
  });

  it("shows exactly the picked calendar year, whole even mid-year", () => {
    // 2025: Jan 1 is a Wednesday → the window anchors to Monday 2024-12-30
    // and runs to Wednesday 2025-12-31 — 53 columns; the 2025-10-06 point
    // lands mid-grid while the 2026 one stays out.
    const grid = buildHeatGrid(daily, NOW, "en-US", 2025);
    expect(grid.columns[0][0].key).toBe("2024-12-30");
    expect(grid.columns).toHaveLength(53);
    // The trailing week is whole (Monday-start grid), so it spills into
    // 2026: the last column runs 2025-12-29 .. 2026-01-04 with the year's
    // last day on its Wednesday row.
    const last = grid.columns[52];
    expect(last[0].key).toBe("2025-12-29");
    expect(last[2].key).toBe("2025-12-31");
    // The 2025-10-06 point lands mid-grid (its Monday) while the 2026 one
    // stays out.
    expect(grid.columns[40][0].key).toBe("2025-10-06");
    expect(grid.columns[40][0].value).toBe(3600);

    // The CURRENT year renders WHOLE even mid-year: 2026 anchors to
    // Monday 2025-12-29 and runs through Dec 31 — 53 columns; days after
    // the pinned today stay in their cells flagged future (the component
    // hatches them).
    const current = buildHeatGrid(daily, NOW, "en-US", 2026);
    expect(current.columns).toHaveLength(53);
    expect(current.columns[0][0].key).toBe("2025-12-29");
    // The 2026-10-05 point lands mid-grid on its Monday, exactly where
    // the old ends-today window put it.
    expect(current.columns[40][0].key).toBe("2026-10-05");
    expect(current.columns[40][0].value).toBe(7200);
    // The tail past today is all future: 2026-12-31 (a Thursday) pulls
    // the last column to Monday 2026-12-28 (hence 53 columns total), and
    // those cells carry no key and no value — hatch fodder only.
    const tail = current.columns[52];
    expect(tail.every((cell) => cell.future)).toBe(true);
    expect(tail[0].key).toBe("");
    expect(tail[0].value).toBe(0);
    // Only future cells blank out; every arrived day keeps its key.
    expect(
      current.columns.every((c) => c.every((cell) => cell.future === (cell.key === ""))),
    ).toBe(true);
  });
});

describe("heatWeeks", () => {
  it("floors at one year and ignores junk keys", () => {
    expect(heatWeeks([], NOW)).toBe(HEAT_MIN_WEEKS);
    expect(heatWeeks([{ date: "junk", value: 1 }], NOW)).toBe(HEAT_MIN_WEEKS);
    expect(heatWeeks([{ date: "2026-10-01", value: 1 }], NOW)).toBe(HEAT_MIN_WEEKS);
  });

  it("spans to the earliest point's Monday anchor", () => {
    // Sunday 2025-06-22 anchors to Monday 2025-06-16 = 68 weeks back.
    expect(heatWeeks([{ date: "2025-06-22", value: 1 }], NOW)).toBe(69);
    // A Monday point anchors to itself.
    expect(heatWeeks([{ date: "2025-10-06", value: 1 }], NOW)).toBe(53);
  });

  it("caps at three years", () => {
    expect(heatWeeks([{ date: "2010-01-04", value: 1 }], NOW)).toBe(HEAT_MAX_WEEKS);
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
