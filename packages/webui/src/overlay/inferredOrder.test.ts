/** Tests for the overlay's rule-inferred row→name mapping ("inferred"
 *  roster mode): the verified Tab sort rule (class rank → tier descending →
 *  ship id) applied per side as [alive] ++ [sunk], allies block before
 *  enemies, unknown-alive rows read as alive, and the ship-id tiebreak only
 *  ever deciding the (class, tier) residue the game's own sort does not
 *  expose in the arena file.
 *
 *  The scenario behind these tests: the Rust watcher supplies the row grid
 *  plus per-row alive flags (pure luma, no OCR) and the overlay must name
 *  the rows without any text recognition — deterministically, from the
 *  closed roster set. */
import { describe, expect, it } from "vitest";

import { inferredRowMapping, type InferredVehicle } from "./inferredOrder";

/** shipId encodes (classRank, tier) as classRank*10 + tier — deterministic
 *  class/tier data without loading the offline ship DB… except the mapping
 *  reads the REAL DB via shipClassRank/shipTierWeight. So the fixtures use
 *  real ship ids from the captured frames instead: */
const SHIPS = {
  ryujo: 4183799504, // AirCarrier T6 (龙骧)
  saipan: 3763320816, // AirCarrier T8-ish (塞班 — CV class)
  newMexico: 4259264496, // Battleship T6
  renown: 4078909392, // Battleship T6
  konigsberg: 4184782640, // Cruiser T5
  argentina: 4184782160, // Cruiser T5
  Leone: 3764270832, // Destroyer T6
  undine: 4183209936, // Submarine T6
} as const;

function veh(name: string, shipId: number, relation = 2): InferredVehicle {
  return { name, relation, shipId };
}

describe("inferredRowMapping", () => {
  it("orders one side by class then tier descending, all alive", () => {
    // Enemy side of the captured 9v9 frame, nobody sunk yet: CV < BB(2×
    // same tier → ship-id desc) < CA ×2 < DD < SS — the exact on-screen
    // order the game showed.
    const vehicles = [
      veh("Undine", SHIPS.undine),
      veh("Leone", SHIPS.Leone),
      veh("Konigsberg", SHIPS.konigsberg),
      veh("Argentina", SHIPS.argentina),
      veh("Renown", SHIPS.renown),
      veh("NewMexico", SHIPS.newMexico),
      veh("Ryujo", SHIPS.ryujo),
    ];
    expect(inferredRowMapping(vehicles, null)).toEqual([
      "Ryujo",
      // (BB, T6) tie → the ship-id tiebreak (ascending) decides
      // deterministically; renown < newMexico id-wise, matching the
      // captured frame where 声望 sat above 新墨西哥.
      "Renown",
      "NewMexico",
      "Argentina",
      "Konigsberg",
      "Leone",
      "Undine",
    ]);
  });

  it("splits alive and sunk blocks, each in rule order", () => {
    // The enemy CV and one CA sunk: they move BELOW every alive ship,
    // keeping the class order inside the sunk block.
    const vehicles = [
      veh("Undine", SHIPS.undine),
      veh("Leone", SHIPS.Leone),
      veh("Konigsberg", SHIPS.konigsberg),
      veh("Argentina", SHIPS.argentina),
      veh("Renown", SHIPS.renown),
      veh("NewMexico", SHIPS.newMexico),
      veh("Ryujo", SHIPS.ryujo),
    ];
    // Alive vector aligned with the game's CURRENT rows: row 0 (CV) and
    // row 3 (a CA) read sunk.
    const alive = [false, true, true, false, true, true, true];
    expect(inferredRowMapping(vehicles, alive)).toEqual([
      // alive block: BB ×2 (id tiebreak), CA, DD, SS — rule order
      "Renown",
      "NewMexico",
      "Konigsberg",
      "Leone",
      "Undine",
      // sunk block: CV first, then the CA — class order again
      "Ryujo",
      "Argentina",
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

  it("keeps same-class same-tier pairs on the ship-id tiebreak", () => {
    // The unknowable residue: two T6 battleships. The mapping is still
    // DETERMINISTIC (id ascending) so chips never flicker between renders —
    // and this exact pair sat 声望-above-新墨西哥 in the captured frame.
    const vehicles = [
      veh("Renown", SHIPS.renown),
      veh("NewMexico", SHIPS.newMexico),
    ];
    expect(inferredRowMapping(vehicles, null)).toEqual([
      "Renown",
      "NewMexico",
    ]);
  });
});
