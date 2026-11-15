/** Tests for the embedded module-stats packs' accessor (shipModuleStats.ts).
 *
 *  The packs are generated artifacts (scripts/extract/build_module_stats.py);
 *  these tests pin the ACCESSOR contract the tooltip cards rely on: the
 *  realm split, the known-module lookup, and the graceful null for module
 *  names a pack does not carry. Spot values are pinned against the real
 *  Shimakaze chain (hull HP 17,900; stock guns 11.37 km / 5.74 s reload;
 *  stock torpedo tubes 150 s) so a regenerated pack that silently shifts
 *  field paths fails here instead of rendering wrong numbers in the card.
 */
import { describe, expect, it } from "vitest";

import { hasModuleStats, moduleStatsOf } from "./shipModuleStats";

describe("moduleStatsOf", () => {
  it("carries both realm packs", () => {
    expect(hasModuleStats("wg")).toBe(true);
    expect(hasModuleStats("lesta")).toBe(true);
  });

  it("answers the hull HP of the Shimakaze stock hull", () => {
    const stats = moduleStatsOf("wg", "PJUH802_Shimakaze_1944");
    expect(stats).toMatchObject({ kind: "hull", ucType: "_Hull", health: 17900 });
  });

  it("answers artillery range and reload from the mount", () => {
    const stats = moduleStatsOf("wg", "PJUA931_D10_ART_STOCK");
    expect(stats?.kind).toBe("artillery");
    expect(stats?.rangeM).toBe(11370);
    expect(stats?.reloadS).toBeCloseTo(5.74, 2);
  });

  it("answers torpedo-tube reload for the stock and mid tubes", () => {
    expect(moduleStatsOf("wg", "PJUT901_D10_TORP_STOCK")?.reloadS).toBeCloseTo(150, 1);
    expect(moduleStatsOf("wg", "PJUT904_D10_TORP_MED")?.reloadS).toBeCloseTo(153, 1);
  });

  it("lists fire-control/engine modules as known-empty rather than unextracted", () => {
    const stats = moduleStatsOf("wg", "PJUS901_Suo");
    expect(stats).not.toBeNull();
    expect(stats).toMatchObject({ kind: "suo", health: null, rangeM: null, reloadS: null });
  });

  it("returns null for a module the pack does not carry", () => {
    expect(moduleStatsOf("wg", "NOPE_Not_A_Module")).toBeNull();
    expect(moduleStatsOf("wg", null)).toBeNull();
    expect(moduleStatsOf("wg", undefined)).toBeNull();
  });
});
