/**
 * Rule-inferred row→name mapping for the in-game overlay ("inferred" roster
 * mode — the default).
 *
 * The Rust watcher supplies the row GRID and the per-row alive flags (pure
 * luma — no text recognition); this module turns the arena roster into the
 * names for those rows by applying the game's own verified Tab sort rule:
 *
 *     [alive ships] ++ [sunk ships], each block by
 *     class rank, then tier descending, then ship id (same-ship players
 *     adjacent — the classic division)
 *
 * shared with the live panel's predicted order via
 * `utils/shipClass#tabOrderCompare`. The mapping is EXACT for everything
 * the closed set + the verified rule determine; the unknowable residue —
 * the order WITHIN a (class, tier, alive-state) group — follows the ship-id
 * tiebreak and can there differ from the game's pick, swapping two same-class
 * same-tier same-state players' chips. The OCR mode exists for when that
 * residue matters.
 *
 * Pure functions only — unit-tested without frames or Tauri.
 */
import { shipClassRank, shipTierWeight, tabOrderCompare } from "@/utils/shipClass";

/** The roster entry shape the mapping needs (the wire's `VehicleEntry`). */
export interface InferredVehicle {
  name: string;
  relation: number;
  shipId: number;
}

/**
 * Map the roster onto the detected rows: allies block first, enemies after,
 * each side ordered [alive by rule] ++ [sunk by rule]. `alive` is the
 * anchor's per-row alive vector aligned with the row grid (null = unknown —
 * every row reads alive, the battle-start state); entry `k` of the result
 * names the player of row `k`. Rows beyond the roster's size (the watcher
 * pads the grid to the team size) yield `null` and render as dots, same as
 * the OCR mode's unmatched rows.
 */
export function inferredRowMapping(
  vehicles: InferredVehicle[],
  alive: boolean[] | null,
): (string | null)[] {
  const out: (string | null)[] = [];
  let offset = 0;
  for (const list of [
    vehicles.filter((v) => v.relation <= 1),
    vehicles.filter((v) => v.relation > 1),
  ]) {
    const ordered = list
      .map((v, i) => ({ v, i }))
      .sort(
        (a, b) =>
          tabOrderCompare(shipClassRank, shipTierWeight)(a.v, b.v) || a.i - b.i,
      )
      .map(({ v }) => v);
    // This side's alive flags, aligned with OUR predicted positions (the
    // luma probe reads the row the game renders; group structure is part of
    // the verified rule, so position k means the same player on both sides
    // — except within a (class, tier) tie, where the flags are equal
    // anyway). Unknown → alive (the battle-start state).
    const flags = ordered.map((_, i) => alive?.[offset + i] ?? true);
    for (const v of ordered.filter((_, i) => flags[i])) out.push(v.name);
    for (const v of ordered.filter((_, i) => !flags[i])) out.push(v.name);
    offset += ordered.length;
  }
  return out;
}
