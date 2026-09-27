/** Tests for the per-battle sunk tracker (utils/sunkTracker.ts): row
 *  indices from the Rust sink solver resolve into names against the
 *  caller's believed alive order; anything unexplainable degrades the
 *  side for the rest of the battle — never a guess. */
import { describe, expect, it } from "vitest";

import { SunkTracker } from "@/utils/sunkTracker";

describe("SunkTracker", () => {
  it("resolves sink rows into names against the alive order", () => {
    const t = new SunkTracker();
    t.reset("battle-1");
    const order = () => ["alice", "bob", "carol"];
    t.applyAttribution({ ally: [1], enemy: [] }, order);
    expect(t.sunkNames("ally")).toEqual(new Set(["bob"]));
    expect(t.isSunk("ally", "bob")).toBe(true);
    expect(t.sunkNames("enemy")).toEqual(new Set());
  });

  it("resolves consecutive sinks against the shrinking alive order", () => {
    const t = new SunkTracker();
    t.reset("battle-1");
    let alive = ["alice", "bob", "carol"];
    const order = () => alive;
    t.applyAttribution({ ally: [2], enemy: [] }, order); // carol sinks
    alive = alive.filter((n) => n !== "carol");
    t.applyAttribution({ ally: [0], enemy: [] }, order); // alice sinks
    expect(t.sunkNames("ally")).toEqual(new Set(["alice", "carol"]));
  });

  it("degrades a side on an out-of-range row", () => {
    const t = new SunkTracker();
    t.reset("battle-1");
    t.applyAttribution({ ally: [5], enemy: [] }, () => ["alice"]);
    expect(t.sunkNames("ally")).toBeNull();
    // Degraded is final for the battle: later events cannot resurrect it.
    t.applyAttribution({ ally: [0], enemy: [] }, () => ["alice"]);
    expect(t.sunkNames("ally")).toBeNull();
  });

  it("degrades a side when the anchor's sunk count disagrees", () => {
    const t = new SunkTracker();
    t.reset("battle-1");
    t.applyAttribution({ ally: [0], enemy: [] }, () => ["alice", "bob"]);
    t.reconcile("ally", 2); // anchor says TWO sunk, the set has one
    expect(t.sunkNames("ally")).toBeNull();
  });

  it("stays exact while the counts agree", () => {
    const t = new SunkTracker();
    t.reset("battle-1");
    t.applyAttribution({ ally: [0], enemy: [] }, () => ["alice", "bob"]);
    t.reconcile("ally", 1);
    expect(t.sunkNames("ally")).toEqual(new Set(["alice"]));
  });

  it("an empty attribution (solver gave up) degrades on the next reconcile", () => {
    const t = new SunkTracker();
    t.reset("battle-1");
    // A sink happened (anchor will report 1 sunk) but the solver explained
    // nothing: the empty event keeps the set, the reconcile degrades.
    t.applyAttribution({ ally: [], enemy: [] }, () => ["alice", "bob"]);
    expect(t.sunkNames("ally")).toEqual(new Set());
    t.reconcile("ally", 1);
    expect(t.sunkNames("ally")).toBeNull();
  });

  it("a battle switch resets both sides to exact", () => {
    const t = new SunkTracker();
    t.reset("battle-1");
    t.applyAttribution({ ally: [9], enemy: [] }, () => ["alice"]);
    expect(t.sunkNames("ally")).toBeNull();
    t.reset("battle-2");
    expect(t.sunkNames("ally")).toEqual(new Set());
    expect(t.sunkNames("enemy")).toEqual(new Set());
  });

  it("an event before any reset (null battle) is tracked under the null battle", () => {
    const t = new SunkTracker();
    t.applyAttribution({ enemy: [0] }, () => ["eve"]);
    expect(t.sunkNames("enemy")).toEqual(new Set(["eve"]));
  });
});
