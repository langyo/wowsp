/**
 * Shared stats-source selection for every roster surface (the live battle
 * panel, both post-battle panels and the in-game Tab overlay): which
 * battle-mode career one row's numbers come from — the randoms career
 * (default), the ranked career, or the global merge of the two — plus the
 * resolver that picks a `RosterStat`'s fields apart per the resolved mode.
 *
 * The mode pref lives in the statsPrefs blob (`overlayStatsMode`, a
 * historical field name kept for storage compatibility); "auto" follows the
 * battle being viewed: ranked battles read the ranked career, everything
 * else randoms.
 */
import { modeKey } from "@/utils/modeColors";
import type { RosterStatsMode } from "@/stores/statsPrefs";

export type { RosterStatsMode };

/** A mode with "auto" already resolved against one battle's identity. */
export type ResolvedStatsMode = "random" | "ranked" | "global";

/** One mode's display numbers (all null = never played that mode / miss). */
export interface RosterModeNumbers {
  winrate: number | null;
  pr: number | null;
  battles: number | null;
  avgDamage: number | null;
}

/** A stat entry the view resolver can read: the randoms fields plus the
 *  optional per-mode payloads the batch answer carries. */
export interface RosterStatViewSource extends RosterModeNumbers {
  /** Ranked (排位) career; null = never played ranked. */
  ranked?: RosterModeNumbers | null;
  /** Global (randoms + ranked merged); null = no stats at all. */
  global?: RosterModeNumbers | null;
}

export const EMPTY_ROSTER_VIEW: RosterModeNumbers = {
  winrate: null,
  pr: null,
  battles: null,
  avgDamage: null,
};

/** Which battle-mode stats one battle renders: "auto" follows the battle
 *  (ranked → the ranked career, everything else randoms); the fixed modes
 *  speak for themselves. */
export function resolveRosterStatsMode(
  mode: RosterStatsMode,
  identity: {
    matchGroup?: string | null;
    scenario?: string | null;
    eventType?: string | null;
  },
): ResolvedStatsMode {
  if (mode === "random" || mode === "ranked" || mode === "global") return mode;
  return modeKey(identity.matchGroup, identity.scenario, identity.eventType) === "ranked"
    ? "ranked"
    : "random";
}

/** Pick one player's display numbers per the resolved mode. Players without
 *  the requested mode (never played ranked) answer their nulls — the row
 *  renders the same "—" face as a stats miss. A payload without the global
 *  fields (older shell) falls back to the randoms view. */
export function rosterStatView(
  st: RosterStatViewSource | null | undefined,
  mode: ResolvedStatsMode,
): RosterModeNumbers {
  if (!st) return EMPTY_ROSTER_VIEW;
  if (mode === "ranked") return st.ranked ?? EMPTY_ROSTER_VIEW;
  if (mode === "global") {
    return st.global ?? {
      winrate: st.winrate,
      pr: st.pr,
      battles: st.battles,
      avgDamage: st.avgDamage,
    };
  }
  return {
    winrate: st.winrate,
    pr: st.pr,
    battles: st.battles,
    avgDamage: st.avgDamage,
  };
}
