/**
 * The live panel head's telemetry-source grade (the pill left of the
 * manual-locate button).
 *
 * "exact" is the top state: the plugin's telemetry carried the game's OWN
 * Tab sort keys for every roster row (`sortKeys`, read off the avatars'
 * ship components — ShipSystem writes str(classRank) + str(100 - level)
 * + str(NATION.SORT_ORDER.index(nation)) + shortName onto each), so the
 * row order IS the client's, not an inference — except on a
 * ship-name-order client (CN), whose HUD renders an order the keys
 * cannot express, so that realm never grades exact (the caller's
 * coverage check applies the same gate). The grade is per-battle:
 * a battle whose sort-key map covers the whole live roster grades exact;
 * anything less falls back through "partial" (connected: alive/sunk
 * states authoritative, row order the offline per-realm inference —
 * utils/shipClass, unstable per-client knowledge) and "incomplete"
 * (mode picked, plugin missing/outdated). The pill must never present
 * the inferred order as game-truth: "partial" reads a neutral fact-voice
 * ("Plugin (order inferred)"), NOT a fault — the plugin delivers
 * everything it can, and a fault phrasing the user cannot clear would
 * read as breakage; the fault-voice is reserved for a state where an
 * order-bearing contract exists but the plugin fails to deliver it.
 */
export type TelemetryGrade = "exact" | "partial" | "incomplete" | "infer";

export function telemetryGradeFor(
  rosterMode: string,
  plugin: { installed: boolean; outdated: boolean },
  exactOrder: boolean,
): TelemetryGrade {
  if (rosterMode !== "plugin") return "infer";
  // An outdated build predates telemetry.json — it is "installed" but
  // will never emit, so it grades as not-connected until updated.
  if (!plugin.installed || plugin.outdated) return "incomplete";
  return exactOrder ? "exact" : "partial";
}
