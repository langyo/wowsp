import { describe, expect, it } from "vitest";

import { branchFromPlayerRealm, branchOfReplay, isKnownRealm } from "./realms";

describe("branchFromPlayerRealm", () => {
  it("maps the Lesta-operated ru cluster onto the Lesta branch", () => {
    // The 2022 split left Wargaming eu/na/asia; Lesta runs ru, so an
    // account there sails Lesta-realm data.
    expect(branchFromPlayerRealm("ru")).toBe("lesta");
    for (const realm of ["eu", "na", "asia", "cn", "RU ", null, undefined, "junk"]) {
      expect(branchFromPlayerRealm(realm as string | null | undefined)).toBe(
        realm === "RU " ? "wg" : "wg",
      );
    }
  });
});

describe("branchOfReplay", () => {
  it("prefers the owning install's identity", () => {
    expect(branchOfReplay("match.wowsreplay", "lesta", "ru")).toBe("lesta");
    expect(branchOfReplay("match.wowsreplay", "lesta", null)).toBe("lesta");
    // Realm without the kind still identifies Lesta.
    expect(branchOfReplay("match.wowsreplay", null, "ru")).toBe("lesta");
    // Any other detected install kind is the WG branch.
    expect(branchOfReplay("match.korablireplay", "wargaming", "eu")).toBe("wg");
  });

  it("falls back to the container extension for untagged picks", () => {
    // The two clients write .wowsreplay and .korablireplay (same framing).
    expect(branchOfReplay("C:/replays/20261114_120000.korablireplay")).toBe("lesta");
    expect(branchOfReplay("C:/replays/20261114_120000.KORABLIREPLAY")).toBe(
      "lesta",
    );
    expect(branchOfReplay("C:/replays/20261114_120000.wowsreplay")).toBe("wg");
    expect(branchOfReplay("")).toBe("wg");
    expect(branchOfReplay(null)).toBe("wg");
    expect(branchOfReplay(undefined)).toBe("wg");
  });
});

describe("isKnownRealm", () => {
  it("knows the app's clusters and rejects anything else", () => {
    for (const realm of ["ru", "eu", "na", "asia", "cn"]) {
      expect(isKnownRealm(realm)).toBe(true);
    }
    for (const realm of ["", "rg", "RU", "kr"]) {
      expect(isKnownRealm(realm)).toBe(false);
    }
  });
});
