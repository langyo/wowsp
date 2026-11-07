/** Unit tests for the 2D-minimap motion helpers (pure given samples + t). */
import { describe, expect, it } from "vitest";
import {
  activeWards,
  planeRawPosAt,
  planeSmoothPosAt,
  TORPEDO_SPEED_UNITS_S,
  torpedoPosAt,
  TRAIL_GAP_LINK_MAX_S,
  trailGapLinks,
  type PlaneAnimState,
} from "./minimapFx";
import type { SquadronPlane, WardEvent, WardRemoveEvent } from "@/api";

function plane(time: number, x: number, z: number, yaw = 0): SquadronPlane {
  return { time, planeId: 7, index: 0, x, y: 20, z, yaw };
}

describe("planeRawPosAt", () => {
  it("answers null for an empty trail", () => {
    expect(planeRawPosAt([], 5)).toBeNull();
  });

  it("interpolates linearly between neighbours", () => {
    const s = [plane(0, 0, 0), plane(2, 100, -50)];
    const p = planeRawPosAt(s, 1)!;
    expect(p.x).toBeCloseTo(50, 6);
    expect(p.z).toBeCloseTo(-25, 6);
  });

  it("takes the short way around for yaw", () => {
    const s = [plane(0, 0, 0, 3.0), plane(2, 0, 0, -3.0)];
    const p = planeRawPosAt(s, 1)!;
    // 3.0 → -3.0 is +0.283 rad across the ±π seam, not -6.
    expect(Math.abs(p.yaw)).toBeGreaterThan(3);
  });

  it("clamps outside the stream span", () => {
    const s = [plane(5, 10, 20), plane(9, 30, 40)];
    expect(planeRawPosAt(s, 0)).toEqual({ x: 10, z: 20, yaw: 0 });
    expect(planeRawPosAt(s, 99)).toEqual({ x: 30, z: 40, yaw: 0 });
  });

  it("survives duplicate timestamps", () => {
    const s = [plane(1, 0, 0), plane(1, 5, 5)];
    expect(planeRawPosAt(s, 1)).toEqual({ x: 0, z: 0, yaw: 0 });
    expect(planeRawPosAt(s, 2)).toEqual({ x: 5, z: 5, yaw: 0 });
  });
});

describe("planeSmoothPosAt", () => {
  it("snaps on the first call and caches a same-t second pass", () => {
    const state = new Map<number, PlaneAnimState>();
    const s = [plane(0, 0, 0), plane(2, 100, 0)];
    const first = planeSmoothPosAt(1, s, 1, state)!;
    expect(first.x).toBeCloseTo(50, 6);
    // Second canvas of the SAME frame: no double-easing, exact same pose.
    expect(planeSmoothPosAt(1, s, 1, state)).toEqual(first);
  });

  it("eases toward the raw pose instead of jumping", () => {
    const state = new Map<number, PlaneAnimState>();
    const s = [plane(0, 0, 0), plane(2, 100, 0)];
    planeSmoothPosAt(1, s, 0, state); // snap at 0
    const eased = planeSmoothPosAt(1, s, 0.06, state)!;
    // One redraw step at 16 Hz must be a small fraction of the 3-unit raw
    // move (raw at 0.06 = 3), i.e. clearly behind but moving.
    expect(eased.x).toBeGreaterThan(0);
    expect(eased.x).toBeLessThan(1);
  });

  it("converges to the raw pose over enough steps", () => {
    const state = new Map<number, PlaneAnimState>();
    const s = [plane(0, 0, 0), plane(2, 100, 0)];
    planeSmoothPosAt(1, s, 0, state);
    let t = 0;
    for (let i = 0; i < 120; i++) {
      t += 0.06;
      planeSmoothPosAt(1, s, t, state);
    }
    const p = planeSmoothPosAt(1, s, t, state);
    expect(p!.x).toBeGreaterThan(50); // at t≈7.2 the raw pose clamps at 100
  });

  it("snaps on a seek (large playhead step) and on a backwards step", () => {
    const state = new Map<number, PlaneAnimState>();
    const s = [plane(0, 0, 0), plane(10, 100, 0)];
    planeSmoothPosAt(1, s, 1, state);
    const seeked = planeSmoothPosAt(1, s, 9, state)!;
    expect(seeked.x).toBeCloseTo(90, 6);
    const back = planeSmoothPosAt(1, s, 2, state)!;
    expect(back.x).toBeCloseTo(20, 6);
  });

  it("answers null for an empty trail", () => {
    expect(planeSmoothPosAt(1, [], 3, new Map())).toBeNull();
  });
});

describe("trailGapLinks", () => {
  const ship = (time: number, x: number, z: number) => ({ time, x, z });

  it("bridges short dark windows only", () => {
    const samples = [
      ship(0, 0, 0),
      ship(1, 10, 0), // normal (1 s) segment → no link
      ship(5, 50, 0), // gap 4 s = UNSEEN_GAP_S → no link (already a trail line)
      ship(18, 180, 0), // gap 13 s → link
      ship(19, 190, 0), // normal
      ship(39, 390, 0), // gap 20 s = max → link (inclusive)
      ship(40, 400, 0), // normal
      ship(60, 600, 0), // gap 20 s after re-arm → link
      ship(61, 610, 0),
      ship(90, 900, 0), // gap 29 s > max → no link
      ship(91, 910, 0),
    ];
    const links = trailGapLinks(samples, 1000);
    expect(links).toHaveLength(3);
    expect(links.map((l) => [Math.round(l.fromX), Math.round(l.toX)])).toEqual([
      [50, 180],
      [190, 390],
      [400, 600],
    ]);
  });

  it("only reports gaps the playhead has fully crossed", () => {
    const samples = [ship(0, 0, 0), ship(13, 130, 0), ship(30, 300, 0)];
    expect(trailGapLinks(samples, 5)).toHaveLength(0);
    expect(trailGapLinks(samples, 13)).toHaveLength(1);
    expect(trailGapLinks(samples, 30)).toHaveLength(2);
  });

  it("keeps the max-window override", () => {
    const samples = [ship(0, 0, 0), ship(10, 100, 0)];
    expect(trailGapLinks(samples, 100, 100)).toHaveLength(1);
    expect(TRAIL_GAP_LINK_MAX_S).toBe(20);
  });

  it("handles empty and single-sample streams", () => {
    expect(trailGapLinks([], 10)).toEqual([]);
    expect(trailGapLinks([ship(0, 0, 0)], 10)).toEqual([]);
  });
});

function ward(time: number, squadronId: number, x = 0, z = 0, radius = 120): WardEvent {
  return { time, squadronId, ownerId: 1, teamId: 0, x, y: 1000, z, radius, wardType: 0 };
}
function remove(time: number, planeId: number): WardRemoveEvent {
  return { time, planeId };
}

describe("activeWards", () => {
  it("is alive from the add until the first later remove", () => {
    const ws = [ward(10, 4)];
    const rs = [remove(20, 4)];
    expect(activeWards(ws, rs, 9.9)).toHaveLength(0);
    expect(activeWards(ws, rs, 10)).toHaveLength(1);
    expect(activeWards(ws, rs, 20)).toHaveLength(1);
    expect(activeWards(ws, rs, 20.1)).toHaveLength(0);
  });

  it("ignores removes from an earlier deployment of the same squadron", () => {
    const ws = [ward(30, 4)];
    const rs = [remove(20, 4), remove(40, 4)];
    expect(activeWards(ws, rs, 25)).toHaveLength(0); // before the re-add
    expect(activeWards(ws, rs, 35)).toHaveLength(1);
    expect(activeWards(ws, rs, 41)).toHaveLength(0);
  });

  it("keeps a ward with no remove alive to the end", () => {
    expect(activeWards([ward(5, 2)], [], 999)).toHaveLength(1);
  });

  it("answers [] for no wards", () => {
    expect(activeWards([], [remove(1, 1)], 10)).toEqual([]);
  });
});

describe("torpedoPosAt", () => {
  const run = { base: { x: 0, z: 0 }, dir: { x: 1, z: 0 } };

  it("advances along the run direction at the shared speed", () => {
    const p = torpedoPosAt(run, 10);
    expect(p.x).toBeCloseTo(10 * TORPEDO_SPEED_UNITS_S, 6);
    expect(p.z).toBeCloseTo(0, 6);
  });

  it("clamps to the map rect", () => {
    const p = torpedoPosAt(run, 1000, { minX: -50, maxX: 50, minZ: -5, maxZ: 5 });
    expect(p).toEqual({ x: 50, z: 0 });
  });

  it("does not clamp without a rect", () => {
    const p = torpedoPosAt(run, 1000);
    expect(p.x).toBeCloseTo(7000, 6);
  });
});
