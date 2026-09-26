/** Tests for the overlay's rule-inferred row→name mapping ("inferred"
 *  roster mode). The verified Tab sort rule (class rank → tier descending)
 *  is a TOTAL order only when no two ships on a side share class+tier; the
 *  tests pin down exactly what the rule can prove, per the module docs:
 *
 *  - all-singleton sides map 1:1, alive/sunk split included;
 *  - at battle start (no sinks) singleton rows are named and tie-group
 *    rows stay anonymous (the within-group order is not in the arena
 *    file — verified against full battle rosters);
 *  - once a sink meets a tie group, the luma vector cannot distinguish
 *    "the pair lost a member" from "the lone ship next to it sank" (both
 *    read flags like [T,T,T,F]) yet the two worlds regroup the table
 *    differently — so the whole side goes anonymous rather than pinning
 *    stats on 50/50 guesses.
 *
 *  The page renders `null` rows as its silent placeholder, exactly like
 *  unrecognized rows; the OCR mode is the exact path for them. */
import { describe, expect, it } from "vitest";

import { inferredRowMapping, type InferredVehicle } from "./inferredOrder";

/** shipId encodes (classRank, tier) as classRank*10 + tier — deterministic
 *  class/tier data without loading the offline ship DB… except the mapping
 *  reads the REAL DB via shipClassRank/shipTierWeight. So the fixtures use
 *  real ship ids from the captured frames instead: */
const SHIPS = {
  ryujo: 4183799504, // AirCarrier T6 (龙骧)
  saipan: 3763320816, // AirCarrier T8 (塞班 — same class, different tier)
  newMexico: 4259264496, // Battleship T6
  renown: 4078909392, // Battleship T6
  konigsberg: 4184782640, // Cruiser T5
  Leone: 3764270832, // Destroyer T6
  undine: 4183209936, // Submarine T6
} as const;

function veh(name: string, shipId: number, relation = 2): InferredVehicle {
  return { name, shipId, relation };
}

describe("inferredRowMapping", () => {
  it("names every row of an all-singleton side, battle start", () => {
    // One ship per (class, tier): CV, BB, CA, DD, SS — every group a
    // singleton, so the rule pins all five rows exactly. The T8 CV sorts
    // above the T6 CV (same class, different tier — the tier key must
    // survive grouping).
    const vehicles = [
      veh("Undine", SHIPS.undine),
      veh("Leone", SHIPS.Leone),
      veh("Konigsberg", SHIPS.konigsberg),
      veh("Renown", SHIPS.renown),
      veh("Saipan", SHIPS.saipan),
      veh("Ryujo", SHIPS.ryujo),
    ];
    expect(inferredRowMapping(vehicles, null)).toEqual([
      "Saipan",
      "Ryujo",
      "Renown",
      "Konigsberg",
      "Leone",
      "Undine",
    ]);
  });

  it("yields null rows for a multi-member (class, tier) group at battle start", () => {
    // Two T6 battleships: the game's pick between them is unknowable from
    // the arena file — neither row may carry a name.
    const vehicles = [
      veh("Undine", SHIPS.undine),
      veh("Renown", SHIPS.renown),
      veh("NewMexico", SHIPS.newMexico),
    ];
    expect(inferredRowMapping(vehicles, null)).toEqual([null, null, "Undine"]);
  });

  it("splits an all-singleton side into alive and sunk blocks exactly", () => {
    // No tie groups anywhere: the rule is a total order, so the alive/sunk
    // regroup is attributable row by row. The CV and the BB sunk: they move
    // below every alive ship, each block in rule order.
    const vehicles = [
      veh("Undine", SHIPS.undine),
      veh("Leone", SHIPS.Leone),
      veh("Konigsberg", SHIPS.konigsberg),
      veh("Renown", SHIPS.renown),
      veh("Ryujo", SHIPS.ryujo),
    ];
    // Alive vector aligned with the game's CURRENT rows: rows 0 (CV) and
    // 1 (BB) read sunk.
    const alive = [false, false, true, true, true];
    expect(inferredRowMapping(vehicles, alive)).toEqual([
      // alive block: CA, DD, SS — rule order
      "Konigsberg",
      "Leone",
      "Undine",
      // sunk block: CV first, then the BB — class order again
      "Ryujo",
      "Renown",
    ]);
  });

  it("anonymizes a whole side once sinks meet a tie group", () => {
    // Flags [T,T,T,F] fit both "the BB pair lost a member" (game rows
    // CV, surviving BB, DD, sunk BB) and "the DD sank instead" (game rows
    // CV, BB, BB, sunk DD) — the luma vector cannot tell them apart, and
    // the two worlds regroup the rows differently, so no row is provable.
    const vehicles = [
      veh("Ryujo", SHIPS.ryujo),
      veh("Renown", SHIPS.renown),
      veh("NewMexico", SHIPS.newMexico),
      veh("Leone", SHIPS.Leone),
    ];
    const alive = [true, true, true, false];
    expect(inferredRowMapping(vehicles, alive)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("an all-sunk side collapses to the provable rule order", () => {
    // Everyone sunk: the layout is the rule order alone — singletons are
    // pinned again, only the tie group stays anonymous.
    const vehicles = [
      veh("Ryujo", SHIPS.ryujo),
      veh("Renown", SHIPS.renown),
      veh("NewMexico", SHIPS.newMexico),
      veh("Leone", SHIPS.Leone),
    ];
    const alive = [false, false, false, false];
    expect(inferredRowMapping(vehicles, alive)).toEqual([
      "Ryujo",
      null,
      null,
      "Leone",
    ]);
  });

  it("maps allies and enemies in separate blocks", () => {
    const vehicles = [
      veh("AllyDD", SHIPS.Leone, 1),
      veh("AllyCV", SHIPS.ryujo, 0),
      veh("FoeBB", SHIPS.newMexico, 3),
    ];
    // Allies (relation ≤ 1) take the first block, enemies the second —
    // regardless of their interleaving in the arena file.
    expect(inferredRowMapping(vehicles, null)).toEqual([
      "AllyCV",
      "AllyDD",
      "FoeBB",
    ]);
  });

  it("unknown alive flags read as alive (battle-start state)", () => {
    const vehicles = [veh("FoeBB", SHIPS.newMexico, 3)];
    expect(inferredRowMapping(vehicles, null)).toEqual(["FoeBB"]);
  });
});
