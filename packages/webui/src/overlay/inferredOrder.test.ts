/** Tests for the overlay's rule-derived row→name mapping ("inferred"
 *  roster mode). The mapping replicates the client's own Tab sort key,
 *  recovered from the decompiled UI code (see inferredOrder.ts):
 *
 *      alive('A'/'B') + classRank + (100-tier) + nationRank
 *      + localized ship name + '[TAG]nickname'
 *
 *  The fixtures use REAL ship ids from the offline DB (the key reads it),
 *  and the headline case replays an actual 3v3 battle whose Tab screenshot
 *  verified the rule end to end: ally rows Germany→Italy→PanAsia, enemy
 *  rows Japan→USA→Germany — exactly NATION.SORT_ORDER.
 *
 *  Mid-battle, sinks make the alive subset unknowable from the luma
 *  vector; each row then carries its provable CONTIGUOUS candidate range
 *  (alive row k: full-order positions k..k+sunk; sunk row j: j..j+alive).
 *  All-sunk collapses back to the exact full order. */
import { describe, expect, it } from "vitest";

import { inferredRowMapping, type InferredVehicle } from "./inferredOrder";

const SHIPS = {
  // The verified 3v3 battle (build 13187581, 2026-09-27): every ship a
  // T9 battleship, so the nation segment decides everything.
  pommern: 3761190704, // Battleship T9 germany 波美拉尼亚
  centurion: 3551475440, // Battleship T9 italy 前百夫长
  bajie: 3761190096, // Battleship T9 pan_asia 八戒
  izumo: 4272895696, // Battleship T9 japan 鲟 (Izumo)
  iowa: 4276041712, // Battleship T9 usa 依阿华
  // Class/tier spread fixtures.
  ryujo: 4183799504, // AirCarrier T6 japan 枭
  saipan: 3741300720, // AirCarrier T8 usa 塞班
  newMexico: 4259264496, // Battleship T6 usa 新墨西哥
  renown: 4078909392, // Battleship T6 united_kingdom 声望
  konigsberg: 4184782640, // Cruiser T5 germany 柯尼斯堡
  leone: 3764270832, // Destroyer T6 italy
  undine: 4183209936, // Submarine T6 united_kingdom
} as const;

function veh(name: string, shipId: number, relation = 2): InferredVehicle {
  return { name, shipId, relation };
}

describe("inferredRowMapping", () => {
  it("reproduces the replay-verified 3v3 battle exactly (nation order)", () => {
    // Ground truth: the in-game Tab rows of the actual battle matched the
    // nation-ordered key 6/6 — ally LaoBao(Germany)→EdwinSzeto(Italy)→
    // langyo(PanAsia), enemy Eastern_sun(Japan)→kamigt0(USA)→wryyy(Germany).
    const battle: InferredVehicle[] = [
      veh("langyo", SHIPS.bajie, 0),
      veh("EdwinSzeto", SHIPS.centurion, 1),
      veh("LaoBao_2026", SHIPS.pommern, 1),
      veh("wryyyyyyyyy_1", SHIPS.pommern, 3),
      veh("kamigt0", SHIPS.iowa, 2),
      veh("Eastern_sun", SHIPS.izumo, 2),
    ];
    expect(inferredRowMapping(battle, null, { locale: "zh-CN" })).toEqual([
      "LaoBao_2026",
      "EdwinSzeto",
      "langyo",
      "Eastern_sun",
      "kamigt0",
      "wryyyyyyyyy_1",
    ]);
  });

  it("orders by class, then tier descending, then nation", () => {
    // CV < BB < CA < DD < SS; inside a class higher tiers first; inside a
    // (class, tier) group the nation rank (USA before UK before Italy).
    const vehicles = [
      veh("Undine", SHIPS.undine),
      veh("Leone", SHIPS.leone),
      veh("Konigsberg", SHIPS.konigsberg),
      veh("Renown", SHIPS.renown),
      veh("NewMexico", SHIPS.newMexico),
      veh("Saipan", SHIPS.saipan),
      veh("Ryujo", SHIPS.ryujo),
    ];
    expect(inferredRowMapping(vehicles, null, { locale: "zh-CN" })).toEqual([
      "Saipan",
      "Ryujo",
      "NewMexico",
      "Renown",
      "Konigsberg",
      "Leone",
      "Undine",
    ]);
  });

  it("breaks same-ship ties by the '[TAG]nickname' display name", () => {
    // Two players in the SAME ship (the classic division): the key's
    // ship-name segments compare equal, so the display name decides — and
    // a clan tag's '[' (0x5B) sorts after uppercase but before lowercase
    // letters, exactly like the client's string compare. The UK battleship
    // trails the pair: nation outranks every name.
    const vehicles = [
      veh("zed", SHIPS.newMexico),
      veh("bob", SHIPS.newMexico),
      veh("Alice", SHIPS.renown),
    ];
    // Tagless: bob < zed < Alice (nation first, then display name).
    expect(inferredRowMapping(vehicles, null, { locale: "zh-CN" })).toEqual([
      "bob",
      "zed",
      "Alice",
    ]);
    // With [CLAN] on zed, '[CLAN]zed' starts with '[' and jumps AHEAD of
    // every lowercase-start nickname — the order flips.
    expect(
      inferredRowMapping(vehicles, null, {
        locale: "zh-CN",
        clanTagOf: (n) => (n === "zed" ? "CLAN" : null),
      }),
    ).toEqual(["zed", "bob", "Alice"]);
  });

  it("narrows rows to contiguous candidate ranges once ships sink", () => {
    // Full order P1..P4; the luma vector reads [T,T,T,F] (3 alive, 1
    // sunk): any of the four could be the sunk one, so alive rows carry
    // their provable ranges (k..k+1) and the sunk row carries everyone.
    const vehicles = [
      veh("P1", SHIPS.izumo),
      veh("P2", SHIPS.iowa),
      veh("P3", SHIPS.pommern),
      veh("P4", SHIPS.bajie),
    ];
    expect(inferredRowMapping(vehicles, [true, true, true, false], { locale: "zh-CN" })).toEqual([
      ["P1", "P2"],
      ["P2", "P3"],
      ["P3", "P4"],
      ["P1", "P2", "P3", "P4"],
    ]);
  });

  it("collapses an all-sunk side back to the exact full order", () => {
    const vehicles = [
      veh("P2", SHIPS.iowa),
      veh("P1", SHIPS.izumo),
      veh("P4", SHIPS.bajie),
      veh("P3", SHIPS.pommern),
    ];
    expect(
      inferredRowMapping(vehicles, [false, false, false, false], { locale: "zh-CN" }),
    ).toEqual(["P1", "P2", "P3", "P4"]);
  });

  it("renders the exact layout when a trusted sunk set matches the flags", () => {
    // The sink solver named the victims: the side's layout is the full key
    // order split by membership — [alive by key] ++ [sunk by key] — every
    // row pinned, no candidate ranges.
    // Full key order: P1 (Japan) < P2 (USA) < P3 (Germany) < P4 (PanAsia).
    const vehicles = [
      veh("P2", SHIPS.iowa, 1),
      veh("P1", SHIPS.izumo, 1),
      veh("P4", SHIPS.bajie, 1),
      veh("P3", SHIPS.pommern, 1),
    ];
    const sunk = new Set(["P2"]);
    expect(
      inferredRowMapping(vehicles, [true, true, true, false], {
        locale: "zh-CN",
        sunk: { ally: sunk },
      }),
    ).toEqual(["P1", "P3", "P4", "P2"]);
    // A set that DISAGREES with the alive count keeps the provable ranges
    // (the caller degrades the side; the function must not trust it).
    expect(
      inferredRowMapping(vehicles, [true, true, true, false], {
        locale: "zh-CN",
        sunk: { ally: new Set(["P1", "P2"]) },
      }),
    ).toEqual([["P1", "P2"], ["P2", "P3"], ["P3", "P4"], ["P1", "P2", "P3", "P4"]]);
  });

  it("maps allies and enemies in separate blocks", () => {
    const vehicles = [
      veh("FoeBB", SHIPS.newMexico, 3),
      veh("AllyDD", SHIPS.leone, 1),
      veh("AllyCV", SHIPS.ryujo, 0),
    ];
    // Allies (relation ≤ 1) take the first block, enemies the second —
    // regardless of their interleaving in the arena file.
    expect(inferredRowMapping(vehicles, null, { locale: "zh-CN" })).toEqual([
      "AllyCV",
      "AllyDD",
      "FoeBB",
    ]);
  });

  it("maps the whole roster as one block in operation scenarios", () => {
    // An operation roster (行动): relation values follow scenario team
    // slots — the `relation: 3` entries are escort allies, not enemies —
    // so `operation` collapses everything into a single allies block.
    // Class order (CA < DD < SS) decides the row order.
    const vehicles = [
      veh("langyo", SHIPS.leone, 0),
      veh("IDS_OP_15_DUMMY_01", SHIPS.konigsberg, 3),
      veh("IDS_OP_15_ALLY_DD_01", SHIPS.undine, 3),
    ];
    expect(
      inferredRowMapping(vehicles, null, { locale: "zh-CN", operation: true }),
    ).toEqual(["IDS_OP_15_DUMMY_01", "langyo", "IDS_OP_15_ALLY_DD_01"]);
  });
});
