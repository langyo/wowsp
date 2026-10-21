/** The team-averages line's comparative tone decision, shared by both
 *  sides' summary cards (overlay/main.ts teamSummaryCard).
 *
 *  Per metric the higher SETTLED side's figure goes green and the lower
 *  red — the same winrate-tier pair the roster numbers grade by. A tone
 *  is a verdict, and a verdict needs both figures final: equal figures,
 *  a missing one (the honest "—" of a profile that never landed), or a
 *  side still loading ALL hold the warm accent. The loading gate covers
 *  BOTH ends — the card's own dots (its figures are not even shown yet)
 *  and, just as much, the opposing side still owing rows: its mean is a
 *  partial average over the players landed so far, and coloring against
 *  it would paint a verdict that flips as the rest of the roster
 *  arrives — the exact "reads as a verdict, then shifts" lie the loading
 *  dots exist to prevent (see teamAggregateFor). */

/** `hi` = this side's figure is the higher settled one (green), `lo` =
 *  the lower (red), `""` = no tone (the warm accent stands). */
export type TeamAvgTone = "overlay-intel-b--hi" | "overlay-intel-b--lo" | "";

/** Compare one metric across the two cards. `mine` / `theirs` are the
 *  settled aggregate figures (null = not landed); `anyLoading` is the OR
 *  of the two sides' loading flags — either one owing rows suppresses the
 *  tone. */
export function teamAvgTone(
  mine: number | null,
  theirs: number | null,
  anyLoading: boolean,
): TeamAvgTone {
  if (anyLoading || mine == null || theirs == null || mine === theirs) return "";
  return mine > theirs ? "overlay-intel-b--hi" : "overlay-intel-b--lo";
}
