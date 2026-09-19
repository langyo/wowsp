/** Tests for the live-roster Tab ordering:
 *  - without a recognized row order, the PREDICTED order groups by ship
 *    class and keeps same-ship players adjacent (division mates), otherwise
 *    stable on the arena order;
 *  - with a recognized row order, the on-screen row order WINS exactly —
 *    including sunk ships interleaved wherever the game currently shows
 *    them — and unmatched rows never eject a roster entry;
 *  - roster entries no row claimed are appended after the recognized ones
 *    in predicted order.
 *
 *  The scenario behind these tests: the in-game Tab table re-sorts as ships
 *  sink ([alive by class] ++ [sunk by class]) while tempArenaInfo.json
 *  keeps the battle-start order, so a live panel keyed to the file order
 *  diverges from what the player is looking at the moment a ship dies. */
import { describe, expect, it } from "vitest";

import type { VehicleEntry } from "@/api";
import { orderForTab } from "./liveTabOrder";

/** Deterministic class ranks for the tests: 0 = "battleship", 1 = "cruiser",
 *  2 = "destroyer" — injected so the offline ship DB never loads. */
const rankOf = (shipId: number) => (shipId % 10) as number;

function vehicle(name: string, shipId: number, relation = 1): VehicleEntry {
  return { id: shipId * 100 + name.length, name, relation, shipId };
}

const names = (ordered: { vehicle: VehicleEntry; sunk: boolean }[]) =>
  ordered.map((o) => o.vehicle.name);

describe("orderForTab", () => {
  it("predicts class-grouped order when no recognition exists", () => {
    // Arena order: cruiser, destroyer, battleship, cruiser, battleship.
    const list = [
      vehicle("Ca1", 11),
      vehicle("Dd1", 12),
      vehicle("Bb1", 10),
      vehicle("Ca2", 21),
      vehicle("Bb2", 20),
    ];
    expect(names(orderForTab(list, null, rankOf))).toEqual([
      "Bb1",
      "Bb2",
      "Ca1",
      "Ca2",
      "Dd1",
    ]);
  });

  it("keeps same-ship players adjacent and stays stable otherwise", () => {
    const list = [
      vehicle("TwinB", 10),
      vehicle("Other", 11),
      vehicle("TwinA", 10),
    ];
    expect(names(orderForTab(list, null, rankOf))).toEqual([
      "TwinB",
      "TwinA",
      "Other",
    ]);
  });

  it("follows the recognized row order exactly, sunk flags included", () => {
    // The game re-sorted: an alive destroyer row sits ABOVE sunk cruisers
    // (alive group first, then the sunk group by class). The recognized
    // order must win verbatim — no re-derivation from the file order.
    const list = [
      vehicle("Bb1", 10),
      vehicle("Ca1", 11),
      vehicle("Ca2", 11),
      vehicle("Dd1", 12),
    ];
    const rows = [
      { name: "Bb1", alive: true },
      { name: "Dd1", alive: true },
      { name: "Ca2", alive: false },
      { name: "Ca1", alive: false },
    ];
    const ordered = orderForTab(list, rows, rankOf);
    expect(names(ordered)).toEqual(["Bb1", "Dd1", "Ca2", "Ca1"]);
    expect(ordered.map((o) => o.sunk)).toEqual([false, false, true, true]);
  });

  it("keeps unmatched rows as slots and appends unclaimed entries", () => {
    // One row failed to match; its roster entry must still render (after
    // the recognized ones, in predicted order) instead of disappearing.
    const list = [
      vehicle("Ca1", 11),
      vehicle("Bb1", 10),
      vehicle("Dd1", 12),
    ];
    const rows = [
      { name: null, alive: true },
      { name: "Bb1", alive: true },
    ];
    expect(names(orderForTab(list, rows, rankOf))).toEqual([
      "Bb1",
      "Ca1",
      "Dd1",
    ]);
  });

  it("ignores row names that are not on this side", () => {
    // Cross-side noise (an enemy name inside the ally rows) must be
    // dropped, never matched against this side's roster.
    const list = [vehicle("Ally", 10), vehicle("Mate", 11)];
    const rows = [
      { name: "Enemy", alive: false },
      { name: "Ally", alive: true },
    ];
    expect(names(orderForTab(list, rows, rankOf))).toEqual(["Ally", "Mate"]);
  });

  it("treats an empty row list as no recognition", () => {
    const list = [vehicle("Ca1", 11), vehicle("Bb1", 10)];
    expect(names(orderForTab(list, [], rankOf))).toEqual(["Bb1", "Ca1"]);
  });
});
