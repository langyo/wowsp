/** Gateway battle-frame helpers: channel-route build/validate, the
 *  tolerant event parser (battle / host / bye / unknown), and the
 *  battle-frame → ArenaInfo mapping the live panel renders. */
import { describe, expect, it } from "vitest";

import type { GatewayBattleFrame } from "@/api";
import {
  arenaOfGatewayBattle,
  gatewayRoute,
  isGatewayRoute,
  parseGatewayBattleEvent,
} from "./gatewayBattle";

describe("gatewayRoute", () => {
  it("builds the r:<realm>:<accountId> channel id, lowercasing the realm", () => {
    expect(gatewayRoute("asia", 123456)).toBe("r:asia:123456");
    expect(gatewayRoute("ASIA", 123456)).toBe("r:asia:123456");
    expect(gatewayRoute(" eu ", 42)).toBe("r:eu:42");
  });

  it("validates the worker's channel shape", () => {
    expect(isGatewayRoute("r:asia:123456")).toBe(true);
    expect(isGatewayRoute("r:na:1")).toBe(true);
    expect(isGatewayRoute("r:toolongrealm:1")).toBe(false);
    expect(isGatewayRoute("asia:123456")).toBe(false);
    expect(isGatewayRoute("r:asia:abc")).toBe(false);
    expect(isGatewayRoute("")).toBe(false);
  });
});

describe("parseGatewayBattleEvent", () => {
  it("parses a battle frame 1:1 (head + vehicles)", () => {
    const frame = parseGatewayBattleEvent({
      type: "battle",
      realm: "asia",
      route: "r:asia:123",
      self: { name: "Tester", accountId: 123 },
      battle: {
        dateTime: "29.10.2026 22:00:00",
        matchGroup: "pvp",
        mapName: "14_ATL_NavalBase",
        scenario: "",
        eventType: "",
        botCount: 0,
        scriptedUnitCount: 0,
        vehicles: [
          { id: 123, name: "Tester", relation: 0, shipId: 4189570000, shipName: "Yamato" },
          { id: 1, name: "Ally", relation: 1, shipId: 1, shipName: "Gearing" },
          { id: 2, name: "Enemy", relation: 2, shipId: 2 },
        ],
      },
    });
    expect(frame).not.toBeNull();
    expect(frame?.type).toBe("battle");
    if (frame?.type !== "battle") return;
    expect(frame.battle.matchGroup).toBe("pvp");
    expect(frame.battle.vehicles).toHaveLength(3);
    expect(frame.battle.vehicles[2].shipName).toBeNull();
  });

  it("parses host presence and bye frames", () => {
    expect(parseGatewayBattleEvent({ type: "host", online: true })).toEqual({
      type: "host",
      online: true,
    });
    expect(parseGatewayBattleEvent({ type: "host", online: 0 })).toEqual({
      type: "host",
      online: false,
    });
    expect(parseGatewayBattleEvent({ type: "bye" })).toEqual({ type: "bye" });
  });

  it("ignores malformed payloads and unknown types instead of throwing", () => {
    expect(parseGatewayBattleEvent(null)).toBeNull();
    expect(parseGatewayBattleEvent("battle")).toBeNull();
    expect(parseGatewayBattleEvent({ type: "future-frame" })).toBeNull();
    expect(parseGatewayBattleEvent({ type: "battle" })).toBeNull();
    expect(parseGatewayBattleEvent({ type: "battle", battle: "nope" })).toBeNull();
    expect(
      parseGatewayBattleEvent({
        type: "battle",
        battle: { vehicles: [{ name: "ok" }, null, 7] },
      }),
    ).toMatchObject({ type: "battle", battle: { vehicles: [{ name: "ok" }] } });
  });
});

describe("arenaOfGatewayBattle", () => {
  const frame: GatewayBattleFrame = {
    type: "battle",
    realm: "asia",
    route: "r:asia:123",
    self: { name: "Tester", accountId: 123 },
    battle: {
      dateTime: "29.10.2026 22:00:00",
      matchGroup: "pvp",
      mapName: "14_ATL_NavalBase",
      scenario: null,
      eventType: null,
      botCount: 0,
      scriptedUnitCount: 0,
      vehicles: [
        { id: 123, name: "Tester", relation: 0, shipId: 10, shipName: "Yamato" },
        { id: 1, name: "Ally", relation: 1, shipId: 11 },
        { id: 2, name: "Enemy", relation: 2, shipId: 12 },
      ],
    },
  };

  it("maps the head fields and fills ArenaInfo defaults", () => {
    const arena = arenaOfGatewayBattle(frame);
    expect(arena.matchGroup).toBe("pvp");
    expect(arena.mapName).toBe("14_ATL_NavalBase");
    expect(arena.dateTime).toBe("29.10.2026 22:00:00");
    expect(arena.botCount).toBe(0);
    expect(arena.scenario).toBeNull();
    expect(arena.vehicles).toHaveLength(3);
  });

  it("keeps relation semantics untouched so teams derive locally", () => {
    const arena = arenaOfGatewayBattle(frame);
    expect(arena.vehicles.map((v) => v.relation)).toEqual([0, 1, 2]);
    expect(arena.vehicles[1].shipName).toBeNull();
    expect(arena.vehicles[0].name).toBe("Tester");
  });

  it("carries the frame as raw for diagnostics", () => {
    expect(arenaOfGatewayBattle(frame).raw).toBe(frame);
  });
});
