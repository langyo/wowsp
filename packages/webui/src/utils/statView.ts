/**
 * Shared stats-source resolution for every roster surface (the live battle
 * panel, both post-battle panels and the in-game Tab overlay).
 *
 * The source is TWO layers:
 *
 *   1. per-COLUMN scope — each configured roster column (see
 *      stores/statsPrefs' OverlayColumn) carries its own scope: the whole
 *      account career ("global"), the account's solo split ("solo"),
 *      exactly the row's current ship ("ship"), that ship's own solo
 *      split ("shipSolo") or every ship of its type ("class");
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
 *  full per-ship list (the pipeline in composables/useRosterStats). The
 *  solo filter is served by the career solo split the same batch carries
 *  (see RosterStatViewSource.solo), so only a ship-scope beyond "all"
 *  forces the per-ship fetch; solo over ranked has no split anywhere and
 *  answers the dash face without one. */
export function dimsNeedShipStats(dims: RosterStatsDims): boolean {
  return dims.ship !== "all";
}

/** One column scope → the ship/solo dims pair its views resolve through.
 *  "global" and "solo" read the account careers the roster batch already
 *  carries (the solo split included); the ship, ship-solo and class scopes
 *  need the player's per-ship list (see dimsNeedShipStats) — "shipSolo"
 *  being the ship × solo combination that answers "this ship's solo
 *  career", the very question an account-solo column placed next to a
 *  ship row is so easily misread as. */
export function overlayColumnDims(
  scope: OverlayColumnScope,
  battle: RosterBattleScope,
): RosterStatsDims {
  switch (scope) {
    case "solo":
      return { ship: "all", battle, solo: "solo" };
    case "ship":
      return { ship: "ship", battle, solo: "all" };
    case "shipSolo":
      return { ship: "ship", battle, solo: "solo" };
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
 *  fetches or spinners. Only the ship / ship-solo / class scopes go past
 *  the careers — the plain solo scope reads the career solo split
 *  (RosterStatViewSource.solo), so a global+solo column set costs no
 *  per-ship fetches at all. */
export function columnsNeedShipStats(
  columns: readonly OverlayColumn[],
  prOn: boolean,
): boolean {
  return effectiveOverlayColumns(columns, prOn).some(
    (c) => c.scope === "ship" || c.scope === "shipSolo" || c.scope === "class",
  );
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
  /** Solo (单排) split of the randoms career — the batch's `pvp_solo`
   *  node, mapped data-only (PR/avgDamage stay null; the view derives the
   *  PR per algorithm). null = the career carried no solo split (never
   *  played solo / hidden profile / older shell). There is no solo split
   *  of ranked anywhere, so this bucket is randoms-only by definition. */
  solo?: RosterModeNumbers | null;
}

export const EMPTY_ROSTER_VIEW: RosterModeNumbers = {
  winrate: null,
  pr: null,
  battles: null,
  avgDamage: null,
};

/** Careers at or below this many randoms battles trust an (near-)all-solo
 *  split: a fresh account genuinely can have played every battle alone. */
const SOLO_SPLIT_TRUST_BATTLES = 50;

/** How close the solo share must come to the whole randoms career before
 *  the split reads as a transport mirror (solo ≡ pvp) rather than a real
 *  division split — within 1% (an exact match included). */
const SOLO_SPLIT_FAKE_RATIO = 0.99;

/** Whether a career solo split is trustworthy as a REAL division split.
 *  Some transports mirror the unsplit pvp node into `pvp_solo`, so a
 *  "solo" share that equals (or all but equals) the whole randoms career
 *  is the mirror artifact, not a measurement — presenting it as 单排 numbers
 *  would be fake data. Guard: an exact/near match on a career beyond
 *  SOLO_SPLIT_TRUST_BATTLES battles is unreliable; a short career may
 *  honestly be all solo, and a missing comparator (either count null)
 *  stays trusted so the plain absence faces keep their meaning. */
export function soloSplitReliable(
  soloBattles: number | null | undefined,
  totalBattles: number | null | undefined,
): boolean {
  if (soloBattles == null || totalBattles == null) return true;
  if (totalBattles <= SOLO_SPLIT_TRUST_BATTLES) return true;
  return soloBattles < totalBattles * SOLO_SPLIT_FAKE_RATIO;
}

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
