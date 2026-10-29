import { describe, expect, it } from "vitest";

import type { CatalogEntry, GameInstall } from "@/api";
import {
  SERVER_REALMS,
  applicableRealms,
  appliesToRealm,
  realmOfInstall,
  serverScopeOf,
} from "@/features/modhub/servers";

const entry = (servers?: string[]): CatalogEntry =>
  ({
    id: "mod",
    category: "battle",
    version: "1",
    game: "*",
    title: "Mod",
    nameZh: "",
    nameEn: "Mod",
    description: "",
    authors: [],
    packages: [],
    i18n: {},
    servers,
  }) as CatalogEntry;

const install = (
  kind: GameInstall["kind"],
  realm?: string | null,
): GameInstall => ({ kind, path: "C:/Game", realm: realm ?? null });

describe("realmOfInstall", () => {
  it("prefers the install's resolved realm over the kind fallback", () => {
    expect(realmOfInstall(install("steam", "asia"))).toBe("asia");
    expect(realmOfInstall(install("cn360", "eu"))).toBe("eu");
  });

  it("falls back through the kind: cn clients → cn, lesta → ru", () => {
    expect(realmOfInstall(install("cn360"))).toBe("cn");
    expect(realmOfInstall(install("cnKongzhong"))).toBe("cn");
    expect(realmOfInstall(install("lesta"))).toBe("ru");
  });

  it("returns null for launcher installs and missing input", () => {
    expect(realmOfInstall(install("wargaming"))).toBeNull();
    expect(realmOfInstall(install("steam"))).toBeNull();
    expect(realmOfInstall(install("manual"))).toBeNull();
    expect(realmOfInstall(null)).toBeNull();
    expect(realmOfInstall(undefined)).toBeNull();
  });
});

describe("applicableRealms", () => {
  it("folds universal spellings to all five codes", () => {
    expect(applicableRealms(undefined)).toEqual([...SERVER_REALMS]);
    expect(applicableRealms(null)).toEqual([...SERVER_REALMS]);
    expect(applicableRealms([])).toEqual([...SERVER_REALMS]);
    expect(applicableRealms([...SERVER_REALMS])).toEqual([...SERVER_REALMS]);
  });

  it("normalizes: unknown codes dropped, dupes merged, canonical order", () => {
    expect(applicableRealms(["cn", "eu", "cn", "mars"])).toEqual(["eu", "cn"]);
    expect(applicableRealms(["asia", "ru"])).toEqual(["ru", "asia"]);
  });
});

describe("appliesToRealm", () => {
  it("universal entries apply everywhere", () => {
    for (const r of SERVER_REALMS) {
      expect(appliesToRealm(entry(), r)).toBe(true);
      expect(appliesToRealm(entry([]), r)).toBe(true);
      expect(appliesToRealm(entry([...SERVER_REALMS]), r)).toBe(true);
    }
  });

  it("an unknown realm never filters (no over-filtering ambiguous clients)", () => {
    expect(appliesToRealm(entry(["eu"]), null)).toBe(true);
    expect(appliesToRealm(entry(["cn"]), null)).toBe(true);
    // A realm token outside the five-code vocabulary (a future code the
    // bundled list predates) is the same class of ambiguity: show all.
    expect(appliesToRealm(entry(["eu"]), "mars")).toBe(true);
  });

  it("restrictive entries apply only on their listed realms", () => {
    const eu = entry(["eu"]);
    expect(appliesToRealm(eu, "eu")).toBe(true);
    expect(appliesToRealm(eu, "na")).toBe(false);
    expect(appliesToRealm(eu, "cn")).toBe(false);
    // Unknown codes in the field change nothing.
    expect(appliesToRealm(entry(["eu", "mars"]), "na")).toBe(false);
  });
});

describe("serverScopeOf", () => {
  it("classifies universal (absent/empty/all five)", () => {
    expect(serverScopeOf(undefined)).toBe("universal");
    expect(serverScopeOf(null)).toBe("universal");
    expect(serverScopeOf([])).toBe("universal");
    expect(serverScopeOf([...SERVER_REALMS])).toBe("universal");
  });

  it("classifies exclusive for one-two realms", () => {
    expect(serverScopeOf(["cn"])).toBe("exclusive");
    expect(serverScopeOf(["eu", "ru"])).toBe("exclusive");
  });

  it("classifies partial for three-four realms", () => {
    expect(serverScopeOf(["ru", "eu", "na"])).toBe("partial");
    expect(serverScopeOf(["ru", "eu", "na", "asia"])).toBe("partial");
  });

  it("normalizes before counting", () => {
    expect(serverScopeOf(["cn", "cn", "mars"])).toBe("exclusive");
    expect(serverScopeOf(["na", "eu", "ru", "ru"])).toBe("partial");
  });
});
