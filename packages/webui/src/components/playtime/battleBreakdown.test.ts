import { describe, expect, it } from "vitest";

import type { PlaytimeBattle } from "@/api";
import {
  battlesActivityKey,
  breakdownByMode,
  breakdownByNation,
  breakdownByTier,
  breakdownByType,
  distinctShipCount,
  filterBattlesByScope,
} from "./battleBreakdown";

/**
 * Battle-row fixtures. shipIds are REAL offline-DB ids (Yamato T10 japan
 * Battleship, Gearing T10 usa Destroyer, Satsuma T11 japan Battleship,
 * Conqueror T10 united_kingdom Battleship, U-2501 T10 germany Submarine) so
 * the type/nation/tier resolution runs against the same bundled DB the app
 * ships; null-descriptor rows stand in for unparsed Lesta replays.
 */
const STEAM = "C:\\Games\\World_of_Warships";
const LESTA = "D:\\Lesta\\WoWS";

function row(over: Partial<PlaytimeBattle>): PlaytimeBattle {
  return {
    installPath: STEAM,
    kind: "steam",
    realm: "asia",
    dateTime: "20260910_201803",
    matchGroup: "pvp",
    scenario: null,
    eventType: null,
    botCount: 0,
    scriptedUnitCount: 0,
    ownShipId: 4276041424,
    ownShipName: "Yamato",
    playerCount: 12,
    ...over,
  };
}

describe("filterBattlesByScope", () => {
  const rows = [
    row({}),
    row({ installPath: LESTA, kind: "lesta", realm: "ru" }),
    row({ installPath: STEAM.replace("World_of_Warships", "World_of_Warships\\") }),
  ];

  it("returns every row for the all scope", () => {
    expect(filterBattlesByScope(rows, "all", STEAM)).toHaveLength(3);
  });

  it("matches the active install case/separator-insensitively (sameGamePath)", () => {
    // Casing and trailing separator differ on purpose — path identity must
    // not be raw ===.
    const scoped = filterBattlesByScope(rows, "selected", "c:/games/world_of_warships");
    expect(scoped).toHaveLength(2);
    expect(scoped.every((r) => r.kind === "steam")).toBe(true);
  });

  it("falls back to all rows when no install is selected", () => {
    expect(filterBattlesByScope(rows, "selected", null)).toHaveLength(3);
    expect(filterBattlesByScope(rows, "selected", "")).toHaveLength(3);
    expect(filterBattlesByScope(rows, "selected", undefined)).toHaveLength(3);
  });

  it("can yield an empty set for an install with no replays", () => {
    expect(filterBattlesByScope(rows, "selected", "E:\\Nowhere")).toHaveLength(0);
  });
});

describe("breakdownByType", () => {
  it("groups by the offline DB's ship type and sorts count desc", () => {
    const rows = [
      row({ ownShipId: 4276041424 }), // Battleship
      row({ ownShipId: 4179572688 }), // Battleship
      row({ ownShipId: 4281219056 }), // Destroyer
    ];
    expect(breakdownByType(rows)).toEqual([
      { key: "Battleship", count: 2, share: 2 / 3 },
      { key: "Destroyer", count: 1, share: 1 / 3 },
    ]);
  });

  it("buckets unresolvable ships (unknown id / null id) into unknown", () => {
    const rows = [
      row({ ownShipId: 4276041424 }),
      row({ ownShipId: 999999 }),
      row({ ownShipId: null, ownShipName: null, matchGroup: null }),
    ];
    expect(breakdownByType(rows)).toEqual([
      { key: "unknown", count: 2, share: 2 / 3 },
      { key: "Battleship", count: 1, share: 1 / 3 },
    ]);
  });

  it("breaks count ties by key ascending", () => {
    const rows = [
      row({ ownShipId: 4281219056 }), // Destroyer
      row({ ownShipId: 4276041424 }), // Battleship
    ];
    expect(breakdownByType(rows).map((e) => e.key)).toEqual([
      "Battleship",
      "Destroyer",
    ]);
  });
});

describe("breakdownByNation", () => {
  it("canonicalizes offline DB spellings onto the app-wide codes", () => {
    // Conqueror's DB nation is "united_kingdom" — the row key must be the
    // canonical "uk", not the raw spelling.
    const rows = [
      row({ ownShipId: 4179572688 }), // united_kingdom → uk
      row({ ownShipId: 3864933840 }), // russia → ussr
    ];
    expect(breakdownByNation(rows).map((e) => e.key).sort()).toEqual(["uk", "ussr"]);
  });

  it("buckets non-nations and unknown ships into unknown", () => {
    const rows = [
      row({ ownShipId: 4276041424 }), // japan
      row({ ownShipId: null, ownShipName: null }),
    ];
    expect(breakdownByNation(rows)).toEqual([
      { key: "japan", count: 1, share: 0.5 },
      { key: "unknown", count: 1, share: 0.5 },
    ]);
  });
});

describe("breakdownByTier", () => {
  it("sorts tiers numerically ascending, not lexicographically", () => {
    const rows = [
      row({ ownShipId: 4178523856 }), // Satsuma T11
      row({ ownShipId: 4281219056 }), // Gearing T10
      row({ ownShipId: 4276041424 }), // Yamato T10
    ];
    const tiers = breakdownByTier(rows).map((e) => e.key);
    expect(tiers).toEqual(["10", "11"]);
  });

  it("keeps unknown tiers last whatever their count", () => {
    const rows = [
      row({ ownShipId: 4178523856 }), // T11
      row({ ownShipId: null, ownShipName: null }),
      row({ ownShipId: 999999 }),
    ];
    expect(breakdownByTier(rows).map((e) => e.key)).toEqual(["11", "unknown"]);
    expect(breakdownByTier(rows)[1]).toEqual({
      key: "unknown",
      count: 2,
      share: 2 / 3,
    });
  });
});

describe("breakdownByMode", () => {
  it("reuses the canonical mode classifier over the descriptor layers", () => {
    const rows = [
      row({ matchGroup: "pvp" }),
      row({ matchGroup: "pvp", eventType: "PVP222ASYM" }), // → asymmetric
      row({ matchGroup: "ranked" }),
      // pve + scripted units → operation, plain pve → cooperative
      row({ matchGroup: "pve", botCount: 8, scriptedUnitCount: 8 }),
      row({ matchGroup: "pve", botCount: 9 }),
      // pvp + bots → custom room vs bots
      row({ matchGroup: "pvp", botCount: 7 }),
    ];
    const out = breakdownByMode(rows);
    // All counts tie at 1, so the order is the tie rule: key ascending.
    expect(out.map((e) => e.key)).toEqual([
      "asymmetric",
      "cooperative",
      "operation",
      "pvp",
      "ranked",
      "room_bots",
    ]);
    expect(out.find((e) => e.key === "pvp")).toEqual({
      key: "pvp",
      count: 1,
      share: 1 / 6,
    });
  });

  it("buckets rows with no mode fingerprint into unknown", () => {
    const rows = [
      row({ matchGroup: "pvp" }),
      row({ matchGroup: null, scenario: null, eventType: null }),
    ];
    expect(breakdownByMode(rows)).toEqual([
      { key: "pvp", count: 1, share: 0.5 },
      { key: "unknown", count: 1, share: 0.5 },
    ]);
  });
});

describe("distinctShipCount", () => {
  it("counts distinct ownShipIds and ignores null ships", () => {
    const rows = [
      row({ ownShipId: 4276041424 }),
      row({ ownShipId: 4276041424 }), // same ship again
      row({ ownShipId: 4281219056 }),
      row({ ownShipId: null, ownShipName: null }),
    ];
    expect(distinctShipCount(rows)).toBe(2);
  });
});

describe("empty input", () => {
  it("every grouping yields [] and shares never divide by zero", () => {
    expect(breakdownByType([])).toEqual([]);
    expect(breakdownByNation([])).toEqual([]);
    expect(breakdownByTier([])).toEqual([]);
    expect(breakdownByMode([])).toEqual([]);
    expect(filterBattlesByScope([], "selected", STEAM)).toEqual([]);
    expect(distinctShipCount([])).toBe(0);
  });
});

describe("battlesActivityKey", () => {
  const idle = (launchCount: number, start: number) => ({
    launchCount,
    lastLaunch: { start, durationSeconds: 60, running: false },
  });

  it("null overview and launch-less ledgers get stable inert keys", () => {
    expect(battlesActivityKey(null)).toBe("none");
    expect(battlesActivityKey({ launchCount: 0, lastLaunch: null })).toBe("0:0");
  });

  it("a running launch collapses to the live key whatever the identity", () => {
    expect(battlesActivityKey(idle(3, 100))).toBe("3:100");
    const running = { launchCount: 3, lastLaunch: { start: 100, durationSeconds: 5, running: true } };
    expect(battlesActivityKey(running)).toBe("running");
  });

  it("keys move across the launch lifecycle an idle poll can observe", () => {
    // Start idle → the launch opens → it exits again: three distinct keys,
    // so the store refetches at exactly those transitions.
    const before = battlesActivityKey({ launchCount: 2, lastLaunch: { start: 50, durationSeconds: 9, running: false } });
    const during = "running";
    const after = battlesActivityKey(idle(3, 100));
    expect(new Set([before, during, after]).size).toBe(3);
  });

  it("an unchanged idle ledger keeps its key across polls", () => {
    expect(battlesActivityKey(idle(3, 100))).toBe(battlesActivityKey(idle(3, 100)));
  });
});
