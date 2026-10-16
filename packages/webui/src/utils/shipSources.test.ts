/** The 来源 filter's derivation: tree/gold/event come from baked data,
 *  coal/steel from the curated name-keyed table — and the tags are
 *  additive (one ship may hold several). */
import { describe, expect, it } from "vitest";

import techTree from "@/data/tech_tree.json";
import shipNamesDb from "@/data/ship_names.json";
import { SHIP_SOURCES, shipSourcesOf } from "./shipSources";

/** A plain silver-line node (real id — PASA020 Essex, group upgradeable). */
const TREE_ID = "4273977328";
/** The one early-access node currently in the baked tree. */
const EARLY_ACCESS_ID = Object.entries(techTree).find(
  ([, node]) => (node as { group?: string }).group === "earlyAccess",
)?.[0];

function idWhoseLocaleNameIs(name: string): string | undefined {
  const want = name.trim().toLowerCase();
  return Object.entries(shipNamesDb).find(([, row]) =>
    Object.values((row as { names?: Record<string, string> }).names ?? {}).some(
      (n) => n.trim().toLowerCase() === want,
    ),
  )?.[0];
}

describe("ship sources", () => {
  it("derives tree membership from the tech tree", () => {
    expect(TREE_ID in techTree).toBe(true);
    const sources = shipSourcesOf({ shipId: TREE_ID });
    expect(sources.has("tree")).toBe(true);
    expect(sources.has("event")).toBe(false);
  });

  it("reads the early-access group as the event tag", () => {
    expect(EARLY_ACCESS_ID).toBeTruthy();
    const sources = shipSourcesOf({ shipId: EARLY_ACCESS_ID! });
    expect(sources.has("event")).toBe(true);
    expect(sources.has("tree")).toBe(false);
  });

  it("takes the gold tag off the encyclopedia flag", () => {
    const sources = shipSourcesOf({ shipId: "1", name: "Whatever", isPremium: true });
    expect(sources.has("gold")).toBe(true);
    expect(sources.has("tree")).toBe(false);
  });

  it("matches curated coal/steel names across the offline db's locales", () => {
    const salemId = idWhoseLocaleNameIs("Salem");
    expect(salemId).toBeTruthy();
    const sources = shipSourcesOf({ shipId: salemId! });
    expect(sources.has("coal")).toBe(true);

    const stalingradId = idWhoseLocaleNameIs("Stalingrad");
    expect(stalingradId).toBeTruthy();
    expect(shipSourcesOf({ shipId: stalingradId! }).has("steel")).toBe(true);
  });

  it("matches the API display name even without an offline db row", () => {
    const sources = shipSourcesOf({ shipId: "99999999", name: "Yoshino" });
    expect(sources.has("coal")).toBe(true);
  });

  it("tags are additive — one ship may hold several at once", () => {
    // Salem is a coal ship AND a gold premium.
    const salemId = idWhoseLocaleNameIs("Salem")!;
    const sources = shipSourcesOf({
      shipId: salemId,
      name: "Salem",
      isPremium: true,
    });
    expect(sources.has("coal")).toBe(true);
    expect(sources.has("gold")).toBe(true);
  });

  it("an unknown untagged ship matches nothing", () => {
    const sources = shipSourcesOf({ shipId: "88888888", name: "Not A Ship" });
    expect(sources.size).toBe(0);
    expect(SHIP_SOURCES).toContain("coal");
  });
});
