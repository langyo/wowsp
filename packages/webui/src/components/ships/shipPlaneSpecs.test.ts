/**
 * Unit tests for the aircraft spec-tree extraction, pinned on the five anchor
 * airframes from the aircraft-specs contract. Their numbers were verified
 * against the wargaming wiki when the GameParams field mapping was derived
 * (and re-verified against the generated plane_specs.json), so a data refresh
 * that breaks the mapping shows up here instead of on the ship-detail panel.
 *
 * The anchors are WG-side airframes: the table sources each row from the
 * client that authored it, and the WG dump stays authoritative for these (the
 * Lesta dump rebalanced the same airframes, so its numbers must never win —
 * see scripts/model_convert/extract_plane_specs.py).
 */
import { describe, expect, it } from "vitest";

import planeSpecsDb from "@/data/plane_specs.json";
import { buildPlaneSpecs, planeSpecEntry } from "./shipPlaneSpecs";
import type { SpecGroup } from "./shipSpecs";

/** Display order the contract fixes for aircraft spec groups. */
const GROUPS = ["survivability", "mobility", "concealment", "aircraftWeapon", "aircraftAttack"];

function group(index: string, name: string): SpecGroup | undefined {
  return buildPlaneSpecs(index).find((g) => g.group === name);
}

function value(index: string, groupName: string, key: string): string | undefined {
  return group(index, groupName)?.rows.find((r) => r.key === key)?.value;
}

/** "1,530" -> 1530: fmtInt is locale-grouped, so numeric assertions strip
 *  the separators instead of pinning one runtime locale. */
function asNumber(text: string | undefined): number {
  return Number((text ?? "").replace(/[^0-9.-]/g, ""));
}

describe("buildPlaneSpecs group layout", () => {
  it("emits the contract's five groups in display order", () => {
    expect(buildPlaneSpecs("PAAF110").map((g) => g.group)).toEqual(GROUPS);
  });

  it("returns [] for an unknown airframe index", () => {
    expect(buildPlaneSpecs("PZZZ999")).toEqual([]);
    expect(planeSpecEntry("PZZZ999")).toBeNull();
  });

  it("keeps torpedo rows out of a rocket fighter", () => {
    expect(group("PAAF110", "aircraftWeapon")?.rows.map((r) => r.key)).toEqual([
      "ammoType",
      "aircraftDamage",
      "aircraftPenetration",
      "aircraftFireChance",
    ]);
  });

  it("has no stub row that would render an empty aircraft panel", () => {
    // The extractor only stores rows it could source from GameParams; a blank
    // airframe is deliberately not committed (the panel shows its own
    // "no specifications for this aircraft" message instead).
    const blank = Object.keys(planeSpecsDb as Record<string, unknown>).filter(
      (index) => buildPlaneSpecs(index).length === 0,
    );
    expect(blank).toEqual([]);
  });

  it("keeps HE/AP-only rows out of a torpedo bomber", () => {
    expect(group("PAAB110", "aircraftWeapon")?.rows.map((r) => r.key)).toEqual([
      "aircraftDamage",
      "aircraftFloodChance",
      "torpSpeed",
      "torpRange",
      "torpDetect",
    ]);
  });
});

describe("contract anchor airframes (WG data)", () => {
  it("PAAF110 — Midway stock rocket fighter", () => {
    // hp / squadron / flight / deck / regen / speeds / payload / weapon.
    expect(planeSpecEntry("PAAF110")).toMatchObject({
      hp: 1530,
      squadron: 9,
      flight: 3,
      deck: 14,
      regen: 68,
      cruise: 173,
      maxSpeed: 213,
      payload: 10,
      ammo: "rocket",
      damage: 2000,
      pen: 33,
      fire: 7,
    });
    expect(asNumber(value("PAAF110", "survivability", "aircraftHp"))).toBe(1530);
    expect(value("PAAF110", "survivability", "aircraftRegen")).toBe("68.0 s");
    expect(value("PAAF110", "mobility", "aircraftCruiseSpeed")).toBe("173 kn");
    expect(value("PAAF110", "mobility", "maxSpeed")).toBe("213 kn");
    expect(value("PAAF110", "concealment", "aircraftDetect")).toBe("10.0 km");
    expect(value("PAAF110", "aircraftWeapon", "ammoType")).toBe("HE");
    expect(asNumber(value("PAAF110", "aircraftWeapon", "aircraftDamage"))).toBe(2000);
    expect(value("PAAF110", "aircraftWeapon", "aircraftPenetration")).toBe("33 mm");
    expect(value("PAAF110", "aircraftWeapon", "aircraftFireChance")).toBe("7%");
    expect(asNumber(value("PAAF110", "aircraftAttack", "aircraftPayload"))).toBe(10);
    expect(value("PAAF110", "aircraftAttack", "aircraftPrepTime")).toBe("5.0 s");
    expect(value("PAAF110", "aircraftAttack", "aircraftCooldown")).toBe("5.0 s");
  });

  it("PAAB110 — Midway stock torpedo bomber", () => {
    // Torpedo damage = alphaDamage / 3 + flooding: 12800/3 + 800 = 5067.
    expect(planeSpecEntry("PAAB110")).toMatchObject({
      hp: 1960,
      squadron: 8,
      flight: 2,
      cruise: 128,
      maxSpeed: 163,
      payload: 2,
      ammo: "torpedo",
      damage: 5067,
      torpSpeed: 35,
      torpRange: 4.0,
      torpDetect: 1.1,
      flood: 42,
    });
    expect(asNumber(value("PAAB110", "aircraftWeapon", "aircraftDamage"))).toBe(5067);
    expect(value("PAAB110", "aircraftWeapon", "aircraftFloodChance")).toBe("42%");
    expect(value("PAAB110", "aircraftWeapon", "torpSpeed")).toBe("35 kn");
    expect(value("PAAB110", "aircraftWeapon", "torpRange")).toBe("4.0 km");
    expect(value("PAAB110", "aircraftWeapon", "torpDetect")).toBe("1.1 km");
    expect(value("PAAB110", "aircraftWeapon", "aircraftPenetration")).toBeUndefined();
  });

  it("PAAD110 — Midway stock HE dive bomber", () => {
    expect(planeSpecEntry("PAAD110")).toMatchObject({
      hp: 2060,
      squadron: 9,
      flight: 3,
      deck: 14,
      regen: 76,
      cruise: 128,
      maxSpeed: 163,
      payload: 2,
      ammo: "bomb",
      damage: 11200,
      pen: 67,
      fire: 64,
      prep: 6,
      cooldown: 9,
    });
    expect(value("PAAD110", "survivability", "aircraftRegen")).toBe("76.0 s");
    expect(value("PAAD110", "aircraftWeapon", "ammoType")).toBe("HE");
    expect(asNumber(value("PAAD110", "aircraftWeapon", "aircraftDamage"))).toBe(11200);
    expect(value("PAAD110", "aircraftWeapon", "aircraftPenetration")).toBe("67 mm");
    expect(value("PAAD110", "aircraftWeapon", "aircraftFireChance")).toBe("64%");
    expect(value("PAAD110", "aircraftAttack", "aircraftPrepTime")).toBe("6.0 s");
    expect(value("PAAD110", "aircraftAttack", "aircraftCooldown")).toBe("9.0 s");
  });

  it("PGAD918 — Hildebrand heavy HE dive bomber", () => {
    expect(planeSpecEntry("PGAD918")).toMatchObject({
      hp: 1530,
      squadron: 6,
      flight: 6,
      deck: 6,
      regen: 300,
      cruise: 174,
      maxSpeed: 214,
      payload: 1,
      damage: 13700,
      pen: 68,
      fire: 78,
    });
    expect(value("PGAD918", "survivability", "aircraftRegen")).toBe("300.0 s");
    expect(value("PGAD918", "aircraftWeapon", "ammoType")).toBe("HE");
    expect(asNumber(value("PGAD918", "aircraftWeapon", "aircraftDamage"))).toBe(13700);
    expect(value("PGAD918", "aircraftWeapon", "aircraftPenetration")).toBe("68 mm");
    expect(value("PGAD918", "aircraftWeapon", "aircraftFireChance")).toBe("78%");
  });

  it("PGAB918 — Hildebrand torpedo bomber (torpedo stored under bombName)", () => {
    expect(planeSpecEntry("PGAB918")).toMatchObject({
      hp: 1710,
      squadron: 3,
      flight: 3,
      deck: 3,
      regen: 80,
      cruise: 174,
      maxSpeed: 214,
      payload: 1,
      ammo: "torpedo",
      damage: 4533,
      torpSpeed: 55,
      torpRange: 3.0,
      torpDetect: 1.4,
      flood: 39,
    });
    expect(asNumber(value("PGAB918", "aircraftWeapon", "aircraftDamage"))).toBe(4533);
    expect(value("PGAB918", "aircraftWeapon", "aircraftFloodChance")).toBe("39%");
    expect(value("PGAB918", "aircraftWeapon", "torpSpeed")).toBe("55 kn");
    expect(value("PGAB918", "aircraftWeapon", "torpRange")).toBe("3.0 km");
    expect(value("PGAB918", "aircraftWeapon", "torpDetect")).toBe("1.4 km");
    expect(value("PGAB918", "aircraftWeapon", "ammoType")).toBeUndefined();
  });
});
