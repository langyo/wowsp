/**
 * Shared stats-source resolution for every roster surface (the live battle
 * panel, both post-battle panels and the in-game Tab overlay).
 *
 * The source is TWO layers:
 *
 *   1. per-COLUMN scope — each configured roster column (see
 *      stores/statsPrefs' OverlayColumn) carries its own scope: the whole
 *      account career ("global"), the solo split ("solo"), exactly the
 *      row's current ship ("ship") or every ship of its type ("class");
 *   2. panel-wide battle scope — follow the battle / randoms / ranked /
 *      the global merge of the two, shared by every column.
 *
 * This module owns the battle-dimension resolution ("follow" against one
 * battle's identity), the account-career picker the global/solo columns
 * read, and the column-scope → dims mapping the ship-scoped columns
 * aggregate per-ship payloads through (see utils/shipStatsScope.ts).
 * Every surface consumes both — the in-game Tab overlay included (its
 * bare-DOM page re-reads the columns live off the store's broadcast and
 * fetches per-ship lists through the shared backend source).
 */
import { modeKey } from "@/utils/modeColors";
import type {
  OverlayColumn,
  OverlayColumnScope,
  RosterBattleScope,
  RosterShipScope,
  RosterSoloScope,
} from "@/stores/statsPrefs";

export type { RosterBattleScope, RosterShipScope, RosterSoloScope };
export type { OverlayColumn, OverlayColumnScope };

/** A battle scope with "follow" already resolved against one battle's
 *  identity. */
export type ResolvedStatsMode = "random" | "ranked" | "all";

/** The view layer's scope dimensions as one plain object (what
 *  `scopedRosterView` consumes). */
export interface RosterStatsDims {
  ship: RosterShipScope;
  battle: RosterBattleScope;
  solo: RosterSoloScope;
}

/** True when these dims cannot be served by the account careers the
 *  roster batch already carries — the row views then need the player's
 *  full per-ship list (the pipeline in composables/useRosterStats). */
export function dimsNeedShipStats(dims: RosterStatsDims): boolean {
  return dims.ship !== "all" || dims.solo === "solo";
}

/** One column scope → the ship/solo dims pair its views resolve through.
 *  "global" reads the account careers the roster batch already carries;
 *  every other scope needs the player's per-ship list (see
 *  dimsNeedShipStats). */
export function overlayColumnDims(
  scope: OverlayColumnScope,
  battle: RosterBattleScope,
): RosterStatsDims {
  switch (scope) {
    case "solo":
      return { ship: "all", battle, solo: "solo" };
    case "ship":
      return { ship: "ship", battle, solo: "all" };
    case "class":
      return { ship: "class", battle, solo: "all" };
    default:
      return { ship: "all", battle, solo: "all" };
  }
}

/** The columns that actually render: PR columns drop out while the
 *  rating master is off — the same rule every render surface applies
 *  (postBattleShare's rosterColumns, the overlay's chip columns). */
export function effectiveOverlayColumns(
  columns: readonly OverlayColumn[],
  prOn: boolean,
): OverlayColumn[] {
  return prOn ? [...columns] : columns.filter((c) => c.metric !== "pr");
}

/** True when ANY rendered column resolves past the account careers the
 *  roster batch already carries — the rows then need the players' full
 *  per-ship lists (the pipeline in composables/useRosterStats). PR columns
 *  the rating master hides do not count: invisible columns must not drive
 *  fetches or spinners. */
export function columnsNeedShipStats(
  columns: readonly OverlayColumn[],
  prOn: boolean,
): boolean {
  return effectiveOverlayColumns(columns, prOn).some((c) => c.scope !== "global");
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
