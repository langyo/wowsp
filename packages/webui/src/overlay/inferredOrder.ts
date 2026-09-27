/**
 * Rule-inferred row→name mapping for the in-game overlay ("inferred" roster
 * mode — the default).
 *
 * The Rust watcher supplies the row GRID and the per-row alive flags (pure
 * luma — no text recognition); this module turns the arena roster into the
 * names for those rows by applying the game's own verified Tab sort rule:
 *
 *     [alive ships] ++ [sunk ships], each block by
 *     class rank, then tier descending
 *
 * shared with the live panel's predicted order via
 * `utils/shipClass#tabOrderCompare`.
 *
 * What the rule can and cannot pin down, exactly:
 *
 * - ALL-SINGLETON side (no two ships share class+tier): the rule is a total
 *   order — every row maps to its player, alive/sunk split included.
 * - BATTLE START (no sinks): the alive block is the whole side; every row
 *   whose (class, tier) group has a single member is pinned; multi-member
 *   groups yield CANDIDATE SET rows — every row of the group carries the
 *   group's full member list, because those rows collectively hold exactly
 *   those players (their internal order is the unknowable residue). The
 *   page renders such a row as one chip listing every member's winrate —
 *   the honest "these rows ARE these players" answer that still puts real
 *   numbers on screen when a whole side shares one class+tier (brawl teams
 *   are the extreme: every row would otherwise be an anonymous dot).
 * - SINKS + any multi-member group on the side: unknowable, and not just
 *   within the group. The luma vector gives row COUNTS, not identities —
 *   "the tier-7 BB pair lost one member" and "the lone DD next to them
 *   sank instead" read byte-identical flags ([T,T,T,F]), yet they regroup
 *   the table into different row sets, shifting every row after the pair.
 *   With a sink anywhere on the side and a tie group anywhere on it, NO
 *   row is provable and no per-row candidate set survives the possible
 *   worlds either, so the whole side yields `null` rows rather than a
 *   50/50 guess that pins the wrong player's stats on a chip (verified
 *   against full battle rosters: neither ship id, entity id, nation, join
 *   order nor localized-name collation reproduces the game's within-group
 *   pick — the information simply is not in the arena file). Exact
 *   attribution at any battle stage stays available via the OCR roster
 *   mode.
 */
import { shipClassRank, shipTierWeight, tabOrderCompare } from "@/utils/shipClass";

/** The roster entry shape the mapping needs (the wire's `VehicleEntry`). */
export interface InferredVehicle {
  name: string;
  relation: number;
  shipId: number;
}

/** (class, tier) group key — equality is all the grouping needs; the
 *  comparator above stays the authority for the ORDER between groups. */
function groupKey(v: InferredVehicle): string {
  return `${shipClassRank(v.shipId)}:${shipTierWeight(v.shipId)}`;
}

/** Consecutive (class, tier) runs of the rule-ordered side. Members of a
 *  group are guaranteed adjacent: the comparator's primary keys are exactly
 *  this key. */
function groupRuns(ordered: InferredVehicle[]): InferredVehicle[][] {
  const runs: InferredVehicle[][] = [];
  for (const v of ordered) {
    const last = runs[runs.length - 1];
    if (last && groupKey(last[0]) === groupKey(v)) last.push(v);
    else runs.push([v]);
  }
  return runs;
}

/** One row's attribution:
 *  - a `string` pins the row to that player (a rule-provable row);
 *  - a `string[]` is a CANDIDATE SET — a (class, tier) tie group the rule
 *    cannot order within: the group's rows collectively hold exactly these
 *    players, one per row, order unknown (every row of the group carries
 *    the same full list);
 *  - `null` is honest silence — nothing provable, not even a set (a whole
 *    side once sinks meet a tie group), or a row beyond the roster. */
export type RowAttribution = string | string[] | null;

/**
 * Map the roster onto the detected rows: allies block first, enemies after,
 * each side ordered [alive by rule] ++ [sunk by rule]. `alive` is the
 * anchor's per-row alive vector aligned with the row grid (null = unknown —
 * every row reads alive, the battle-start state); entry `k` of the result
 * is row `k`'s attribution (see {@link RowAttribution}). Rows beyond the
 * roster's size (the watcher pads the grid to the team size) yield `null`
 * and render as dots.
 */
export function inferredRowMapping(
  vehicles: InferredVehicle[],
  alive: boolean[] | null,
): RowAttribution[] {
  const out: RowAttribution[] = [];
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
    // This side's alive flags, aligned with OUR predicted positions. With
    // an all-singleton side our layout IS the game's layout, so the flags
    // transfer 1:1; at battle start every row reads alive anyway. Unknown
    // → alive (the battle-start state).
    const flags = ordered.map((_, i) => alive?.[offset + i] ?? true);
    const runs = groupRuns(ordered);
    const hasTie = runs.some((run) => run.length > 1);
    const sunkCount = flags.filter((f) => !f).length;

    if (hasTie && sunkCount > 0 && sunkCount < ordered.length) {
      // Sinks met a tie group: no row's identity survives the possible
      // regroupings (see the module docs) — the whole side goes anonymous
      // instead of pinning stats on 50/50 guesses. (An ALL-sunk side is
      // exempt: the layout collapses to the rule order alone, provable
      // like battle start.)
      for (const _v of ordered) out.push(null);
    } else if (!hasTie) {
      // All-singleton side: the rule is a total order, our layout is the
      // game's layout — emit [alive] ++ [sunk] verbatim.
      for (const v of ordered.filter((_, i) => flags[i])) out.push(v.name);
      for (const v of ordered.filter((_, i) => !flags[i])) out.push(v.name);
    } else {
      // Battle start with tie groups (or the all-sunk end state — same
      // collapsed rule order): singletons are pinned, tie-group rows carry
      // the group's full member list — those rows ARE those players, one
      // per row, with only the internal order unknowable.
      for (const run of runs) {
        if (run.length > 1) {
          const candidates = run.map((v) => v.name);
          for (const _v of run) out.push([...candidates]);
        } else {
          out.push(run[0].name);
        }
      }
    }
    offset += ordered.length;
  }
  return out;
}
