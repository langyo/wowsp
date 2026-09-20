/** Tests for the GameParams AA extraction: stock-hull auras across the
 *  A_AirDefense / A_ATBA / A_Artillery blocks aggregate into per-band DPS /
 *  range / hit-chance / flak stats, structurally ignoring mount HP_* entries
 *  and the priority-sector settings dicts. Fixtures are inline minimal
 *  GameParams subtrees (Yamato- and Seattle-shaped), not the big dump. */
import { describe, expect, it } from "vitest";

import { buildAntiAirRows, collectAaBands, gunBandMap } from "./antiAir";

// Yamato-shaped: two near auras sharing 2500 m (109 + 2 DPS), the far aura
// and its bubbles companion living in A_ATBA. AimedFire (priority sector)
// and the HP_* mount dicts must not be read as auras.
const yamatoGp = {
  A_AirDefense: {
    AuraNear1: {
      type: "near", areaDamage: 109, bubbleDamage: 0,
      maxDistance: 2500, minDistance: 700, hitChance: 0.85,
      innerBubbleCount: 0, outerBubbleCount: 0,
      guns: ["HP_JGA021"],
    },
    AuraNear2: {
      type: "near", areaDamage: 2, bubbleDamage: 0,
      maxDistance: 2500, minDistance: 0, hitChance: 0.85,
      innerBubbleCount: 0, outerBubbleCount: 0,
      guns: ["HP_JGA023"],
    },
    AimedFire: { cooldownTime: 5, boostAreaDamageCoeff: 1.35 },
    HP_JGA021: { name: "PJSA012", numBarrels: 3, barrelDiameter: 0.025 },
    HP_JGA023: { name: "PJSA017", numBarrels: 1, barrelDiameter: 0.0132 },
    // Claimed by no aura's guns list — must not appear in gunBandMap.
    HP_JGA019: { name: "PJSA011", numBarrels: 2, barrelDiameter: 0.0132 },
  },
  A_ATBA: {
    AuraFar: {
      type: "far", areaDamage: 42, bubbleDamage: 0,
      maxDistance: 5800, minDistance: 1500, hitChance: 0.75,
      innerBubbleCount: 0, outerBubbleCount: 0,
      guns: ["HP_JGA037"],
    },
    AuraFar_Bubbles: {
      type: "far", areaDamage: 0, bubbleDamage: 230,
      maxDistance: 5800, minDistance: 1500, hitChance: 0.75,
      innerBubbleCount: 5, outerBubbleCount: 1,
      guns: [],
    },
    HP_JGA037: { name: "PJSA015", numBarrels: 8, barrelDiameter: 0.127 },
  },
};

// Seattle-shaped: dual-purpose main battery keeps the far aura inside
// A_Artillery, not A_AirDefense.
const seattleGp = {
  A_AirDefense: {
    Medium_1: {
      type: "medium", areaDamage: 147, bubbleDamage: 0,
      maxDistance: 4000, hitChance: 0.75, guns: ["HP_PDM016"],
    },
    Near_1: {
      type: "near", areaDamage: 158, bubbleDamage: 0,
      maxDistance: 2000, hitChance: 0.85, guns: ["HP_PGM002"],
    },
    HP_PDM016: { name: "PDSA034", numBarrels: 2, barrelDiameter: 0.0762 },
    HP_PGM002: { name: "PGSA012", numBarrels: 1, barrelDiameter: 0.02 },
  },
  A_Artillery: {
    Far_1: {
      type: "far", areaDamage: 31, bubbleDamage: 0,
      maxDistance: 6900, hitChance: 0.75, guns: ["HP_PDM_1"],
    },
    HP_PDM_1: { name: "PDSA020", numBarrels: 2, barrelDiameter: 0.127 },
  },
};

// Submarine-shaped: no auras anywhere.
const subGp = {
  A_Hull: { health: 24000, draft: 5.5 },
};

// Scarlet-Thunder-shaped (PBSB609, values from the real GameParams): TWO
// bubble auras share the far band (in A_ATBA on the real ship). Their
// bubbleDamage matches (always true in the data) and the clouds from each
// source ADD in-game, so counts sum: (3+1) + (2+1) = 7.
const scarletThunderGp = {
  A_ATBA: {
    AuraFar1: {
      type: "far", areaDamage: 23, bubbleDamage: 0,
      maxDistance: 6000, hitChance: 0.75, guns: ["HP_HGA209"],
    },
    AuraFar1_Bubbles: {
      type: "far", areaDamage: 0, bubbleDamage: 210,
      maxDistance: 6000, hitChance: 0.75,
      innerBubbleCount: 3, outerBubbleCount: 1, guns: [],
    },
    AuraFar: {
      type: "far", areaDamage: 16, bubbleDamage: 0,
      maxDistance: 6000, hitChance: 0.75, guns: ["HP_HGA204"],
    },
    AuraFar_Bubbles: {
      type: "far", areaDamage: 0, bubbleDamage: 210,
      maxDistance: 6000, hitChance: 0.75,
      innerBubbleCount: 2, outerBubbleCount: 1, guns: [],
    },
  },
};

describe("collectAaBands", () => {
  it("sums same-range near auras and folds the far bubbles companion", () => {
    const bands = collectAaBands(yamatoGp);
    expect(bands.map((b) => b.key)).toEqual(["near", "far"]);
    const near = bands[0];
    expect(near.dps).toBe(111);
    expect(near.rangeM).toBe(2500);
    expect(near.hitChance).toBe(0.85);
    expect(near.flakDamage).toBeNull();
    const far = bands[1];
    expect(far.dps).toBe(42);
    expect(far.rangeM).toBe(5800);
    expect(far.flakDamage).toBe(230);
    expect(far.flakCount).toBe(6); // inner 5 + outer 1
  });

  it("picks the far band up from A_Artillery on DP main-battery ships", () => {
    const bands = collectAaBands(seattleGp);
    expect(bands.map((b) => b.key)).toEqual(["near", "medium", "far"]);
    const far = bands[2];
    expect(far.dps).toBe(31);
    expect(far.rangeM).toBe(6900);
  });

  it("returns nothing for hulls without auras", () => {
    expect(collectAaBands(subGp)).toEqual([]);
    expect(collectAaBands(null)).toEqual([]);
    expect(collectAaBands(undefined)).toEqual([]);
  });

  it("sums the clouds when several bubble auras share the far band", () => {
    const bands = collectAaBands(scarletThunderGp);
    expect(bands.map((b) => b.key)).toEqual(["far"]);
    const far = bands[0];
    expect(far.dps).toBe(23 + 16);
    expect(far.flakDamage).toBe(210);
    expect(far.flakCount).toBe(7); // (3+1) + (2+1)
  });
});

describe("buildAntiAirRows", () => {
  it("formats range, DPS, hit chance and flak per band", () => {
    const rows = buildAntiAirRows(yamatoGp);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(byKey["aaShortRange"]).toBe("2.5 km");
    expect(byKey["aaShortDps"]).toBe("111");
    expect(byKey["aaShortHitChance"]).toBe("85%");
    expect(byKey["aaLongRange"]).toBe("5.8 km");
    expect(byKey["aaLongDps"]).toBe("42");
    expect(byKey["aaLongHitChance"]).toBe("75%");
    expect(byKey["aaFlakDamage"]).toBe("230");
    expect(byKey["aaFlakCount"]).toBe("6");
  });

  it("reads the DP far band range from A_Artillery", () => {
    const byKey = Object.fromEntries(buildAntiAirRows(seattleGp).map((r) => [r.key, r.value]));
    expect(byKey["aaLongRange"]).toBe("6.9 km");
    expect(byKey["aaLongDps"]).toBe("31");
  });

  it("emits no rows for hulls without auras", () => {
    expect(buildAntiAirRows(subGp)).toEqual([]);
  });

  it("adds flak clouds across the band's bubble auras", () => {
    const byKey = Object.fromEntries(buildAntiAirRows(scarletThunderGp).map((r) => [r.key, r.value]));
    expect(byKey["aaFlakDamage"]).toBe("210");
    expect(byKey["aaFlakCount"]).toBe("7"); // (3+1) + (2+1)
  });
});

describe("gunBandMap", () => {
  it("maps mounts to their aura's band and leaves unlisted mounts out", () => {
    const map = gunBandMap(yamatoGp);
    expect(map.get("HP_JGA037")).toBe("far");
    expect(map.get("HP_JGA021")).toBe("near");
    expect(map.get("HP_JGA023")).toBe("near");
    // Present in the block but claimed by no aura's guns list.
    expect(map.has("HP_JGA019")).toBe(false);
  });

  it("resolves a slot listed in several bands to the outermost one", () => {
    const map = gunBandMap({
      A_AirDefense: {
        AuraNear: { type: "near", areaDamage: 5, guns: ["HP_X_1"] },
        AuraFar: { type: "far", areaDamage: 5, guns: ["HP_X_1"] },
      },
    });
    expect(map.get("HP_X_1")).toBe("far");
  });
});
