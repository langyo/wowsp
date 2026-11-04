/**
 * Post-battle AI confidence scores — the join and weighting math behind the
 * results panel's AI score column and its AI-confidence sort.
 *
 * The data source is ONE `decision_static_report` call (E25): its roster
 * already carries every ship's whole-game agreement (the fire+move
 * combination, `whole.wholeGame` in [0, 1]) and the coverage profile
 * (`coverage.completeness` — the fraction of the ship's alive interval the
 * replay could actually resolve it: packet observability, not camera time;
 * allies sit near 1, enemies ride their spotted fraction). The panel joins
 * those entries onto its BattleResults rows by the PLAYER nickname
 * (`playerName` — `name` prefers the ship display name and cannot join).
 *
 * The sort key follows the user's weighting rule verbatim: the observable
 * ratio IS the AI weight —
 *
 *     key = coverage × aiScore + (1 − coverage) × (xp / teamXpTotal)
 *
 * 90% observable → nine parts AI to one part the game's own settlement
 * score; 100% → pure AI; 25% → a quarter AI, three quarters the star
 * share (each team normalises over its OWN roster, so both columns rank
 * independently). Rows without an entry (join miss, unscoreable ship) keep
 * coverage 0 and ride the star share alone — a missing report therefore
 * degrades to exactly the pre-AI settlement-XP order.
 */
import type { StaticReport } from "@/api/modules/decision";

/** One roster row's AI verdict, already filtered to scoreable ships
 * (entries without `whole` never enter the map — they carry no AI opinion
 * at all and must fall back to the game's own score). */
export interface AiScoreEntry {
  /** Recorder-relative team: 0 = recorder's side, 1 = enemy. */
  teamId: 0 | 1;
  isRecorder: boolean;
  /** Row-mean instant score (fire + move agreement), [0, 1]. */
  wholeGame: number;
  /** Mean fire agreement over can-fire samples; null when none. */
  wholeFire: number | null;
  /** Mean move-agreement mass, [0, 1]. */
  wholeMove: number;
  /** covered / alive over the ship's alive interval, [0, 1] — the AI
   *  weight in the sort formula. */
  coverage: number;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Player-name → AI verdict, off the E25 static report's roster. Entries
 * without a `playerName` (roster join miss) or without `whole` (nothing
 * scoreable — the exporter dropped the hull) sit out. Same-nick collisions
 * (two players in one battle sharing a nickname — vanishingly rare, the
 * game itself distinguishes them only by clan) resolve to the recorder if
 * one of them is, else the better-covered hull: a deterministic pick that
 * never silently flip-flops between renders. */
export function aiScoreMapOf(report: StaticReport): Map<string, AiScoreEntry> {
  const map = new Map<string, AiScoreEntry>();
  for (const r of report.roster) {
    if (!r.playerName || !r.whole) continue;
    const entry: AiScoreEntry = {
      teamId: r.teamId,
      isRecorder: r.isRecorder,
      wholeGame: clamp01(r.whole.wholeGame),
      wholeFire: r.whole.wholeFire,
      wholeMove: clamp01(r.whole.wholeMove),
      coverage: clamp01(r.coverage.completeness),
    };
    const prev = map.get(r.playerName);
    if (
      !prev ||
      (entry.isRecorder && !prev.isRecorder) ||
      (entry.isRecorder === prev.isRecorder && entry.coverage > prev.coverage)
    ) {
      map.set(r.playerName, entry);
    }
  }
  return map;
}

/** The recorder's own verdict (the share banner's AI line). Null when the
 * recorder has no scoreable rows — the banner then simply omits the pair. */
export function aiRecorderEntryOf(report: StaticReport): AiScoreEntry | null {
  for (const r of report.roster) {
    if (r.isRecorder && r.whole) {
      return {
        teamId: r.teamId,
        isRecorder: true,
        wholeGame: clamp01(r.whole.wholeGame),
        wholeFire: r.whole.wholeFire,
        wholeMove: clamp01(r.whole.wholeMove),
        coverage: clamp01(r.coverage.completeness),
      };
    }
  }
  return null;
}

/** The AI-confidence sort key: `coverage × aiScore + (1 − coverage) ×
 * starShare`, where starShare is the row's settlement XP over its OWN
 * team's total (the caller passes the team sum, both columns rank
 * independently). A missing entry weighs in at coverage 0 — pure star
 * share — so report misses keep the pre-AI order. A team with zero total
 * XP (all-bots co-op edge) drops the star term to 0 rather than dividing
 * by zero: the AI part then orders whatever it scored. */
export function aiWeightedKey(
  entry: AiScoreEntry | undefined,
  xp: number,
  teamXpTotal: number,
): number {
  const coverage = entry ? entry.coverage : 0;
  const ai = entry ? entry.wholeGame : 0;
  const starShare = teamXpTotal > 0 ? clamp01(xp / teamXpTotal) : 0;
  return coverage * ai + (1 - coverage) * starShare;
}

/** Whole-game agreement as the column's percentage face ("62%"). */
export function formatAiPct(v: number): string {
  return `${Math.round(clamp01(v) * 100)}%`;
}
