/**
 * Shared stats-source selection for every roster surface (the live battle
 * panel, both post-battle panels and the in-game Tab overlay).
 *
 * The source is modeled as THREE orthogonal dimensions persisted in the
 * statsPrefs blob (see stores/statsPrefs.ts):
 *
 *   1. ship scope   — all ships (account careers) / the row's current-ship
 *                     class / tier / exactly that ship;
 *   2. battle scope — follow the battle / randoms / ranked / the global
 *                     merge of the two;
 *   3. solo filter  — all divisions / solo queue only.
 *
 * This module owns the battle-dimension resolution ("follow" against one
 * battle's identity) and the account-career picker the all-ships scope
 * reads; the ship-scoped dimensions aggregate per-ship payloads instead
 * (see utils/shipStatsScope.ts). The in-game Tab overlay consumes the
 * battle dimension only (its bare-DOM pipeline keeps the account
 * careers).
 */
import { modeKey } from "@/utils/modeColors";
import type {
  RosterBattleScope,
  RosterShipScope,
  RosterSoloScope,
} from "@/stores/statsPrefs";

export type { RosterBattleScope, RosterShipScope, RosterSoloScope };

/** A battle scope with "follow" already resolved against one battle's
 *  identity. */
export type ResolvedStatsMode = "random" | "ranked" | "all";

/** The three stored stats-source dimensions as one plain object (what
 *  `rosterDimsOf` hands the view layer). */
export interface RosterStatsDims {
  ship: RosterShipScope;
  battle: RosterBattleScope;
  solo: RosterSoloScope;
}

/** Read the three stats-source dimensions off a statsPrefs-shaped object. */
export function rosterDimsOf(p: {
  overlayShipScope: RosterShipScope;
  overlayBattleScope: RosterBattleScope;
  overlaySoloScope: RosterSoloScope;
}): RosterStatsDims {
  return {
    ship: p.overlayShipScope,
    battle: p.overlayBattleScope,
    solo: p.overlaySoloScope,
  };
}

/** True when the dimensions cannot be served by the account careers the
 *  roster batch already carries — the row views then need the player's
 *  full per-ship list (the pipeline in composables/useRosterStats). */
export function dimsNeedShipStats(dims: RosterStatsDims): boolean {
  return dims.ship !== "all" || dims.solo === "solo";
}

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

/** Which battle-type stats one battle renders: "follow" follows the battle
 *  (ranked → the ranked career, everything else randoms); the fixed scopes
 *  speak for themselves ("all" = randoms + ranked merged). */
export function resolveRosterBattleScope(
  scope: RosterBattleScope,
  identity: {
    matchGroup?: string | null;
    scenario?: string | null;
    eventType?: string | null;
  },
): ResolvedStatsMode {
  if (scope === "random" || scope === "ranked" || scope === "all") return scope;
  return modeKey(identity.matchGroup, identity.scenario, identity.eventType) === "ranked"
    ? "ranked"
    : "random";
}

/** Pick one player's display numbers per the resolved battle scope.
 *  Players without the requested mode (never played ranked) answer their
 *  nulls — the row renders the same "—" face as a stats miss. A payload
 *  without the global fields (older shell) falls back to the randoms
 *  view. */
export function rosterStatView(
  st: RosterStatViewSource | null | undefined,
  mode: ResolvedStatsMode,
): RosterModeNumbers {
  if (!st) return EMPTY_ROSTER_VIEW;
  if (mode === "ranked") return st.ranked ?? EMPTY_ROSTER_VIEW;
  if (mode === "all") {
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
