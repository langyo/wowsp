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
 *  `computeRecentDelta`). The plain lastBattleTime filter is kept only as the
 *  labeled career fallback for when no old-enough baseline exists yet.
 */
import type { PlayerShipStats, ShipStatsHistoryPoint } from "@/api";
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

/** A real "recent N days" view: per-ship deltas since a baseline point. */
export interface RecentDelta {
  /** Ships actually played in the covered window, with battles/wins/damage
   *  etc. recomputed as deltas (winrate/avgDamage derived from them). */
  ships: PlayerShipStats[];
  /** Baseline point timestamp — the deltas actually cover [sinceTs, now]. */
  sinceTs: number;
}

/** Compute real recent stats as current career totals minus the latest
 *  history point at or before `cutoffSec` (history points are recorded
 *  locally on each successful per-ship fetch, ascending by timestamp).
 *  Ships with a zero battle delta are dropped; totals are clamped at 0 to
 *  tolerate WG-side data corrections. Returns null when no baseline exists
 *  yet (first-ever lookup, or every recorded point is newer than the
 *  cutoff) — callers fall back to the labeled career view then. */
export function computeRecentDelta(
  current: PlayerShipStats[],
  history: ShipStatsHistoryPoint[],
  cutoffSec: number,
): RecentDelta | null {
  let base: ShipStatsHistoryPoint | undefined;
  for (const point of history) {
    if (point.timestamp <= cutoffSec) base = point;
  }
  if (!base) return null;

  const baseByShip = new Map(base.ships.map((s) => [s.shipId, s]));
  const ships: PlayerShipStats[] = [];
  for (const cur of current) {
    const prev = baseByShip.get(cur.shipId);
    const battles = cur.battles - (prev?.battles ?? 0);
    if (battles <= 0) continue;
    const wins = Math.max(0, cur.wins - (prev?.wins ?? 0));
    const damageCaused = Math.max(0, cur.damageCaused - (prev?.damageCaused ?? 0));
    ships.push({
      ...cur,
      battles,
      wins,
      damageCaused,
      frags: Math.max(0, cur.frags - (prev?.frags ?? 0)),
      survivedBattles: Math.max(0, cur.survivedBattles - (prev?.survivedBattles ?? 0)),
      winrate: (wins / battles) * 100,
      avgDamage: damageCaused / battles,
    });
  }
  return { ships, sinceTs: base.timestamp };
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
