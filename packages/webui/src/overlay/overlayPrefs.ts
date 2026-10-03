/** The Tab overlay's display-preferences reader.
 *
 *  The overlay page is bare DOM (no Vue), yet its content toggles live in
 *  the same `wowsp-stats-prefs` localStorage blob the main window's pinia
 *  store owns (see stores/statsPrefs.ts). This module re-reads that blob
 *  with the SAME tolerant contract as the store's parsePrefs — a corrupt or
 *  hand-edited blob falls back to the store defaults, never to a crash or a
 *  silently-wrong half merge. Defaults are imported from the store module
 *  (the module-level ref utils/winrate already depends on) so the two
 *  readers can never drift apart.
 *
 *  Read ONCE at window creation (display-only knobs): a settings flip
 *  applies the next time the overlay window is (re)created. */
import {
  DEFAULT_STATS_PREFS,
  STATS_PREFS_STORAGE_KEY,
  legacyBattleScopeOf,
  type OverlayChipToggles,
  type OverlayIntelToggles,
  type OverlayTeamAvgToggles,
  type PrAlgo,
  type RosterBattleScope,
} from "@/stores/statsPrefs";
import {
  resolveRosterBattleScope,
  rosterStatView,
  type ResolvedStatsMode,
  type RosterModeNumbers,
  type RosterStatViewSource,
} from "@/utils/statView";
import type { StampKind } from "@/utils/winrate";

// The stat-view helpers the overlay renders through live in utils/statView
// (shared with the main-window panels); re-exported so the overlay page
// keeps its one import site.
export { resolveRosterBattleScope, rosterStatView };
export type { ResolvedStatsMode, RosterModeNumbers, RosterStatViewSource };

/** The raw per-player stats the overlay caches: the randoms career plus
 *  the ranked / global per-mode payloads nested the way `rosterStatView`
 *  reads them (the wire fields map in main.ts's batch handler). */
export interface RawStat extends RosterStatViewSource {
  clanId: number | null;
  clanTag: string | null;
  hidden: boolean;
}

/** The stats source as the overlay consumes it: the battle dimension only
 *  (raw — resolved per battle in main.ts). The ship/solo dimensions are
 *  main-window surfaces (the live/post-battle panels aggregate per-ship
 *  payloads); the overlay's bare-DOM pipeline keeps the account careers,
 *  so they are deliberately not modeled in this snapshot. */
export interface OverlayStatsDims {
  battle: RosterBattleScope;
}

/** Everything the overlay renders consumes this snapshot. */
export interface OverlayDisplayPrefs {
  chips: OverlayChipToggles;
  statsDims: OverlayStatsDims;
  intel: OverlayIntelToggles;
  /** Team-intel card master switch. */
  teamIntel: boolean;
  teamAvg: OverlayTeamAvgToggles;
  /** Team winrate aggregation shared with the live panel. */
  weightedTeamWr: boolean;
  /** `prEnabled && sealsEnabled` — the seal pipeline's master gate. */
  sealsOn: boolean;
  /** Per-kind seal kill switches (settings' seal customizer). */
  sealsDisabled: ReadonlySet<StampKind>;
  /** `prAlgo` forwarded to the stats RPC while the PR rating is on. */
  prAlgo: PrAlgo | undefined;
  /** The PR master switch — the PR chip/average double-gates on it, the
   *  same rule the roster panels' PR columns follow. */
  prOn: boolean;
}

/** Known seal kinds — junk keys in the kill-switch map are dropped. */
const STAMP_KINDS: readonly StampKind[] = ["miracle", "ape", "maggot", "rat", "air", "sub"];

function readBlob(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(STATS_PREFS_STORAGE_KEY);
    if (raw == null) return null;
    const j = JSON.parse(raw) as Record<string, unknown>;
    return j != null && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

function readFlag(j: Record<string, unknown> | null, key: string, fallback: boolean): boolean {
  const v = j?.[key];
  return typeof v === "boolean" ? v : fallback;
}

function readToggles<T extends object>(
  j: Record<string, unknown> | null,
  key: string,
  defaults: T,
): T {
  const out = { ...defaults };
  const raw = j?.[key];
  if (raw == null || typeof raw !== "object") return out;
  const src = raw as Record<string, unknown>;
  const dst = out as Record<string, unknown>;
  for (const k of Object.keys(defaults) as Array<keyof T & string>) {
    if (typeof src[k] === "boolean") dst[k] = src[k];
  }
  return out;
}

/** The one-shot prefs snapshot. See the module doc for the contract. */
export function readOverlayDisplayPrefs(): OverlayDisplayPrefs {
  const j = readBlob();
  const prEnabled = readFlag(j, "prEnabled", DEFAULT_STATS_PREFS.prEnabled);
  let prAlgo: PrAlgo | undefined;
  if (prEnabled) {
    const v = j?.prAlgo;
    prAlgo = v === "expected" ? "expected" : "winrate";
  }
  // Migration parity with the store's parsePrefs: a blob last written by a
  // pre-split build carries only the retired `overlayStatsMode` enum.
  const battle: RosterBattleScope =
    j?.overlayBattleScope === "follow" ||
    j?.overlayBattleScope === "random" ||
    j?.overlayBattleScope === "ranked" ||
    j?.overlayBattleScope === "all"
      ? j.overlayBattleScope
      : (legacyBattleScopeOf(j?.overlayStatsMode) ??
        DEFAULT_STATS_PREFS.overlayBattleScope);
  return {
    chips: readToggles(j, "overlayChips", DEFAULT_STATS_PREFS.overlayChips),
    statsDims: { battle },
    intel: readToggles(j, "overlayIntel", DEFAULT_STATS_PREFS.overlayIntel),
    teamIntel: readFlag(j, "teamIntelEnabled", DEFAULT_STATS_PREFS.teamIntelEnabled),
    teamAvg: readToggles(j, "overlayTeamAvg", DEFAULT_STATS_PREFS.overlayTeamAvg),
    weightedTeamWr: readFlag(j, "weightedTeamWr", DEFAULT_STATS_PREFS.weightedTeamWr),
    sealsOn: prEnabled && readFlag(j, "sealsEnabled", DEFAULT_STATS_PREFS.sealsEnabled),
    sealsDisabled: new Set(
      STAMP_KINDS.filter((kind) => {
        const v = j?.sealDisabled;
        return (
          v != null && typeof v === "object" && (v as Record<string, unknown>)[kind] === true
        );
      }),
    ),
    prAlgo,
    prOn: prEnabled,
  };
}
