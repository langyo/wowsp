/** Tests for the overlay's per-side row list (rowList.ts): the believed
 *  Tab order split [alive] ++ [sunk] by the side's trusted sunk set, so the
 *  drawn list mirrors the game's own mid-battle regroup — and an untrusted
 *  side keeps the full order with nothing flagged (the flag is a claim
 *  about a KNOWN sunk set, never a guess). */
import { describe, expect, it } from "vitest";

import { splitRowsBySunk } from "./rowList";

describe("splitRowsBySunk", () => {
  it("moves the sunk members to the tail, preserving the order inside both blocks", () => {
    const full = ["A", "B", "C", "D"];
    expect(splitRowsBySunk(full, new Set(["B", "D"]))).toEqual([
      { name: "A", sunk: false },
      { name: "C", sunk: false },
      { name: "B", sunk: true },
      { name: "D", sunk: true },
    ]);
  });

  it("keeps the full order un-flagged when the set is untrusted (null)", () => {
    const full = ["A", "B", "C"];
    expect(splitRowsBySunk(full, null)).toEqual([
      { name: "A", sunk: false },
      { name: "B", sunk: false },
      { name: "C", sunk: false },
    ]);
  });

  it("keeps the full order when the set is empty (nobody sunk yet)", () => {
    const full = ["A", "B"];
    expect(splitRowsBySunk(full, new Set())).toEqual([
      { name: "A", sunk: false },
      { name: "B", sunk: false },
    ]);
  });

  it("an all-sunk set collapses to the full order, every row flagged", () => {
    const full = ["A", "B"];
    expect(splitRowsBySunk(full, new Set(["A", "B"]))).toEqual([
      { name: "A", sunk: true },
      { name: "B", sunk: true },
    ]);
  });

  it("names outside the set's membership stay alive regardless of set order", () => {
    const full = ["A", "B", "C"];
    // A set naming someone NOT in the list (a stale name) must not shift
    // the list's own split.
    expect(splitRowsBySunk(full, new Set(["C", "Ghost"]))).toEqual([
      { name: "A", sunk: false },
      { name: "B", sunk: false },
      { name: "C", sunk: true },
    ]);
  });
});
