/**
 * reportSheet tests — the pure roster join the report sheet hands to the
 * perspective picker.
 *
 * The fixture pins the FAILURE MODE this join exists for: a replay
 * descriptor's `vehicles[].id`s are arena/account ids in a ~5.3e8 number
 * space, while the STATIC REPORT's `roster[].entityId`s are BigWorld stream
 * ids. The old face map was keyed by the descriptor ids, so the picker's
 * `report.roster[]` lookups never matched — every row drew its blue/red
 * fallback dot, showed no clan and no ship line (2026-11-07 report). The
 * builder must key strictly by the report's own roster ids and resolve the
 * ship off `row.shipId`.
 */
import { describe, expect, it } from "vitest";

import type { DogTag, ShipInfo, StaticReport, StaticRosterEntry } from "@/api";
import {
  buildReportRosterFaces,
  type ReportRosterFaceResolver,
} from "./reportSheet";

/** BigWorld stream entity ids — the report roster's / picker's key space. */
const RECORDER_ENTITY = 2_969_286;
const MATE_ENTITY = 2_969_287;
const FOE_ENTITY = 2_969_288;

/** Descriptor-roster / arena account ids (~5.3e8) of the kind a replay's
 *  `vehicles[].id`s carry. The OLD join keyed faces by these; the helper
 *  must never produce one as a face key. */
const DESCRIPTOR_VEHICLE_IDS = [530_915_423, 530_915_424, 530_915_425];

/** Real ids off data/ship_names.json (PASD002 Sampson, PASC002 Chester) so
 *  the fixture exercises the same number space the app resolves. */
const SAMPSON_ID = 4_292_753_392;
const CHESTER_ID = 4_292_786_160;
/** An id neither the encyclopedia stub nor the baked-DB stubs know. */
const UNKNOWN_SHIP_ID = 4_000_000_001;

const DOG_TAG: DogTag = {
  textureId: 1,
  symbolId: 2,
  borderColor: 0xff000000,
  backgroundColor: 0xff001122,
  backgroundId: 3,
};

function ship(overrides: Partial<ShipInfo> = {}): ShipInfo {
  return {
    shipId: SAMPSON_ID,
    name: "Sampson",
    tier: 10,
    type: "Destroyer",
    nation: "usa",
    isPremium: false,
    isSpecial: false,
    description: "",
    gameVersion: "0.0.0",
    defaultProfile: null,
    images: { small: "", medium: "", large: "", contour: "" },
    ...overrides,
  };
}

function rosterEntry(overrides: Partial<StaticRosterEntry>): StaticRosterEntry {
  return {
    entityId: 1,
    shipId: null,
    name: null,
    playerName: null,
    teamId: 0,
    isRecorder: false,
    diedAt: null,
    coverage: {
      aliveFrom: 0,
      aliveTo: 600,
      samples: 40,
      gapSeconds: 0,
      completeness: 0.97,
      gapSegments: [],
    },
    whole: null,
    outcome: null,
    ...overrides,
  };
}

function report(roster: StaticRosterEntry[]): StaticReport {
  return {
    replayPath: "replays/20261107_1.wowsreplay",
    replayId: "20261107_1",
    mapName: "spaces/15_NE_north",
    gameMode: "Domination",
    durationS: 600,
    losLoaded: false,
    modelSources: { fire: "models/fire.onnx", moveModel: "models/move.onnx" },
    entityId: RECORDER_ENTITY,
    roster,
    timeline: [],
    moments: [],
  };
}

/** The three roster rows the join tests share: the recorder's Sampson (an
 *  encyclopedia HIT), a Chester the encyclopedia has not loaded yet (a
 *  baked-DB fallback) and an entirely unknown hull. `name` is the
 *  ship-name-preferred display name the Rust resolver fills, `playerName`
 *  the player nickname the stats batch is keyed by. */
function sampleRoster(): StaticRosterEntry[] {
  return [
    rosterEntry({
      entityId: RECORDER_ENTITY,
      shipId: SAMPSON_ID,
      name: "Sampson",
      playerName: "alice",
      isRecorder: true,
    }),
    rosterEntry({
      entityId: MATE_ENTITY,
      shipId: CHESTER_ID,
      name: "Chester",
      playerName: "bob",
    }),
    rosterEntry({
      entityId: FOE_ENTITY,
      shipId: UNKNOWN_SHIP_ID,
      name: "unknown hull",
      playerName: "carol",
      teamId: 1,
    }),
  ];
}

/** The live-store bindings, stubbed: the encyclopedia knows Sampson only,
 *  the baked-DB fallbacks know both real ids, and the stats batch answers
 *  clan tag + emblem per player nickname. */
function resolver(
  overrides: Partial<ReportRosterFaceResolver> = {},
): ReportRosterFaceResolver {
  const encyclopedia = new Map<number, ShipInfo>([
    [SAMPSON_ID, ship()],
  ]);
  const stats: Record<
    string,
    { clanTag: string | null; dogTag: DogTag | null }
  > = {
    alice: { clanTag: "HOOD", dogTag: DOG_TAG },
    bob: { clanTag: "ABC", dogTag: null },
  };
  return {
    shipOf: (shipId) => encyclopedia.get(shipId) ?? null,
    shipDisplayName: (s) => s.name,
    shipTypeOf: (shipId) =>
      shipId === SAMPSON_ID ? "Destroyer" : shipId === CHESTER_ID ? "Cruiser" : "",
    shipTierOf: (shipId) =>
      shipId === SAMPSON_ID ? 10 : shipId === CHESTER_ID ? 2 : null,
    shipNameOf: (shipId, language) =>
      shipId === CHESTER_ID && language === "zh-CN" ? "切斯特" : "",
    language: "zh-CN",
    statOf: (playerName) => stats[playerName] ?? null,
    ...overrides,
  };
}

describe("buildReportRosterFaces", () => {
  it("keys faces by the report roster's entity ids, never a descriptor vehicle id", () => {
    const faces = buildReportRosterFaces(report(sampleRoster()), resolver());
    expect(faces.size).toBe(3);
    expect([...faces.keys()].sort()).toEqual(
      [RECORDER_ENTITY, MATE_ENTITY, FOE_ENTITY].sort(),
    );
    // The 2026-11-07 regression: the descriptor/arena id space must not
    // leak into the face keys — that is exactly what broke the lookup.
    for (const descriptorId of DESCRIPTOR_VEHICLE_IDS) {
      expect(faces.has(descriptorId)).toBe(false);
    }
  });

  it("fills the ship face from the encyclopedia and clan/emblem from the stats batch", () => {
    const faces = buildReportRosterFaces(report(sampleRoster()), resolver());
    expect(faces.get(RECORDER_ENTITY)).toEqual({
      clanTag: "HOOD",
      dogTag: DOG_TAG,
      shipType: "Destroyer",
      shipName: "Sampson",
      tier: 10,
    });
  });

  it("falls back to the baked ship DB while the encyclopedia realm is loading", () => {
    // Chester is absent from the encyclopedia stub (the async load has not
    // landed); the baked-DB callbacks must still answer class/tier/name in
    // the configured language, or the row would lose its whole ship column.
    const faces = buildReportRosterFaces(report(sampleRoster()), resolver());
    expect(faces.get(MATE_ENTITY)).toEqual({
      clanTag: "ABC",
      dogTag: null,
      shipType: "Cruiser",
      shipName: "切斯特",
      tier: 2,
    });
  });

  it("leaves a hull no source knows null for the picker's neutral dash", () => {
    const faces = buildReportRosterFaces(
      report([
        ...sampleRoster(),
        // A null shipId (the exporter could not attribute this hull) is the
        // same unknown case and must not throw or invent a ship.
        rosterEntry({ entityId: 42, shipId: null, name: "ghost" }),
      ]),
      resolver(),
    );
    expect(faces.get(FOE_ENTITY)).toEqual({
      clanTag: null,
      dogTag: null,
      shipType: null,
      shipName: null,
      tier: null,
    });
    expect(faces.get(42)).toEqual({
      clanTag: null,
      dogTag: null,
      shipType: null,
      shipName: null,
      tier: null,
    });
  });

  it("joins the clan tag on the player nickname, with the display name as fallback", () => {
    const asked: string[] = [];
    const spy = resolver({
      statOf: (playerName) => {
        asked.push(playerName);
        return null;
      },
    });
    buildReportRosterFaces(
      report([
        rosterEntry({
          entityId: RECORDER_ENTITY,
          name: "Sampson",
          playerName: "alice",
        }),
        // A shell that predates playerName: the display-facing name is then
        // the only nickname candidate, so it must be used rather than "".
        rosterEntry({ entityId: MATE_ENTITY, name: "bob", playerName: null }),
      ]),
      spy,
    );
    expect(asked).toEqual(["alice", "bob"]);
  });

  it("answers an empty map when no report is open", () => {
    expect(buildReportRosterFaces(null, resolver()).size).toBe(0);
    expect(buildReportRosterFaces(undefined, resolver()).size).toBe(0);
  });
});
