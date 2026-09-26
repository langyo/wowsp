import { describe, expect, it } from "vitest";
import {
  assignRows,
  clampWindow,
  fmtClock,
  parseClock,
  fullWindow,
  layoutMarkers,
  layoutPlanRows,
  planBandHeight,
  rulerTicks,
  zoomWindow,
  TIMELINE_MIN_SPAN_S,
  TRACK_BODY_MAX_H,
  TRACK_BODY_MIN_H,
  TRACK_HEADER_H,
} from "./timelineModel";
import type { ShipAction } from "./actions";
import type { PlanRowLayout } from "./timelineModel";

const act = (time: number): ShipAction => ({ id: `a${time}`, time, entityId: 1, kind: "shell", ammo: "HE" });

/** `n` unit keys, as the plan board hands them to `layoutPlanRows`. */
const planKeys = (n: number) => Array.from({ length: n }, (_, i) => `unit-${i}`);

describe("parseClock", () => {
  it("parses M:SS, bare seconds and fractional seconds", () => {
    expect(parseClock("0:30")).toBe(30);
    expect(parseClock("12:05")).toBe(725);
    expect(parseClock("90")).toBe(90);
    expect(parseClock("1:02.5")).toBeCloseTo(62.5, 5);
    expect(parseClock("  3:00 ")).toBe(180);
  });

  it("rejects malformed times (null keeps the old value)", () => {
    expect(parseClock("2:99")).toBeNull(); // the SS field stops at 59
    expect(parseClock("abc")).toBeNull();
    expect(parseClock("1:2:3")).toBeNull();
    expect(parseClock("")).toBeNull();
  });
});

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

describe("layoutPlanRows", () => {
  /** Shortest band a row can occupy: header floor + body floor. */
  const ROW_FLOOR_H = 11 + TRACK_BODY_MIN_H;
  const usedH = (rows: PlanRowLayout[]) => {
    const visible = rows.filter((r) => !r.hidden);
    const last = visible[visible.length - 1];
    return last ? last.top + last.headerH + last.bodyH : 0;
  };

  it("lays out nothing for an empty plan", () => {
    expect(layoutPlanRows([], new Set(), 172)).toEqual([]);
  });

  it("gives every unit a header, collapsed units no body", () => {
    const rows = layoutPlanRows(["a", "b", "c"], new Set(["b"]), 172);
    expect(rows.map((r) => r.collapsed)).toEqual([false, true, false]);
    expect(rows[1].bodyH).toBe(0);
    expect(rows[1].headerH).toBeGreaterThan(0);
    // A collapsed row consumes its header only, so `c` starts right after it.
    expect(rows[2].top).toBe(rows[0].headerH + rows[0].bodyH + rows[1].headerH);
  });

  it("keeps every visible row inside its band, bodies within the floor/ceiling", () => {
    // Bands that can host the four rows — a band too short hides rows instead
    // (see the hidden-row tests), so the size assertions need the room.
    for (const lanesH of [172, 320]) {
      const rows = layoutPlanRows(planKeys(4), new Set(), lanesH);
      expect(rows.every((r) => !r.hidden)).toBe(true);
      for (const r of rows) {
        expect(r.top + r.headerH + r.bodyH).toBeLessThanOrEqual(lanesH);
        expect(r.bodyH).toBeGreaterThanOrEqual(TRACK_BODY_MIN_H);
        expect(r.bodyH).toBeLessThanOrEqual(TRACK_BODY_MAX_H);
        expect(r.headerH).toBeLessThanOrEqual(TRACK_HEADER_H);
      }
    }
  });

  it("never lays out past the band for 1, 3, 12 and 20 units", () => {
    for (const n of [1, 3, 12, 20]) {
      // Tightest band that can host n expanded rows, plus one with room to
      // spare (bodies grow into it) — neither may overflow.
      for (const slack of [0, 60]) {
        const lanesH = n * ROW_FLOOR_H + slack;
        const rows = layoutPlanRows(planKeys(n), new Set(), lanesH);
        expect(rows.every((r) => !r.hidden)).toBe(true);
        expect(rows[0].top).toBe(0);
        expect(usedH(rows)).toBeLessThanOrEqual(lanesH);
      }
    }
  });

  it("flags the rows the band cannot host as hidden, parked at the band edge", () => {
    const lanesH = 320; // LANES_H_TALL_MAX
    const rows = layoutPlanRows(planKeys(20), new Set(), lanesH);
    // 20 expanded rows at the 11 px header + 10 px body floors need 420 px,
    // so only 15 fit: the tail is flagged, not laid out.
    expect(rows.filter((r) => r.hidden)).toHaveLength(5);
    for (const r of rows.filter((r) => r.hidden)) {
      expect(r).toMatchObject({ top: lanesH, headerH: 0, bodyH: 0 });
    }
    // Hidden rows are the tail: no visible row follows a hidden one.
    const firstHidden = rows.findIndex((r) => r.hidden);
    expect(rows.slice(firstHidden).every((r) => r.hidden)).toBe(true);
    expect(usedH(rows)).toBeLessThanOrEqual(lanesH);
  });

  it("hides exactly the rows that do not fit — one pixel short hides the last", () => {
    // Four rows at the floors occupy 84 px; 83 px leaves the last one out.
    expect(layoutPlanRows(planKeys(4), new Set(), 84).map((r) => r.hidden)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(layoutPlanRows(planKeys(4), new Set(), 83).map((r) => r.hidden)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it("fits a 12-unit plan into the real plan band once units are collapsed", () => {
    // Collapsing is what buys the room: 12 expanded rows need 204 px, more
    // than this band, while 11 collapsed rows + 1 body fit it exactly.
    const lanesH = 172; // Timeline LANES_H_TALL
    const all = planKeys(12);
    const rows = layoutPlanRows(all, new Set(all.slice(1)), lanesH);
    expect(rows.every((r) => !r.hidden)).toBe(true);
    expect(usedH(rows)).toBeLessThanOrEqual(lanesH);
    expect(usedH(rows)).toBeGreaterThan(lanesH / 2);
  });

  it("shares one header height across rows, shrinking it when cramped", () => {
    // 68 px hosts exactly: header (68 - 2*10) / 4 = 12 < the 15 px preferred.
    const rows = layoutPlanRows(["a", "b", "c", "d"], new Set(["a", "c"]), 68);
    expect(new Set(rows.filter((r) => !r.hidden).map((r) => r.headerH)).size).toBe(1);
    expect(rows[0].headerH).toBeLessThan(TRACK_HEADER_H);
    expect(rows[0].headerH).toBeGreaterThan(0);
  });
});

describe("planBandHeight", () => {
  it("never shrinks below the minimum nor grows past the maximum", () => {
    expect(planBandHeight(0, 0, 172, 320)).toBe(172);
    expect(planBandHeight(2, 2, 172, 320)).toBe(172);
    expect(planBandHeight(100, 100, 172, 320)).toBe(320);
  });

  it("grows with the units and with the expanded bodies among them", () => {
    // Same units, more keyframe bodies → taller.
    expect(planBandHeight(6, 3, 172, 320)).toBe(188);
    expect(planBandHeight(6, 6, 172, 320)).toBe(278);
    // More units, bodies unchanged → taller.
    expect(planBandHeight(8, 0, 172, 320)).toBe(172);
    expect(planBandHeight(12, 0, 172, 320)).toBeGreaterThan(planBandHeight(8, 0, 172, 320));
  });

  it("sizes a band that hosts the plan it was sized for", () => {
    // The real wiring (Timeline.tsx): lanesH = planBandHeight(tracks, expanded, 172, 320).
    for (const n of [1, 3, 8, 12]) {
      const lanesH = planBandHeight(n, n, 172, 320);
      const rows = layoutPlanRows(planKeys(n), new Set(), lanesH);
      expect(rows.filter((r) => r.hidden)).toEqual([]);
      for (const r of rows) {
        expect(r.bodyH).toBeGreaterThanOrEqual(TRACK_BODY_MIN_H);
        expect(r.top + r.headerH + r.bodyH).toBeLessThanOrEqual(lanesH);
      }
    }
  });

  it("cannot host a 20-unit plan: the cap wins and the overflow is reported, not clipped", () => {
    // 20 expanded rows at the floors need 20 * 21 = 420 px, but the 320 px
    // cap is reached first, so five units come back flagged for the badge.
    const lanesH = planBandHeight(20, 20, 172, 320);
    expect(lanesH).toBe(320);
    expect(layoutPlanRows(planKeys(20), new Set(), lanesH).filter((r) => r.hidden)).toHaveLength(5);
  });
});
