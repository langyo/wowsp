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
  legacyChipsOf,
  legacyColumnsSeed,
  legacyTeamAvgEnabledOf,
  parseOverlayColumns,
  type OverlayColumn,
  type OverlayColumnMetric,
  type OverlayColumnScope,
  type PrAlgo,
  type RosterBattleScope,
} from "@/stores/statsPrefs";
import {
  columnsNeedShipStats,
  effectiveOverlayColumns,
  overlayColumnDims,
  resolveRosterBattleScope,
  rosterStatView,
  type ResolvedStatsMode,
  type RosterModeNumbers,
  type RosterStatViewSource,
} from "@/utils/statView";
import { scopedRosterView } from "@/utils/shipStatsScope";
import type { StampKind } from "@/utils/winrate";

// The stat-view helpers the overlay renders through live in
// utils/statView + utils/shipStatsScope (shared with the main-window
// panels; the aggregation module is deliberately free of the Vue/three.js
// dependency chains so this bare-DOM page can import it); re-exported so
// the overlay page keeps its one import site.
export {
  columnsNeedShipStats,
  effectiveOverlayColumns,
  overlayColumnDims,
  resolveRosterBattleScope,
  rosterStatView,
  scopedRosterView,
};
export type {
  OverlayColumn,
  OverlayColumnMetric,
  OverlayColumnScope,
  PrAlgo,
  ResolvedStatsMode,
  RosterModeNumbers,
  RosterStatViewSource,
};

/** The raw per-player stats the overlay caches: the randoms career plus
 *  the ranked / global per-mode payloads nested the way `rosterStatView`
 *  reads them (the wire fields map in main.ts's batch handler), and the
 *  per-ship list the ship-scoped columns attach (shared backend
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
  /** undefined = not requested; null = requested but unavailable. No
   *  separate loading flag: a row whose list is still owed renders the
   *  chasing three-dot loading face (overlay/main.ts statFace) until the
   *  list lands. */
  ships?: readonly PlayerShipStats[] | null;
}

/** Everything the overlay renders consumes this snapshot. */
export interface OverlayDisplayPrefs {
  /** The configured roster columns (scope × metric, in order) — the same
   *  list every webui roster surface renders; the overlay's per-row chip
   *  numbers are these columns. */
  columns: OverlayColumn[];
  /** The panel-wide battle-type scope ("follow" resolved per battle in
   *  main.ts). */
  battleScope: RosterBattleScope;
  /** The team-averages line under each side — one all-or-nothing switch
   *  (the consumable-intel line above it renders unconditionally). */
  teamAvgEnabled: boolean;
  /** Team winrate aggregation shared with the live panel. */
  weightedTeamWr: boolean;
  /** `prEnabled && sealsEnabled` — the seal pipeline's master gate. */
  sealsOn: boolean;
  /** Per-kind seal kill switches (settings' seal customizer). */
  sealsDisabled: ReadonlySet<StampKind>;
  /** `prAlgo` forwarded to the stats RPC while the PR rating is on. */
  prAlgo: PrAlgo | undefined;
  /** The PR master switch — the PR columns/averages double-gate on it,
   *  the same rule the roster panels' PR columns follow. */
  prOn: boolean;
}

/** Known seal kinds — junk keys in the kill-switch map are dropped. The
 *  veteran tiers (空中奶龙 / 水下奶蛙) and the merged kinds (空中神人 /
 *  水下神人 / 空中小猴 / 水下小猴) participate like every other seal. */
const STAMP_KINDS: readonly StampKind[] = [
  "miracle",
  "ape",
  "maggot",
  "rat",
  "air",
  "sub",
  "airVeteran",
  "subVeteran",
  "airMiracle",
  "subMiracle",
  "airApe",
  "subApe",
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

/** The one-shot prefs snapshot. See the module doc for the contract. */
export function readOverlayDisplayPrefs(): OverlayDisplayPrefs {
  const j = readBlob();
  const prEnabled = readFlag(j, "prEnabled", DEFAULT_STATS_PREFS.prEnabled);
  let prAlgo: PrAlgo | undefined;
  if (prEnabled) {
    const v = j?.prAlgo;
    prAlgo = v === "expected" ? "expected" : "winrate";
  }
  // Migration parity with the store's parsePrefs: a blob last written by
  // a pre-columns build carries only the retired chips + ship/solo dims —
  // they seed the column list through the SAME helper the store uses, so
  // the overlay agrees with the main window even before its heal-write
  // lands. A blob (or storage) without even the chips key answers the
  // shipped default: all four chips on. A blob carrying `overlayStatsMode`
  // (pre-split) seeds the battle scope the same way.
  const battle: RosterBattleScope =
    j?.overlayBattleScope === "follow" ||
    j?.overlayBattleScope === "random" ||
    j?.overlayBattleScope === "ranked" ||
    j?.overlayBattleScope === "all"
      ? j.overlayBattleScope
      : (legacyBattleScopeOf(j?.overlayStatsMode) ??
        DEFAULT_STATS_PREFS.overlayBattleScope);
  const columns: OverlayColumn[] = Array.isArray(j?.overlayColumns)
    ? parseOverlayColumns(j?.overlayColumns)
    : legacyColumnsSeed(
        j?.overlayChips == null
          ? // The pre-chips `avgStatsEnabled` switch seeds the whole set,
            // same as the store's parsePrefs ("show the stat numbers").
            typeof j?.avgStatsEnabled === "boolean" && !j.avgStatsEnabled
            ? { winrate: false, pr: false, battles: false, damage: false }
            : { winrate: true, pr: true, battles: true, damage: true }
          : legacyChipsOf(j.overlayChips),
        j?.overlayShipScope,
        j?.overlaySoloScope,
      );
  return {
    columns,
    battleScope: battle,
    // Migration parity with the store's parsePrefs: the single
    // team-averages switch, seeded by the retired per-item toggles of a
    // pre-simplification blob through the SAME helper the store uses.
    teamAvgEnabled: readFlag(
      j,
      "teamAvgEnabled",
      legacyTeamAvgEnabledOf(j?.overlayTeamAvg),
    ),
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
