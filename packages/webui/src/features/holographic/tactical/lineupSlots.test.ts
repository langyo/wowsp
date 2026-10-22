/**
 * lineupSlots unit tests. The baked path runs against the REAL baked
 * assets (ship_live_stats + consumable_details are imported by the module
 * itself); the GameParams path feeds a minimal ShipAbilities slice built
 * from real (entity, variant) pairs so the details join resolves.
 */
import { describe, expect, it } from "vitest";
import {
  bakedToggleOptions,
  effectiveFamilies,
  gameparamsSlotGroups,
  selectFamily,
} from "./lineupSlots";

/** A hull whose baked `load` carries radar + hydro + spotter + fighter
 * (a US cruiser family inventory — see ship_live_stats.json). */
const CRUISER_ID = 3248404464;

/** Minimal ShipAbilities slice over real detail entities: slot 2 offers
 *  spotter vs fighter alternatives, slot 3 a radar. */
const FAKE_GP = {
  ShipAbilities: {
    AbilitySlot3: {
      slot: 2,
      abils: [
        ["PCY005_Spotter", "Default"],
        ["PCY004_Fighter", "Fighter_1"],
      ],
    },
    AbilitySlot4: { slot: 3, abils: [["PCY019_RLSSearch", "Default"]] },
  },
};

describe("bakedToggleOptions", () => {
  it("lists the hull's mountable families with names and icons", () => {
    const opts = bakedToggleOptions(CRUISER_ID);
    const families = opts.map((o) => o.family);
    expect(families).toContain("RLSSearch");
    expect(families).toContain("SonarSearch");
    expect(families).toContain("Spotter");
    expect(opts.every((o) => o.name.length > 0)).toBe(true);
    expect(opts.find((o) => o.family === "SonarSearch")?.iconUrl).toBeTruthy();
  });

  it("is empty for an unknown hull", () => {
    expect(bakedToggleOptions(999999999)).toEqual([]);
  });
});

describe("gameparamsSlotGroups", () => {
  it("builds one group per slot with alternatives collapsed to families", () => {
    const groups = gameparamsSlotGroups(FAKE_GP, "en-US");
    expect(groups.map((g) => g.slot)).toEqual([2, 3]);
    expect(groups[0].key).toBe("Y");
    expect(groups[0].options.map((o) => o.family)).toEqual(["Spotter", "Fighter"]);
    expect(groups[1].key).toBe("U");
    expect(groups[1].options.map((o) => o.family)).toEqual(["RLSSearch"]);
  });

  it("yields nothing for a slice without abilities", () => {
    expect(gameparamsSlotGroups({}, "en-US")).toEqual([]);
    expect(gameparamsSlotGroups(null, "en-US")).toEqual([]);
  });
});

describe("effectiveFamilies / selectFamily", () => {
  const groups = gameparamsSlotGroups(FAKE_GP, "en-US");

  it("defaults every untouched slot to its first option", () => {
    expect(effectiveFamilies(groups, [])).toEqual(["Spotter", "RLSSearch"]);
  });

  it("honours an explicit choice per slot", () => {
    expect(effectiveFamilies(groups, ["Fighter", "RLSSearch"])).toEqual([
      "Fighter",
      "RLSSearch",
    ]);
  });

  it("switching one slot writes the full effective loadout", () => {
    expect(selectFamily(groups, ["Fighter", "RLSSearch"], 2, "Spotter")).toEqual([
      "Spotter",
      "RLSSearch",
    ]);
  });
});
