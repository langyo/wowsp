/** Tests for the map-version succession table: the legacy → current lookup,
 *  which end of a version pair a space id sits on, and the cross-check that
 *  every successor is a space the bundled catalog actually ships. */
import { describe, expect, it } from "vitest";

import mapNamesRaw from "@/data/map_names.json";
import { LEGACY_MAP_VERSIONS, legacyMapOf, mapLineage } from "./legacyMaps";

/** The catalog `utils/mapNames` exposes as MAP_NAMES, read directly so this
 *  test stays free of the i18n import that module pulls in. */
const MAP_NAMES = mapNamesRaw as Record<string, Record<string, string>>;

describe("legacyMapOf", () => {
  it("resolves a superseded space to its successor", () => {
    expect(legacyMapOf("37_Ridge")?.replacedBy).toBe("58_RidgeNew");
  });

  it("knows nothing about ordinary or unknown spaces", () => {
    expect(legacyMapOf("58_RidgeNew")).toBeNull();
    expect(legacyMapOf("05_Ring")).toBeNull();
    expect(legacyMapOf("")).toBeNull();
  });
});

describe("mapLineage", () => {
  it("labels both ends of a version pair", () => {
    expect(mapLineage("37_Ridge")).toBe("legacy");
    expect(mapLineage("58_RidgeNew")).toBe("current");
  });

  it("returns null for everything that is not a version pair", () => {
    expect(mapLineage("05_Ring")).toBeNull();
    expect(mapLineage("no_such_map")).toBeNull();
    // Winter / day skins are two maps, not two versions of one.
    expect(mapLineage("15_NE_north")).toBeNull();
    expect(mapLineage("35_NE_north_winter")).toBeNull();
  });
});

describe("version table", () => {
  it("points every entry at a catalog map, never at itself", () => {
    for (const [oldId, info] of Object.entries(LEGACY_MAP_VERSIONS)) {
      expect(info.replacedBy, `successor of ${oldId}`).not.toBe(oldId);
      expect(MAP_NAMES[info.replacedBy], `unknown successor of ${oldId}`).toBeTruthy();
      expect(info.evidence.trim(), `evidence for ${oldId}`).not.toBe("");
    }
  });
});
