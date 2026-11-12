/** Unit tests for the plane-follow card derivation (pure functions). */
import { describe, expect, it } from "vitest";
import type {
  SquadronConsumableEvent,
  SquadronConsumableKind,
  SquadronConsumableType,
  SquadronHealthEvent,
  SquadronStateEvents,
  SquadronThrottleEvent,
} from "@/api";
import {
  activeConsumablesAt,
  chaseStrength,
  CONSUMABLE_LABEL,
  consumableLabelKey,
  consumableWindowFrac,
  planeCardExtras,
  squadronAttacking,
  squadronFlyingAt,
  squadronHpAt,
  squadronSamplesAt,
  squadronSlotGroups,
  squadronStrength,
  SQUADRON_ATTACK_PITCH_DEG,
  throttleAt,
  unknownConsumableId,
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
/** One consumable lifecycle event; `consumableType` stays the RAW wire byte
 *  and `semantic` is what the decoder normalized it to (E27d — the tests
 *  below pair raw ids with their branch-table semantics the way the WG and
 *  Lesta decoders do). */
const consEv = (
  time: number,
  planeId: number,
  consumableType: number,
  semantic: SquadronConsumableType,
  kind: SquadronConsumableKind,
): SquadronConsumableEvent => ({ time, planeId, consumableType, semantic, kind });

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

describe("consumableWindowFrac", () => {
  const ev = (time: number, kind: "used" | "stopWorking") => ({
    time,
    planeId: 1,
    consumableType: 20,
    semantic: "healForsage" as const,
    kind,
  });

  it("reads the used→stopWorking bracket as a countdown", () => {
    const events = [ev(100, "used"), ev(105, "stopWorking")];
    expect(consumableWindowFrac(events, 1, "healForsage", 100)).toBeCloseTo(1);
    expect(consumableWindowFrac(events, 1, "healForsage", 102.5)).toBeCloseTo(0.5);
    // After the window closes nothing is running.
    expect(consumableWindowFrac(events, 1, "healForsage", 106)).toBeNull();
  });

  it("keeps a still-open window on its documented fallback duration", () => {
    const events = [ev(100, "used")];
    expect(consumableWindowFrac(events, 1, "healForsage", 102)).toBeCloseTo(0.6);
    // Past the fallback duration the window is over: null, not an empty bar.
    expect(consumableWindowFrac(events, 1, "healForsage", 200)).toBeNull();
  });

  it("ignores other planes and other consumable types", () => {
    const events = [
      { ...ev(100, "used"), planeId: 2 },
      { ...ev(100, "used"), semantic: "planeSmokeGenerator" as const },
    ];
    expect(consumableWindowFrac(events, 1, "healForsage", 101)).toBeNull();
    expect(consumableWindowFrac(undefined, 1, "healForsage", 101)).toBeNull();
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
    const events = [consEv(10, 1, 20, "healForsage", "used")];
    expect(activeConsumablesAt(events, 1, 9.9)).toEqual([]);
  });

  it("opens at used and stays open until stopWorking (inclusive ends)", () => {
    const events = [
      consEv(10, 1, 20, "healForsage", "used"),
      consEv(30, 1, 20, "healForsage", "stopWorking"),
    ];
    expect(activeConsumablesAt(events, 1, 10)).toEqual(["healForsage"]);
    expect(activeConsumablesAt(events, 1, 29.9)).toEqual(["healForsage"]);
    expect(activeConsumablesAt(events, 1, 30)).toEqual([]);
    expect(activeConsumablesAt(events, 1, 100)).toEqual([]);
  });

  it("keeps a used-with-no-stop open to stream end", () => {
    const events = [consEv(10, 1, 21, "planeTacticalFighters", "used")];
    expect(activeConsumablesAt(events, 1, 10_000)).toEqual(["planeTacticalFighters"]);
  });

  it("reopens on a later used", () => {
    const events = [
      consEv(10, 1, 20, "healForsage", "used"),
      consEv(20, 1, 20, "healForsage", "stopWorking"),
      consEv(35, 1, 20, "healForsage", "used"),
    ];
    expect(activeConsumablesAt(events, 1, 25)).toEqual([]);
    expect(activeConsumablesAt(events, 1, 35)).toEqual(["healForsage"]);
  });

  it("tracks several types independently, ordered by raw id", () => {
    const events = [
      consEv(10, 1, 22, "fireExtinguishing", "used"),
      consEv(12, 1, 20, "healForsage", "used"),
      consEv(15, 1, 21, "planeTacticalFighters", "used"),
      consEv(18, 1, 22, "fireExtinguishing", "stopWorking"),
    ];
    expect(activeConsumablesAt(events, 1, 17)).toEqual([
      "healForsage",
      "planeTacticalFighters",
      "fireExtinguishing",
    ]);
    expect(activeConsumablesAt(events, 1, 18)).toEqual([
      "healForsage",
      "planeTacticalFighters",
    ]);
  });

  it("passes unknown semantics through with their raw ids, one window per raw byte", () => {
    // Two unmapped wire bytes on the same branch are two distinct windows —
    // the semantic payload keeps each raw id (E27d: nothing is ever lost).
    const events = [
      consEv(10, 1, 57, { unknown: 57 }, "used"),
      consEv(11, 1, 99, { unknown: 99 }, "used"),
      consEv(12, 1, 57, { unknown: 57 }, "stopWorking"),
    ];
    expect(activeConsumablesAt(events, 1, 11)).toEqual([{ unknown: 57 }, { unknown: 99 }]);
    expect(activeConsumablesAt(events, 1, 12)).toEqual([{ unknown: 99 }]);
  });

  it("answers in the decoder's semantic vocabulary across branches", () => {
    // The same semantic on both branch tables (WG 20 vs Lesta 21 both
    // normalize to healForsage): the card sees ONE vocabulary either way.
    const wg = [consEv(10, 1, 20, "healForsage", "used")];
    const lesta = [consEv(10, 1, 21, "healForsage", "used")];
    expect(activeConsumablesAt(wg, 1, 15)).toEqual(["healForsage"]);
    expect(activeConsumablesAt(lesta, 1, 15)).toEqual(["healForsage"]);
    // Byte 23 is RegenerateHealth on Lesta and unknown on WG (E27c fork).
    const lesta23 = [consEv(10, 1, 23, "regenerateHealth", "used")];
    const wg23 = [consEv(10, 1, 23, { unknown: 23 }, "used")];
    expect(activeConsumablesAt(lesta23, 1, 15)).toEqual(["regenerateHealth"]);
    expect(activeConsumablesAt(wg23, 1, 15)).toEqual([{ unknown: 23 }]);
  });

  it("only reads the asked plane's events", () => {
    const events = [consEv(10, 2, 20, "healForsage", "used")];
    expect(activeConsumablesAt(events, 1, 15)).toEqual([]);
    expect(activeConsumablesAt(events, 2, 15)).toEqual(["healForsage"]);
  });
});

describe("consumableLabelKey", () => {
  it("routes the semantic types to their named keys", () => {
    expect(CONSUMABLE_LABEL.healForsage).toBe("replay.planeCard.consForsage");
    expect(CONSUMABLE_LABEL.planeTacticalFighters).toBe("replay.planeCard.consFighters");
    expect(CONSUMABLE_LABEL.fireExtinguishing).toBe("replay.planeCard.consExtinguisher");
    expect(CONSUMABLE_LABEL.planeSmokeGenerator).toBe("replay.planeCard.consSmoke");
    expect(CONSUMABLE_LABEL.regenerateHealth).toBe("replay.planeCard.consRegen");
    expect(consumableLabelKey("healForsage")).toBe("replay.planeCard.consForsage");
    expect(consumableLabelKey("planeTacticalFighters")).toBe("replay.planeCard.consFighters");
    expect(consumableLabelKey("fireExtinguishing")).toBe("replay.planeCard.consExtinguisher");
    expect(consumableLabelKey("planeSmokeGenerator")).toBe("replay.planeCard.consSmoke");
    expect(consumableLabelKey("regenerateHealth")).toBe("replay.planeCard.consRegen");
  });

  it("falls back to the generic key for unknown payloads", () => {
    expect(consumableLabelKey({ unknown: 57 })).toBe("replay.planeCard.consOther");
    expect(consumableLabelKey({ unknown: 0 })).toBe("replay.planeCard.consOther");
  });

  it("exposes the raw id an unknown semantic carries (chip suffix)", () => {
    expect(unknownConsumableId("healForsage")).toBeNull();
    expect(unknownConsumableId("planeSmokeGenerator")).toBeNull();
    expect(unknownConsumableId({ unknown: 57 })).toBe(57);
    expect(unknownConsumableId({ unknown: 0 })).toBe(0);
  });
});

describe("planeCardExtras", () => {
  it("degrades cleanly without streams (pre-E27 replay / failed load)", () => {
    expect(planeCardExtras(undefined, 1, 100)).toEqual({
      hp: null,
      boost: false,
      slow: false,
      consumables: [],
    });
    expect(planeCardExtras({}, 1, 100)).toEqual({
      hp: null,
      boost: false,
      slow: false,
      consumables: [],
    });
  });

  it("aggregates hp, boost and open windows at t", () => {
    const events: SquadronStateEvents = {
      health: [hpEv(10, 1, 0.75), hpEv(20, 1, 0.4)],
      throttle: [thEv(12, 1, 1), thEv(50, 1, 0)],
      consumables: [
        consEv(14, 1, 20, "healForsage", "used"),
        consEv(14, 1, 22, "fireExtinguishing", "used"),
      ],
    };
    expect(planeCardExtras(events, 1, 15)).toEqual({
      hp: 0.75,
      boost: true,
      slow: false,
      consumables: ["healForsage", "fireExtinguishing"],
    });
    // Before the boost toggle: cruise, no chips yet (use lands at 14).
    expect(planeCardExtras(events, 1, 11)).toEqual({
      hp: 0.75,
      boost: false,
      slow: false,
      consumables: [],
    });
    expect(planeCardExtras(events, 1, 13)).toEqual({
      hp: 0.75,
      boost: true,
      slow: false,
      consumables: [],
    });
    expect(planeCardExtras(events, 1, 60)).toEqual({
      hp: 0.4,
      boost: false,
      slow: false,
      consumables: ["healForsage", "fireExtinguishing"],
    });
  });

  it("reads the third engine mode −1 as slow, not boost", () => {
    // Empirical: 146 slow windows across 12 CV replays (0.1–12.4 s,
    // variable) — a distinct throttle mode, not a missing 0/1.
    const events: SquadronStateEvents = {
      throttle: [thEv(12, 1, 1), thEv(20, 1, -1), thEv(30, 1, 0)],
    };
    expect(planeCardExtras(events, 1, 15)).toMatchObject({ boost: true, slow: false });
    expect(planeCardExtras(events, 1, 25)).toMatchObject({ boost: false, slow: true });
    expect(planeCardExtras(events, 1, 31)).toMatchObject({ boost: false, slow: false });
  });

  it("ignores other planes' streams", () => {
    const events: SquadronStateEvents = {
      health: [hpEv(10, 2, 0.5)],
      throttle: [thEv(10, 2, 1)],
      consumables: [consEv(10, 2, 20, "healForsage", "used")],
    };
    expect(planeCardExtras(events, 1, 15)).toEqual({
      hp: null,
      boost: false,
      slow: false,
      consumables: [],
    });
  });
});

describe("squadronSlotGroups", () => {
  it("splits the wing into its flight groups, one segment per plane", () => {
    // 9 planes in 3 groups: three groups of three, each segment its band.
    const groups = squadronSlotGroups([1, 1, 1, 2, 2, 2, 4, 4, 4], 3, 9);
    expect(groups).toHaveLength(3);
    expect(groups[0].map((p) => p.band)).toEqual([1, 1, 1]);
    expect(groups[1].map((p) => p.band)).toEqual([2, 2, 2]);
    expect(groups[2].map((p) => p.band)).toEqual([4, 4, 4]);
  });

  it("keeps a lost plane's slot dark instead of reflowing the group", () => {
    // 6 launched, 4 still flying: the last two slots are dead, so the
    // groups keep their launch silhouette.
    const groups = squadronSlotGroups([1, 1, 2, 2], 3, 6);
    expect(groups.map((g) => g.map((p) => p.band))).toEqual([
      [1, 1, 2],
      [2, null, null],
    ]);
  });

  it("drops wiped groups so the panel narrows", () => {
    // Three groups launched, the middle one gone: only two remain.
    const groups = squadronSlotGroups([1, 1, 1, 1, 1, 1], 3, 9);
    expect(groups).toHaveLength(2);
  });

  it("keeps a partial group partial instead of padding it to a full one", () => {
    // 4 planes in three-plane groups: one full group + one of a single
    // plane — NOT two full groups with two phantom dead slots.
    const groups = squadronSlotGroups([1, 1, 1, 2], 3, 4);
    expect(groups.map((g) => g.length)).toEqual([3, 1]);
    expect(groups[1][0].band).toBe(2);
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
describe("squadronFlyingAt", () => {
  const phEv = (time: number, planeId: number, packed: number) => ({
    time, planeId, packed,
  });

  it("is null on an absent stream and before the first sample", () => {
    // Pre-E27 replay: the backend skips empty vectors on the wire — the
    // tooltip falls back to the trail-derived strength then.
    expect(squadronFlyingAt(undefined, 1, 100)).toBeNull();
    expect(squadronFlyingAt([], 1, 100)).toBeNull();
    const stream = [phEv(10, 1, 12)];
    expect(squadronFlyingAt(stream, 1, 9.9)).toBeNull();
  });

  it("counts the packed u64's digit count at the last sample at or before t", () => {
    // 12 = octal 14 → digits [4, 1] → two planes flying.
    const stream = [phEv(10, 1, 5), phEv(20, 1, 12), phEv(30, 1, 4)];
    expect(squadronFlyingAt(stream, 1, 10)).toBe(1);
    expect(squadronFlyingAt(stream, 1, 20)).toBe(2);
    expect(squadronFlyingAt(stream, 1, 25)).toBe(2);
    expect(squadronFlyingAt(stream, 1, 30)).toBe(1);
    expect(squadronFlyingAt(stream, 1, 999)).toBe(1);
  });

  it("only reads the asked plane's stream", () => {
    const stream = [phEv(10, 1, 12), phEv(10, 2, 4)];
    expect(squadronFlyingAt(stream, 1, 15)).toBe(2);
    expect(squadronFlyingAt(stream, 2, 15)).toBe(1);
    expect(squadronFlyingAt(stream, 3, 15)).toBeNull();
  });
});

describe("chaseStrength (the follow pill's alive / total)", () => {
  /** Packed bands for `n` flying planes at full HP (one digit 1 each). */
  const packedFull = (n: number) => {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += 8 ** i;
    return acc;
  };

  it("prefers the E27 digit count over expiring sparse-3D wingman trails", () => {
    // The minimap-merge case: the ANCHOR trail is padded out to the sortie
    // end while the wingman's 3D trail stops at launch — the per-trail
    // count reads 1/2 mid-sortie even though the squadron still flies.
    const trails = [trail(1, [10, 200]), trail(1, [10, 20], 1)];
    const formations = new Map([[1, { count: 4 }]]);
    const health = [{ time: 10, planeId: 1, packed: packedFull(4) }];
    expect(squadronStrength(trails, 1, noRemoves, 100)).toEqual({
      alive: 1,
      total: 2,
    });
    expect(chaseStrength(trails, formations, health, noRemoves, 1, 100)).toEqual({
      alive: 4,
      total: 4,
    });
  });

  it("keeps the trail-derived answer on pre-E27 replays", () => {
    const trails = [trail(1, [10, 200]), trail(1, [10, 200], 1)];
    const formations = new Map([[1, { count: 2 }]]);
    expect(chaseStrength(trails, formations, undefined, noRemoves, 1, 100)).toEqual({
      alive: 2,
      total: 2,
    });
    // Launch strength comes from the formation table when the trails only
    // ever saw the anchor (minimap-only squadrons).
    expect(chaseStrength([trail(1, [10, 200])], formations, undefined, noRemoves, 1, 100)).toEqual({
      alive: 1,
      total: 2,
    });
  });

  it("answers null when nothing is live by either source", () => {
    expect(chaseStrength([], new Map(), undefined, noRemoves, 1, 100)).toBeNull();
  });
});
