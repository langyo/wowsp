/**
 * Per-battle sunk-player tracking — the frontend half of the sink
 * attribution pipeline.
 *
 * The Rust sink fast-path solves WHO sank by fingerprint-matching the Tab
 * table's name strips across the transition (`wowsp://sink-attrib`:
 * pre-sink alive-row indices per side). This tracker turns those row
 * indices into NAMES against the consumer's own layout — the decompiled
 * Tab sort key (utils/shipClass) keeps each side's alive order exact at
 * battle start — and then answers the one question every renderer has:
 * "is this side's sunk set TRUSTED right now?"
 *
 * The state machine per side is one-way within a battle:
 *
 * - EXACT from battle start (empty sunk set);
 * - a sink event whose rows all resolve against the current alive order
 *   keeps it EXACT (the named players join the sunk set);
 * - anything the solver could not explain — an event with a row out of
 *   range, or an anchor whose alive-count disagrees with the set —
 *   DEGRADES the side for the rest of the battle: the renderer falls back
 *   to candidate ranges rather than guessing (a missed sink cannot be
 *   recovered from, because later row indices are only meaningful against
 *   the layout the missed sink produced).
 *
 * A battle switch resets both sides to EXACT.
 */
export type SunkSide = "ally" | "enemy";

interface SideState {
  sunk: Set<string>;
  exact: boolean;
}

export class SunkTracker {
  private battle: string | null = null;
  private readonly sides: Record<SunkSide, SideState> = {
    ally: { sunk: new Set(), exact: true },
    enemy: { sunk: new Set(), exact: true },
  };

  /** Bind to a battle (its `dateTime` identity). A different battle resets
   *  both sides; the same battle is a no-op. `null` clears everything. */
  reset(battle: string | null): void {
    if (battle === this.battle) return;
    this.battle = battle;
    for (const s of Object.values(this.sides)) {
      s.sunk.clear();
      s.exact = true;
    }
  }

  /** Resolve one sink event's row indices into names, against the given
   *  side's CURRENT (pre-event) alive order. `aliveOrderOf` must return
   *  the side's believed alive layout in row order (the sort-key order
   *  minus the current sunk set). Any unresolvable row — or an event
   *  arriving while the side is already degraded — degrades the side. */
  applyAttribution(
    rowsBySide: { ally?: number[]; enemy?: number[] },
    aliveOrderOf: (side: SunkSide) => string[],
  ): void {
    for (const side of ["ally", "enemy"] as const) {
      const rows = rowsBySide[side] ?? [];
      if (rows.length === 0) continue; // no attribution: the next reconcile decides
      const state = this.sides[side];
      if (!state.exact) continue;
      const order = aliveOrderOf(side);
      const names = rows.map((r) => order[r]);
      if (names.some((n) => n == null)) {
        state.exact = false;
        continue;
      }
      for (const n of names) state.sunk.add(n);
    }
  }

  /** Cross-check the sunk set against what the anchor's alive vector says
   *  (the side's sunk-row count). A disagreement — a sink the solver never
   *  explained, or a revive — degrades the side for the battle. */
  reconcile(side: SunkSide, sunkCount: number): void {
    const state = this.sides[side];
    if (state.exact && state.sunk.size !== sunkCount) {
      state.exact = false;
    }
  }

  /** The side's trusted sunk set, or NULL once degraded — callers render
   *  candidate ranges instead of guessing. */
  sunkNames(side: SunkSide): Set<string> | null {
    return this.sides[side].exact ? this.sides[side].sunk : null;
  }

  /** Whether a named player is (trusted-)sunk; false when unknown or the
   *  side is degraded (the set is then untrusted residue). */
  isSunk(side: SunkSide, name: string): boolean {
    return this.sides[side].exact && this.sides[side].sunk.has(name);
  }
}
