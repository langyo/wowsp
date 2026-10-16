/**
 * Tests for the damage-composition split (伤害组成) behind the self
 * report: the weapon-family mapping (the vendored DamageStatWeapon table's
 * families, aircraft ids through the shared isPlaneWeapon predicate), the
 * server-total fold into families (enemy category only, latest tick per
 * pair wins), and the launch-join classifier behind the ledger rows'
 * per-weapon chips.
 */
import { describe, expect, it } from "vitest";

import type { ShellLaunchEvent, TorpedoLaunch } from "@/api";
import {
  foldDamageComp,
  rowCompEntries,
  shotWeaponJoiner,
  weaponFamilyOf,
} from "./damageComp";

describe("weaponFamilyOf", () => {
  it("maps the documented DamageStatWeapon ids onto their families", () => {
    expect(weaponFamilyOf(1)).toBe("main"); // MainAp
    expect(weaponFamilyOf(2)).toBe("main"); // MainHe
    expect(weaponFamilyOf(6)).toBe("main"); // MainAiHe
    expect(weaponFamilyOf(3)).toBe("atba"); // AtbaAp
    expect(weaponFamilyOf(33)).toBe("atba"); // AtbaCs
    expect(weaponFamilyOf(7)).toBe("torpedo"); // ship torpedo
    expect(weaponFamilyOf(60)).toBe("torpedo"); // TorpedoAlter
    expect(weaponFamilyOf(17)).toBe("burn");
    expect(weaponFamilyOf(20)).toBe("flood");
    expect(weaponFamilyOf(27)).toBe("depth"); // ship-launched depth charge
    expect(weaponFamilyOf(18)).toBe("ram");
  });

  it("resolves aircraft weapons through the shared isPlaneWeapon set", () => {
    expect(weaponFamilyOf(10)).toBe("air"); // BomberAp (completes the tile's set)
    expect(weaponFamilyOf(11)).toBe("air"); // BomberHe
    expect(weaponFamilyOf(28)).toBe("air"); // RocketHe
    expect(weaponFamilyOf(55)).toBe("air"); // RocketApAsup
    expect(weaponFamilyOf(61)).toBe("air"); // AirSupport
    expect(weaponFamilyOf(73)).toBe("air"); // TBomberTc
    expect(weaponFamilyOf(58)).toBe("air"); // aircraft depth charges stay air
    // Non-aircraft ids stay out of the family: 70 (Recon) only spots, and
    // 79-81 are the laser/event weapons.
    expect(weaponFamilyOf(70)).toBe("other");
    expect(weaponFamilyOf(80)).toBe("other");
  });

  it("falls everything unlisted to other", () => {
    expect(weaponFamilyOf(0)).toBe("other"); // Default
    expect(weaponFamilyOf(22)).toBe("other"); // Radar
    expect(weaponFamilyOf(83)).toBe("other"); // Missile
  });
});

describe("foldDamageComp", () => {
  it("groups enemy-category totals per family, latest tick per pair winning", () => {
    const total = foldDamageComp([
      // Cumulative ticks of the same pair — the later replaces the earlier.
      { time: 1, weapon: 1, category: 0, count: 5, total: 1000 },
      { time: 2, weapon: 1, category: 0, count: 9, total: 2000 },
      { time: 2, weapon: 7, category: 0, count: 2, total: 30000 },
      { time: 3, weapon: 17, category: 0, count: 1, total: 2500.4 },
      // Ally damage (category 1) never counts.
      { time: 3, weapon: 1, category: 1, count: 4, total: 9999 },
    ]);
    const byFamily = new Map(total.map((f) => [f.family, f]));
    expect(byFamily.get("main")).toMatchObject({ total: 2000, count: 9 });
    expect(byFamily.get("torpedo")).toMatchObject({ total: 30000, count: 2 });
    // Fractional server totals round at the fold.
    expect(byFamily.get("burn")).toMatchObject({ total: 2500, count: 1 });
    expect(total[0].family).toBe("torpedo"); // desc by total
  });

  it("returns an empty list without samples", () => {
    expect(foldDamageComp(null)).toEqual([]);
    expect(foldDamageComp([])).toEqual([]);
  });
});

function shellLaunch(ownerId: number, shotId: number, time = 1): ShellLaunchEvent {
  return {
    time,
    ownerId,
    paramsId: 1,
    salvoId: 1,
    shotId,
    x: 0,
    y: 0,
    z: 0,
    targetX: 0,
    targetY: 0,
    targetZ: 0,
    serverTimeLeft: 0,
    speed: 800,
    gunBarrelId: 0,
  };
}

function torpedoLaunch(ownerId: number, shotId: number, time = 1): TorpedoLaunch {
  return {
    time,
    ownerId,
    paramsId: 2,
    salvoId: 1,
    shotId,
    x: 0,
    y: 0,
    z: 0,
    dirX: 1,
    dirY: 0,
    dirZ: 0,
    armed: true,
  };
}

describe("shotWeaponJoiner", () => {
  it("classifies hits by the nearest (ownerId, shotId) launch at or before the hit", () => {
    const joiner = shotWeaponJoiner([shellLaunch(10, 5)], [torpedoLaunch(10, 6)]);
    expect(joiner(10, 5, 11)).toBe("shell");
    expect(joiner(10, 6, 12)).toBe("torpedo");
    // Unlaunched hits (aircraft weapons, DoT splashes) have no bucket.
    expect(joiner(10, 7, 13)).toBeNull();
    // A different owner's identical shot id does not cross-match.
    expect(joiner(11, 5, 13)).toBeNull();
    // A launch AFTER the hit does not own it.
    expect(joiner(10, 5, 0.5)).toBeNull();
  });

  it("survives per-salvo shot-id recycling (gun ids colliding with fish ids)", () => {
    // Both families fire shotId 3: a fish launched at t=5, gun salvos at
    // t=30 and t=60 (ids recycle per salvo). The NEAREST preceding launch
    // owns each hit — a battle-wide id set would chip the late gun hits as
    // torpedo.
    const joiner = shotWeaponJoiner(
      [shellLaunch(10, 3, 30), shellLaunch(10, 3, 60)],
      [torpedoLaunch(10, 3, 5)],
    );
    expect(joiner(10, 3, 10)).toBe("torpedo"); // only the fish is in flight
    expect(joiner(10, 3, 31)).toBe("shell"); // the t=30 salvo is nearest
    expect(joiner(10, 3, 65)).toBe("shell"); // the t=60 salvo is nearest
    expect(joiner(10, 3, 3)).toBeNull(); // nothing launched yet
  });

  it("degenerates to a null classifier without launch streams", () => {
    const joiner = shotWeaponJoiner(undefined, []);
    expect(joiner(10, 5, 9)).toBeNull();
  });
});

describe("rowCompEntries", () => {
  it("lists non-zero buckets in shell → torpedo → other order", () => {
    expect(
      rowCompEntries({ torpedo: 200, other: 50, shell: 1000 }),
    ).toEqual([
      { key: "shell", total: 1000 },
      { key: "torpedo", total: 200 },
      { key: "other", total: 50 },
    ]);
  });

  it("drops zero buckets and handles absent compositions", () => {
    expect(rowCompEntries({ shell: 0, torpedo: 120 })).toEqual([
      { key: "torpedo", total: 120 },
    ]);
    expect(rowCompEntries(undefined)).toEqual([]);
    expect(rowCompEntries({})).toEqual([]);
  });
});
