/**
 * Ship-scoped roster views — the aggregation behind the stats source's
 * ship dimension (see utils/statView.ts for the three-dimension model).
 *
 * While the ship scope is "all" AND the solo filter off, row numbers come
 * straight from the account careers the roster batch already carries
 * (`rosterStatView`). Any other combination needs the player's FULL
 * per-ship list (`lookup_player_ship_stats` — fetched per account and
 * session-cached in composables/useRosterStats) and aggregates it here:
 *
 *   ships  — filtered to the row's own current ship (exact / same class /
 *            same tier — class and tier come from the bundled offline
 *            ship database);
 *   battle — randoms (the per-ship pvp career, or its solo split when the
 *            solo filter is on) / ranked (the per-ship ranked bucket) /
 *            both merged;
 *   solo   — restricts the randoms side to the solo-queue split. The WG
 *            per-ship payload exposes no solo split for ranked, so the
 *            ranked bucket passes through unsplit (documented in the
 *            settings copy).
 *
 * PR: under the default winrate algorithm the aggregate PR is the same
 * anchor mapping the backend applies to careers (`rating_from_winrate`,
 * ported below — identical anchors/clamps, so an aggregated PR sits on the
 * same scale as every career PR). Under the expected algorithm only the
 * per-row randoms PR is exact data; solo/ranked/merged buckets have no
 * expected-values form, so those views show PR "—" instead of a made-up
 * number.
 */
import type { PlayerShipStats, ShipModeStats } from "@/api";
import {
  prAlgoForRequest,
  statsPrefsState,
  type PrAlgo,
  type RosterShipScope,
} from "@/stores/statsPrefs";
import { shipOfflineEntry } from "@/features/holographic/modelLoader";
import { shipTierOf } from "@/utils/shipClass";
import {
  EMPTY_ROSTER_VIEW,
  dimsNeedShipStats,
  rosterDimsOf,
  rosterStatView,
  type ResolvedStatsMode,
  type RosterModeNumbers,
  type RosterStatViewSource,
  type RosterStatsDims,
} from "@/utils/statView";

/** Winrate (percent) → community PR scale — frontend port of the backend's
 *  `rating_from_winrate` (commands/wg_api.rs): the anchors put ApeRadar's
 *  color lines (47/52/56/60/65%) exactly on the standard PR boundaries
 *  (750/1350/1750/2100/2450); piecewise-linear in between, clamped to 0
 *  below 35% and extrapolated along the top segment above 65%. Keeping the
 *  two in lockstep is a release requirement — the unit test pins the
 *  backend's own anchor test values. */
const WR_TO_PR_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [35.0, 0.0],
  [47.0, 750.0],
  [52.0, 1350.0],
  [56.0, 1750.0],
  [60.0, 2100.0],
  [65.0, 2450.0],
];

export function prProxyFromWinrate(wr: number): number {
  if (wr <= WR_TO_PR_ANCHORS[0][0]) return 0;
  for (let i = 1; i < WR_TO_PR_ANCHORS.length; i += 1) {
    const [x0, y0] = WR_TO_PR_ANCHORS[i - 1];
    const [x1, y1] = WR_TO_PR_ANCHORS[i];
    if (wr <= x1) return Math.round(y0 + ((wr - x0) / (x1 - x0)) * (y1 - y0));
  }
  const [x0, y0] = WR_TO_PR_ANCHORS[WR_TO_PR_ANCHORS.length - 2];
  const [x1, y1] = WR_TO_PR_ANCHORS[WR_TO_PR_ANCHORS.length - 1];
  return Math.round(y0 + ((wr - x0) / (x1 - x0)) * (y1 - y0));
}

/** The offline-database facts a ship-scope filter matches on. */
export interface ShipScopeMeta {
  type: string | null;
  tier: number | null;
}

export type ShipMetaResolver = (shipId: number) => ShipScopeMeta | null;

/** Default resolver: the bundled offline ship database (same source the
 *  roster rows' class icons and tier weighting read). */
const defaultShipMeta: ShipMetaResolver = (shipId) => {
  const tier = shipTierOf(shipId);
  const type = shipOfflineEntry(shipId)?.type ?? null;
  return tier == null && type == null ? null : { tier, type };
};

/** Additive counters behind one aggregated view. */
interface Counters {
  battles: number;
  wins: number;
  damage: number;
}

function modeCounters(m: ShipModeStats | null | undefined): Counters | null {
  if (!m || m.battles <= 0) return null;
  return { battles: m.battles, wins: m.wins, damage: m.damageCaused };
}

function mergeCounters(a: Counters | null, b: Counters | null): Counters | null {
  if (!a) return b;
  if (!b) return a;
  return { battles: a.battles + b.battles, wins: a.wins + b.wins, damage: a.damage + b.damage };
}

/** One ship row's counters for the requested battle scope. Randoms = the
 *  row's own top-level fields (they ARE the pvp career); the solo split
 *  lives in the mode breakdown; ranked has no solo split (see the module
 *  doc). */
function countersOf(
  row: PlayerShipStats,
  battle: ResolvedStatsMode,
  solo: boolean,
): Counters | null {
  const randoms = (): Counters | null =>
    solo
      ? modeCounters(row.modes?.solo)
      : row.battles > 0
        ? { battles: row.battles, wins: row.wins, damage: row.damageCaused }
        : null;
  switch (battle) {
    case "random":
      return randoms();
    case "ranked":
      return modeCounters(row.modes?.ranked);
    default:
      return mergeCounters(randoms(), modeCounters(row.modes?.ranked));
  }
}

/** Aggregate one player's per-ship list into the requested scope's display
 *  numbers. Null = the scope itself is unresolvable (the row's ship is
 *  unknown, so "same class/tier" has nothing to match on); an all-null
 *  view = resolved but zero battles (the row then shows the same "—" face
 *  as a career the player never played). Scope "all" (the solo-only
 *  configuration) sweeps the whole list and needs no target ship. */
export function aggregateShipScopeStats(
  ships: readonly PlayerShipStats[],
  targetShipId: number | null,
  opts: {
    scope: RosterShipScope;
    battle: ResolvedStatsMode;
    solo: boolean;
    prAlgo: PrAlgo;
  },
  resolveMeta: ShipMetaResolver = defaultShipMeta,
): RosterModeNumbers | null {
  let predicate: (shipId: number) => boolean;
  if (opts.scope === "all") {
    predicate = () => true;
  } else if (targetShipId == null) {
    return null;
  } else if (opts.scope === "ship") {
    const target = targetShipId;
    predicate = (shipId) => shipId === target;
  } else {
    const targetMeta = resolveMeta(targetShipId);
    const key = opts.scope === "class" ? targetMeta?.type : targetMeta?.tier;
    if (key == null) return null;
    predicate =
      opts.scope === "class"
        ? (shipId) => resolveMeta(shipId)?.type === key
        : (shipId) => resolveMeta(shipId)?.tier === key;
  }

  const totals: Counters = { battles: 0, wins: 0, damage: 0 };
  // Expected-PR aggregation: a battles-weighted mean of the per-row randoms
  // PRs — only valid where the bucket IS the randoms career (see the module
  // doc); rows without a PR contribute no weight.
  let prWeight = 0;
  let prSum = 0;
  for (const row of ships) {
    if (!predicate(row.shipId)) continue;
    const c = countersOf(row, opts.battle, opts.solo);
    if (!c) continue;
    totals.battles += c.battles;
    totals.wins += c.wins;
    totals.damage += c.damage;
    if (opts.prAlgo === "expected" && opts.battle === "random" && !opts.solo && row.pr != null) {
      prWeight += row.battles;
      prSum += row.pr * row.battles;
    }
  }
  if (totals.battles <= 0) return EMPTY_ROSTER_VIEW;
  const winrate = (totals.wins / totals.battles) * 100;
  const pr =
    opts.prAlgo === "winrate"
      ? prProxyFromWinrate(winrate)
      : prWeight > 0
        ? Math.round(prSum / prWeight)
        : null;
  return {
    winrate,
    pr,
    battles: totals.battles,
    avgDamage: totals.damage / totals.battles,
  };
}

/** The per-ship payload slots a roster stat carries once the ship-scoped
 *  pipeline has attached them (see composables/useRosterStats). */
export interface ShipScopedStat {
  accountId?: number | null;
  /** The player's full per-ship list. undefined = not requested yet,
   *  null = requested but unavailable (lookup failed / hidden). */
  ships?: readonly PlayerShipStats[] | null;
  /** True while the per-ship list is being fetched (row spinners). */
  shipsLoading?: boolean;
}

/** One row's display numbers under the FULL three-dimension model: the
 *  account-career path while the dims allow it, the aggregated per-ship
 *  view otherwise. Loading / unavailable per-ship data answers the
 *  all-null view (callers own the spinner face). */
export function scopedRosterView(
  st: (RosterStatViewSource & ShipScopedStat) | null | undefined,
  targetShipId: number | null,
  dims: RosterStatsDims,
  battle: ResolvedStatsMode,
  prAlgo: PrAlgo,
): RosterModeNumbers {
  if (!dimsNeedShipStats(dims)) return rosterStatView(st, battle);
  if (!st || st.shipsLoading || st.ships == null) return EMPTY_ROSTER_VIEW;
  return (
    aggregateShipScopeStats(st.ships, targetShipId, {
      scope: dims.ship,
      battle,
      solo: dims.solo === "solo",
      prAlgo,
    }) ?? EMPTY_ROSTER_VIEW
  );
}

/** Convenience for prop-driven consumers (the replay fallback matrix):
 *  resolve the dims straight off the live prefs and scope one row's view
 *  against an already-resolved battle scope. */
export function scopedViewOf(
  st: (RosterStatViewSource & ShipScopedStat) | null | undefined,
  shipId: number | null,
  battle: ResolvedStatsMode,
): RosterModeNumbers {
  return scopedRosterView(
    st,
    shipId,
    rosterDimsOf(statsPrefsState.value),
    battle,
    prAlgoForRequest() ?? "winrate",
  );
}
