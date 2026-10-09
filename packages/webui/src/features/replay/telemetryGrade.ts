/**
 * The live panel head's telemetry-source grade (the pill left of the
 * manual-locate button).
 *
 * "partial" is the load-bearing state: the plugin is connected and its
 * alive/sunk states ARE authoritative, but it cannot read the game's true
 * TAB row order — the datahub collection the TAB renders
 * (`team.ally.sortedAlive`) has no Python-side equivalent on the injected
 * dataHub (docs/en/designs/ingame-stats-plugin.md), so the row ORDER
 * remains the offline per-realm inference (utils/shipClass — knowledge
 * calibrated per client against rendered captures, and unstable: it
 * differs per realm and can change with any client update). The pill
 * therefore states the row order is inferred — a permanent, neutral
 * fact-voice (NOT "plugin not fully working": the plugin delivers
 * everything it can, and that phrasing would read as a fault the user
 * cannot fix; the fault-voice is reserved for a future state where a
 * telemetry contract carries an order but the plugin fails to deliver
 * it). The grade flips to a fully-working state only if the telemetry
 * payload ever carries a game-true order — no such field exists today.
 */
export type TelemetryGrade = "partial" | "incomplete" | "infer";

export function telemetryGradeFor(
  rosterMode: string,
  plugin: { installed: boolean; outdated: boolean },
): TelemetryGrade {
  if (rosterMode !== "plugin") return "infer";
  // An outdated build predates telemetry.json — it is "installed" but
  // will never emit, so it grades as not-connected until updated.
  return plugin.installed && !plugin.outdated ? "partial" : "incomplete";
}
