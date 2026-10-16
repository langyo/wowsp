/**
 * Migration-wizard identity matching: the catalog-hint and Aslain-alias
 * lookups are display-only, so a regression would not crash anything — it
 * would silently degrade the decide list back to raw paths. These tests pin
 * the matching order (catalog two-segment → one-segment → alias table) and
 * the exact alias entries.
 */
import { describe, expect, it } from "vitest";

import type { CatalogEntry } from "@/api";

import { DIR_ALIASES, idHints, resolveIdentity } from "./migrateIdentity";

const entry = (id: string, name: string): CatalogEntry =>
  ({
    id,
    category: "battle",
    discussion: null,
    version: "1",
    game: ">=15.7",
    bundled: false,
    title: name,
    nameZh: "",
    nameEn: name,
    description: "",
    authorUrl: "",
    packages: [],
    i18n: {},
  }) as unknown as CatalogEntry;

const CATALOG = [entry("battle.calculator.penetration", "PenCalc"), entry("battle.marker.smoke", "SmokeMark")];

describe("idHints", () => {
  it("derives the last two dot-segments plus the last one", () => {
    expect(idHints("battle.calculator.penetration")).toEqual([
      "calculator.penetration",
      "penetration",
    ]);
  });

  it("collapses when the id has a single segment", () => {
    expect(idHints("penetration")).toEqual(["penetration"]);
    expect(idHints("")).toEqual([]);
  });
});

describe("resolveIdentity", () => {
  const nameOf = (e: CatalogEntry) => e.nameEn;

  it("matches a PnFMods directory against a one-segment catalog hint", () => {
    expect(resolveIdentity("PnFMods/Penetration/Main.py", CATALOG, nameOf)).toBe("PenCalc");
  });

  it("prefers the more specific two-segment hint", () => {
    const catalog = [entry("battle.calculator.penetration", "TwoSeg"), entry("battle.marker.penetration", "OneSeg")];
    expect(resolveIdentity("PnFMods/calculator.penetration/Main.py", catalog, nameOf)).toBe("TwoSeg");
  });

  it("falls back to the built-in Aslain alias table", () => {
    expect(resolveIdentity("PnFMods/AdvancedTorpedoMarkerPy/config.xml", [], nameOf)).toBe(
      "Advanced Torpedo Marker",
    );
    expect(resolveIdentity("gui/TeamHP/frames.xml", [], nameOf)).toBe("Team HP Panels");
  });

  it("matches versioned installer directories by prefix", () => {
    expect(resolveIdentity("ModsInstaller_4_3_1/manifest.json", [], nameOf)).toBe(
      "Aslain Modpack Installer",
    );
  });

  it("catalog matches win over aliases and unknown paths stay raw", () => {
    const catalog = [entry("battle.marker.teamhp", "Catalog HP")];
    expect(resolveIdentity("PnFMods/TeamHP/Main.py", catalog, nameOf)).toBe("Catalog HP");
    expect(resolveIdentity("gui/some_unknown_mod/tables.xml", CATALOG, nameOf)).toBeNull();
  });

  it("covers every alias table entry end to end", () => {
    for (const key of Object.keys(DIR_ALIASES)) {
      const hit = resolveIdentity(`PnFMods/${key}/Main.py`, [], nameOf);
      expect(hit, key).toBeTruthy();
      expect(hit).not.toMatch(/^aslain 功能/i);
    }
  });
});
