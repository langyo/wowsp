/** The overlay's per-side row list: one row per roster player, in the
 *  believed client Tab order, split [alive] ++ [sunk] by the side's
 *  TRUSTED sunk set so the list mirrors the game's own mid-battle regroup
 *  and every sunk member is flagged for the dim pass.
 *
 *  This replaced the old per-row attribution machinery (candidate ranges
 *  over the anchor's alive vector): the display is its own standing list —
 *  every line IS one known player, with the nickname rendered beside the
 *  numbers — so there is nothing left to attribute, and a side without a
 *  trusted set simply keeps the full order un-flagged. The flag is a claim
 *  about a KNOWN sunk set, never a guess. */

/** One line of a side's display list. */
export interface RosterRow {
  name: string;
  sunk: boolean;
}

/** Split the believed full order by sunk membership: the alive block
 *  first (order preserved), then the sunk block. `sunkSet` null (the
 *  solver degraded on a sink it could not explain) keeps the full order
 *  with nothing flagged. */
export function splitRowsBySunk(
  full: readonly string[],
  sunkSet: ReadonlySet<string> | null,
): RosterRow[] {
  if (sunkSet == null) return full.map((name) => ({ name, sunk: false }));
  return [
    ...full.filter((name) => !sunkSet.has(name)).map((name) => ({ name, sunk: false })),
    ...full.filter((name) => sunkSet.has(name)).map((name) => ({ name, sunk: true })),
  ];
}
