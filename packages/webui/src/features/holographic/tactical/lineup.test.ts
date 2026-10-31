/**
 * Lineup unit tests. The localStorage-backed loaders run against the jsdom
 * store (cleared per test, same pattern as planSlots.test.ts); resolution
 * tests stub the encyclopedia map (the baked assets are imported by
 * lineup.ts itself — these tests only assert shapes and the copy/mirror/
 * spawn math).
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  cloneBuild,
  copySide,
  emptyLineup,
  loadLineup,
  makeEntry,
  mirrorHeading,
  mirrorPoint,
  newEntryId,
  resolveUnit,
  saveLineup,
  spawnPoses,
  type LineupEntry,
} from "./lineup";

const BOUNDS = { minX: -700, maxX: 700, minZ: -700, maxZ: 700 };

describe("persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips a lineup", () => {
    const lu = emptyLineup();
    lu.ally.push(makeEntry(4290883632));
    lu.enemy.push(makeEntry(4182902352, "Label"));
    saveLineup("20_NE", lu);
    const back = loadLineup("20_NE");
    expect(back.ally).toHaveLength(1);
    expect(back.ally[0].shipId).toBe(4290883632);
    expect(back.enemy[0].label).toBe("Label");
  });

  it("a corrupt entry drops out instead of bricking the lineup", () => {
    window.localStorage.setItem(
      "wowsp:tactics:lineup:v1:20_NE",
      JSON.stringify({ ally: [{ shipId: "x" }], enemy: [] }),
    );
    expect(loadLineup("20_NE").ally).toHaveLength(0);
  });

  it("a missing key yields an empty lineup", () => {
    expect(loadLineup("nowhere")).toEqual(emptyLineup());
  });

  it("round-trips a per-hull build (slots numeric, healthPct clamped)", () => {
    const build = {
      skills: { GmShellReload: 1 as const },
      signals: ["PCEF016"],
      upgrades: { 2: "PCM027_ConcealmentMeasures_Mod_I" },
      commander: "PAW102_Halsey",
      healthPct: 0.5,
    };
    const lu = emptyLineup();
    lu.ally.push(makeEntry(4290883632, "", build));
    saveLineup("20_NE", lu);
    const back = loadLineup("20_NE");
    // JSON turns slot keys into strings; sanitize normalizes them back.
    expect(back.ally[0].build).toEqual(build);
  });

  it("a legacy entry without a build loads as build null (implicit default)", () => {
    window.localStorage.setItem(
      "wowsp:tactics:lineup:v1:20_NE",
      JSON.stringify({
        ally: [{ id: "lu-1", shipId: 1, label: "", torpedo: 0, consumables: [] }],
        enemy: [],
      }),
    );
    expect(loadLineup("20_NE").ally[0].build).toBeNull();
  });

  it("a corrupt build degrades to an empty-but-valid one", () => {
    window.localStorage.setItem(
      "wowsp:tactics:lineup:v1:20_NE",
      JSON.stringify({
        ally: [
          {
            id: "lu-1",
            shipId: 1,
            consumables: [],
            build: { signals: ["x", 3], upgrades: { bad: 4 }, healthPct: 9 },
          },
        ],
        enemy: [],
      }),
    );
    const build = loadLineup("20_NE").ally[0].build!;
    expect(build.signals).toEqual(["x"]);
    expect(build.upgrades).toEqual({});
    expect(build.healthPct).toBe(1);
    expect(build.commander).toBeNull();
  });
});

describe("copySide", () => {
  it("copies with fresh ids (independent hulls)", () => {
    const a = makeEntry(1);
    const lu = { ally: [a], enemy: [] };
    const out = copySide(lu, "ally", "enemy");
    expect(out.enemy).toHaveLength(1);
    expect(out.enemy[0].shipId).toBe(1);
    expect(out.enemy[0].id).not.toBe(a.id);
    expect(out.ally).toBe(lu.ally); // source untouched
  });

  it("deep-copies the build (copies never share skill dicts)", () => {
    const a: LineupEntry = {
      ...makeEntry(1),
      build: { skills: { A: 1 }, signals: ["PCEF016"], upgrades: { 0: "X" }, commander: null, healthPct: 1 },
    };
    const out = copySide({ ally: [a], enemy: [] }, "ally", "enemy");
    out.enemy[0].build!.skills.B = 1;
    out.enemy[0].build!.signals.push("PCEF017");
    expect(Object.keys(a.build!.skills)).toEqual(["A"]);
    expect(a.build!.signals).toEqual(["PCEF016"]);
  });
});

describe("cloneBuild", () => {
  it("normalizes string slot keys back to numbers", () => {
    const out = cloneBuild({
      skills: { A: 1 },
      signals: [],
      upgrades: { "2": "PCM001", 3: "PCM002" },
      commander: null,
      healthPct: 1,
    });
    expect(Object.keys(out!.upgrades).map(Number).sort()).toEqual([2, 3]);
  });

  it("passes null through", () => {
    expect(cloneBuild(null)).toBeNull();
    expect(cloneBuild(undefined)).toBeNull();
  });
});

describe("mirroring", () => {
  it("point-reflects through the map centre (both axes)", () => {
    expect(mirrorPoint({ x: 300, z: -50 }, BOUNDS)).toEqual({ x: -300, z: 50 });
  });

  it("swings the bow 180°", () => {
    expect(mirrorHeading(Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 6);
    expect(mirrorHeading(0)).toBeCloseTo(Math.PI, 6);
    expect(mirrorHeading(Math.PI)).toBeCloseTo(0, 6);
  });

});

describe("spawnPoses", () => {
  it("allies spawn on the south edge facing north, enemies the mirror", () => {
    const ally = spawnPoses(BOUNDS, "ally", 3);
    const enemy = spawnPoses(BOUNDS, "enemy", 3);
    expect(ally).toHaveLength(3);
    expect(ally.every((p) => p.heading === 0)).toBe(true);
    expect(ally.every((p) => p.at.z < 0)).toBe(true);
    expect(enemy.every((p) => p.heading === Math.PI)).toBe(true);
    expect(enemy.every((p) => p.at.z > 0)).toBe(true);
  });

  it("single-hull sides centre on the spawn line", () => {
    const [solo] = spawnPoses(BOUNDS, "ally", 1);
    expect(solo.at.x).toBeCloseTo(0, 6);
  });
});

describe("resolveUnit", () => {
  it("falls back to the ship id when nothing is known", () => {
    const u = resolveUnit(makeEntry(999999999), new Map());
    expect(u.name).toBe("#999999999");
    expect(u.topSpeedKn).toBeGreaterThan(0);
  });

  it("uses the encyclopedia name and type when present", () => {
    const ship = {
      shipId: 1,
      name: "Test Cruiser",
      type: "Cruiser",
    } as never;
    const u = resolveUnit(makeEntry(1), new Map([[1, ship]]));
    expect(u.name).toBe("Test Cruiser");
    expect(u.shipType).toBe("Cruiser");
  });

  it("an explicit label wins over the ship name", () => {
    const ship = { shipId: 1, name: "Test Cruiser" } as never;
    const e = { ...makeEntry(1), label: "Mine" };
    expect(resolveUnit(e, new Map([[1, ship]])).name).toBe("Mine");
  });
});

describe("newEntryId", () => {
  it("mints unique ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newEntryId()));
    expect(ids.size).toBe(50);
  });
});
