/** Ranked-battle aggregation — combined winrate across the loaded seasons. */
import type { RankedSeasonStats } from "@/api";

/** Combined ranked winrate (%) over all seasons; null when no battles. */
export function aggregateRankedWinrate(seasons: RankedSeasonStats[]): number | null {
  let battles = 0;
  let wins = 0;
  for (const s of seasons) {
    battles += s.battles;
    wins += s.wins;
  }
  if (battles === 0) return null;
  return (wins / battles) * 100;
}
