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
 *  The mapping receives its sides PRE-SPLIT from the caller
 *  (splitLiveRosterSides — exactly the rows the game draws); the fixtures
 *  mirror the non-operation caller by splitting on `relation` here.
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

/** The non-operation caller's split (relation ≤ 1 allies / > 1 enemies),
 *  arena-file order — what splitLiveRosterSides(vehicles, false) hands the
 *  mapping in every battle the game renders verbatim. */
function sidesOf(vehicles: InferredVehicle[]) {
  return {
    allies: vehicles.filter((v) => v.relation <= 1),
    enemies: vehicles.filter((v) => v.relation > 1),
  };
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
    expect(inferredRowMapping(sidesOf(battle), null, { locale: "zh-CN" })).toEqual([
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
    expect(inferredRowMapping(sidesOf(vehicles), null, { locale: "zh-CN" })).toEqual([
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
    expect(inferredRowMapping(sidesOf(vehicles), null, { locale: "zh-CN" })).toEqual([
      "bob",
      "zed",
      "Alice",
    ]);
    // With [CLAN] on zed, '[CLAN]zed' starts with '[' and jumps AHEAD of
    // every lowercase-start nickname — the order flips.
    expect(
      inferredRowMapping(sidesOf(vehicles), null, {
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
    expect(inferredRowMapping(sidesOf(vehicles), [true, true, true, false], { locale: "zh-CN" })).toEqual([
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
      inferredRowMapping(sidesOf(vehicles), [false, false, false, false], { locale: "zh-CN" }),
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
      inferredRowMapping(sidesOf(vehicles), [true, true, true, false], {
        locale: "zh-CN",
        sunk: { ally: sunk },
      }),
    ).toEqual(["P1", "P3", "P4", "P2"]);
    // A set that DISAGREES with the alive count keeps the provable ranges
    // (the caller degrades the side; the function must not trust it).
    expect(
      inferredRowMapping(sidesOf(vehicles), [true, true, true, false], {
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
    expect(inferredRowMapping(sidesOf(vehicles), null, { locale: "zh-CN" })).toEqual([
      "AllyCV",
      "AllyDD",
      "FoeBB",
    ]);
  });

  it("maps the caller's operation-filtered sides with no scripted rows", () => {
    // PCVO011_OP_10_s10_USS_CL (Chumphon), excerpt: the game's story table
    // renders its humans only, so splitLiveRosterSides(vehicles, true)
    // drops the scripted allies and the scripted enemy waves BEFORE the
    // mapping — the row grid below is exactly the human rows the game
    // draws (BB < CA < DD), and no untranslated `IDS_*` key can ever
    // surface as a row attribution.
    const opRoster = [
      veh("ShigureKira", SHIPS.leone, 0),
      veh("Lesi", SHIPS.konigsberg, 1),
      veh("89757_hero", SHIPS.newMexico, 1),
      veh("IDS_OP_10_09_GAMBLE", SHIPS.undine, 1),
      veh("IDS_OP_10_10_BREEZE", SHIPS.undine, 1),
      veh("IDS_OP_10_EN_0101", SHIPS.izumo, 2),
      veh("IDS_OP_10_EN_0102", SHIPS.iowa, 2),
    ];
    const sides = {
      allies: opRoster.filter(
        (v) => v.relation <= 1 && !v.name.startsWith("IDS_"),
      ),
      enemies: [],
    };
    expect(inferredRowMapping(sides, null, { locale: "zh-CN" })).toEqual([
      "89757_hero",
      "Lesi",
      "ShigureKira",
    ]);
  });

  it("keeps the tutorial family's scripted fills as ordinary rows", () => {
    // LOW_LVL_OPERATION_3 (isOperationBattle false): the game fields its
    // scripted flagship pair as REAL team rows under localized names, so
    // splitLiveRosterSides(vehicles, false) keeps them in the ally block —
    // the mapping still owes them rows. Class order (CV < DD < SS) decides
    // the order inside the block.
    const vehicles = [
      veh("langyo", SHIPS.leone, 0),
      veh("IDS_OP_17_ALLY_FLAGSHIP", SHIPS.undine, 1),
      veh("IDS_OP_17_ALLY_FLAGSHIP_CV", SHIPS.ryujo, 1),
    ];
    expect(inferredRowMapping(sidesOf(vehicles), null, { locale: "zh-CN" })).toEqual([
      "IDS_OP_17_ALLY_FLAGSHIP_CV",
      "langyo",
      "IDS_OP_17_ALLY_FLAGSHIP",
    ]);
  });

  // The CN-client ground truth (360 build 13243917, 15.8.1): a real co-op
  // battle's ally roster — ship ids straight off the replay meta, arena
  // order = meta order — against the row order OBSERVED on the in-game Tab
  // screenshot. The decompiled nation order predicts
  // [杰克逊港, 切斯特, 韦茅斯, 海尔德兰] for the T2 cruiser group
  // (commonwealth '10' sorts before '9' as a string; usa < uk < nld);
  // the client rendered 海尔德兰 → 杰克逊港 → 切斯特 → 韦茅斯 — localized
  // ship names in the client's own collation.
  const CN_BATTLE = {
    // arena-file order (the replay meta's vehicles, relation ≠ 2)
    roster: [
      veh("用户_14222696867", 4186912592, 1), // Turenne III France BB 杜伦尼
      veh("用户_70297220473", 4187894992, 1), // Longjiang II pan_asia DD 龙江
      veh("用户_61087182998", 4187894992, 1), // same ship, division twin
      veh("用户_78851053968", 4279154384, 1), // Tenryū III japan CA 豹
      veh("神楽坂柚咲", 4292786160, 0), // Chester II usa CA 切斯特 (self)
      veh(":Millo:", 4282299760, 1), // Port Jackson II commonwealth CA 杰克逊港
      veh(":Yegorov:", 4187895632, 1), // En. Gabolde II france DD 加博尔德海军少尉
      veh(":Tributs:", 4187928528, 1), // Weymouth II united_kingdom CA 韦茅斯
      veh(":Apostolis:", 4187928336, 1), // Gelderland II netherlands CA 海尔德兰
    ],
    // The client's battle-start (and battle-LONG — see staticLayout) order.
    expected: [
      "用户_14222696867",
      "用户_78851053968",
      ":Apostolis:",
      ":Millo:",
      "神楽坂柚咲",
      ":Tributs:",
      ":Yegorov:",
      "用户_61087182998",
      "用户_70297220473",
    ],
  };

  it("reproduces the CN client's ship-name row order (real battle, 9/9)", () => {
    expect(
      inferredRowMapping(sidesOf(CN_BATTLE.roster), null, {
        locale: "zh-CN",
        shipNameOrder: true,
        staticLayout: true,
      }),
    ).toEqual(CN_BATTLE.expected);
  });

  it("keeps the nation order for WG clients on the same roster", () => {
    // The default (decompiled) permutation must stay byte-compatible with
    // the verified WG behavior — the CN gate is per-realm, not global. The
    // T2 cruiser group lands 切斯特(usa) → 韦茅斯(uk) → 海尔德兰(nld) →
    // 杰克逊港(commonwealth, the '10' < '9' string quirk).
    expect(
      inferredRowMapping(sidesOf(CN_BATTLE.roster), null, { locale: "zh-CN" }),
    ).toEqual([
      "用户_14222696867",
      "用户_78851053968",
      ":Millo:",
      "神楽坂柚咲",
      ":Tributs:",
      ":Apostolis:",
      ":Yegorov:",
      "用户_61087182998",
      "用户_70297220473",
    ]);
  });

  it("keeps battle-start positions under the CN static layout mid-battle", () => {
    // The CN client dims sunk rows IN PLACE — the alive vector interleaves
    // (rows 1,2,3,5 alive; 4,6,7,8,9 sunk, as measured off the screenshot)
    // and is NOT blockwise. The mapping must ignore it for positions (the
    // WG candidate-range machinery would pin WRONG names with battle-start
    // confidence — the exact misattribution that marked a human row 机器人).
    const alive = [
      true, true, true, false, true, // 用户A, 用户B, :Apostolis:, :Millo:†, 神楽
      false, false, false, false, // :Tributs:†, :Yegorov:†, 610†, 702†
    ];
    expect(
      inferredRowMapping(sidesOf(CN_BATTLE.roster), alive, {
        locale: "zh-CN",
        shipNameOrder: true,
        staticLayout: true,
      }),
    ).toEqual(CN_BATTLE.expected);
    // Even a trusted sunk set must not re-sort the static layout (the
    // [alive] ++ [sunk] permutation is a WG-client behavior).
    expect(
      inferredRowMapping(sidesOf(CN_BATTLE.roster), alive, {
        locale: "zh-CN",
        shipNameOrder: true,
        staticLayout: true,
        sunk: {
          ally: new Set([
            ":Millo:",
            ":Tributs:",
            ":Yegorov:",
            "用户_61087182998",
            "用户_70297220473",
          ]),
        },
      }),
    ).toEqual(CN_BATTLE.expected);
  });

  it("breaks CN same-ship ties by the display name, nation last", () => {
    // The 龙江 twins (same ship): the collated ship names tie, so the
    // display name decides; the nation rank only outranks EQUAL names
    // across different ships, never the name itself.
    const vehicles = [
      veh("用户_70297220473", 4187894992, 1),
      veh("用户_61087182998", 4187894992, 1),
    ];
    expect(
      inferredRowMapping(sidesOf(vehicles), null, {
        locale: "zh-CN",
        shipNameOrder: true,
        staticLayout: true,
      }),
    ).toEqual(["用户_61087182998", "用户_70297220473"]);
  });

  it("sorts unknown-DB ships after known ones under the CN order", () => {
    // The '~'-segment sentinel, name-order edition: a ship the offline DB
    // does not know stays deterministic and last within its class group.
    const vehicles = [
      veh("mystery", 1234567890, 1), // not in the offline DB
      veh("knownDD", SHIPS.leone, 1), // Destroyer T6 italy
    ];
    expect(
      inferredRowMapping(sidesOf(vehicles), null, {
        locale: "zh-CN",
        shipNameOrder: true,
        staticLayout: true,
      }),
    ).toEqual(["knownDD", "mystery"]);
  });

  // The Lesta-client ground truth (2026-10-09 co-op capture, realm ru):
  // the game's Tab order for the allied team, ship ids straight off the
  // offline DB. The decompiled nation rank puts 圣路易斯(usa) ahead of
  // 博加特里(russia); the client rendered the opposite — the ship-name
  // order, like the CN client. Unlike CN, no static layout: the blockwise
  // machinery stays live for Lesta.
  const LESTA_ROSTER = [
    veh(":Sturdee:", 4186912560, 1), // Nassau III germany BB 拿骚
    veh("BILTEMA8", 4186879440, 1), // Bogatyr III russia CA 博加特里
    veh(":Fisher:", 4290689008, 1), // St. Louis III usa CA 圣路易斯
    veh("langyo", 4290689008, 0), // St. Louis III usa CA 圣路易斯 (self)
    veh("Navy_804", 4187928528, 1), // Weymouth II united_kingdom CA 韦茅斯
    veh(":Hollmann:", 4187895600, 1), // V-25 II germany DD
  ];

  it("reproduces the Lesta client's ship-name row order (real battle, 6/6)", () => {
    // shipNameOrder WITHOUT staticLayout — the Lesta combination: the
    // battle-start mapping is the name-order key over the block layout.
    expect(
      inferredRowMapping(sidesOf(LESTA_ROSTER), null, {
        locale: "zh-CN",
        shipNameOrder: true,
      }),
    ).toEqual([
      ":Sturdee:",
      "BILTEMA8",
      ":Fisher:",
      "langyo",
      "Navy_804",
      ":Hollmann:",
    ]);
  });

  it("keeps the WG regroup live for Lesta once ships sink", () => {
    // The blockwise vector holds (sunk rows re-sort to the tail), so the
    // trusted sunk set renders the exact [alive] ++ [sunk] layout — the
    // sunk 圣路易斯 lands on the tail row, not its battle-start slot.
    const alive = [true, true, true, true, true, false];
    expect(
      inferredRowMapping(sidesOf(LESTA_ROSTER), alive, {
        locale: "zh-CN",
        shipNameOrder: true,
        sunk: { ally: new Set(["langyo"]) },
      }),
    ).toEqual([
      ":Sturdee:",
      "BILTEMA8",
      ":Fisher:",
      "Navy_804",
      ":Hollmann:",
      "langyo",
    ]);
  });

  it("switches to the client's own sort keys when the map covers a side", () => {
    // The plugin's game-true sort keys (telemetry `sortKeys`, read off the
    // avatars' ship components) supersede BOTH offline permutations: the
    // St. Louis keys ('2981…') sort ahead of Bogatyr's ('2982…' — the
    // nation segment at the same class+tier) even though the CN/Lesta
    // ship-name permutation puts 博加特里(bó) first, and the same-ship tie
    // breaks by display name exactly as __sortKeyAlive compares.
    const vehicles = [
      veh("BILTEMA8", 4186879440, 1), // Bogatyr III russia CA 博加特里
      veh("langyo", 4290689008, 0), // St. Louis III usa CA 圣路易斯 (self)
      veh("Fisher", 4290689008, 1), // St. Louis III usa CA 圣路易斯
    ];
    const keys: Record<string, string> = {
      BILTEMA8: "2982Bogatyr",
      langyo: "2981St. Louis",
      Fisher: "2981St. Louis",
    };
    expect(
      inferredRowMapping(sidesOf(vehicles), null, {
        locale: "zh-CN",
        shipNameOrder: true,
        sortKeyOf: (n) => keys[n],
      }),
    ).toEqual(["Fisher", "langyo", "BILTEMA8"]);
    // One missing key disables the override wholesale — no interleaving.
    expect(
      inferredRowMapping(sidesOf(vehicles), null, {
        locale: "zh-CN",
        shipNameOrder: true,
        sortKeyOf: (n) => (n === "BILTEMA8" ? undefined : keys[n]),
      }),
    ).toEqual(["BILTEMA8", "Fisher", "langyo"]);
  });
});
