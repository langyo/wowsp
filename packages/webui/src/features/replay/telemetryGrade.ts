/**
 * The live panel head's telemetry-source grade (the pill left of the
 * manual-locate button).
 *
 * "exact" is the top state: the row order IS the client's, not an
 * inference. Two roads: the WG family's sort keys (`sortKeys` covering
 * every roster row, read off the avatars' ship components) — and, since
 * the 2026-10-18 calibration release, the CN ship-name-order client,
 * whose exact verdict the caller derives from full client-truth
 * localized ship-name coverage instead (the calibrated arrangement's
 * inputs are then the rendered strings; see the design doc). The grade
 * is per-battle: a battle whose coverage gate holds grades exact;
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
