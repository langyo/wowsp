/** Unit tests for the plane-follow card derivation (pure functions). */
import { describe, expect, it } from "vitest";
import type {
  SquadronConsumableEvent,
  SquadronConsumableKind,
  SquadronHealthEvent,
  SquadronStateEvents,
  SquadronThrottleEvent,
} from "@/api";
import {
  activeConsumablesAt,
  CONSUMABLE_LABEL,
  consumableLabelKey,
  planeCardExtras,
  squadronAttacking,
  squadronHpAt,
  squadronSamplesAt,
  squadronStrength,
  SQUADRON_ATTACK_PITCH_DEG,
  throttleAt,
  unpackSquadronBands,
} from "./planeFollow";

/** One aircraft update sample. Declared locally instead of SquadronPlane so
 *  the optional `pitch` compiles whether or not the decoder type has grown
 *  the field yet (the lead owns that change; planeFollow reads pitch
 *  structurally). */
interface Sample {
  time: number;
  planeId: number;
  index: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch?: number;
}

/** One aircraft update sample at match time `time` (pitch optional — older
 *  streams carry none). */
const sp = (time: number, planeId = 1, index = 0, pitch?: number): Sample => ({
  time,
  planeId,
  index,
  x: 0,
  y: 100,
  z: 0,
  yaw: 0,
  ...(pitch != null ? { pitch } : {}),
});

/** One formation-member trail of a squadron, one sample per given time. */
const trail = (planeId: number, times: number[], index = 0) => ({
  id: planeId * 16 + index,
  samples: times.map((t) => sp(t, planeId, index)),
});

/** No minimap remove events. */
const noRemoves = new Map<number, number>();

describe("squadronStrength", () => {
  it("counts every live formation member against the launch strength", () => {
    // Three members airborne mid-sortie: 3 / 3.
    const trails = [trail(1, [10, 20]), trail(1, [10, 20], 1), trail(1, [10, 20], 2)];
    expect(squadronStrength(trails, 1, noRemoves, 15)).toEqual({
      alive: 3,
      total: 3,
    });
  });

  it("drops shot-down wingmen from alive but keeps the launch strength", () => {
    // Member 1's stream stopped at t=12 → its grace window ends at 17;
    // the anchor and member 2 ran to 20 (expiry 25). At t=18: 2 / 3.
    const trails = [trail(1, [10, 20]), trail(1, [10, 12], 1), trail(1, [10, 20], 2)];
    expect(squadronStrength(trails, 1, noRemoves, 18)).toEqual({
      alive: 2,
      total: 3,
    });
    // After every window has passed: no live plane → null, not 0 / N.
    expect(squadronStrength(trails, 1, noRemoves, 40)).toBeNull();
  });

  it("obeys the remove event even when samples run longer", () => {
    const trails = [trail(3, [10, 100])];
    const removeAt = new Map<number, number>([[3, 50]]);
    expect(squadronStrength(trails, 3, removeAt, 20)).toEqual({
      alive: 1,
      total: 1,
    });
    expect(squadronStrength(trails, 3, removeAt, 50)).toEqual({
      alive: 1,
      total: 1,
    });
    expect(squadronStrength(trails, 3, removeAt, 50.1)).toBeNull();
  });

  it("is null before the launch and during the anchor's first gap", () => {
    const trails = [trail(1, [10, 20]), trail(1, [12, 20], 1)];
    expect(squadronStrength(trails, 1, noRemoves, 9.9)).toBeNull();
    // The anchor launched, the late member has not: 1 / 2.
    expect(squadronStrength(trails, 1, noRemoves, 11)).toEqual({
      alive: 1,
      total: 2,
    });
    // Launch timestamp itself counts (born <= t, sample at t inclusive).
    expect(squadronStrength(trails, 1, noRemoves, 12)).toEqual({
      alive: 2,
      total: 2,
    });
  });

  it("only counts the asked squadron's trails", () => {
    const trails = [trail(1, [10, 20]), trail(2, [10, 20]), trail(2, [10, 20], 1)];
    expect(squadronStrength(trails, 1, noRemoves, 15)).toEqual({
      alive: 1,
      total: 1,
    });
    expect(squadronStrength([], 1, noRemoves, 15)).toBeNull();
  });
});

describe("squadronAttacking", () => {
  it("is false without pitch data or without a dive", () => {
    expect(squadronAttacking([])).toBe(false);
    // Older streams: no pitch at all — never "attacking".
    expect(squadronAttacking([sp(10), sp(11, 1, 1)])).toBe(false);
    expect(squadronAttacking([sp(10, 1, 0, 0), sp(11, 1, 1, -10)])).toBe(false);
  });

  it("is true at or beyond the dive threshold on any member", () => {
    expect(SQUADRON_ATTACK_PITCH_DEG).toBe(-25);
    expect(squadronAttacking([sp(10, 1, 0, -25)])).toBe(true);
    expect(squadronAttacking([sp(10, 1, 0, -30)])).toBe(true);
    // One diving member is enough even among shallow climbers.
    expect(squadronAttacking([sp(10, 1, 0, 5), sp(11, 1, 1, -40)])).toBe(true);
  });
});

describe("squadronSamplesAt", () => {
  it("collects each member's last sample at or before t", () => {
    const trails = [
      { id: 1 * 16, samples: [sp(10, 1, 0, -5), sp(20, 1, 0, -30)] },
      { id: 1 * 16 + 1, samples: [sp(12, 1, 1, 0)] },
      { id: 1 * 16 + 2, samples: [sp(25, 1, 2, -10)] },
      // Another squadron's trail must not leak in.
      { id: 2 * 16, samples: [sp(15, 2, 0, -60)] },
    ];
    expect(squadronSamplesAt(trails, 1, 15)).toEqual([
      sp(10, 1, 0, -5),
      sp(12, 1, 1, 0),
    ]);
    expect(squadronSamplesAt(trails, 1, 30)).toEqual([
      sp(20, 1, 0, -30),
      sp(12, 1, 1, 0),
      sp(25, 1, 2, -10),
    ]);
    expect(squadronSamplesAt(trails, 1, 9)).toEqual([]);
  });
});

// ── E27 squadron-state stream lookups ────────────────────────────────────

const hpEv = (time: number, planeId: number, hp: number): SquadronHealthEvent => ({
  time,
  planeId,
  hp,
});
const thEv = (time: number, planeId: number, mode: number): SquadronThrottleEvent => ({
  time,
  planeId,
  mode,
});
const consEv = (
  time: number,
  planeId: number,
  consumableType: number,
  kind: SquadronConsumableKind,
): SquadronConsumableEvent => ({ time, planeId, consumableType, kind });

describe("squadronHpAt", () => {
  it("is null on an absent stream and before the first sample", () => {
    // Pre-E27 replay: the backend skips empty vectors on the wire.
    expect(squadronHpAt(undefined, 1, 100)).toBeNull();
    expect(squadronHpAt([], 1, 100)).toBeNull();
    const health = [hpEv(10, 1, 1), hpEv(20, 1, 0.5)];
    expect(squadronHpAt(health, 1, 9.9)).toBeNull();
  });

  it("returns the last sample at or before t (inclusive at the tick)", () => {
    const health = [hpEv(10, 1, 1), hpEv(20, 1, 0.5), hpEv(30, 1, 0.25)];
    expect(squadronHpAt(health, 1, 10)).toBe(1);
    expect(squadronHpAt(health, 1, 19.9)).toBe(1);
    expect(squadronHpAt(health, 1, 20)).toBe(0.5);
    expect(squadronHpAt(health, 1, 500)).toBe(0.25);
  });

  it("only reads the asked plane's stream", () => {
    const health = [hpEv(10, 1, 0.9), hpEv(10, 2, 0.1)];
    expect(squadronHpAt(health, 1, 15)).toBe(0.9);
    expect(squadronHpAt(health, 2, 15)).toBe(0.1);
    expect(squadronHpAt(health, 3, 15)).toBeNull();
  });
});

describe("throttleAt", () => {
  it("is null before the first toggle (the caller reads cruise)", () => {
    expect(throttleAt(undefined, 1, 100)).toBeNull();
    expect(throttleAt([], 1, 100)).toBeNull();
    const throttle = [thEv(10, 1, 1)];
    expect(throttleAt(throttle, 1, 9.9)).toBeNull();
  });

  it("tracks the boost on/off toggles inclusively", () => {
    const throttle = [thEv(10, 1, 1), thEv(30, 1, 0), thEv(60, 1, 1)];
    expect(throttleAt(throttle, 1, 10)).toBe(1);
    expect(throttleAt(throttle, 1, 29.9)).toBe(1);
    expect(throttleAt(throttle, 1, 30)).toBe(0);
    expect(throttleAt(throttle, 1, 59.9)).toBe(0);
    expect(throttleAt(throttle, 1, 60)).toBe(1);
  });

  it("only reads the asked plane's stream", () => {
    const throttle = [thEv(10, 1, 1), thEv(10, 2, 0)];
    expect(throttleAt(throttle, 1, 15)).toBe(1);
    expect(throttleAt(throttle, 2, 15)).toBe(0);
  });
});

describe("activeConsumablesAt", () => {
  it("is empty on an absent stream or before any use", () => {
    expect(activeConsumablesAt(undefined, 1, 100)).toEqual([]);
    expect(activeConsumablesAt([], 1, 100)).toEqual([]);
    const events = [consEv(10, 1, 20, "used")];
    expect(activeConsumablesAt(events, 1, 9.9)).toEqual([]);
  });

  it("opens at used and stays open until stopWorking (inclusive ends)", () => {
    const events = [consEv(10, 1, 20, "used"), consEv(30, 1, 20, "stopWorking")];
    expect(activeConsumablesAt(events, 1, 10)).toEqual([20]);
    expect(activeConsumablesAt(events, 1, 29.9)).toEqual([20]);
    expect(activeConsumablesAt(events, 1, 30)).toEqual([]);
    expect(activeConsumablesAt(events, 1, 100)).toEqual([]);
  });

  it("keeps a used-with-no-stop open to stream end", () => {
    const events = [consEv(10, 1, 21, "used")];
    expect(activeConsumablesAt(events, 1, 10_000)).toEqual([21]);
  });

  it("reopens on a later used", () => {
    const events = [
      consEv(10, 1, 20, "used"),
      consEv(20, 1, 20, "stopWorking"),
      consEv(35, 1, 20, "used"),
    ];
    expect(activeConsumablesAt(events, 1, 25)).toEqual([]);
    expect(activeConsumablesAt(events, 1, 35)).toEqual([20]);
  });

  it("tracks several types independently, sorted ascending", () => {
    const events = [
      consEv(10, 1, 22, "used"),
      consEv(12, 1, 20, "used"),
      consEv(15, 1, 21, "used"),
      consEv(18, 1, 22, "stopWorking"),
    ];
    expect(activeConsumablesAt(events, 1, 17)).toEqual([20, 21, 22]);
    expect(activeConsumablesAt(events, 1, 18)).toEqual([20, 21]);
  });

  it("only reads the asked plane's events", () => {
    const events = [consEv(10, 2, 20, "used")];
    expect(activeConsumablesAt(events, 1, 15)).toEqual([]);
    expect(activeConsumablesAt(events, 2, 15)).toEqual([20]);
  });
});

describe("consumableLabelKey", () => {
  it("routes the observed ids to their named keys", () => {
    expect(CONSUMABLE_LABEL[20]).toBe("replay.planeCard.cons20");
    expect(CONSUMABLE_LABEL[21]).toBe("replay.planeCard.cons21");
    expect(CONSUMABLE_LABEL[22]).toBe("replay.planeCard.cons22");
    // E27b: the support-carrier smoke generator rides its own wire id.
    expect(CONSUMABLE_LABEL[42]).toBe("replay.planeCard.cons42");
    expect(consumableLabelKey(20)).toBe("replay.planeCard.cons20");
    expect(consumableLabelKey(21)).toBe("replay.planeCard.cons21");
    expect(consumableLabelKey(22)).toBe("replay.planeCard.cons22");
    expect(consumableLabelKey(42)).toBe("replay.planeCard.cons42");
  });

  it("falls back to the generic key for unknown ids", () => {
    expect(consumableLabelKey(99)).toBe("replay.planeCard.consOther");
    expect(consumableLabelKey(0)).toBe("replay.planeCard.consOther");
  });
});

describe("planeCardExtras", () => {
  it("degrades cleanly without streams (pre-E27 replay / failed load)", () => {
    expect(planeCardExtras(undefined, 1, 100)).toEqual({
      hp: null,
      boost: false,
      consumables: [],
    });
    expect(planeCardExtras({}, 1, 100)).toEqual({
      hp: null,
      boost: false,
      consumables: [],
    });
  });

  it("aggregates hp, boost and open windows at t", () => {
    const events: SquadronStateEvents = {
      health: [hpEv(10, 1, 0.75), hpEv(20, 1, 0.4)],
      throttle: [thEv(12, 1, 1), thEv(50, 1, 0)],
      consumables: [consEv(14, 1, 20, "used"), consEv(14, 1, 22, "used")],
    };
    expect(planeCardExtras(events, 1, 15)).toEqual({
      hp: 0.75,
      boost: true,
      consumables: [20, 22],
    });
    // Before the boost toggle: cruise, no chips yet (use lands at 14).
    expect(planeCardExtras(events, 1, 11)).toEqual({
      hp: 0.75,
      boost: false,
      consumables: [],
    });
    expect(planeCardExtras(events, 1, 13)).toEqual({
      hp: 0.75,
      boost: true,
      consumables: [],
    });
    expect(planeCardExtras(events, 1, 60)).toEqual({
      hp: 0.4,
      boost: false,
      consumables: [20, 22],
    });
  });

  it("ignores other planes' streams", () => {
    const events: SquadronStateEvents = {
      health: [hpEv(10, 2, 0.5)],
      throttle: [thEv(10, 2, 1)],
      consumables: [consEv(10, 2, 20, "used")],
    };
    expect(planeCardExtras(events, 1, 15)).toEqual({
      hp: null,
      boost: false,
      consumables: [],
    });
  });
});

describe("unpackSquadronBands", () => {
  it("unpacks nothing from an empty packing", () => {
    expect(unpackSquadronBands(0)).toEqual([]);
  });

  it("reads one band digit per flying plane, LSB first", () => {
    // Digit order: slot 0 = bits 0..2, slot 1 = bits 3..5, ...
    expect(unpackSquadronBands(1)).toEqual([1]); // one plane, HP > 3/4
    expect(unpackSquadronBands(2)).toEqual([2]); // one plane, (1/4, 3/4]
    expect(unpackSquadronBands(4)).toEqual([4]); // one plane, <= 1/4
    expect(unpackSquadronBands(4 + 1 * 8 + 2 * 64)).toEqual([4, 1, 2]);
  });

  it("a death drops the TOP digit (count = flying planes)", () => {
    // Two planes [4, 1]; the top one dies → packing collapses to [4].
    expect(unpackSquadronBands(4 + 1 * 8)).toEqual([4, 1]);
    expect(unpackSquadronBands(4)).toEqual([4]);
  });

  it("stops at the first zero digit (empty formation slots)", () => {
    // Digit 0 = 4, digit 1 = 0 (empty), digit 2 = 1 beyond the gap: junk
    // past the first zero never reaches the bands.
    expect(unpackSquadronBands(4 + 0 * 8 + 1 * 64)).toEqual([4]);
  });

  it("survives a full 16-slot packing (48 bits, beyond >>>'s 32)", () => {
    let packed = 0;
    for (let slot = 0; slot < 16; slot++) packed += 4 * 8 ** slot;
    const bands = unpackSquadronBands(packed);
    expect(bands).toHaveLength(16);
    expect(bands.every((band) => band === 4)).toBe(true);
  });
});
