/**
 * Tests for the airframe-picker option pipeline (shipSquadrons.ts) and the
 * committed squadron seed (data/ship_squadrons.json).
 *
 * The picker rows carry three pieces of information the grouped dropdown
 * renders: the aircraft model designation (label), the combat role (group
 * heading) and the base/variant version rank (small tag). The seed is what
 * makes the dropdown + aircraft-view hint instant: they used to wait for the
 * ship GameParams slice, which on desktop unpacks from the install for
 * several seconds per uncached ship. The fixtures pin REAL baked entities
 * (Hakuryu's six airframes, the Azur Kearsarge scout), so a rebake that drifts
 * — squadron blocks moved off the served-slice top level, airframes losing
 * their baked GLBs or their plane_types.json roles — fails here instead of as
 * a late-or-empty picker on the ship-detail modal.
 */
import { describe, expect, it } from "vitest";

import planeModelsDb from "@/data/plane_models.json";
import planeTypesDb from "@/data/plane_types.json";
import techTreeDb from "@/data/tech_tree.json";
import squadronsTable from "@/data/ship_squadrons.json";
import {
  aircraftModelOf,
  buildPlaneOptionsFromSeed,
  buildPlaneOptionsFromSlice,
  groupPlaneModelOptions,
  groupShowsVersionTags,
  planeConfigRank,
  showsVersionTag,
  squadronSeed,
  type SquadronSeedEntry,
} from "./shipSquadrons";

// Hakuryu's real baked squadrons: two airframes per role (stock + top),
// which is exactly the shape the grouped picker + version tags exist for.
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

describe("aircraftModelOf", () => {
  it("distils the baked model stem into the aircraft designation", () => {
    // Hakuryu's stock torpedo bomber (its GameParams model path points at
    // JAB710_Nakajima_C6N5_1b_proto) and the shared J5N dive/torpedo model.
    expect(aircraftModelOf("PJAB110")).toBe("Nakajima C6N5 1b");
    expect(aircraftModelOf("PJAB210")).toBe("J5N");
    expect(aircraftModelOf("PJAF210")).toBe("Mitsubishi A8M");
    expect(aircraftModelOf("PAAF801")).toBe("Grumman F8F Bearcat TinyTim");
  });

  it("falls back to the entity tail when the model path names only the container", () => {
    // PXAB002_Grumman_TBF points at the shared XAB001 container, whose
    // directory carries no aircraft designation — the entity names it.
    expect(aircraftModelOf("PXAB002")).toBe("Grumman TBF");
  });

  it("returns null for airframes the committed tables do not cover", () => {
    expect(aircraftModelOf("PZZ999")).toBeNull();
    expect(aircraftModelOf("")).toBeNull();
  });
});

describe("planeConfigRank", () => {
  it("maps the hull-config suffix words onto base / variant", () => {
    expect(planeConfigRank("Hakuryu_stock")).toBe("base");
    expect(planeConfigRank("ESSEX_STOCK")).toBe("base");
    expect(planeConfigRank("Hakuryu_top")).toBe("variant");
    expect(planeConfigRank("SEKIRYU_JET")).toBe("variant");
    expect(planeConfigRank("TAIHO_TACT")).toBe("variant");
    expect(planeConfigRank("AKAGI_ALT")).toBe("variant");
    // A trailing bake marker must not hide the version word in front of it.
    expect(planeConfigRank("Graf_Zeppelin_stock_WARD")).toBe("base");
  });

  it("leaves aircraft-named / historical squadrons unranked", () => {
    expect(planeConfigRank("Lexington_1944")).toBeNull();
    expect(planeConfigRank("TBF_ENTERPRISE")).toBeNull();
    expect(planeConfigRank("Ju_87C_GZ")).toBeNull();
    expect(planeConfigRank("")).toBeNull();
  });
});

describe("buildPlaneOptionsFromSeed", () => {
  it("names, ranks and role-groups Hakuryu's airframes", () => {
    const options = buildPlaneOptionsFromSeed(hakuryuSeed());
    // Role order groups the entries: torpedo bombers (PJAB*), AP dive
    // bombers (PJAD*), rockets (PJAF*); base before variant inside a role.
    expect(options.map((o) => o.index)).toEqual([
      "PJAB110", "PJAB210",
      "PJAD110", "PJAD210",
      "PJAF110", "PJAF210",
    ]);
    expect(options.map((o) => o.label)).toEqual([
      "Nakajima C6N5 1b",
      "J5N",
      "Mitsubishi A7M2",
      "J5N",
      "Mitsubishi A7M2",
      "Mitsubishi A8M",
    ]);
    expect(options.map((o) => o.role)).toEqual([
      "torpedo", "torpedo",
      "apBomber", "apBomber",
      "rocket", "rocket",
    ]);
    expect(options.map((o) => o.config)).toEqual([
      "base", "variant",
      "base", "variant",
      "base", "variant",
    ]);
  });

  it("sorts the base airframe before the variant one", () => {
    const options = buildPlaneOptionsFromSeed({
      name: "X",
      planes: ["PJAB210_Hakuryu_top", "PJAB110_Hakuryu_stock"],
    });
    expect(options.map((o) => o.index)).toEqual(["PJAB110", "PJAB210"]);
  });

  it("keeps a single airframe unqualified by a version tag", () => {
    // Azur Kearsarge fields one scout-like rocket only — no variant twin.
    const seed = squadronSeed(3362732016);
    expect(seed, "Azur Kearsarge must stay in the committed seed table").not.toBeNull();
    const options = buildPlaneOptionsFromSeed(seed!);
    expect(options).toHaveLength(1);
    expect(options[0].index).toBe("PAAF801");
    expect(options[0].label).toBe("Grumman F8F Bearcat TinyTim");
    expect(options[0].role).toBe("rocket");
    expect(options[0].config).toBeNull();
  });

  it("keeps unmapped roles contiguous when several are present", () => {
    // Airship / dive both sort after the mapped roles and share one rank; the
    // role-key tie-break keeps each role's rows adjacent so the menu never
    // emits the same heading twice (indices here would interleave them).
    const options = buildPlaneOptionsFromSeed({
      name: "X",
      planes: [
        "PXAA001_Airship",
        "PGAD010_SupportDropPlane",
        "PZAD010_SupportDropPlane",
      ],
    });
    const groups = groupPlaneModelOptions(options);
    expect(groups.map((g) => g.role)).toEqual(["airship", "dive"]);
    expect(groups[1].options.map((o) => o.index)).toEqual(["PGAD010", "PZAD010"]);
  });

  it("drops airframes whose names carry no index prefix", () => {
    const options = buildPlaneOptionsFromSeed({
      name: "X",
      planes: ["not_a_plane", "PJAD110_Hakuryu_stock"],
    });
    expect(options.map((o) => o.index)).toEqual(["PJAD110"]);
  });

  it("falls back to the raw suffix for airframes outside the tables", () => {
    const options = buildPlaneOptionsFromSeed({
      name: "X",
      planes: ["PZZ999_Fake_stock"],
    });
    expect(options).toEqual([
      { index: "PZZ999", label: "Fake stock", role: "", config: "base" },
    ]);
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
    expect(buildPlaneOptionsFromSlice(fakeSlice)).toEqual(
      buildPlaneOptionsFromSeed(seed),
    );
  });

  it("returns nothing for slices without squadrons and for a null slice", () => {
    expect(buildPlaneOptionsFromSlice({ ShipHp: { maxHealth: 1 } })).toEqual([]);
    expect(buildPlaneOptionsFromSlice(null)).toEqual([]);
  });

  it("dedupes shared airframes and skips non-string entries", () => {
    const slice = {
      name: "PJSA110_Hakuryu",
      A: { planes: ["PJAD110_Hakuryu_stock", "PJAD110_Hakuryu_top", 42, null] },
      B: { planes: ["PJAD110_Hakuryu_stock"] },
    };
    const options = buildPlaneOptionsFromSlice(slice);
    expect(options.map((o) => o.index)).toEqual(["PJAD110"]);
  });
});

describe("groupPlaneModelOptions", () => {
  it("groups rows under one heading per role, in picker order", () => {
    const groups = groupPlaneModelOptions(buildPlaneOptionsFromSeed(hakuryuSeed()));
    expect(groups.map((g) => g.role)).toEqual(["torpedo", "apBomber", "rocket"]);
    for (const group of groups) {
      expect(group.options).toHaveLength(2);
      expect(group.options.map((o) => o.config)).toEqual(["base", "variant"]);
    }
  });

  it("keeps unmapped roles in one trailing unlabelled bucket", () => {
    const groups = groupPlaneModelOptions([
      { index: "A", label: "A", role: "torpedo", config: "base" },
      { index: "B", label: "B", role: "", config: null },
      { index: "C", label: "C", role: "", config: null },
    ]);
    expect(groups.map((g) => g.role)).toEqual(["torpedo", ""]);
    expect(groups[1].options.map((o) => o.index)).toEqual(["B", "C"]);
  });

  it("returns no groups for an empty picker", () => {
    expect(groupPlaneModelOptions([])).toEqual([]);
  });
});

describe("groupShowsVersionTags", () => {
  it("tags a section that offers both versions of a configuration", () => {
    for (const group of groupPlaneModelOptions(buildPlaneOptionsFromSeed(hakuryuSeed()))) {
      expect(groupShowsVersionTags(group)).toBe(true);
    }
  });

  it("drops the tags for a single airframe and for mixed-rank sections", () => {
    // A lone airframe has no counterpart to be the base / variant OF.
    expect(
      groupShowsVersionTags({
        role: "rocket",
        options: [{ index: "A", label: "A", role: "rocket", config: null }],
      }),
    ).toBe(false);
    // Older "1942/1944" configs mix ranked squadrons with aircraft-named
    // ones; tagging only half the section would read as broken, so none.
    expect(
      groupShowsVersionTags({
        role: "torpedo",
        options: [
          { index: "A", label: "A", role: "torpedo", config: "base" },
          { index: "B", label: "B", role: "torpedo", config: null },
        ],
      }),
    ).toBe(false);
  });
});

describe("showsVersionTag", () => {
  const base = { index: "A", label: "A", role: "torpedo", config: "base" as const };
  const variant = { index: "B", label: "B", role: "torpedo", config: "variant" as const };
  const unranked = { index: "C", label: "C", role: "torpedo", config: null };

  it("tags every row of a fully versioned section", () => {
    const group = { role: "torpedo", options: [base, variant] };
    expect(showsVersionTag(group, base)).toBe(true);
    expect(showsVersionTag(group, variant)).toBe(true);
  });

  it("never tags an unranked row", () => {
    expect(
      showsVersionTag({ role: "torpedo", options: [base, unranked] }, unranked),
    ).toBe(false);
  });

  it("tags a mixed section row only when its label is shared with a sibling", () => {
    // Lesta "…_ALT" rocket squadrons reuse one model for two entities: with
    // distinct labels the mixed section stays untagged, but the duplicated
    // row keeps its tag so the two airframes stay distinguishable.
    const distinct = { role: "torpedo", options: [base, unranked] };
    expect(showsVersionTag(distinct, base)).toBe(false);
    const twinUnranked = { ...unranked, label: "A" };
    const shared = { role: "torpedo", options: [base, twinUnranked] };
    expect(showsVersionTag(shared, base)).toBe(true);
    expect(showsVersionTag(shared, twinUnranked)).toBe(false);
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
        expect(
          aircraftModelOf(index),
          `${plane} (ship ${id}): no model designation in plane_models.json`,
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
