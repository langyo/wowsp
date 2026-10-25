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
 *   solo   — restricts the randoms side to the solo-queue split. No solo
 *            split of ranked exists on any transport, so a solo view over
 *            the ranked bucket answers the dash face instead of the
 *            unsplit ranked career, and the randoms+ranked merge under the
 *            solo filter keeps only the solo randoms side.
 *
 * The solo-ONLY views (ship scope "all") never touch this aggregation:
 * the account career the roster batch carries has the solo split
 * first-class (`pvp_solo` → RosterStatViewSource.solo), so those views
 * read it directly — same source, same fetch, same vintage as the global
 * columns, and no per-ship list needed. (The per-ship split document is
 * the one bulk transport that can fail or lag behind the career; its sum
 * used to drift from the career the moment it did.) A ship/class scope
 * COMBINED with the solo filter still aggregates per-ship — the shipped
 * "shipSolo" column scope is exactly that combination (the row ship's own
 * solo split).
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
import { type PrAlgo, type RosterShipScope } from "@/stores/statsPrefs";
// shipClass only (NOT features/holographic/modelLoader): this module is
// shared with the bare-DOM Tab overlay page, which must stay free of the
// three.js/model-pack dependency chain. Same offline database either way.
import { shipTierOf, shipTypeOf } from "@/utils/shipClass";
import {
  EMPTY_ROSTER_VIEW,
  dimsNeedShipStats,
  rosterStatView,
  soloSplitReliable,
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
  const type = shipTypeOf(shipId);
  if (tier == null && type === "") return null;
  return { tier, type: type === "" ? null : type };
};

/** Additive counters behind one aggregated view. frags/survived ride along
 *  so the K/D aggregates the RAW counters (Σfrags / Σ(battles − survived)) —
 *  the same caliber the account careers carry, never a mean of per-ship
 *  ratios. */
interface Counters {
  battles: number;
  wins: number;
  damage: number;
  frags: number;
  survived: number;
}

function modeCounters(m: ShipModeStats | null | undefined): Counters | null {
  if (!m || m.battles <= 0) return null;
  return {
    battles: m.battles,
    wins: m.wins,
    damage: m.damageCaused,
    frags: m.frags,
    survived: m.survivedBattles,
  };
}

function mergeCounters(a: Counters | null, b: Counters | null): Counters | null {
  if (!a) return b;
  if (!b) return a;
  return {
    battles: a.battles + b.battles,
    wins: a.wins + b.wins,
    damage: a.damage + b.damage,
    frags: a.frags + b.frags,
    survived: a.survived + b.survived,
  };
}

/** One ship row's counters for the requested battle scope. Randoms = the
 *  row's own top-level fields (they ARE the pvp career); the solo split
 *  lives in the mode breakdown. Ranked has no solo split (see the module
 *  doc): under the solo filter the ranked bucket answers null and the
 *  randoms+ranked merge keeps only the solo randoms side — the unsplit
 *  ranked career must never masquerade as solo numbers. */
function countersOf(
  row: PlayerShipStats,
  battle: ResolvedStatsMode,
  solo: boolean,
): Counters | null {
  const randoms = (): Counters | null =>
    solo
      ? modeCounters(row.modes?.solo)
      : row.battles > 0
        ? {
            battles: row.battles,
            wins: row.wins,
            damage: row.damageCaused,
            frags: row.frags,
            survived: row.survivedBattles,
          }
        : null;
  switch (battle) {
    case "random":
      return randoms();
    case "ranked":
      return solo ? null : modeCounters(row.modes?.ranked);
    default:
      return mergeCounters(randoms(), solo ? null : modeCounters(row.modes?.ranked));
  }
}

/** Aggregate one player's per-ship list into the requested scope's display
 *  numbers. Null = the scope itself is unresolvable (the row's ship is
 *  unknown, so "same class/tier" has nothing to match on). A RESOLVED
 *  scope with zero battles answers battles 0 with every ratio null: the
 *  count is real (a row whose list landed shows "0 场", never the "—" a
 *  data miss wears), while wins or damage over zero battles is not a
 *  value — winrate / PR / avg damage keep the dash face. Scope "all"
 *  sweeps the whole list and needs no target ship (the production
 *  solo-only views read the career instead — see scopedRosterView). */
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

  // A solo view over the RANKED bucket has no split anywhere (see
  // countersOf) — the all-dash face scopedRosterView already answers at
  // its own choke point; a "measured" 0 would claim a split that does not
  // exist on any transport.
  if (opts.solo && opts.battle === "ranked") return EMPTY_ROSTER_VIEW;
  const totals: Counters = { battles: 0, wins: 0, damage: 0, frags: 0, survived: 0 };
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
    totals.frags += c.frags;
    totals.survived += c.survived;
    if (opts.prAlgo === "expected" && opts.battle === "random" && !opts.solo && row.pr != null) {
      prWeight += row.battles;
      prSum += row.pr * row.battles;
    }
  }
  if (totals.battles <= 0) {
    // Resolved but never played: an honest 0 for the count, the dash for
    // every ratio (wins/damage over zero battles has no real value). A
    // ship missing from the landed list lands here too — never played IS
    // zero battles; only an unresolvable scope (unknown ship above)
    // answers the all-null view.
    return { winrate: null, pr: null, battles: 0, avgDamage: null, kd: null };
  }
  const winrate = (totals.wins / totals.battles) * 100;
  const pr =
    opts.prAlgo === "winrate"
      ? prProxyFromWinrate(winrate)
      : prWeight > 0
        ? Math.round(prSum / prWeight)
        : null;
  // K/D over the summed raw counters — deaths = battles − survived, the
  // game's own caliber (an aggregate where nobody died answers the dash:
  // division by zero is not a 0 K/D, it is no ratio at all).
  const deaths = totals.battles - Math.min(totals.survived, totals.battles);
  return {
    winrate,
    pr,
    battles: totals.battles,
    avgDamage: totals.damage / totals.battles,
    kd: deaths > 0 ? totals.frags / deaths : null,
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

/** The account career's solo split as display numbers: PR derives from the
 *  split's own winrate under the winrate algorithm (the same anchors every
 *  career PR uses); under the expected algorithm — and for a split the
 *  career never carried — the honest faces are the dash ones. A split the
 *  reliability guard rejects (soloSplitReliable — a transport-mirrored
 *  split that just equals the career) answers the same dash faces: the
 *  mapping layers already drop those, and this choke point keeps every
 *  scopedRosterView consumer honest even against an unguarded cache. */
function careerSoloView(
  st: RosterStatViewSource | null | undefined,
  prAlgo: PrAlgo,
): RosterModeNumbers {
  const solo = st?.solo;
  if (!solo || solo.battles == null) return EMPTY_ROSTER_VIEW;
  if (!soloSplitReliable(solo.battles, st?.battles ?? null)) return EMPTY_ROSTER_VIEW;
  return {
    winrate: solo.winrate,
    pr: prAlgo === "winrate" && solo.winrate != null ? prProxyFromWinrate(solo.winrate) : null,
    battles: solo.battles,
    avgDamage: null,
    // The split's own K/D when the wire carried it (battles/wins-only
    // splits — CN — answer null, the dash face).
    kd: solo.kd ?? null,
  };
}

/** One row's display numbers under the FULL three-dimension model: the
 *  account-career path while the dims allow it, the aggregated per-ship
 *  view otherwise. Solo-only views (ship scope "all") are a career path —
 *  the batch answer carries the solo split first-class, so those columns
 *  neither wait on nor degrade with the per-ship transport. A ship/class
 *  scope COMBINED with the solo filter still aggregates the per-ship solo
 *  splits (a "this ship's solo career" question the account career cannot
 *  answer). Loading / unavailable per-ship data answers the all-null view
 *  (callers own the spinner face). */
export function scopedRosterView(
  st: (RosterStatViewSource & ShipScopedStat) | null | undefined,
  targetShipId: number | null,
  dims: RosterStatsDims,
  battle: ResolvedStatsMode,
  prAlgo: PrAlgo,
): RosterModeNumbers {
  if (dims.solo === "solo") {
    // No solo split of ranked exists on any transport — the dash face is
    // the honest answer, not the unsplit ranked career.
    if (battle === "ranked") return EMPTY_ROSTER_VIEW;
    if (dims.ship === "all") return careerSoloView(st, prAlgo);
  }
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

/** Convenience for prop-driven consumers (the holographic ship tooltip):
 *  resolve the ACCOUNT career view against an already-resolved battle
 *  scope. The per-column scopes live in the roster surfaces' own column
 *  engines (postBattleShare / overlay main) — a tooltip has no column
 *  list of its own, so it reads the plain global career. */
export function scopedViewOf(
  st: (RosterStatViewSource & ShipScopedStat) | null | undefined,
  _shipId: number | null,
  battle: ResolvedStatsMode,
): RosterModeNumbers {
  return rosterStatView(st, battle);
}
