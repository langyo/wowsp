/** Tests for the tactics-view mode classification:
 *  - bucketOf collapses every fine-grained modeKey into one of the four
 *    coarse map buckets (random / ranked / clan / pve), defaulting unknown
 *    modes to "random";
 *  - isPveSpace flags scenario / special-mode spaces by their id shape
 *    (s01_…, *_op_*, halloween, naval_mission, 00_co_*) while regular
 *    PVP-map ids stay unflagged;
 *  - isHarborSpace flags the non-battle spaces (docks / exteriors /
 *    shipyards) and battleMapIds keeps only analysable, art-backed maps. */
import { describe, expect, it } from "vitest";

import { battleMapIds, bucketOf, isHarborSpace, isPveSpace } from "./mapModes";

describe("bucketOf", () => {
  it("keeps ranked and its variants ranked", () => {
    expect(bucketOf("ranked")).toBe("ranked");
    expect(bucketOf("ranked_solo")).toBe("ranked");
    expect(bucketOf("ranked_sprint")).toBe("ranked");
  });

  it("puts clan and brawl in the clan family", () => {
    expect(bucketOf("clan")).toBe("clan");
    expect(bucketOf("brawl")).toBe("clan");
  });

  it("collapses every PvE-flavoured key into pve", () => {
    for (const key of [
      "cooperative",
      "pve",
      "operation",
      "pve_event",
      "halloween",
      "training",
      "room_bots",
      "sandbox",
    ]) {
      expect(bucketOf(key)).toBe("pve");
    }
  });

  it("rides random for regular and unmatched modes", () => {
    for (const key of ["pvp", "squad", "armsrace", "convoy", "asymmetric"]) {
      expect(bucketOf(key)).toBe("random");
    }
    expect(bucketOf("unknown_mode")).toBe("random");
    expect(bucketOf("")).toBe("random");
  });

  it("is case-insensitive", () => {
    expect(bucketOf("Ranked")).toBe("ranked");
    expect(bucketOf("CLAN")).toBe("clan");
    expect(bucketOf("Cooperative")).toBe("pve");
    expect(bucketOf("PVP")).toBe("random");
  });
});

describe("isPveSpace", () => {
  it("flags scenario spaces (s01_ … s99_)", () => {
    expect(isPveSpace("s01_terra")).toBe(true);
    expect(isPveSpace("s09_halloween_space")).toBe(true);
    expect(isPveSpace("s99_final")).toBe(true);
  });

  it("flags operation, halloween and naval-mission spaces", () => {
    expect(isPveSpace("a_op_dday")).toBe(true);
    expect(isPveSpace("halloween_map")).toBe(true);
    expect(isPveSpace("naval_mission_x")).toBe(true);
  });

  it("flags the combat-training ocean (00_co_)", () => {
    expect(isPveSpace("00_co_ocean")).toBe(true);
  });

  it("leaves regular PVP-map ids unflagged", () => {
    expect(isPveSpace("20_NE_two_brothers")).toBe(false);
    expect(isPveSpace("15_NE_north")).toBe(false);
    expect(isPveSpace("00_customs")).toBe(false);
    expect(isPveSpace("spaces/10_NE_bigrace")).toBe(false);
  });

  it("is case-insensitive and tolerates empty ids", () => {
    expect(isPveSpace("S01_TERRA")).toBe(true);
    expect(isPveSpace("A_OP_DDAYS")).toBe(true);
    expect(isPveSpace("HALLOWEEN_MAP")).toBe(true);
    expect(isPveSpace("")).toBe(false);
  });
});

describe("isHarborSpace", () => {
  it("flags docks, exteriors and shipyards", () => {
    for (const id of ["Dock", "Dock_Kure", "dock_dry", "Exterior", "Shipyard_GERZH1"]) {
      expect(isHarborSpace(id)).toBe(true);
    }
  });

  it("leaves battle spaces unflagged, whatever their flavour", () => {
    for (const id of ["05_Ring", "58_RidgeNew", "s01_NavalBase", ""]) {
      expect(isHarborSpace(id)).toBe(false);
    }
  });
});

describe("battleMapIds", () => {
  const CATALOG = ["05_Ring", "Dock_Kure", "58_RidgeNew", "s01_NavalBase", "dock_dry"];
  /** Docks ship minimap art too — they are dropped for being harbors. */
  const ART = new Set(["05_Ring", "58_RidgeNew", "Dock_Kure", "dock_dry"]);

  it("keeps the art-backed battle maps in catalog order", () => {
    expect(battleMapIds(CATALOG, (id) => ART.has(id))).toEqual(["05_Ring", "58_RidgeNew"]);
  });

  it("drops art-less entries and never probes a harbor for art", () => {
    const probed: string[] = [];
    const kept = battleMapIds(CATALOG, (id) => {
      probed.push(id);
      return true;
    });
    expect(kept).toEqual(["05_Ring", "58_RidgeNew", "s01_NavalBase"]);
    expect(probed).toEqual(kept);
  });
});
