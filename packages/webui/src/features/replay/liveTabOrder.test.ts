/** Tests for the live-roster Tab ordering:
 *  - without a recognized row order, the PREDICTED order replicates the
 *    client's full Tab key (recovered from the decompiled client — see
 *    utils/shipClass): class, tier descending, nation, ship name,
 *    '[TAG]nickname';
 *  - the trusted sunk set (sink-attrib events) splits [alive by key] ++
 *    [sunk by key] and marks the sunk entries, mirroring the game's
 *    regroup.
 *
 *  The fixtures use REAL ship ids from the offline DB (the key reads it).
 *  The scenario behind these tests: the in-game Tab table re-sorts as
 *  ships sink while tempArenaInfo.json keeps the battle-start order, so a
 *  live panel keyed to the file order diverges from what the player is
 *  looking at the moment a ship dies. */
import { describe, expect, it } from "vitest";

import type { VehicleEntry } from "@/api";
import { orderForTab } from "./liveTabOrder";

const SHIPS = {
  iowa: 4276041712, // Battleship T9 usa
  pommern: 3761190704, // Battleship T9 germany
  ryujo: 4183799504, // AirCarrier T6 japan
  saipan: 3741300720, // AirCarrier T8 usa
  newMexico: 4259264496, // Battleship T6 usa
  renown: 4078909392, // Battleship T6 united_kingdom
  konigsberg: 4184782640, // Cruiser T5 germany
  leone: 3764270832, // Destroyer T6 italy
  bogatyr: 4186879440, // Cruiser T3 russia 博加特里
  stLouis: 4290689008, // Cruiser T3 usa 圣路易斯
} as const;

function vehicle(name: string, shipId: number, relation = 1): VehicleEntry {
  return { id: shipId * 100 + name.length, name, relation, shipId };
}

const names = (ordered: { vehicle: VehicleEntry; sunk: boolean }[]) =>
  ordered.map((o) => o.vehicle.name);

describe("orderForTab", () => {
  it("predicts the client's key order when no recognition exists", () => {
    // Arena order: T9 German BB, T6 USA BB, T8 USA CV, T6 Japan CV, T5
    // German CA, T6 Italian DD. Predicted: carriers first (higher tier
    // first), then battleships (T9 first, the two T6s by nation — USA
    // before UK), cruiser, dd.
    const list = [
      vehicle("Pommern", SHIPS.pommern),
      vehicle("NewMexico", SHIPS.newMexico),
      vehicle("Saipan", SHIPS.saipan),
      vehicle("Ryujo", SHIPS.ryujo),
      vehicle("Konigsberg", SHIPS.konigsberg),
      vehicle("Leone", SHIPS.leone),
    ];
    expect(names(orderForTab(list, { locale: "zh-CN" }))).toEqual([
      "Saipan",
      "Ryujo",
      "Pommern",
      "NewMexico",
      "Konigsberg",
      "Leone",
    ]);
  });

  it("re-sorts same-ship divisions when a clan tag lands", () => {
    // Same ship, bare nicknames: bob < zed. Once the WG batch returns
    // zed's clan tag, '[CLAN]zed' compares ahead of 'bob' — the predicted
    // order must flip with it (the options re-derive reactively in the
    // panel).
    const list = [vehicle("zed", SHIPS.newMexico), vehicle("bob", SHIPS.newMexico)];
    expect(names(orderForTab(list, { locale: "zh-CN" }))).toEqual(["bob", "zed"]);
    expect(
      names(
        orderForTab(list, {
          locale: "zh-CN",
          clanTagOf: (v) => (v.name === "zed" ? "CLAN" : null),
        }),
      ),
    ).toEqual(["zed", "bob"]);
  });

  it("splits [alive] ++ [sunk] when a trusted sunk set is present", () => {
    // The sink solver named the victim: the predicted order mirrors the
    // game's regroup and flags the card sunk.
    const list = [
      vehicle("Iowa", SHIPS.iowa),
      vehicle("Saipan", SHIPS.saipan),
      vehicle("Pommern", SHIPS.pommern),
    ];
    const ordered = orderForTab(list, {
      locale: "zh-CN",
      sunk: new Set(["Saipan"]),
    });
    expect(names(ordered)).toEqual(["Iowa", "Pommern", "Saipan"]);
    expect(ordered.map((o) => o.sunk)).toEqual([false, false, true]);
  });

  it("orders carriers first and battleships by nation otherwise", () => {
    const list = [vehicle("Konigsberg", SHIPS.konigsberg), vehicle("Saipan", SHIPS.saipan)];
    expect(names(orderForTab(list, { locale: "zh-CN" }))).toEqual(["Saipan", "Konigsberg"]);
  });

  it("keeps the WG [alive] ++ [sunk] regroup under the Lesta name order", () => {
    // Lesta (realm 'ru') takes the ship-name permutation — 博加特里(bó)
    // leads the 圣路易斯(shèng) pair, the 2026-10-09 capture's order —
    // but, unlike CN, still re-sorts the table as ships sink: the sunk
    // 圣路易斯 drops to the tail instead of dimming in place.
    const list = [
      vehicle("Fisher", SHIPS.stLouis),
      vehicle("langyo", SHIPS.stLouis),
      vehicle("BILTEMA8", SHIPS.bogatyr),
    ];
    const ordered = orderForTab(list, {
      locale: "zh-CN",
      shipNameOrder: true,
      sunk: new Set(["Fisher"]),
    });
    expect(names(ordered)).toEqual(["BILTEMA8", "langyo", "Fisher"]);
    expect(ordered.map((o) => o.sunk)).toEqual([false, false, true]);
  });

  it("keeps key-order positions and only marks sinks under staticOrder (CN)", () => {
    // The CN table never re-sorts: the sunk entry keeps its battle-start
    // slot, flagged. The WG partition would move it to the tail — a layout
    // the CN client never renders.
    const list = [
      vehicle("Iowa", SHIPS.iowa),
      vehicle("Saipan", SHIPS.saipan),
      vehicle("Pommern", SHIPS.pommern),
    ];
    const ordered = orderForTab(list, {
      locale: "zh-CN",
      sunk: new Set(["Saipan"]),
      shipNameOrder: true,
      staticOrder: true,
    });
    // Full key order: Saipan (carrier) → then the T9 BB pair by pinyin
    // ship name (波美拉尼亚 bō < 依阿华 yī — the name segment outranks the
    // nation rank under the CN order).
    expect(names(ordered)).toEqual(["Saipan", "Pommern", "Iowa"]);
    expect(ordered.map((o) => o.sunk)).toEqual([true, false, false]);
  });

  it("switches to the client's own sort keys when the telemetry covers the roster", () => {
    // The plugin's game-true sort keys (read off the avatars' ship
    // components) supersede every offline permutation: the comparator is
    // exactly __sortKeyAlive's — key + '[TAG]nickname' ascending, plain
    // string compare. BILTEMA8's key sorts after the two St. Louis keys
    // (nation segment '2' > '1' at the same class+tier), and the two
    // SAME-SHIP keys tie exactly as they do in the client — the display
    // name decides. Both offline permutations would interleave these
    // three differently; the keys are the client's verdict, not an
    // inference.
    const list = [
      vehicle("BILTEMA8", SHIPS.bogatyr),
      vehicle("langyo", SHIPS.stLouis),
      vehicle("Fisher", SHIPS.stLouis),
    ];
    const keys: Record<string, string> = {
      Fisher: "2981St. Louis",
      langyo: "2981St. Louis",
      BILTEMA8: "2982Bogatyr",
    };
    expect(
      names(
        orderForTab(list, {
          locale: "zh-CN",
          shipNameOrder: true,
          sortKeyOf: (v) => keys[v.name],
        }),
      ),
    ).toEqual(["Fisher", "langyo", "BILTEMA8"]);
    // The clan tag rides the display-name tail exactly like the client's
    // own compare: '[PLC]zed' jumps ahead of 'amy' when the keys tie.
    const twins = [vehicle("amy", SHIPS.stLouis), vehicle("zed", SHIPS.stLouis)];
    expect(
      names(
        orderForTab(twins, {
          locale: "zh-CN",
          sortKeyOf: () => "2981St. Louis",
          clanTagOf: (v) => (v.name === "zed" ? "PLC" : null),
        }),
      ),
    ).toEqual(["zed", "amy"]);
  });

  it("ignores the sort-key override unless it covers the whole list", () => {
    // Game-true and inferred rows must never interleave: one missing key
    // disables the override for the WHOLE side, keeping the offline
    // inference (here the WG nation rank: 圣路易斯/usa before 博加特里/russia).
    const list = [
      vehicle("langyo", SHIPS.stLouis),
      vehicle("BILTEMA8", SHIPS.bogatyr),
    ];
    expect(
      names(
        orderForTab(list, {
          locale: "zh-CN",
          sortKeyOf: (v) => (v.name === "langyo" ? "2981St. Louis" : undefined),
        }),
      ),
    ).toEqual(["langyo", "BILTEMA8"]);
  });
});
