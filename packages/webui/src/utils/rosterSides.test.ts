/** Tests for the roster side split: scripted scenario NPCs (the story-mode
 *  `IDS_*` ally flagships / `#Name` units) must never appear in a player
 *  list, while the `:Name:` co-op bot fills stay listed; operations drop
 *  the enemy side entirely. Roster shapes come from the live 360-server
 *  story replays (PCVO010_OP_09_s09_LePVE, LOW_LVL_OPERATION_3_LVL_5A) and
 *  the vendored operation fixtures. */
import { describe, expect, it } from "vitest";

import { isListedPlayer, splitRosterSides } from "./rosterSides";
import { isScriptedUnitName } from "./aiNames";

const veh = (name: string, relation: number) => ({ id: 1, name, relation });

describe("isScriptedUnitName", () => {
  it("matches text-key and #Name scenario nicknames", () => {
    expect(isScriptedUnitName("IDS_OP_09_FLAGMAN_NAME")).toBe(true);
    expect(isScriptedUnitName("IDS_OP_17_ALLY_FLAGSHIP_CV")).toBe(true);
    expect(isScriptedUnitName("IDS_SCENARIO_TRANSPORT_1")).toBe(true);
    expect(isScriptedUnitName("#Scripted")).toBe(true);
  });

  it("keeps human and colon-bot nicknames listed", () => {
    expect(isScriptedUnitName("ShigureKira")).toBe(false);
    expect(isScriptedUnitName(":Sturdee:")).toBe(false);
    // IDs inside the name, but not leading — a legal account nickname.
    expect(isScriptedUnitName("Player_1125394906")).toBe(false);
  });
});

describe("isListedPlayer", () => {
  it("is the negation of the scripted marker", () => {
    expect(isListedPlayer(veh("Kuaile722", 1))).toBe(true);
    expect(isListedPlayer(veh(":WGR_bot:", 2))).toBe(true);
    expect(isListedPlayer(veh("IDS_OP_09_FLAGMAN_NAME", 1))).toBe(false);
  });
});

describe("splitRosterSides", () => {
  it("drops the story-mode scripted ally from the allies list", () => {
    // 20261006_160516_PZSC106-Rahmat_s09_LePVE.wowsreplay (excerpt): 7
    // humans plus the IDS_OP_09 flagship NPC, all relation ≤ 1, no enemy
    // entries.
    const roster = [
      veh("Kuaile722", 1),
      veh("Vinsell", 1),
      veh("ShigureKira", 0),
      veh("IDS_OP_09_FLAGMAN_NAME", 1),
    ];
    const sides = splitRosterSides(roster, true);
    expect(sides.allies.map((v) => v.name)).toEqual([
      "Kuaile722",
      "Vinsell",
      "ShigureKira",
    ]);
    expect(sides.enemies).toEqual([]);
  });

  it("drops the escort-op scripted allies in the two-team layout", () => {
    // 20261006_162153_PZSC106-Rahmat_13_OC_new_dawn.wowsreplay
    // (LOW_LVL_OPERATION_3): the non-operation two-column layout, with the
    // IDS_OP_17 flagship pair riding the ally block.
    const roster = [
      veh("Stella_Palace", 1),
      veh("ShigureKira", 0),
      veh("IDS_OP_17_ALLY_FLAGSHIP", 1),
      veh("IDS_OP_17_ALLY_FLAGSHIP_CV", 1),
    ];
    const sides = splitRosterSides(roster, false);
    expect(sides.allies.map((v) => v.name)).toEqual([
      "Stella_Palace",
      "ShigureKira",
    ]);
    expect(sides.enemies).toEqual([]);
  });

  it("drops scripted enemies but keeps colon-bot co-op fills", () => {
    const roster = [
      veh("ShigureKira", 0),
      veh(":WGR_bot:", 1),
      veh(":Sturdee:", 2),
      veh("IDS_OP_02_03_AT_TRANSPORT_A_1", 2),
    ];
    const sides = splitRosterSides(roster, false);
    expect(sides.allies.map((v) => v.name)).toEqual([
      "ShigureKira",
      ":WGR_bot:",
    ]);
    expect(sides.enemies.map((v) => v.name)).toEqual([":Sturdee:"]);
  });

  it("empties the enemy side for operations after the scripted filter", () => {
    const roster = [
      veh("ShigureKira", 0),
      veh("IDS_SCENARIO_WAVE_1", 2),
    ];
    expect(splitRosterSides(roster, true).enemies).toEqual([]);
    // The same roster in a two-team context still filters the scripted unit.
    expect(splitRosterSides(roster, false).enemies).toEqual([]);
  });

  it("never returns an empty allies list (the recorder is always listed)", () => {
    const roster = [veh("ShigureKira", 0), veh("IDS_EN_01", 1)];
    const sides = splitRosterSides(roster, true);
    expect(sides.allies).toHaveLength(1);
  });

  it("does not mutate the input roster", () => {
    const roster = [veh("IDS_EN_01", 1), veh("ShigureKira", 0)];
    splitRosterSides(roster, false);
    expect(roster).toHaveLength(2);
  });
});
