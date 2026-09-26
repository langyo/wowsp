/**
 * Team-level roster aggregates for the live-battle columns: one winrate +
 * one mean PR per team, rendered beside the 我方/敌方 column titles (only
 * while the PR rating is on).
 *
 * The weighted mode leans on the ship's tier — a higher-tier hull speaks
 * louder about the battle's balance (both its carry potential and its
 * expected impact are larger), so each player's winrate enters the mean
 * with weight = tier (a T10 counts double a T5, supers' T11 the most).
 * Ships the offline DB does not know take the mean known weight, which
 * lands exactly on the weighted center — present in the aggregate, silent
 * on its lean. The plain mode is the ordinary arithmetic mean. The mean PR
 * is always plain: the rating is already a career-long synthesis.
 */
export interface TeamStatEntry {
  /** Career winrate in percent; null = no data (AI, hidden, still loading). */
  winrate: number | null;
  /** Career PR (per the active rating algorithm); null = no data. */
  pr: number | null;
  /** Ship tier 1–11; null = ship unknown to the offline DB. */
  tier: number | null;
}

export interface TeamAggregate {
  /** Tier-weighted (or plain, per the mode) mean winrate, percent. */
  winrate: number | null;
  /** Arithmetic mean PR over the players that have one. */
  avgPr: number | null;
  /** How many players' winrates entered the aggregate. */
  counted: number;
}

export function aggregateTeamStats(
  entries: TeamStatEntry[],
  weighted: boolean,
): TeamAggregate {
  const rated = entries.filter(
    (e): e is TeamStatEntry & { winrate: number } => e.winrate != null,
  );
  const prRated = entries.filter(
    (e): e is TeamStatEntry & { pr: number } => e.pr != null,
  );
  if (rated.length === 0) {
    return {
      winrate: null,
      avgPr:
        prRated.length > 0
          ? prRated.reduce((a, e) => a + e.pr, 0) / prRated.length
          : null,
      counted: 0,
    };
  }
  const tiers = rated
    .map((e) => e.tier)
    .filter((t): t is number => t != null);
  // Unknown-tier neutral weight: the mean known tier (1 when none is
  // known), so a DB miss neither inflates nor deflates the aggregate.
  const neutral =
    tiers.length > 0 ? tiers.reduce((a, b) => a + b, 0) / tiers.length : 1;
  let sum = 0;
  let weight = 0;
  for (const e of rated) {
    const w = weighted ? (e.tier ?? neutral) : 1;
    sum += e.winrate * w;
    weight += w;
  }
  return {
    winrate: sum / weight,
    avgPr:
      prRated.length > 0
        ? prRated.reduce((a, e) => a + e.pr, 0) / prRated.length
        : null,
    counted: rated.length,
  };
}
