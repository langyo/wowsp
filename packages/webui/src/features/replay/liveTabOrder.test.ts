/** Tests for the live-roster Tab ordering:
 *  - without a recognized row order, the PREDICTED order replicates the
 *    client's full Tab key (recovered from the decompiled client — see
 *    utils/shipClass): class, tier descending, nation, ship name,
 *    '[TAG]nickname';
 *  - with a recognized row order, the on-screen row order WINS exactly —
 *    including sunk ships interleaved wherever the game currently shows
 *    them — and unmatched rows never eject a roster entry;
 *  - roster entries no row claimed are appended after the recognized ones
 *    in predicted order.
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
    expect(names(orderForTab(list, null, { locale: "zh-CN" }))).toEqual([
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
    expect(names(orderForTab(list, null, { locale: "zh-CN" }))).toEqual(["bob", "zed"]);
    expect(
      names(
        orderForTab(list, null, {
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
    const ordered = orderForTab(list, null, {
      locale: "zh-CN",
      sunk: new Set(["Saipan"]),
    });
    expect(names(ordered)).toEqual(["Iowa", "Pommern", "Saipan"]);
    expect(ordered.map((o) => o.sunk)).toEqual([false, false, true]);
  });

  it("follows the recognized row order exactly, sunk flags included", () => {
    // The game re-sorted: an alive carrier row sits ABOVE sunk battleships
    // (alive group first). The recognized order must win verbatim — no
    // re-derivation from the file order.
    const list = [
      vehicle("Iowa", SHIPS.iowa),
      vehicle("Saipan", SHIPS.saipan),
      vehicle("Pommern", SHIPS.pommern),
    ];
    const rows = [
      { name: "Saipan", alive: true },
      { name: "Pommern", alive: false },
      { name: "Iowa", alive: false },
    ];
    const ordered = orderForTab(list, rows, { locale: "zh-CN" });
    expect(names(ordered)).toEqual(["Saipan", "Pommern", "Iowa"]);
    expect(ordered.map((o) => o.sunk)).toEqual([false, true, true]);
  });

  it("keeps unmatched rows as slots and appends unclaimed entries", () => {
    // One row failed to match; its roster entry must still render (after
    // the recognized ones, in predicted order) instead of disappearing.
    const list = [
      vehicle("Konigsberg", SHIPS.konigsberg),
      vehicle("Saipan", SHIPS.saipan),
      vehicle("Leone", SHIPS.leone),
    ];
    const rows = [
      { name: null, alive: true },
      { name: "Saipan", alive: true },
    ];
    expect(names(orderForTab(list, rows, { locale: "zh-CN" }))).toEqual([
      "Saipan",
      "Konigsberg",
      "Leone",
    ]);
  });

  it("ignores row names that are not on this side", () => {
    // Cross-side noise (an enemy name inside the ally rows) must be
    // dropped, never matched against this side's roster.
    const list = [vehicle("Ally", SHIPS.iowa), vehicle("Mate", SHIPS.renown)];
    const rows = [
      { name: "Enemy", alive: false },
      { name: "Ally", alive: true },
    ];
    expect(names(orderForTab(list, rows, { locale: "zh-CN" }))).toEqual(["Ally", "Mate"]);
  });

  it("treats an empty row list as no recognition", () => {
    const list = [vehicle("Konigsberg", SHIPS.konigsberg), vehicle("Saipan", SHIPS.saipan)];
    expect(names(orderForTab(list, [], { locale: "zh-CN" }))).toEqual(["Saipan", "Konigsberg"]);
  });
});
