/**
 * Consumable family pins + window helpers (items C/D): the modules read the
 * raw consumable-type ids the Rust decoder keeps, so the family sets and the
 * window lookups are the whole contract between the streams and the labels.
 */
import { describe, expect, it } from "vitest";
import {
  FIGHTER_PATROL_CONSUMABLE_IDS,
  SCOUT_CONSUMABLE_IDS,
  activeConsumableAt,
  consumableWindows,
  lastConsumableUseAt,
} from "./consumableRoles";
import type { ConsumableUseEvent } from "@/api";

const use = (
  time: number,
  entityId: number,
  consumableId: number,
  duration: number,
): ConsumableUseEvent => ({
  time,
  entityId,
  usageType: 0,
  consumableId,
  duration,
});

describe("consumable family pins", () => {
  it("pins the carrier patrol fighter and the catapult scout ids apart", () => {
    // 9 = PCY038 FighterAuto (600 s, the WARD patrol); 1 = the Spotter family
    // (the catapult-launched scout). They must never overlap: C anchors a card
    // on the first and D suppresses cards for the second.
    expect(FIGHTER_PATROL_CONSUMABLE_IDS.has(9)).toBe(true);
    expect(SCOUT_CONSUMABLE_IDS.has(1)).toBe(true);
    for (const id of SCOUT_CONSUMABLE_IDS) {
      expect(FIGHTER_PATROL_CONSUMABLE_IDS.has(id)).toBe(false);
    }
  });
});

describe("consumableWindows", () => {
  it("keeps only the hull's own family windows, in time order", () => {
    const uses = [
      use(300, 7, 1, 100),
      use(10, 7, 8, 28), // repair party — not a scout window
      use(200, 8, 1, 60), // another hull
      use(20, 7, 1, 0), // no duration → no window
      use(40, 7, 1, 71.5),
    ];
    const w = consumableWindows(uses, 7, SCOUT_CONSUMABLE_IDS);
    expect(w.map((x) => x.t0)).toEqual([40, 300]);
    expect(w[0].t1).toBeCloseTo(111.5);
  });

  it("answers [] without uses", () => {
    expect(consumableWindows(undefined, 7, SCOUT_CONSUMABLE_IDS)).toEqual([]);
    expect(consumableWindows([], 7, SCOUT_CONSUMABLE_IDS)).toEqual([]);
  });
});

describe("activeConsumableAt / lastConsumableUseAt", () => {
  const windows = consumableWindows(
    [use(10, 7, 1, 30), use(100, 7, 1, 20)],
    7,
    SCOUT_CONSUMABLE_IDS,
  );

  it("finds the window covering the playhead, newest first", () => {
    expect(activeConsumableAt(windows, 5)).toBeNull();
    expect(activeConsumableAt(windows, 10)?.t0).toBe(10);
    expect(activeConsumableAt(windows, 40)?.t0).toBe(10);
    expect(activeConsumableAt(windows, 41)).toBeNull();
    expect(activeConsumableAt(windows, 110)?.t0).toBe(100);
  });

  it("answers the newest STARTED window even after it closed (deployment lookup)", () => {
    // The fighter consumable's own window outlives the deployment, but the
    // ward can arrive after the window's t1 in a hypothetical replay — the
    // deployment lookup must still find the use that opened it.
    expect(lastConsumableUseAt(windows, 5)).toBeNull();
    expect(lastConsumableUseAt(windows, 10)?.t0).toBe(10);
    expect(lastConsumableUseAt(windows, 500)?.t0).toBe(100);
  });
});
