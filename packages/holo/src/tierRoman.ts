/** WoWS ship tier → Roman numeral (I–X, ★ for superships). */
const TIER_ROMAN = [
  "", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "★",
];

export function tierToRoman(tier: number): string {
  const t = Math.trunc(tier);
  if (t >= 0 && t < TIER_ROMAN.length) return TIER_ROMAN[t];
  return String(tier);
}
