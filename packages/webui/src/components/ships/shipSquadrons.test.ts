/**
 * Tests for the airframe-picker option builder (shipSquadrons.ts) and the
 * committed squadron seed (data/ship_squadrons.json).
 *
 * The seed is what makes the ship-detail dropdown + aircraft-view hint
 * instant: they used to wait for the ship GameParams slice, which on
 * desktop unpacks from the install for several seconds per uncached ship.
 * The fixtures pin REAL baked entities (Hakuryu's six airframes, the
 * Azur Kearsarge scout) so a rebake that drifts — squadron blocks moved
 * off the served-slice top level, airframes losing their baked GLBs or
 * their plane_types.json roles — fails here instead of as a late-or-empty
 * picker on the ship-detail modal.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { setLocale } from "@/i18n";
import planeModelsDb from "@/data/plane_models.json";
import planeTypesDb from "@/data/plane_types.json";
import techTreeDb from "@/data/tech_tree.json";
import squadronsTable from "@/data/ship_squadrons.json";
import {
  buildPlaneOptionsFromSeed,
  buildPlaneOptionsFromSlice,
  squadronSeed,
  type SquadronSeedEntry,
} from "./shipSquadrons";

// The label assertions pin the zh-CN strings. setLocale is async (the
// zh-CN bundle loads lazily), so the switch must be awaited first.
beforeAll(async () => {
  await setLocale("zh-CN");
});

// Hakuryu's real baked squadrons: two airframes per role (stock + top),
// which is exactly the shape the qualifier distillation exists for.
const HAKURYU_ID = 4179605200;

function hakuryuSeed(): SquadronSeedEntry {
  const seed = squadronSeed(HAKURYU_ID);
  expect(seed, "Hakuryu must stay in the committed seed table").not.toBeNull();
  return seed!;
}

describe("squadronSeed", () => {
  it("resolves committed ships and rejects everything else", () => {
    const seed = squadronSeed(HAKURYU_ID);
    expect(seed?.name).toBe("PJSA110_Hakuryu");
    expect(seed?.planes).toHaveLength(6);
    expect(squadronSeed(1)).toBeNull();
    expect(squadronSeed(null)).toBeNull();
    expect(squadronSeed(undefined)).toBeNull();
  });

  it("covers every tech-tree carrier (the reported late-picker ships)", () => {
    const carriers = Object.values(techTreeDb).filter(
      (n) => (n as { type?: string }).type === "AirCarrier",
    );
    expect(carriers.length).toBeGreaterThan(20);
    for (const node of carriers) {
      expect(
        squadronSeed((node as { shipId: number }).shipId),
        `tree carrier ${(node as { index: string }).index} must be seeded`,
      ).not.toBeNull();
    }
  });
});

describe("buildPlaneOptionsFromSeed", () => {
  it("labels Hakuryu by role with stock/top qualifiers, role-grouped", () => {
    const options = buildPlaneOptionsFromSeed(hakuryuSeed(), "Hakuryu");
    // Role order groups the entries: torpedo bombers (PJAB*), AP dive
    // bombers (PJAD*), rockets (PJAF*); stock before top inside a role.
    expect(options.map((o) => o.index)).toEqual([
      "PJAB110", "PJAB210",
      "PJAD110", "PJAD210",
      "PJAF110", "PJAF210",
    ]);
    expect(options.map((o) => o.label)).toEqual([
      "鱼雷机 · 白板",
      "鱼雷机 · 顶级",
      "AP轰炸机 · 白板",
      "AP轰炸机 · 顶级",
      "火箭机 · 白板",
      "火箭机 · 顶级",
    ]);
  });

  it("keeps the role name alone when a role has a single airframe", () => {
    // Azur Kearsarge fields one scout only — no qualifier to distill.
    const seed = squadronSeed(3362732016);
    expect(seed, "Azur Kearsarge must stay in the committed seed table").not.toBeNull();
    const options = buildPlaneOptionsFromSeed(seed!, "Kearsarge");
    expect(options).toHaveLength(1);
    expect(options[0].index).toBe("PAAF801");
    expect(options[0].label).toBe("火箭机");
  });

  it("drops airframes whose names carry no index prefix", () => {
    const options = buildPlaneOptionsFromSeed(
      { name: "X", planes: ["not_a_plane", "PJAD110_Hakuryu_stock"] },
      "X",
    );
    expect(options.map((o) => o.index)).toEqual(["PJAD110"]);
  });
});

describe("buildPlaneOptionsFromSlice", () => {
  it("agrees with the seed path for the same squadron data", () => {
    // The picker must not change what it shows when the live slice
    // replaces the seed — same pipeline, same entries.
    const seed = hakuryuSeed();
    const fakeSlice = {
      name: seed.name,
      Squadron0: { planes: seed.planes.slice(0, 3) },
      Squadron1: { planes: seed.planes.slice(3) },
      ShipUpgradeInfo: {},
    };
    expect(buildPlaneOptionsFromSlice(fakeSlice, "Hakuryu")).toEqual(
      buildPlaneOptionsFromSeed(seed, "Hakuryu"),
    );
  });

  it("returns nothing for slices without squadrons and for a null slice", () => {
    expect(buildPlaneOptionsFromSlice({ ShipHp: { maxHealth: 1 } }, "X")).toEqual([]);
    expect(buildPlaneOptionsFromSlice(null, "X")).toEqual([]);
  });

  it("dedupes shared airframes and skips non-string entries", () => {
    const slice = {
      name: "PJSA110_Hakuryu",
      A: { planes: ["PJAD110_Hakuryu_stock", "PJAD110_Hakuryu_top", 42, null] },
      B: { planes: ["PJAD110_Hakuryu_stock"] },
    };
    const options = buildPlaneOptionsFromSlice(slice, "Hakuryu");
    expect(options.map((o) => o.index)).toEqual(["PJAD110"]);
  });
});

describe("committed ship_squadrons.json integrity", () => {
  // The rows type-narrow per entry from the JSON import (only Lesta rows
  // carry the optional marker); the seed contract is the module's interface.
  const seed = squadronsTable as Record<string, SquadronSeedEntry>;

  it("only lists airframes the plane tables can label and stage", () => {
    const models = planeModelsDb as Record<string, string>;
    const roleByIndex = new Map(
      Object.values(planeTypesDb as Record<string, { index: string; role?: string }>).map(
        (m) => [m.index, m.role ?? ""],
      ),
    );
    const indexes = Object.keys(seed);
    expect(indexes.length).toBeGreaterThan(100);
    for (const [id, row] of Object.entries(seed)) {
      expect(row.name, `ship ${id} needs its entity name`).toBeTruthy();
      const seen = new Set<string>();
      for (const plane of row.planes) {
        expect(
          plane in models,
          `${plane} (ship ${id}): no baked GLB in plane_models.json`,
        ).toBe(true);
        const index = plane.split("_")[0];
        expect(seen.has(index), `${plane}: duplicate index on ship ${id}`).toBe(false);
        seen.add(index);
        expect(
          roleByIndex.get(index),
          `${plane} (ship ${id}): no role in plane_types.json`,
        ).toBeTruthy();
      }
    }
  });

  it("carries the Lesta-only fleet beside the WG table", () => {
    const lesta = Object.values(seed).filter((r) => r.lesta);
    expect(lesta.length).toBeGreaterThan(10);
    // Lesta rows may only ADD ids the WG dump lacks; every row keeps the
    // shape the labelling pipeline reads.
    for (const row of lesta) {
      expect(row.name).toBeTruthy();
      expect(row.planes.length).toBeGreaterThan(0);
    }
  });
});
