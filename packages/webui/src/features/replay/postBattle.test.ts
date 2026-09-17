/** Tests for the post-battle parser's CLIENT_PUBLIC_RESULTS field mapping.
 *
 * The index semantics come from the vendored authoritative layout
 * (wowsunpack constants.json, client 15.2) and were verified against 126
 * replays / 417 players on client 15.8 — see postBattle.ts. These tests pin
 * the mapping so layout regressions (first-spotting read as plane kills,
 * bomb drops as plane losses, distance as HP ratio) can't silently return.
 */
import { describe, expect, it } from "vitest";

import { parsePostBattle } from "./postBattle";

/** Build a zeroed CLIENT_PUBLIC_RESULTS array with sparse overrides. */
function arr(overrides: Record<number, unknown>, len = 538): unknown[] {
  const a: unknown[] = new Array(len).fill(0);
  Object.assign(a, overrides);
  return a;
}

/** A minimal but well-formed BattleResults payload around one player. */
function payload(entry: unknown[], accountId = 42): string {
  const privateDataList = new Array(54).fill(0);
  privateDataList[7] = [1_250_000, 0, 0, 1450, 0];
  return JSON.stringify({
    accountDBID: accountId,
    commonList: [7, "pvp_domination"],
    playersPublicInfo: { [accountId]: entry },
    privateDataList,
  });
}

describe("parsePostBattle field mapping", () => {
  it("reads identity, damage, damage taken and HP ratio from the authoritative indices", () => {
    const data = parsePostBattle(
      payload(
        arr({
          1: "TestCV",
          6: 0,
          7: 4178556624,
          9: "ASIA",
          15: 74900, // max_health
          20: 7490, // remained_hp → 10%
          21: true, // is_alive
          426: 96429, // damage
          404: 910, // exp
        }),
      ),
    );
    expect(data).not.toBeNull();
    const p = data!.players[0];
    expect(p.name).toBe("TestCV");
    expect(p.realm).toBe("asia");
    expect(p.shipId).toBe(4178556624);
    expect(p.team).toBe(0);
    expect(p.alive).toBe(true);
    expect(p.damage).toBe(96429);
    expect(p.damageTaken).toBe(67410);
    expect(p.hpRatio).toBeCloseTo(10, 5);
    expect(p.exp).toBe(910);
  });

  it("treats a sunk ship as full damage taken and 0% HP", () => {
    const data = parsePostBattle(
      payload(
        arr({
          1: "Sunk",
          15: 52600,
          20: 0, // remained_hp
          21: false,
          408: 2040518414, // killer_db_id
        }),
      ),
    );
    const p = data!.players[0];
    expect(p.alive).toBe(false);
    expect(p.damageTaken).toBe(52600);
    expect(p.hpRatio).toBe(0);
    expect(p.killerId).toBe(2040518414);
  });

  it("sums plane kills from planes_killed_by_ship + planes_killed_by_plane", () => {
    const data = parsePostBattle(
      payload(
        arr({
          280: 24, // planes_killed_by_ship
          281: 2, // planes_killed_by_plane
        }),
      ),
    );
    const plane = data!.players[0].ribbons.find((x) => x.key === "plane");
    expect(plane?.value).toBe(26);
  });

  it("aggregates main/secondary/torpedo/depth-charge counters", () => {
    const data = parsePostBattle(
      payload(
        arr({
          32: 2, // ships_killed → frag
          35: 10, 36: 3, 37: 69, // shots_main ap/cs/he → main_caliber_shots 82
          66: 4, 67: 1, 68: 27, // hits_main → main_caliber 32
          69: 2, 70: 5, 71: 38, // hits_atba (3 of the 6 slots)
          75: 13, // hits_tpd → torpedo
          87: 1, 96: 2, // hits_dbomb + airsupport → dbomb 3
        }),
      ),
    );
    const byKey = Object.fromEntries(data!.players[0].ribbons.map((x) => [x.key, x.value]));
    expect(byKey).toEqual({
      frag: 2,
      main_caliber: 32,
      main_caliber_shots: 82,
      secondary_caliber: 45,
      torpedo: 13,
      dbomb: 3,
    });
  });

  it("never maps first-spotting counts or bomb drops onto plane ribbons (290-planes regression)", () => {
    // Real 15.8 values for a CV: index 27 = first ships spotted by plane,
    // 45 = bombs dropped (the number users misread as ~290 planes down).
    const data = parsePostBattle(
      payload(
        arr({
          27: 5,
          45: 295,
          46: 295, // shots_bomb_avia (same drops, per-plane-family split)
        }),
      ),
    );
    expect(data!.players[0].ribbons).toEqual([]);
  });

  it("drops zero counters instead of rendering them", () => {
    const data = parsePostBattle(payload(arr({ 32: 3 })));
    expect(data!.players[0].ribbons).toEqual([{ key: "frag", value: 3 }]);
  });

  it("degrades gracefully on legacy short arrays (pre-15.x layouts)", () => {
    const data = parsePostBattle(
      payload(
        arr(
          {
            1: "Legacy",
            6: 1,
            15: 20000,
            20: 20000,
            21: true,
          },
          100,
        ),
      ),
    );
    const p = data!.players[0];
    expect(p.damage).toBe(0);
    expect(p.exp).toBeNull();
    expect(p.ribbons).toEqual([]);
    expect(p.damageTaken).toBe(0);
    expect(p.hpRatio).toBe(100);
  });

  it("parses mode, self id and the recorder's private settlement", () => {
    const data = parsePostBattle(payload(arr({ 1: "Self" })));
    expect(data!.mode).toBe("pvp_domination");
    expect(data!.selfId).toBe(42);
    expect(data!.selfCredits).toBe(1_250_000);
    expect(data!.selfExp).toBe(1450);
  });

  it("sorts players by damage and falls back to #id for non-string names", () => {
    const raw = JSON.stringify({
      playersPublicInfo: {
        7: arr({ 1: "LowDmg", 426: 1000 }),
        9: arr({ 426: 200000 }),
      },
    });
    const data = parsePostBattle(raw)!;
    expect(data.players.map((p) => p.name)).toEqual(["#9", "LowDmg"]);
    expect(data.players.map((p) => p.damage)).toEqual([200000, 1000]);
  });

  it("rejects malformed payloads", () => {
    expect(parsePostBattle(null)).toBeNull();
    expect(parsePostBattle("not json")).toBeNull();
    expect(parsePostBattle('{"playersPublicInfo": {}}')).toBeNull();
  });
});
