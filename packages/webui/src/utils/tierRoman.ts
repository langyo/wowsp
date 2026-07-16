/**
 * WoWS ship tier → Roman numeral formatting.
 *
 * The game's tech tree spans tiers 1–10, shown in-game and in the official
 * client as Roman numerals (I … X). We mirror that everywhere the detail
 * header / titles display a tier, so a Tier-9 ship reads "IX 密苏里" rather
 * than the generic "Tier 9".
 *
 * Out-of-range tiers (shouldn't occur, but defensive) fall back to the plain
 * Arabic numeral so the UI never shows "undefined".
 */

/** Roman numerals indexed by tier (index 0 is unused — tiers are 1-based). */
const TIER_ROMAN = [
  "",       // 0 — unused
  "I",      // 1
  "II",     // 2
  "III",    // 3
  "IV",     // 4
  "V",      // 5
  "VI",     // 6
  "VII",    // 7
  "VIII",   // 8
  "IX",     // 9
  "X",      // 10
  "★",     // 11 — superships
];

/** Convert a WoWS tier (1–11) to its Roman numeral (or ★ for 11).
 *  Falls back to the Arabic numeral as a string for any value outside range. */
export function tierToRoman(tier: number): string {
  const t = Math.trunc(tier);
  if (t >= 0 && t < TIER_ROMAN.length) {
    return TIER_ROMAN[t];
  }
  return String(tier);
}
