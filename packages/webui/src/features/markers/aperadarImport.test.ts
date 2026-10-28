/** ApeRadar import pipeline (海猴雷达 → 玩家标记): status→color
 *  mapping, the category filter, cross-server dedupe, existing-marker
 *  flags and the MarkerImportItem[] build. Pure functions — no store, no
 *  transport, so no mock harness beyond the fixtures themselves. */
import { describe, expect, it } from "vitest";

import type { ApeRadarWatchList } from "@/api";
import {
  buildApeRadarPreview,
  rowsToImportItems,
  statusToColor,
} from "./aperadarImport";

const ALL_ON = { negtive: true, cheater: true };

/** A realistic watch list: two servers, every status kind, one
 *  cross-server duplicate (LANGYO on CN repeats langyo on ASIA). */
const list: ApeRadarWatchList = {
  path: "C:\\Users\\dev\\AppData\\Local\\ApeRadar\\WatchList.json",
  servers: [
    {
      server: "ASIA",
      players: [
        { accountId: 2035526744, name: "langyo", status: "Negtive" },
        { accountId: null, name: "script_kiddie", status: "Cheater" },
        { accountId: 7, name: "NicePerson", status: "Positive" },
      ],
    },
    {
      server: "CN",
      players: [
        // Duplicate by lowercased nickname — first entry (ASIA, red) wins.
        { accountId: 42, name: "LANGYO", status: "Cheater" },
        { accountId: 100, name: "挂机王", status: "Negtive" },
        { accountId: null, name: "UnknownGuy", status: "Banned" },
      ],
    },
  ],
};

describe("statusToColor", () => {
  it("maps the two importable statuses", () => {
    expect(statusToColor("Negtive")).toBe("red");
    expect(statusToColor("Cheater")).toBe("yellow");
  });

  it("never imports Positive or unknown spellings", () => {
    expect(statusToColor("Positive")).toBeNull();
    // Upstream's spelling is exact — case variants are unknown statuses.
    expect(statusToColor("negtive")).toBeNull();
    expect(statusToColor("CHEATER")).toBeNull();
    expect(statusToColor("Banned")).toBeNull();
    expect(statusToColor("")).toBeNull();
  });
});

describe("buildApeRadarPreview", () => {
  it("builds the preview in data order with server tags, colors and ids", () => {
    const preview = buildApeRadarPreview(list, ALL_ON, []);
    expect(preview.rows).toEqual([
      { server: "ASIA", nickname: "langyo", color: "red", accountId: 2035526744, exists: false },
      { server: "ASIA", nickname: "script_kiddie", color: "yellow", accountId: null, exists: false },
      { server: "CN", nickname: "挂机王", color: "red", accountId: 100, exists: false },
    ]);
    expect(preview.counts).toEqual({ total: 3, existing: 0 });
  });

  it("drops the categories that are switched off", () => {
    const onlyCheater = buildApeRadarPreview(list, { negtive: false, cheater: true }, []);
    // Dedupe applies to the FILTERED preview: with Negtive off, the red
    // "langyo" is excluded before dedupe, so the CN cheater "LANGYO" is
    // no duplicate and legitimately stays.
    expect(onlyCheater.rows.map((r) => r.nickname)).toEqual(["script_kiddie", "LANGYO"]);
    const onlyNegtive = buildApeRadarPreview(list, { negtive: true, cheater: false }, []);
    expect(onlyNegtive.rows.map((r) => r.nickname)).toEqual(["langyo", "挂机王"]);
  });

  it("yields nothing when every category is off", () => {
    const preview = buildApeRadarPreview(list, { negtive: false, cheater: false }, []);
    expect(preview.rows).toEqual([]);
    expect(preview.counts).toEqual({ total: 0, existing: 0 });
  });

  it("dedupes cross-server duplicates by lowercased nickname (first wins)", () => {
    const preview = buildApeRadarPreview(list, ALL_ON, []);
    const langyos = preview.rows.filter((r) => r.nickname.toLowerCase() === "langyo");
    // The CN "LANGYO" (yellow, id 42) is simply not shown — the ASIA
    // entry won by data order.
    expect(langyos).toHaveLength(1);
    expect(langyos[0]).toMatchObject({ server: "ASIA", color: "red", accountId: 2035526744 });
  });

  it("flags existing markers case-insensitively and counts them", () => {
    // The store carries "LANEIGEDC" and "挂机王" — LANGYO-style casing must
    // still match what the upsert will hit.
    const preview = buildApeRadarPreview(list, ALL_ON, ["LANEIGEDC", " 挂机王 "]);
    expect(preview.rows.map((r) => r.exists)).toEqual([false, false, true]);
    expect(preview.counts).toEqual({ total: 3, existing: 1 });
  });

  it("keeps numeric-string account ids and drops junk", () => {
    // The typed contract says number | null, but a hand-edited file can
    // carry strings — cast the fixture so the defensive parse is what
    // the test pins, not the type.
    const messy = {
      path: "/tmp/WatchList.json",
      servers: [
        {
          server: "EU",
          players: [
            { accountId: "12345" as unknown as number, name: "StringId", status: "Cheater" },
            { accountId: "not-a-number" as unknown as number, name: "JunkId", status: "Cheater" },
            { accountId: undefined, name: "NoId", status: "Negtive" },
          ],
        },
      ],
    } as ApeRadarWatchList;
    const preview = buildApeRadarPreview(messy, ALL_ON, []);
    expect(preview.rows.map((r) => r.accountId)).toEqual([12345, null, null]);
  });

  it("skips blank nicknames", () => {
    const blank: ApeRadarWatchList = {
      path: "/tmp/WatchList.json",
      servers: [
        { server: "NA", players: [{ accountId: 1, name: "  ", status: "Negtive" }] },
      ],
    };
    expect(buildApeRadarPreview(blank, ALL_ON, []).rows).toEqual([]);
  });

  it("handles an empty watch list", () => {
    const empty: ApeRadarWatchList = { path: "/tmp/none.json", servers: [] };
    const preview = buildApeRadarPreview(empty, ALL_ON, ["langyo"]);
    expect(preview.rows).toEqual([]);
    expect(preview.counts).toEqual({ total: 0, existing: 0 });
  });
});

describe("rowsToImportItems", () => {
  it("maps preview rows to wire items with note null", () => {
    const preview = buildApeRadarPreview(list, ALL_ON, []);
    expect(rowsToImportItems(preview.rows)).toEqual([
      { nickname: "langyo", color: "red", note: null, accountId: 2035526744 },
      { nickname: "script_kiddie", color: "yellow", note: null, accountId: null },
      { nickname: "挂机王", color: "red", note: null, accountId: 100 },
    ]);
  });
});
