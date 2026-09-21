/** Winrate color tiers — mirrors ApeRadar / competitive WoWS community convention.
 *  Red < 47% → yellow 47-50% → green 50-55% → purple > 55%. */

import { t } from "@/i18n";
import { statsPrefsState } from "@/stores/statsPrefs";

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

/** Standard English tier wording for `localizedTiers: false` — the
 *  wows-numbers band vocabulary instead of the fun localized flavor
 *  (拉完了/夯/战舰仙人…) that lives in res/i18n `stats.json`. Front-end
 *  constants by design: the wording must NOT follow the UI locale when the
 *  user asked for the neutral scale. `unknown` renders the same "—" the
 *  localized path uses (there is no `stats.unknown` key — every consumer
 *  hardcodes the em dash for a missing rating). */
export const PR_TIER_STANDARD_LABELS: Record<string, string> = {
  tierBad: "Bad",
  tierBelowAvg: "Below Average",
  tierAvg: "Average",
  tierGood: "Good",
  tierGreat: "Great",
  tierUnicum: "Unicum",
  unknown: "—",
};

/** Display label for a PR tier key: the localized flavor wording or the
 *  standard English band word, per the stats prefs. Reads the prefs ref
 *  directly so a settings toggle re-renders every consumer, and routes
 *  through `t` inside the caller's render context so locale switches do
 *  too. Colors/rainbow stay tied to prTier() and never follow this knob. */
export function prTierLabel(key: string): string {
  if (!statsPrefsState.value.localizedTiers) {
    return PR_TIER_STANDARD_LABELS[key] ?? PR_TIER_STANDARD_LABELS.unknown;
  }
  return key === "unknown" ? "—" : t(`stats.${key}`);
}

/** Clan aggregate winrate above which a hidden profile is EXCUSED from the
 *  过街老鼠 stamp (percent 0–100, same scale as `ClanInfo.winrate`): a clan
 *  this strong makes the hidden profile read as privacy, not as hiding a
 *  bad career. Below or at the threshold — or with no verdict at all — the
 *  stamp stays on (fail-open). */
export const RAT_CLAN_WINRATE_MAX = 53;

export type CareerStamp = "miracle" | "ape" | "maggot" | "rat";

/** Composition stamps (ApeRadar's 成分 tags): 空中小人 marks CV mains, 水下小人
 *  marks submarine mains. Independent of the PR verdicts — a player can carry
 *  both a career stamp and a composition stamp. */
export type CompositionStamp = "air" | "sub";

export type StampKind = CareerStamp | CompositionStamp;

/** Career verdict stamps: a red-tier career earns the 海猴 mark — or the 蛆
 *  mark when the winrate is also sub-40% (a red-tier red-WR career is a
 *  different beast); a sustained purple-tier+ career earns 神了 — gated on
 *  500+ battles, ApeRadar's unicum battle-count threshold ("长期" 紫表, not a
 *  short hot streak). A hidden profile earns the 过街老鼠 mark no matter
 *  what — there are no stats to grade, and hiding is the tell — unless the
 *  clan gate excuses it: when `clanWinrate` carries the player's clan's
 *  aggregate winrate and it beats RAT_CLAN_WINRATE_MAX, the clan is strong
 *  enough that the hidden profile is not read as hiding a bad career and no
 *  stamp is earned. Fail-open: a missing (`undefined`) or failed (`null`)
 *  clan verdict never suppresses the stamp — only a RESOLVED strong-clan
 *  verdict does. An unknown winrate falls back to 海猴. Null when no stamp
 *  applies. */
export function careerStamp(
  pr: number | null | undefined,
  battles: number | null | undefined,
  winrate: number | null | undefined,
  hidden = false,
  clanWinrate?: number | null,
): CareerStamp | null {
  if (hidden && clanWinrate != null && clanWinrate > RAT_CLAN_WINRATE_MAX) return null;
  if (hidden) return "rat";
  if (pr == null) return null;
  if (pr >= 2100) return battles != null && battles >= 500 ? "miracle" : null;
  if (pr < 750) return winrate != null && winrate < 40 ? "maggot" : "ape";
  return null;
}

export interface CompositionStamps {
  air: boolean;
  sub: boolean;
}

/** 空中小人 / 水下小人 criteria (user-defined): CV (resp. SS) battles must
 *  exceed 20% of the player's career battles, with a career total above 200
 *  battles so a fresh account's first CV foray doesn't earn the mark.
 *  `ships` is the player's full per-ship stat list; `typeOf` resolves the
 *  ship type (encyclopedia first, offline DB fallback). Career-level tags:
 *  they render on the account card only, never on a single ship's page. */
export function compositionStamps(
  ships: { shipId: number; battles: number }[],
  typeOf: (shipId: number) => string | null | undefined,
  minBattles = 200,
  minShare = 0.2,
): CompositionStamps {
  let career = 0;
  let air = 0;
  let sub = 0;
  for (const s of ships) {
    career += s.battles;
    const t = typeOf(s.shipId);
    if (t === "AirCarrier") air += s.battles;
    else if (t === "Submarine") sub += s.battles;
  }
  if (career <= minBattles) return { air: false, sub: false };
  return { air: air / career > minShare, sub: sub / career > minShare };
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
