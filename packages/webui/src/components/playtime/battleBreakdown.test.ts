import { describe, expect, it } from "vitest";

import type { PlaytimeBattle } from "@/api";
import { modeColorOfKey } from "@/utils/modeColors";
import {
  battlesActivityKey,
  battlesDaily,
  breakdownByMode,
  breakdownByNation,
  breakdownByTier,
  breakdownByType,
  BREAKDOWN_UNKNOWN_COLOR,
  breakdownColor,
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

describe("breakdownColor", () => {
  it("resolves nothing for ship types — the view wires the user-tintable store", () => {
    // "type" left BreakdownGroup on purpose: the canonical WG class palette
    // lives in theme/shipTypeColors (covered by its own tests). The gray
    // the type resolver lands "unknown" on stays exported from here.
    expect(BREAKDOWN_UNKNOWN_COLOR).toBe("#C4BDC9");
  });

  it("colors every canonical nation distinctly and falls back to gray", () => {
    const nations = [
      "usa",
      "japan",
      "germany",
      "uk",
      "ussr",
      "france",
      "italy",
      "pan_asia",
      "pan_america",
      "netherlands",
      "commonwealth",
      "spain",
      "europe",
    ];
    const hues = nations.map((n) => breakdownColor("nation", n));
    expect(new Set(hues).size).toBe(nations.length); // pairwise distinct
    expect(breakdownColor("nation", "usa")).toBe("#4E79A7");
    expect(breakdownColor("nation", "japan")).toBe("#E15759");
    expect(breakdownColor("nation", "unknown")).toBe("#C4BDC9");
    expect(breakdownColor("nation", "atlantis")).toBe("#C4BDC9");
  });

  it("indexes the tier ramp strictly by tier number, gray elsewhere", () => {
    expect(breakdownColor("tier", "1")).toBe("#F6CADA");
    expect(breakdownColor("tier", "11")).toBe("#D6336C");
    // Every tier owns its own ramp step (and "1" is lighter than "11" —
    // the light→deep direction the ramp is built for).
    const ramp = Array.from({ length: 11 }, (_, i) => breakdownColor("tier", String(i + 1)));
    expect(new Set(ramp).size).toBe(11);
    expect(breakdownColor("tier", "12")).toBe("#C4BDC9");
    expect(breakdownColor("tier", "0")).toBe("#C4BDC9");
    expect(breakdownColor("tier", "unknown")).toBe("#C4BDC9");
  });

  it("delegates mode colors to the canonical mode palette", () => {
    expect(breakdownColor("mode", "pvp")).toBe(modeColorOfKey("pvp").color);
    expect(breakdownColor("mode", "operation")).toBe(modeColorOfKey("operation").color);
    // Unknown modes ride modeColors' own fallback, not the breakdown gray.
    expect(breakdownColor("mode", "no_such_mode")).toBe(modeColorOfKey("no_such_mode").color);
  });
});

describe("battlesDaily", () => {
  it("groups by day across both filename stamp forms and sums same-day rows", () => {
    const rows = [
      row({}), // default 20260910_201803
      row({ dateTime: "20260910" }), // bare-date form
      row({ dateTime: "20260910_235959" }), // same day, later stamp
      row({ dateTime: "20260911_014502" }),
    ];
    expect(battlesDaily(rows)).toEqual([
      { date: "2026-09-10", value: 3 },
      { date: "2026-09-11", value: 1 },
    ]);
  });

  it("sorts by date ascending whatever order the rows carry", () => {
    const rows = [
      row({ dateTime: "20260105_100000" }),
      row({ dateTime: "20251231_235959" }),
      row({ dateTime: "20260105_080000" }),
    ];
    expect(battlesDaily(rows)).toEqual([
      { date: "2025-12-31", value: 1 },
      { date: "2026-01-05", value: 2 },
    ]);
  });

  it("excludes rows whose dateTime holds no parsable calendar day", () => {
    const rows = [
      row({ dateTime: null }), // unparsed replay
      row({ dateTime: "20261301_000000" }), // month 13
      row({ dateTime: "abcdefgh" }), // not digits
      row({ dateTime: "20260230_120000" }), // Feb 30 — Date rolls it over
      row({ dateTime: "19991231_235959" }), // below the 2000..2100 window
      row({ dateTime: "2026" }), // too short to carry a day
      row({ dateTime: "20260910_201803" }), // the one survivor
    ];
    expect(battlesDaily(rows)).toEqual([{ date: "2026-09-10", value: 1 }]);
  });

  it("yields [] for empty input", () => {
    expect(battlesDaily([])).toEqual([]);
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
