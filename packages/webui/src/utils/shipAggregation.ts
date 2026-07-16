/** Ship-type aggregation + date-range filtering utilities.
 *
 *  The WG API returns flat per-ship PvP stats (PlayerShipStats[]). This module
 *  derives the higher-level views a stats page needs:
 *    - Per-ship-type summary (battles/wins/winrate/avgDamage by BB/CA/DD/CV/SS)
 *    - Date-range filtering via lastBattleTime (1d/7d/30d/all-time)
 *    - Per-mode breakdown from the account-level division winrates
 *
 *  Ship-type is resolved by joining shipId → encyclopedia ShipInfo.type.
 */
import type { PlayerShipStats } from "@/api";
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

/** Filter PlayerShipStats by a date range based on lastBattleTime.
 *  "all" returns everything; "1d/7d/30d" keep only ships whose last battle
 *  was within that many days from now. */
export function filterByDateRange(
  ships: PlayerShipStats[],
  range: DateRange,
  nowSec: number = Math.floor(Date.now() / 1000),
): PlayerShipStats[] {
  if (range === "all") return ships;
  const days = range === "1d" ? 1 : range === "7d" ? 7 : 30;
  const cutoff = nowSec - days * DAY_SECONDS;
  return ships.filter((s) => s.lastBattleTime >= cutoff);
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
