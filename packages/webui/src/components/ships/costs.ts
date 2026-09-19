/** Build-cost math for the planner's 成本计算 panel.
 *
 *  Upgrade prices come straight from the install's GameParams.data via the
 *  `get_upgrade_prices` command (exact, version-synced). Commander skill
 *  points have no per-item price — training a captain costs cumulative
 *  commander XP per the official wiki's skill-point table (current economy:
 *  685,500 CXP buys all 21 points); retraining is estimated at the familiar
 *  100,000-credits-per-point rate and surfaced as an estimate, not a fact. */

import type { UpgradePrice } from "@/api";

/** Cumulative commander XP needed to own each skill point (1-based index =
 *  point number). Source: official wiki Ship:Commander skill-point table. */
export const SKILL_POINT_CXP: readonly number[] = [
  1_500, 2_500, 4_500, 7_500, 11_500, 16_500, 22_500, 29_500, 37_500, 46_500, 68_500, 91_500,
  121_500, 155_500, 195_500, 245_500, 305_500, 380_500, 470_500, 570_500, 685_500,
];

/** Cumulative CXP to reach `points` skill points (clamped to the table). */
export function cxpForPoints(points: number): number {
  if (points <= 0) return 0;
  return SKILL_POINT_CXP[Math.min(points, SKILL_POINT_CXP.length) - 1] ?? 0;
}

/** Retraining estimate: 100,000 credits per skill point. Documented as an
 *  estimate in the UI — WG doesn't expose this through any API. */
export const RETRAIN_CREDITS_PER_POINT = 100_000;

export function retrainCredits(points: number): number {
  return points * RETRAIN_CREDITS_PER_POINT;
}

/** Price lookup: builds store full entity names (PCM027_Concealment…), the
 *  price map carries both the index and the full name as keys. */
export function priceOf(
  prices: Record<string, UpgradePrice> | null,
  name: string,
): number | null {
  if (!prices) return null;
  const hit = prices[name] ?? prices[name.split("_")[0]];
  return typeof hit?.cost === "number" && hit.cost > 0 ? hit.cost : null;
}
