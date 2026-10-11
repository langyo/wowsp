/** Ship-type aggregation + date-range filtering utilities.
 *
 *  The WG API returns flat per-ship PvP stats (PlayerShipStats[]). This module
 *  derives the higher-level views a stats page needs:
 *    - Per-ship-type summary (battles/wins/winrate/avgDamage by BB/CA/DD/CV/SS)
 *    - Date-range views (1d/7d/30d/all-time)
 *    - Per-mode breakdown from the account-level division winrates
 *
 *  Ship-type is resolved by joining shipId → encyclopedia ShipInfo.type.
 *
 *  Date ranges: WG exposes only career totals per ship (no per-battle data),
 *  so a range view is computed as current totals minus the latest locally
 *  recorded history point at or before the range cutoff (see
 *  `computeRecentDelta`). A custom window additionally bounds the end the
 *  same way — the latest history point at or before the window's last day
 *  closes it instead of the current rows. The plain lastBattleTime filter is
 *  kept only as the labeled career fallback for when no old-enough baseline
 *  exists yet.
 *
 *  Baseline rows with impossible career counters (battles recorded, zero
 *  damage AND zero kills — artifacts of a partially broken upstream, such as
 *  the 2026-09 CN vortex regression) are skipped when picking a baseline:
 *  diffing against one would resurrect the whole career total as the
 *  "recent" delta while battles stay a true small delta (see
 *  `isPoisonedCareerRow`).
 */
import type { PlayerShipStats, ShipCareerTotals, ShipStatsHistoryPoint } from "@/api";
import type { ShipInfo } from "@/api";

export type DateRange = "1d" | "7d" | "30d" | "all";

export interface ShipTypeSummary {
  type: string;
  battles: number;
  wins: number;
  winrate: number;
  avgDamage: number;
  totalDamage: number;
  frags: number;
  ships: number;
}

export interface ModeSummary {
  label: string;
  winrate: number | null;
}

const DAY_SECONDS = 86400;

/** Range cutoff in Unix seconds — a range view covers [cutoff, now]. */
export function dateRangeCutoff(
  range: DateRange,
  nowSec: number = Math.floor(Date.now() / 1000),
): number {
  const days = range === "1d" ? 1 : range === "7d" ? 7 : 30;
  return nowSec - days * DAY_SECONDS;
}

/** Filter PlayerShipStats by a date range based on lastBattleTime.
 *  "all" returns everything; "1d/7d/30d" keep only ships whose last battle
 *  was within that many days from now.
 *
 *  CAREER FALLBACK ONLY: the kept rows still carry career totals, so this is
 *  not a real "recent N days" view — it answers "which ships were played
 *  recently". Use `computeRecentDelta` whenever an old-enough history
 *  baseline exists; views must label this fallback explicitly. */
export function filterByDateRange(
  ships: PlayerShipStats[],
  range: DateRange,
  nowSec: number = Math.floor(Date.now() / 1000),
): PlayerShipStats[] {
  if (range === "all") return ships;
  return ships.filter((s) => s.lastBattleTime >= dateRangeCutoff(range, nowSec));
}

/** A custom [from, to] day window in Unix seconds — from-day local midnight
 *  through the to day's last second. Null when either ISO string is
 *  malformed (including rollover dates like 2026-02-31) or the pair is
 *  inverted (the pickers cross-link min/max so an inverted window can never
 *  form; this is the belt-and-suspenders guard). */
export function isoDayWindowSec(
  fromIso: string,
  toIso: string,
): { fromSec: number; toSec: number } | null {
  // Date-only ISO strings parse as UTC — build the dates explicitly in the
  // local zone so the window tracks the user's calendar day.
  const localDay = (iso: string): Date | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const date = new Date(y, mo - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) {
      return null;
    }
    return date;
  };
  const from = localDay(fromIso);
  const to = localDay(toIso);
  if (!from || !to) return null;
  const fromSec = Math.floor(from.getTime() / 1000);
  // The to bound is one second before the FOLLOWING day's midnight — a flat
  // +86399 would run an hour past the to day across a spring-forward DST
  // transition (23-hour local day).
  const toSec = Math.floor(new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).getTime() / 1000) - 1;
  if (fromSec > toSec) return null;
  return { fromSec, toSec };
}

/** Career fallback for a custom [fromSec, toSec] window — same labeled
 *  CAREER FALLBACK ONLY semantics as `filterByDateRange`: rows keep career
 *  totals and answer "which ships were played in the window". */
export function filterByDateWindow(
  ships: PlayerShipStats[],
  fromSec: number,
  toSec: number,
): PlayerShipStats[] {
  return ships.filter((s) => s.lastBattleTime >= fromSec && s.lastBattleTime <= toSec);
}

/** A real "recent N days" view: per-ship deltas since a baseline point. */
export interface RecentDelta {
  /** Ships actually played in the covered window, with battles/wins/damage
   *  etc. recomputed as deltas (winrate/avgDamage derived from them). */
  ships: PlayerShipStats[];
  /** Baseline point timestamp — the latest history point at or before the
   *  cutoff. A ship whose rows there are absent or poisoned falls back to
   *  its latest healthy earlier point, so an individual ship's window may
   *  reach further back than `sinceTs`. */
  sinceTs: number;
  /** Window end actually used — the history point that closed a finite end
   *  bound, or "now" (the current rows) for the classic [cutoff, now]
   *  view. Views label the covered window from sinceTs..endTs. */
  endTs: number;
}

/** Per-ship recent-window delta — the single-ship slice of `RecentDelta`
 *  (career totals minus the totals at the ship's latest usable baseline row
 *  at or before the cutoff). Null when no old-enough baseline exists yet. */
export interface ShipRecentDelta {
  battles: number;
  wins: number;
  frags: number;
  winrate: number;
  avgDamage: number;
  avgFrags: number;
  /** Baseline point timestamp — the window actually covers [sinceTs, now]. */
  sinceTs: number;
}

/** Career-total rows recording battles but zero damage AND zero kills cannot
 *  be genuine — any played battle deals damage or scores kills. They are what
 *  a partially broken upstream returns (the 2026-09 CN vortex regression
 *  shipped `battles_count` with null counter fields). Diffing current totals
 *  against such a row resurrects the whole career total as the "recent"
 *  delta while battles stay a true small delta, inflating every range-view
 *  average by orders of magnitude — so baseline selection skips them. */
export function isPoisonedCareerRow(row: ShipCareerTotals): boolean {
  return row.battles > 0 && row.damageCaused === 0 && row.frags === 0;
}

/** Compute one ship's real recent stats: current career totals minus the
 *  totals at the latest non-poisoned history row at or before `cutoffSec`
 *  (single-ship counterpart of `computeRecentDelta`). Deltas are clamped at 0
 *  to tolerate WG-side data corrections; a zero/negative battle delta yields
 *  null (not played in the window is indistinguishable from no baseline
 *  coverage per ship). */
export function shipRecentDelta(
  current: PlayerShipStats,
  history: ShipStatsHistoryPoint[],
  cutoffSec: number,
): ShipRecentDelta | null {
  let base: ShipCareerTotals | undefined;
  let baseTs = 0;
  let latestTs = 0;
  for (const point of history) {
    if (point.timestamp > cutoffSec) continue;
    latestTs = point.timestamp;
    const row = point.ships.find((s) => s.shipId === current.shipId);
    if (row && !isPoisonedCareerRow(row)) {
      base = row;
      baseTs = point.timestamp;
    }
  }
  // No baseline point at all → unknown window (same semantics as the
  // account-level view). A baseline with no usable row for this ship — the
  // point simply lacks it, or every recorded row is poisoned — means the
  // ship was unplayed then — a full-career window, deltas = career, labeled
  // from the latest known point.
  if (latestTs === 0) return null;
  const sinceTs = base ? baseTs : latestTs;
  const battles = current.battles - (base?.battles ?? 0);
  if (battles <= 0) return null;
  const wins = Math.max(0, current.wins - (base?.wins ?? 0));
  const frags = Math.max(0, current.frags - (base?.frags ?? 0));
  const damage = Math.max(0, current.damageCaused - (base?.damageCaused ?? 0));
  return {
    battles,
    wins,
    frags,
    winrate: (wins / battles) * 100,
    avgDamage: damage / battles,
    avgFrags: frags / battles,
    sinceTs,
  };
}

/** Compute real recent stats as current career totals minus the per-ship
 *  totals at the latest non-poisoned history rows at or before `cutoffSec`
 *  (history points are recorded locally on each successful per-ship fetch,
 *  ascending by timestamp). Ships with a zero battle delta are dropped;
 *  totals are clamped at 0 to tolerate WG-side data corrections. Returns
 *  null when no baseline exists yet (first-ever lookup, or every recorded
 *  point is newer than the cutoff) — callers fall back to the labeled
 *  career view then.
 *
 *  A finite `endSec` bounds the window's end the same way (the custom
 *  range's `to` day): the latest history point at or before it closes the
 *  window instead of the current rows, so a past end day never leaks
 *  newer battles in. Without a snapshot that old the window effectively
 *  runs to now — the current rows close it, and `endTs` says so. */
export function computeRecentDelta(
  current: PlayerShipStats[],
  history: ShipStatsHistoryPoint[],
  cutoffSec: number,
  endSec: number = Number.POSITIVE_INFINITY,
): RecentDelta | null {
  let sinceTs = 0;
  const baseByShip = new Map<number, ShipCareerTotals>();
  for (const point of history) {
    if (point.timestamp > cutoffSec) continue;
    sinceTs = point.timestamp;
    // Later points overwrite earlier ones, so each ship ends up with its
    // latest usable row; a poisoned row never displaces a healthy one.
    for (const row of point.ships) {
      if (isPoisonedCareerRow(row)) continue;
      baseByShip.set(row.shipId, row);
    }
  }
  if (sinceTs === 0) return null;
  // End-of-window reference. Rows merge across every point at or before the
  // bound with poisoned rows skipped — mirroring the baseline side, so one
  // broken point cannot nuke the closing totals either. A ship absent from
  // the merged rows was unplayed at the window's end and drops out via the
  // battle-delta guard.
  let endByShip: Map<number, ShipCareerTotals> | null = null;
  let endTs = Math.floor(Date.now() / 1000);
  if (Number.isFinite(endSec)) {
    let ts = 0;
    const merged = new Map<number, ShipCareerTotals>();
    for (const point of history) {
      if (point.timestamp > endSec) continue;
      ts = point.timestamp;
      for (const row of point.ships) {
        if (isPoisonedCareerRow(row)) continue;
        merged.set(row.shipId, row);
      }
    }
    if (ts > 0) {
      endByShip = merged;
      endTs = ts;
    }
  }
  const ships: PlayerShipStats[] = [];
  for (const cur of current) {
    const prev = baseByShip.get(cur.shipId);
    // endByShip === null (no finite bound / no snapshot that old) closes at
    // the current rows — exactly the classic behavior.
    const end = endByShip ? endByShip.get(cur.shipId) : cur;
    const battles = (end?.battles ?? 0) - (prev?.battles ?? 0);
    if (battles <= 0) continue;
    const wins = Math.max(0, (end?.wins ?? 0) - (prev?.wins ?? 0));
    const damageCaused = Math.max(0, (end?.damageCaused ?? 0) - (prev?.damageCaused ?? 0));
    ships.push({
      ...cur,
      battles,
      wins,
      damageCaused,
      frags: Math.max(0, (end?.frags ?? 0) - (prev?.frags ?? 0)),
      survivedBattles: Math.max(0, (end?.survivedBattles ?? 0) - (prev?.survivedBattles ?? 0)),
      winrate: (wins / battles) * 100,
      avgDamage: damageCaused / battles,
    });
  }
  return { ships, sinceTs, endTs };
}

/** Aggregate PlayerShipStats by ship type (Battleship/Cruiser/...).
 *  Requires the encyclopedia lookup map to resolve shipId → type. */
export function aggregateByType(
  ships: PlayerShipStats[],
  byId: Map<number, ShipInfo>,
): ShipTypeSummary[] {
  const buckets = new Map<string, ShipTypeSummary>();

  for (const s of ships) {
    const info = byId.get(s.shipId);
    const type = info?.type ?? "Unknown";
    let bucket = buckets.get(type);
    if (!bucket) {
      bucket = {
        type,
        battles: 0,
        wins: 0,
        winrate: 0,
        avgDamage: 0,
        totalDamage: 0,
        frags: 0,
        ships: 0,
      };
      buckets.set(type, bucket);
    }
    bucket.battles += s.battles;
    bucket.wins += s.wins;
    bucket.totalDamage += s.damageCaused;
    bucket.frags += s.frags;
    bucket.ships += 1;
  }

  const result = [...buckets.values()];
  for (const b of result) {
    b.winrate = b.battles > 0 ? (b.wins / b.battles) * 100 : 0;
    b.avgDamage = b.battles > 0 ? b.totalDamage / b.battles : 0;
  }
  // Sort by battles descending (most-played type first).
  result.sort((a, b) => b.battles - a.battles);
  return result;
}

/** Ship type display order for consistent column rendering. */
export const SHIP_TYPE_ORDER = [
  "Battleship",
  "Cruiser",
  "Destroyer",
  "AirCarrier",
  "Submarine",
  "Unknown",
] as const;

/** Ship type short labels (for compact display). */
export const SHIP_TYPE_SHORT: Record<string, string> = {
  Battleship: "BB",
  Cruiser: "CA",
  Destroyer: "DD",
  AirCarrier: "CV",
  Submarine: "SS",
  Unknown: "?",
};
