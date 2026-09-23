/** Tests for the tactics-view mode classification:
 *  - bucketOf collapses every fine-grained modeKey into one of the four
 *    coarse map buckets (random / ranked / clan / pve), defaulting unknown
 *    modes to "random";
 *  - isPveSpace flags scenario / special-mode spaces by their id shape
 *    (s01_…, *_op_*, halloween, naval_mission, 00_co_*) while regular
 *    PVP-map ids stay unflagged. */
import { describe, expect, it } from "vitest";

import { bucketOf, isPveSpace } from "./mapModes";

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
