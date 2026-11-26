/** Tests for the per-player hull-variant resolver: the pure slice→override
 *  mapping against a synthetic PXSC999-shaped subtree (the verified Bermuda
 *  Triangle ground truth — five parallel hulls, 7..16.5 km concealment) and
 *  the registration surface (one slice fetch per shipId, entity/name lookup,
 *  swallowed failures). The api transport is mocked — the resolver must
 *  never touch real Tauri IPC; gameparamCode rides the real baked
 *  gameparam_ids.json (the PXUH80x ids below ARE the real event ids). */
import { flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerBuild } from "@/api";
import {
  entityShipVariantEpoch,
  entityShipVariantFor,
  registerEntityShipVariants,
  resetEntityShipVariants,
  resetEntityShipVariantsForTests,
  shipVariantOverrideFromSlice,
} from "./entityShipVariant";

const mocks = vi.hoisted(() => ({ getShipGameparams: vi.fn() }));
vi.mock("@/api", () => ({ api: { getShipGameparams: mocks.getShipGameparams } }));

// Synthetic slice shaped like the real PXSC999_Siegfried_1510 one
// (ShipUpgradeInfo keyed by upgrade code, hull components nested at the
// slice root); numbers are the verified 15.10 event hulls.
const SLICE = {
  ShipUpgradeInfo: {
    PXUH801_HULL_A: { ucType: "_Hull", prev: "", components: { hull: ["A_Hull"] } },
    PXUH802_HULL_B: { ucType: "_Hull", prev: "", components: { hull: ["B_Hull"] } },
    PXUH803_HULL_C: { ucType: "_Hull", prev: "", components: { hull: ["C_Hull"] } },
    PXUH804_HULL_D: { ucType: "_Hull", prev: "", components: { hull: ["D_Hull"] } },
    PXUH805_HULL_E: { ucType: "_Hull", prev: "", components: { hull: ["E_Hull"] } },
    PXUH825_HULL_E_TIER3: {
      ucType: "_Hull",
      prev: "PXUH805_HULL_E",
      components: { hull: ["E_Hull_TIER3"] },
    },
    PXUM801_PRIMARYWEAPON_1: {
      ucType: "_PrimaryWeapons",
      prev: "",
      components: { artillery: ["A_Artillery"] },
    },
  },
  A_Hull: { visibilityFactor: 15, visibilityFactorByPlane: 15, health: 63450, maxSpeed: 40 },
  B_Hull: { visibilityFactor: 16.5, visibilityFactorByPlane: 16.5, health: 44600, maxSpeed: 35 },
  C_Hull: { visibilityFactor: 7, visibilityFactorByPlane: 7, health: 30700, maxSpeed: 48 },
  D_Hull: { visibilityFactor: 10, visibilityFactorByPlane: 10, health: 47300, maxSpeed: 40 },
  E_Hull: { visibilityFactor: 13, visibilityFactorByPlane: 13, health: 42500, maxSpeed: 40 },
  E_Hull_TIER3: { visibilityFactor: 13, visibilityFactorByPlane: 13, health: 50100, maxSpeed: 45 },
};

// Real numeric ids (gameparam_ids.json, refreshed with the 15.10 event).
const ID_A = 3454807312;
const ID_B = 3453758736;
const ID_C = 3452710160;
const ID_D = 3451661584;
const ID_E_TIER3 = 3429641488;
/** Not in the baked map — an id the decode layer may carry but the bake
 *  predates. Must be skipped, never break the walk. */
const ID_UNKNOWN = 4111111111;

function build(partial: Partial<PlayerBuild>): PlayerBuild {
  return {
    entityId: 101,
    shipParamsId: 3247355152,
    units: [ID_A],
    ...partial,
  };
}

beforeEach(() => {
  mocks.getShipGameparams.mockReset();
  resetEntityShipVariantsForTests();
});

describe("shipVariantOverrideFromSlice", () => {
  it("derives the A-hull override off the hull-first unit", () => {
    expect(shipVariantOverrideFromSlice(SLICE, [ID_A])).toEqual({
      det: 15,
      detAir: 15,
      hp: 63450,
      spd: 40,
    });
  });

  it("resolves each parallel variant to its own numbers", () => {
    expect(shipVariantOverrideFromSlice(SLICE, [ID_B])).toEqual({
      det: 16.5,
      detAir: 16.5,
      hp: 44600,
      spd: 35,
    });
    expect(shipVariantOverrideFromSlice(SLICE, [ID_C])).toEqual({
      det: 7,
      detAir: 7,
      hp: 30700,
      spd: 48,
    });
  });

  it("resolves the fourth variant to its own numbers", () => {
    expect(shipVariantOverrideFromSlice(SLICE, [ID_D])).toEqual({
      det: 10,
      detAir: 10,
      hp: 47300,
      spd: 40,
    });
  });

  it("rides the mounted upgrade — a tier variant names its own hull", () => {
    expect(shipVariantOverrideFromSlice(SLICE, [ID_E_TIER3])).toEqual({
      det: 13,
      detAir: 13,
      hp: 50100,
      spd: 45,
    });
  });

  it("skips non-hull and unknown units before the hull one", () => {
    expect(
      shipVariantOverrideFromSlice(SLICE, [ID_UNKNOWN, 4222222222, ID_C]),
    ).toEqual({ det: 7, detAir: 7, hp: 30700, spd: 48 });
  });

  it("returns null without a decodable hull (no units, bad slice)", () => {
    expect(shipVariantOverrideFromSlice(SLICE, [])).toBeNull();
    expect(shipVariantOverrideFromSlice(SLICE, undefined)).toBeNull();
    expect(shipVariantOverrideFromSlice(SLICE, [ID_UNKNOWN])).toBeNull();
    expect(shipVariantOverrideFromSlice(null, [ID_A])).toBeNull();
    expect(shipVariantOverrideFromSlice({}, [ID_A])).toBeNull();
    expect(shipVariantOverrideFromSlice({ ShipUpgradeInfo: {} }, [ID_A])).toBeNull();
  });
});

describe("registerEntityShipVariants", () => {
  it("fetches ONE slice per shipId and registers every player", async () => {
    mocks.getShipGameparams.mockResolvedValue(SLICE);
    registerEntityShipVariants(
      [
        build({ entityId: 1, name: "Alpha", units: [ID_A] }),
        build({ entityId: 2, name: "Bravo", units: [ID_C] }),
        // No units — must not join the fetch group nor register.
        build({ entityId: 3, name: "NoUnits", units: [] }),
      ],
      "C:/Game",
      "wg",
    );
    await flushPromises();
    expect(mocks.getShipGameparams).toHaveBeenCalledTimes(1);
    expect(mocks.getShipGameparams).toHaveBeenCalledWith(3247355152, "C:/Game", "wg");
    expect(entityShipVariantFor(1, "Alpha")).toEqual({
      det: 15,
      detAir: 15,
      hp: 63450,
      spd: 40,
    });
    expect(entityShipVariantFor(2, "Bravo")).toEqual({
      det: 7,
      detAir: 7,
      hp: 30700,
      spd: 48,
    });
    expect(entityShipVariantFor(3, "NoUnits")).toBeNull();
    expect(entityShipVariantEpoch.value).toBeGreaterThan(0);
  });

  it("prefers the entity id and falls back to the name", async () => {
    mocks.getShipGameparams.mockResolvedValue(SLICE);
    registerEntityShipVariants([build({ entityId: 7, name: "Gamma" })], "", "wg");
    await flushPromises();
    expect(entityShipVariantFor(7, "SomeoneElse")).toEqual({
      det: 15,
      detAir: 15,
      hp: 63450,
      spd: 40,
    });
    expect(entityShipVariantFor(999, "Gamma")).toEqual({
      det: 15,
      detAir: 15,
      hp: 63450,
      spd: 40,
    });
    expect(entityShipVariantFor(null, null)).toBeNull();
  });

  it("swallows a failed fetch — nothing registers, no epoch bump", async () => {
    mocks.getShipGameparams.mockRejectedValue(new Error("no install"));
    const epochBefore = entityShipVariantEpoch.value;
    registerEntityShipVariants([build({ name: "Delta" })], "", undefined);
    await flushPromises();
    expect(entityShipVariantFor(101, "Delta")).toBeNull();
    expect(entityShipVariantEpoch.value).toBe(epochBefore);
  });

  it("dedupes concurrent registrations behind one cached slice", async () => {
    mocks.getShipGameparams.mockResolvedValue(SLICE);
    registerEntityShipVariants([build({ name: "Alpha" })], "", "wg");
    registerEntityShipVariants([build({ entityId: 5, name: "Echo" })], "", "wg");
    await flushPromises();
    expect(mocks.getShipGameparams).toHaveBeenCalledTimes(1);
    expect(entityShipVariantFor(5, "Echo")).not.toBeNull();
  });
});

describe("registry lifecycle", () => {
  it("a battle reset wipes the per-player entries (entity ids and names are reused across battles)", async () => {
    mocks.getShipGameparams.mockResolvedValue(SLICE);
    registerEntityShipVariants([build({ entityId: 9, name: "Alpha" })], "", "wg");
    await flushPromises();
    expect(entityShipVariantFor(9, "Alpha")).not.toBeNull();
    resetEntityShipVariants();
    // The lookup must now miss — a new battle's late/failed decode keeps the
    // bake instead of the previous battle's numbers.
    expect(entityShipVariantFor(9, "Alpha")).toBeNull();
    // ...and the next battle's registrations land into the clean registry.
    registerEntityShipVariants(
      [build({ entityId: 9, name: "Alpha", units: [ID_C] })],
      "",
      "wg",
    );
    await flushPromises();
    expect(entityShipVariantFor(9, "Alpha")).toEqual({
      det: 7,
      detAir: 7,
      hp: 30700,
      spd: 48,
    });
  });

  it("re-registering the SAME override does not re-bump the epoch", async () => {
    mocks.getShipGameparams.mockResolvedValue(SLICE);
    registerEntityShipVariants([build({ name: "Alpha" })], "", "wg");
    await flushPromises();
    const settled = entityShipVariantEpoch.value;
    // Probe frames replace the whole build set every few seconds — the same
    // values must not churn the render trigger.
    registerEntityShipVariants([build({ name: "Alpha", units: [ID_A] })], "", "wg");
    await flushPromises();
    expect(entityShipVariantEpoch.value).toBe(settled);
    // A genuinely different hull still bumps.
    registerEntityShipVariants([build({ name: "Alpha", units: [ID_C] })], "", "wg");
    await flushPromises();
    expect(entityShipVariantEpoch.value).toBe(settled + 1);
    expect(entityShipVariantFor(null, "Alpha")?.det).toBe(7);
  });

  it("keeps per-(root, branch) fetches apart", async () => {
    mocks.getShipGameparams.mockResolvedValue(SLICE);
    registerEntityShipVariants([build({ name: "Alpha" })], "C:/GameA", "wg");
    registerEntityShipVariants([build({ name: "Bravo" })], "C:/GameB", "wg");
    registerEntityShipVariants([build({ name: "Charlie" })], "C:/GameA", "lesta");
    await flushPromises();
    // Three distinct (root, shipId, branch) keys — three fetches, no
    // memo-poisoning across installs or realms.
    expect(mocks.getShipGameparams).toHaveBeenCalledTimes(3);
    expect(entityShipVariantFor(null, "Alpha")).not.toBeNull();
    expect(entityShipVariantFor(null, "Bravo")).not.toBeNull();
    expect(entityShipVariantFor(null, "Charlie")).not.toBeNull();
  });
});
