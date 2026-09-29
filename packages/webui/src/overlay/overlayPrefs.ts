/** The Tab overlay's display-preferences reader + stat-source helpers.
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
  type OverlayChipToggles,
  type OverlayIntelToggles,
  type OverlayStatsMode,
  type OverlayTeamAvgToggles,
  type PrAlgo,
} from "@/stores/statsPrefs";
import { modeKey } from "@/utils/modeColors";
import type { StampKind } from "@/utils/winrate";

/** The stat view one roster row consumes: either the overall randoms
 *  numbers or the ranked (排位) career numbers, per the stats source. */
export interface StatView {
  winrate: number | null;
  pr: number | null;
  battles: number | null;
  damage: number | null;
}

/** The raw per-player stats the overlay caches (wire shape of
 * `lookup_players_stats_batch`; overall = randoms career). */
export interface RawStat {
  winrate: number | null;
  avgDamage: number | null;
  pr: number | null;
  battles: number | null;
  rankedWinrate: number | null;
  rankedAvgDamage: number | null;
  rankedPr: number | null;
  rankedBattles: number | null;
}

/** Everything the overlay renders consumes this snapshot. */
export interface OverlayDisplayPrefs {
  chips: OverlayChipToggles;
  statsMode: OverlayStatsMode;
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
  const statsMode: OverlayStatsMode =
    j?.overlayStatsMode === "random" || j?.overlayStatsMode === "ranked"
      ? j.overlayStatsMode
      : DEFAULT_STATS_PREFS.overlayStatsMode;
  return {
    chips: readToggles(j, "overlayChips", DEFAULT_STATS_PREFS.overlayChips),
    statsMode,
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
  };
}

/** Which battle-mode stats a battle renders: "auto" follows the current
 *  battle (ranked → ranked stats, everything else randoms), the fixed
 *  modes speak for themselves. */
export function rankedStatsSource(
  mode: OverlayStatsMode,
  identity: { matchGroup?: string | null; scenario?: string | null; eventType?: string | null },
): boolean {
  if (mode === "ranked") return true;
  if (mode === "random") return false;
  return modeKey(identity.matchGroup, identity.scenario, identity.eventType) === "ranked";
}

/** Pick one player's display numbers per the stats source. Players without
 *  the requested mode (never played ranked) answer their nulls — the chips
 *  render the same "—" face as a stats miss. */
export function statViewOf(st: RawStat | undefined, ranked: boolean): StatView {
  if (!st) return { winrate: null, pr: null, battles: null, damage: null };
  return ranked
    ? {
        winrate: st.rankedWinrate,
        pr: st.rankedPr,
        battles: st.rankedBattles,
        damage: st.rankedAvgDamage,
      }
    : {
        winrate: st.winrate,
        pr: st.pr,
        battles: st.battles,
        damage: st.avgDamage,
      };
}
