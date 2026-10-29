/** Pure helpers for the gateway-push live view: channel-route
 *  derivation/validation, tolerant parsing of `wowsp://gateway-battle`
 *  payloads, and the battle-frame → `ArenaInfo` mapping the phone renders
 *  through the EXISTING LiveBattlePanel (relation → teams, exactly like
 *  the local arena roster — no translation beyond stripping the envelope).
 *
 *  Everything here is pure so the mapping is unit-testable without a
 *  transport (see gatewayBattle.test.ts). */
import type { ArenaInfo, VehicleEntry, GatewayBattleEvent, GatewayBattleFrame } from "@/api";
import { GATEWAY_ROUTE_RE } from "@/api";

/** Build the gateway channel route `r:<realm>:<accountId>` (§2). The
 *  realm is lowercased defensively — WG realm codes are lowercase on the
 *  wire and the worker validates shape, not case-folding. */
export function gatewayRoute(realm: string, accountId: number): string {
  return "r:" + realm.trim().toLowerCase() + ":" + accountId;
}

/** Whether a string is a valid channel id (the worker's own shape rule). */
export function isGatewayRoute(route: string): boolean {
  return GATEWAY_ROUTE_RE.test(route);
}

/** Tolerant parse of one `wowsp://gateway-battle` payload into the known
 *  frame union — null for anything malformed or an unknown `type` (a
 *  newer server frame must never crash the live view; it is simply
 *  ignored). Never throws. */
export function parseGatewayBattleEvent(payload: unknown): GatewayBattleEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p.type === "host") {
    return { type: "host", online: Boolean(p.online) };
  }
  if (p.type === "bye") return { type: "bye" };
  if (p.type !== "battle") return null;
  const battle = p.battle;
  if (typeof battle !== "object" || battle === null) return null;
  const b = battle as Record<string, unknown>;
  const vehicles = Array.isArray(b.vehicles)
    ? b.vehicles.filter(
        (v): v is Record<string, unknown> =>
          typeof v === "object" &&
          v !== null &&
          typeof (v as Record<string, unknown>).name === "string",
      )
    : [];
  const self =
    typeof p.self === "object" && p.self !== null
      ? (p.self as Record<string, unknown>)
      : {};
  return {
    type: "battle",
    realm: typeof p.realm === "string" ? p.realm : "",
    route: typeof p.route === "string" ? p.route : "",
    self: {
      name: typeof self.name === "string" ? self.name : "",
      accountId: typeof self.accountId === "number" ? self.accountId : null,
    },
    battle: {
      dateTime: typeof b.dateTime === "string" ? b.dateTime : null,
      matchGroup: typeof b.matchGroup === "string" ? b.matchGroup : null,
      mapName: typeof b.mapName === "string" ? b.mapName : null,
      scenario: typeof b.scenario === "string" ? b.scenario : null,
      eventType: typeof b.eventType === "string" ? b.eventType : null,
      botCount: typeof b.botCount === "number" ? b.botCount : 0,
      scriptedUnitCount:
        typeof b.scriptedUnitCount === "number" ? b.scriptedUnitCount : 0,
      vehicles: vehicles.map((v) => ({
        id: typeof v.id === "number" ? v.id : 0,
        name: String(v.name ?? ""),
        relation: typeof v.relation === "number" ? v.relation : 2,
        shipId: typeof v.shipId === "number" ? v.shipId : 0,
        shipName: typeof v.shipName === "string" ? v.shipName : null,
      })),
    },
  };
}

/** Map a battle frame into the `ArenaInfo` shape the existing live
 *  components render. The frame's battle block mirrors the ArenaInfo head
 *  + VehicleEntry fields 1:1 minus `raw` (§3.3) — this is a structured
 *  copy (defaults filled), never a re-interpretation: `relation` keeps
 *  its arena meaning (0 = self, 1 = ally, 2+ = enemy) so
 *  splitLiveRosterSides/team derivation stays the local code path, and
 *  `dateTime` passes through in the game's own format (the battle clock
 *  parses it). `raw` carries the frame for diagnostics. */
export function arenaOfGatewayBattle(frame: GatewayBattleFrame): ArenaInfo {
  const vehicles: VehicleEntry[] = frame.battle.vehicles.map((v) => ({
    id: v.id,
    name: v.name,
    relation: v.relation,
    shipId: v.shipId,
    shipName: v.shipName ?? null,
  }));
  return {
    matchGroup: frame.battle.matchGroup ?? null,
    dateTime: frame.battle.dateTime ?? null,
    mapName: frame.battle.mapName ?? null,
    scenario: frame.battle.scenario ?? null,
    eventType: frame.battle.eventType ?? null,
    botCount: frame.battle.botCount ?? 0,
    scriptedUnitCount: frame.battle.scriptedUnitCount ?? 0,
    vehicles,
    raw: frame,
  };
}
