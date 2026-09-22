import { describe, expect, it } from "vitest";
import {
  assignRows,
  clampWindow,
  fmtClock,
  fullWindow,
  layoutMarkers,
  rulerTicks,
  zoomWindow,
  TIMELINE_MIN_SPAN_S,
} from "./timelineModel";
import type { ShipAction } from "./actions";

const act = (time: number): ShipAction => ({ id: `a${time}`, time, entityId: 1, kind: "shell", ammo: "HE" });

describe("clampWindow", () => {
  it("enforces the 15 s zoom floor", () => {
    const w = clampWindow({ start: 10, end: 20 }, 600);
    expect(w.end - w.start).toBeGreaterThanOrEqual(TIMELINE_MIN_SPAN_S);
  });

  it("clamps into the battle extent", () => {
    const w = clampWindow({ start: -40, end: 900 }, 600);
    expect(w.start).toBe(0);
    expect(w.end).toBeLessThanOrEqual(600);
  });

  it("shrinks the floor on battles shorter than 15 s", () => {
    const w = clampWindow({ start: 0, end: 30 }, 8);
    expect(w.end - w.start).toBeLessThanOrEqual(8);
  });
});

describe("zoomWindow", () => {
  it("keeps the anchor point fixed under the cursor", () => {
    const cur = { start: 0, end: 600 };
    const anchor = 150;
    const next = zoomWindow(cur, 600, 2, anchor);
    const before = (anchor - cur.start) / (cur.end - cur.start);
    const after = (anchor - next.start) / (next.end - next.start);
    expect(after).toBeCloseTo(before, 5);
    expect(next.end - next.start).toBeCloseTo(300, 5);
  });

  it("never zooms past the 15 s floor however large the factor", () => {
    const next = zoomWindow({ start: 0, end: 600 }, 600, 1e9, 300);
    expect(next.end - next.start).toBe(TIMELINE_MIN_SPAN_S);
  });
});

describe("fullWindow", () => {
  it("full window spans the battle", () => {
    expect(fullWindow(600)).toEqual({ start: 0, end: 600 });
  });
});

describe("rulerTicks", () => {
  it("spreads major labels at least minLabelPx apart", () => {
    const ticks = rulerTicks(0, 1200, 760, 64, fmtClock);
    const majors = ticks.filter((t) => t.major);
    expect(majors.length).toBeGreaterThan(1);
    const px = (t: number) => ((t - 0) / 1200) * 760;
    for (let i = 1; i < majors.length; i++) {
      expect(px(majors[i].t) - px(majors[i - 1].t)).toBeGreaterThanOrEqual(64);
    }
  });
  it("labels render as battle clocks", () => {
    expect(fmtClock(0)).toBe("0:00");
    expect(fmtClock(75)).toBe("1:15");
    expect(fmtClock(600)).toBe("10:00");
  });
});

describe("assignRows / layoutMarkers", () => {
  it("puts overlapping markers into separate rows", () => {
    // 1 px per second → markers 2 s apart collide (icon 15 px + gap ≈ 18 px),
    // while 20 s of separation leaves room to reuse the first lane.
    const laid = assignRows([0, 2, 20, 22], 0, 30, 30, 15, 4);
    expect(laid[0].row).toBe(0);
    expect(laid[1].row).toBe(1);
    expect(laid[2].row).toBe(0);
    expect(laid[3].row).toBe(1);
  });

  it("filters out-of-window actions", () => {
    const laid = layoutMarkers([act(-5), act(5), act(95)], 0, 30, 300, 15, 4);
    expect(laid).toHaveLength(1);
    expect(laid[0].action.time).toBe(5);
  });

  it("caps lanes instead of spilling past maxRows", () => {
    const times = Array.from({ length: 20 }, (_, i) => i);
    const laid = assignRows(times, 0, 40, 40, 15, 3);
    for (const l of laid) expect(l.row).toBeLessThanOrEqual(2);
  });
});
