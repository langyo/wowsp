/** Ranked-battle aggregation helpers shared by the stats card and the
 *  season-timeline modal. */
import type { RankedLeagueTiers, RankedSeasonStats } from "@/api";

/** Best-rank league metals, in HoK-timeline spirit: each timeline node is
 *  tinted with the metal its season's best rank reached. */
export type RankedLeague = "gold" | "silver" | "bronze";

/** League of the backend's numeric league number (1 = Gold, 2 = Silver,
 *  3 = Bronze); null for anything else. */
export function leagueFromNumber(
  league: number | null | undefined,
): RankedLeague | null {
  if (league === 1) return "gold";
  if (league === 2) return "silver";
  if (league === 3) return "bronze";
  return null;
}

/** Tier window [lo, hi] one league designates within a season's league
 *  metadata; null when the season carries no window for it (the metadata
 *  is missing or the league never existed that season). */
export function leagueTierWindow(
  leagues: RankedLeagueTiers[] | null | undefined,
  league: number,
): [number, number] | null {
  const hit = leagues?.find((l) => l.league === league);
  return hit ? [hit.minTier, hit.maxTier] : null;
}

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

/** League of a backend rank display ("Gold 3" → gold); null when the
 *  display is absent or names no known metal. */
export function rankLeague(
  bestRankDisplay: string | null | undefined,
): RankedLeague | null {
  if (!bestRankDisplay) return null;
  const l = bestRankDisplay.trim().toLowerCase();
  if (l.startsWith("gold")) return "gold";
  if (l.startsWith("silver")) return "silver";
  if (l.startsWith("bronze")) return "bronze";
  return null;
}

/** Season number for the "S30"-style timeline tag: the trailing number of
 *  the season name ("Season 30"), falling back to the backend's id
 *  convention (season id − 1000) when the name carries none. */
export function seasonNumber(season: Pick<RankedSeasonStats, "seasonId" | "seasonName">): number {
  const m = /(\d+)\s*$/.exec(season.seasonName);
  if (m) return Number(m[1]);
  return season.seasonId - 1000;
}
