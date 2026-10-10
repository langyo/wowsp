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
 *  Read at window creation and RE-read whenever the main window's store
 *  broadcasts a write (the `wowsp://stats-prefs-changed` event — see
 *  stores/statsPrefs.ts and overlay/main.ts's refreshPrefs): a settings
 *  flip applies to the live window, not only the next one. */
import type { PlayerShipStats } from "@/api";
import {
  DEFAULT_STATS_PREFS,
  STATS_PREFS_STORAGE_KEY,
  legacyBattleScopeOf,
  type OverlayChipToggles,
  type OverlayIntelToggles,
  type OverlayTeamAvgToggles,
  type PrAlgo,
  type RosterBattleScope,
  type RosterShipScope,
  type RosterSoloScope,
} from "@/stores/statsPrefs";
import {
  dimsNeedShipStats,
  resolveRosterBattleScope,
  rosterStatView,
  type ResolvedStatsMode,
  type RosterModeNumbers,
  type RosterStatViewSource,
  type RosterStatsDims,
} from "@/utils/statView";
import { scopedRosterView } from "@/utils/shipStatsScope";
import type { StampKind } from "@/utils/winrate";

// The stat-view helpers the overlay renders through live in
// utils/statView + utils/shipStatsScope (shared with the main-window
// panels; the aggregation module is deliberately free of the Vue/three.js
// dependency chains so this bare-DOM page can import it); re-exported so
// the overlay page keeps its one import site.
export { dimsNeedShipStats, resolveRosterBattleScope, rosterStatView, scopedRosterView };
export type { PrAlgo, ResolvedStatsMode, RosterModeNumbers, RosterStatViewSource, RosterStatsDims };

/** The raw per-player stats the overlay caches: the randoms career plus
 *  the ranked / global per-mode payloads nested the way `rosterStatView`
 *  reads them (the wire fields map in main.ts's batch handler), and the
 *  per-ship list the ship-scoped source attaches (shared backend
 *  facility — see utils/shipStatsScope and main.ts's ship pipeline). */
export interface RawStat extends RosterStatViewSource {
  clanId: number | null;
  clanTag: string | null;
  hidden: boolean;
  /** WG account id off the batch answer — the ship-scoped fetch key. */
  accountId: number | null;
  /** The cluster the stats actually resolved on. Cross-server Clan
   *  Battles can adopt a foreign-realm account for a roster name; its
   *  per-ship fetches must ride THIS realm, not the window's. null = not
   *  resolved (a landed answer always carries its realm string). */
  realm?: string | null;
  /** undefined = not requested; null = requested but unavailable. The
   *  overlay has no spinner face, so no separate loading flag: pending
   *  rows render the muted "querying" ellipsis until the list lands. */
  ships?: readonly PlayerShipStats[] | null;
}

/** The stats source's three dimensions as the overlay consumes them: the
 *  battle dimension is resolved per battle in main.ts; the ship/solo
 *  dimensions drive the page's per-ship pipeline (same aggregation module
 *  the main-window panels use). Re-read live on the store's broadcast —
 *  see the module doc. */
export type OverlayStatsDims = RosterStatsDims;

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

/** Known seal kinds — junk keys in the kill-switch map are dropped. The
 *  merged kinds (空中神人 / 水下神人) participate like every other seal. */
const STAMP_KINDS: readonly StampKind[] = [
  "miracle",
  "ape",
  "maggot",
  "rat",
  "air",
  "sub",
  "airMiracle",
  "subMiracle",
];

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
  const ship: RosterShipScope =
    j?.overlayShipScope === "class" || j?.overlayShipScope === "tier" || j?.overlayShipScope === "ship"
      ? j.overlayShipScope
      : DEFAULT_STATS_PREFS.overlayShipScope;
  const solo: RosterSoloScope =
    j?.overlaySoloScope === "solo" ? "solo" : DEFAULT_STATS_PREFS.overlaySoloScope;
  return {
    chips: readToggles(j, "overlayChips", DEFAULT_STATS_PREFS.overlayChips),
    statsDims: { battle, ship, solo },
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
