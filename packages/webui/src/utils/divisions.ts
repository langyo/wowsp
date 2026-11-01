/**
 * Division (组队) lettering for the roster surfaces: players who queued as
 * a division share one prebattle id, and every member carries the same
 * letter tag (组队A / 组队B / …) in front of the nickname — the game's own
 * results screen numbers divisions the same way.
 *
 * Letters are assigned per CALL and follow the input's first-appearance
 * order, so a panel letters each side independently over its DISPLAYED
 * rows (both sides start at A) and the tags read top-down exactly like
 * the rows they ride. The join key is the nickname — the one identity
 * both the telemetry and the arena file carry.
 *
 * A falsy division id (0 / absent / null) is a SOLO player — the game
 * reports 0 outside divisions — and never gets lettered. The sequence is
 * the spreadsheet-column one (A..Z, then AA, AB, …), capped at 52 letters
 * as a paranoid guard: a roster cannot field 53 divisions (24 players at
 * 2-3 per division), so reaching the cap means corrupt input, and the
 * surplus groups simply stay unlettered instead of growing the tag faces
 * unbounded.
 */

/** One roster entry for the lettering pass: the nickname plus its optional
 *  division id (falsy / null / absent = solo). */
export interface DivisionEntry {
  name: string;
  div?: number | null;
}

/** Spreadsheet-column letters: 0 = "A", 25 = "Z", 26 = "AA", 27 = "AB"…. */
function divisionLetter(index: number): string {
  let out = "";
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) {
    out = String.fromCharCode(65 + (n % 26)) + out;
  }
  return out;
}

/**
 * Letter every division of `entries` in first-appearance order. Returns
 * name → letter for DIVISION members only — solo rows (falsy `div`) are
 * absent, so a lookup miss renders no tag. Divisions past the 52-letter
 * cap stay unlettered wholesale (see the module docs): the guard exists
 * for corrupt input, not for display.
 */
export function divisionLetters(
  entries: readonly DivisionEntry[],
): Map<string, string> {
  const letters = new Map<string, string>();
  const byDiv = new Map<number, string>();
  let count = 0;
  for (const entry of entries) {
    if (!entry.div) continue; // 0 / null / absent = solo — never lettered
    let letter = byDiv.get(entry.div);
    if (letter === undefined) {
      if (count >= 52) continue; // paranoid overflow guard (module docs)
      letter = divisionLetter(count++);
      byDiv.set(entry.div, letter);
    }
    letters.set(entry.name, letter);
  }
  return letters;
}
