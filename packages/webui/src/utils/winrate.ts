/** Winrate color tiers — mirrors ApeRadar / competitive WoWS community convention.
 *  Red < 47% → yellow 47-50% → green 50-55% → purple > 55%. */

export type WinrateTier = "red" | "yellow" | "green" | "purple";

export function winrateTier(wr: number | null | undefined): WinrateTier {
  if (wr == null) return "red";
  if (wr >= 55) return "purple";
  if (wr >= 50) return "green";
  if (wr >= 47) return "yellow";
  return "red";
}

export function winrateColor(wr: number | null | undefined): string {
  switch (winrateTier(wr)) {
    case "purple": return "rgb(168 85 247)";
    case "green": return "rgb(71 227 165)";
    case "yellow": return "rgb(230 170 50)";
    case "red": return "rgb(220 80 80)";
  }
}

/** PR tier bands — ApeRadar's 8-color scheme (wows-numbers convention)
 *  collapsed to six bands. The backend maps ApeRadar's winrate color lines
 *  (47/52/56/60/65%) onto 750/1350/1750/2100/2450, so band N here is band N
 *  there. 战舰仙人 (≥2450) is the 彩表 tier and renders as rainbow text. */
export interface PrTier {
  /** `stats`-namespace i18n key ("tierBad" … "tierUnicum"), or "unknown". */
  key: string;
  color: string;
  /** 战舰仙人 band — render with the rainbow 彩表 gradient, not a solid color. */
  rainbow?: boolean;
}

export function prTier(pr: number | null | undefined): PrTier {
  if (pr == null) return { key: "unknown", color: "rgb(150 160 175)" };
  if (pr >= 2450) return { key: "tierUnicum", color: "rgb(160 13 197)", rainbow: true };
  if (pr >= 2100) return { key: "tierGreat", color: "rgb(208 66 243)" };
  if (pr >= 1750) return { key: "tierGood", color: "rgb(2 201 179)" };
  if (pr >= 1350) return { key: "tierAvg", color: "rgb(68 179 0)" };
  if (pr >= 750) return { key: "tierBelowAvg", color: "rgb(255 199 31)" };
  return { key: "tierBad", color: "rgb(254 14 0)" };
}

export type CareerStamp = "miracle" | "ape";

/** ApeRadar's 成分 tags as career verdict stamps: a red-tier career earns the
 *  海猴 mark; a sustained purple-tier+ career earns 神了 — gated on 500+
 *  battles, ApeRadar's unicum battle-count threshold ("长期" 紫表, not a
 *  short hot streak). Null when no stamp applies. */
export function careerStamp(
  pr: number | null | undefined,
  battles: number | null | undefined,
): CareerStamp | null {
  if (pr == null) return null;
  if (pr >= 2100) return battles != null && battles >= 500 ? "miracle" : null;
  if (pr < 750) return "ape";
  return null;
}

/** Average-damage color tiers — rough absolute buckets for overall account
 *  avg damage, tuned for tier VIII–X randoms (ship-agnostic, so treat as a
 *  skill hint rather than a ship-grade verdict). */
export function damageColor(avg: number | null | undefined): string {
  if (avg == null) return "rgb(150 160 175)";
  if (avg >= 85000) return "rgb(168 85 247)";
  if (avg >= 50000) return "rgb(71 227 165)";
  if (avg >= 25000) return "rgb(230 170 50)";
  return "rgb(220 80 80)";
}
