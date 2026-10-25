/**
 * Tests for the live self-combat model (我的战绩 data layer).
 *
 * The scenarios below pin the behaviors the panel depends on:
 *  - self identity via the arena join (isSelf), with the roster as fallback;
 *  - dealt/received attribution off shot impacts + victim HP deltas (the
 *    same 500 m / ±window heuristic the replay review view uses);
 *  - frag credit by death proximity, then the BattleResults re-stamp;
 *  - totals preferring the server's damage stream over the heuristic sum;
 *  - the final merge (authoritative figures, my killer, DoT-only kills).
 */
import { describe, expect, it } from "vitest";

import type {
  EntityTrajectory,
  ReplayStream,
  ShellLaunchEvent,
  ShotKillEvent,
  TorpedoLaunch,
  VehicleEntry,
} from "@/api";
import { buildSelfStats, type BuildSelfStatsInput } from "./liveSelfStats";

/** The stream slice the model consumes, launch joins included. */
type TestStream = Pick<
  ReplayStream,
  | "trajectories"
  | "recorderVehicleId"
  | "shotKills"
  | "damageStats"
  | "achievements"
  | "arenaPlayers"
  | "battleResults"
  | "shellLaunches"
  | "torpedoes"
>;

function traj(
  entityId: number,
  shipId: number,
  pos: { x: number; z: number },
  hp: { time: number; value: number }[],
  deathTime?: number,
): EntityTrajectory {
  const samples = hp.map((h) => ({
    time: h.time,
    entityId,
    vehicleId: 0,
    x: pos.x,
    y: 0,
    z: pos.z,
    yaw: 0,
  }));
  return {
    entityId,
    kind: { entityType: 2, vehicleId: 0, initialX: pos.x, initialY: 0, initialZ: pos.z, creationTime: 0, shipId },
    samples,
    hpSamples: hp,
    ...(deathTime != null ? { deathTime } : {}),
  };
}

function impact(time: number, ownerId: number, x: number, z: number): ShotKillEvent {
  return { time, ownerId, hitType: 100, shotId: 1, x, y: 0, z };
}

const ROSTER: VehicleEntry[] = [
  { id: 77, name: "Me", relation: 0, shipId: 101, shipName: "SelfShip" },
  { id: 88, name: "Victim", relation: 2, shipId: 102, shipName: "EnemyShip" },
  { id: 99, name: "Attacker", relation: 2, shipId: 103, shipName: "EnemyShip2" },
];

const ARENA_PLAYERS = [
  { entityId: 10, teamId: 0, playerId: 77, shipParamsId: 101, maxHealth: 50000, name: "Me", isBot: false, avatarId: null, isSelf: true },
  { entityId: 20, teamId: 1, playerId: 88, shipParamsId: 102, maxHealth: 40000, name: "Victim", isBot: false, avatarId: null, isSelf: false },
  { entityId: 30, teamId: 1, playerId: 99, shipParamsId: 103, maxHealth: 30000, name: "Attacker", isBot: false, avatarId: null, isSelf: false },
];

function baseStream(): TestStream {
  return {
    trajectories: [
      traj(10, 101, { x: 0, z: 0 }, [
        { time: 0, value: 50000 },
        { time: 14, value: 50000 },
        { time: 15, value: 46000 },
        { time: 30, value: 46000 },
      ]),
      traj(20, 102, { x: 900, z: 0 }, [
        { time: 0, value: 40000 },
        { time: 10, value: 40000 },
        { time: 11, value: 36000 },
        { time: 30, value: 36000 },
      ], 11.6),
      traj(30, 103, { x: 200, z: 500 }, [
        { time: 0, value: 30000 },
        { time: 30, value: 30000 },
      ]),
    ],
    shotKills: [
      // My hit near Victim (x=900) at t=11: HP 40000→36000 across the window.
      impact(11, 10, 905, 5),
      // Attacker's hit near me at t=15: HP 50000→46000.
      impact(15, 30, 10, 8),
    ],
    damageStats: [],
    achievements: [],
    arenaPlayers: ARENA_PLAYERS,
    battleResults: null,
  };
}

function build(stream: TestStream) {
  return buildSelfStats({ stream, roster: ROSTER, dataLang: "en-US" } satisfies BuildSelfStatsInput);
}

function shellLaunch(ownerId: number, shotId: number): ShellLaunchEvent {
  return {
    time: 1,
    ownerId,
    paramsId: 1,
    salvoId: 1,
    shotId,
    x: 0,
    y: 0,
    z: 0,
    targetX: 0,
    targetY: 0,
    targetZ: 0,
    serverTimeLeft: 0,
    speed: 800,
    gunBarrelId: 0,
  };
}

function torpedoLaunch(ownerId: number, shotId: number): TorpedoLaunch {
  return {
    time: 1,
    ownerId,
    paramsId: 2,
    salvoId: 1,
    shotId,
    x: 0,
    y: 0,
    z: 0,
    dirX: 1,
    dirY: 0,
    dirZ: 0,
    armed: true,
  };
}

describe("buildSelfStats", () => {
  it("resolves self via the arena join and attributes dealt damage by hit + HP delta", () => {
    const m = build(baseStream());
    expect(m).not.toBeNull();
    expect(m!.selfPlayerId).toBe(77);
    expect(m!.selfEntityId).toBe(10);
    expect(m!.damageSource).toBe("heuristic");
    const dealt = m!.dealt.find((r) => r.entityId === 20);
    expect(dealt).toBeDefined();
    expect(dealt!.damage).toBe(4000);
    expect(dealt!.name).toBe("Victim");
    expect(dealt!.killed).toBe(true); // death 11.6 within 1.2 s of impact 11
    expect(m!.frags).toBe(1);
  });

  it("attributes received damage to the firing ship when the impact lands near me", () => {
    const m = build(baseStream());
    const rec = m!.received.find((r) => r.entityId === 30);
    expect(rec).toBeDefined();
    expect(rec!.damage).toBe(4000);
    expect(rec!.name).toBe("Attacker");
    // My own hull: 50000 → 46000.
    expect(m!.taken).toBe(4000);
    expect(m!.hpRatio).toBeCloseTo(92, 5);
    expect(m!.sunk).toBe(false);
  });

  it("prefers the server damage stream for totals while keeping per-target rows", () => {
    const stream = baseStream();
    stream.damageStats = [{ time: 20, weapon: 1, category: 0, count: 6, total: 5123 }];
    const m = build(stream);
    expect(m!.damageSource).toBe("server");
    expect(m!.damage).toBe(5123);
    // Hits ride the impact stream when the ship entity is known (the
    // server dict counts damage-dealing hits only — field calibration
    // 2026-10-08 measured 63 vs the game's 73 on a real Lesta battle);
    // baseStream has one self impact near the live victim.
    expect(m!.hits).toBe(1);
    expect(m!.dealt.find((r) => r.entityId === 20)!.damage).toBe(4000);
  });

  it("falls back to the server dict's hit counts without a ship entity", () => {
    // No self ship entity yet (still loading): the dict counts are the
    // only hit signal available.
    const stream = baseStream();
    stream.damageStats = [{ time: 20, weapon: 1, category: 0, count: 6, total: 5123 }];
    stream.trajectories = [];
    const m = build(stream);
    expect(m!.selfEntityId).toBeNull();
    expect(m!.hits).toBe(6);
  });

  it("localizes my achievements only", () => {
    const stream = baseStream();
    stream.achievements = [
      { time: 5, playerId: 77, achievementId: 4293059504 },
      { time: 6, playerId: 88, achievementId: 4293059504 },
    ];
    const m = build(stream);
    expect(m!.achievements.length).toBe(1);
    expect(m!.achievements[0].name).toBe("Double Strike");
    expect(m!.achievements[0].grade).toBe("honorable");
  });

  it("merges BattleResults as authoritative: totals, killer, kill flags, DoT-only kills", () => {
    const stream = baseStream();
    // Remove my shot at Victim so the kill is DoT-only (no attributed row).
    stream.shotKills = [impact(15, 30, 10, 8)];
    // A helper is cleaner than hand-writing 500-entry arrays twice — patch
    // the late indices (legacy layout shift does not apply at len 538).
    const mk = (name: string, id: number, shipId: number, damage: number, remained: number, alive: boolean, frags: number, killerId: number | null, exp: number): unknown[] => {
      const a: unknown[] = new Array(538).fill(0);
      a[1] = name; a[6] = id === 77 ? 0 : 1; a[7] = shipId; a[9] = "asia";
      a[15] = 50000; a[20] = remained; a[21] = alive; a[32] = frags;
      a[404] = exp; a[408] = killerId; a[426] = damage;
      return a;
    };
    stream.battleResults = JSON.stringify({
      accountDBID: 77,
      playersPublicInfo: {
        77: mk("Me", 77, 101, 29999, 0, false, 1, 55, 1800),
        55: mk("Killer", 55, 103, 8000, 30000, true, 0, null, 1200),
        88: mk("Victim", 88, 102, 2000, 0, false, 0, 77, 900),
      },
    });
    const m = build(stream);
    expect(m!.final).not.toBeNull();
    expect(m!.damage).toBe(29999);
    expect(m!.taken).toBe(50000);
    expect(m!.sunk).toBe(true);
    expect(m!.frags).toBe(1);
    expect(m!.final!.killerName).toBe("Killer");
    expect(m!.final!.exp).toBe(1800);
    // DoT-only kill: Victim was never hit-attributed, but the results credit
    // the sink to me — a bare killed row appears.
    const victimRow = m!.dealt.find((r) => r.name === "Victim");
    expect(victimRow).toBeDefined();
    expect(victimRow!.killed).toBe(true);
  });

  it("stamps an anonymous heuristic kill row instead of duplicating it", () => {
    // No arena join → the death-proximity kill lands as an anonymous row;
    // BattleResults must stamp its identity, not append a second one.
    const stream = baseStream();
    stream.arenaPlayers = [];
    const mk = (name: string, team: number, shipId: number, killerId: number | null): unknown[] => {
      const a: unknown[] = new Array(538).fill(0);
      a[1] = name; a[6] = team; a[7] = shipId; a[9] = "asia";
      a[15] = 40000; a[20] = 0; a[21] = false; a[32] = 0;
      a[408] = killerId; a[426] = 1000;
      return a;
    };
    stream.battleResults = JSON.stringify({
      accountDBID: 77,
      playersPublicInfo: {
        77: mk("Me", 0, 101, null),
        88: mk("Victim", 1, 102, 77),
      },
    });
    const m = build(stream);
    const rows = m!.dealt.filter((r) => r.name === "Victim");
    expect(rows.length).toBe(1);
    expect(rows[0].killed).toBe(true);
    expect(rows[0].playerId).toBe(88);
  });

  it("surfaces server totals before the recorder's ship entity appears", () => {
    // Loading-screen shape: damage stream already flowing, no trajectories.
    const stream = baseStream();
    stream.trajectories = [];
    stream.shotKills = [];
    stream.arenaPlayers = [];
    stream.damageStats = [{ time: 3, weapon: 1, category: 0, count: 2, total: 800 }];
    const m = build(stream);
    expect(m).not.toBeNull();
    expect(m!.damageSource).toBe("server");
    expect(m!.damage).toBe(800);
    expect(m!.hits).toBe(2);
    expect(m!.dealt).toEqual([]);
  });

  it("falls back to the roster's relation-0 player without the arena join", () => {
    const stream = baseStream();
    stream.arenaPlayers = [];
    const m = build(stream);
    expect(m).not.toBeNull();
    expect(m!.selfPlayerId).toBe(77);
    // Unique shipId join finds my trajectory.
    expect(m!.selfEntityId).toBe(10);
    expect(m!.dealt.find((r) => r.entityId === 20)).toBeDefined();
  });

  it("returns null when nothing identifies the recorder", () => {
    const stream = baseStream();
    stream.arenaPlayers = [];
    const m = buildSelfStats({
      stream,
      roster: ROSTER.map((v) => ({ ...v, relation: 2 })),
      dataLang: "en-US",
    });
    expect(m).toBeNull();
  });

  it("keeps known allies out of the dealt ledger and the heuristic total", () => {
    // The 2026-10-09 co-op shape: my splash grazes a TEAMMATE (Stenga) —
    // the attributed HP drop is friendly fire / graze noise, not damage
    // dealt, and an ally row must not render inside the enemies-only list.
    const ally = traj(40, 104, { x: 1800, z: 0 }, [
      { time: 0, value: 20000 },
      { time: 11, value: 20000 },
      { time: 12, value: 17000 },
      { time: 30, value: 17000 },
    ]);
    const stream = baseStream();
    stream.trajectories = [...stream.trajectories, ally];
    stream.shotKills = [
      impact(11, 10, 905, 5),
      impact(12, 10, 1805, 0), // near the ally
      impact(15, 30, 10, 8),
    ];
    const roster: VehicleEntry[] = [
      ...ROSTER,
      { id: 111, name: "Stenga", relation: 1, shipId: 104, shipName: "AllyShip" },
    ];
    const arena = [
      ...ARENA_PLAYERS,
      { entityId: 40, teamId: 0, playerId: 111, shipParamsId: 104, maxHealth: 20000, name: "Stenga", isBot: false, avatarId: null, isSelf: false },
    ];
    stream.arenaPlayers = arena;
    const m = buildSelfStats({ stream, roster, dataLang: "en-US" });
    expect(m).not.toBeNull();
    expect(m!.dealt.find((r) => r.entityId === 40)).toBeUndefined();
    // The heuristic fallback total counts enemy-side damage only.
    expect(m!.damage).toBe(4000);
    expect(m!.damageSource).toBe("heuristic");
    // The received ledger keeps its sources (a teammate hurting me is
    // real information there).
    expect(m!.received.find((r) => r.entityId === 30)).toBeDefined();
  });

  it("splits attributed damage by the launch join (shell / torpedo / other)", () => {
    const second = traj(50, 105, { x: 3000, z: 0 }, [
      { time: 0, value: 25000 },
      { time: 10, value: 25000 },
      { time: 12, value: 22000 },
      { time: 30, value: 22000 },
    ]);
    const stream = baseStream();
    stream.trajectories = [...stream.trajectories, second];
    stream.shotKills = [
      // shell (shotId 5) near Victim, torpedo (shotId 6) near the second
      // enemy, unlaunched shotId 1 attacker hit near me.
      { time: 11, ownerId: 10, hitType: 100, shotId: 5, x: 905, y: 0, z: 5 },
      { time: 12, ownerId: 10, hitType: 100, shotId: 6, x: 3005, y: 0, z: 0 },
      impact(15, 30, 10, 8),
    ];
    stream.shellLaunches = [shellLaunch(10, 5)];
    stream.torpedoes = [torpedoLaunch(10, 6), torpedoLaunch(30, 9)];
    const roster: VehicleEntry[] = [
      ...ROSTER,
      { id: 122, name: "Enemy2", relation: 2, shipId: 105, shipName: "EnemyShip3" },
    ];
    const arena = [
      ...ARENA_PLAYERS,
      { entityId: 50, teamId: 1, playerId: 122, shipParamsId: 105, maxHealth: 25000, name: "Enemy2", isBot: false, avatarId: null, isSelf: false },
    ];
    stream.arenaPlayers = arena;
    const m = buildSelfStats({ stream, roster, dataLang: "en-US" });
    expect(m).not.toBeNull();
    const shellRow = m!.dealt.find((r) => r.entityId === 20);
    expect(shellRow!.comp).toEqual({ shell: 4000 });
    const torpedoRow = m!.dealt.find((r) => r.entityId === 50);
    expect(torpedoRow!.comp).toEqual({ torpedo: 3000 });
    // The attacker's hit near me rode no launch of theirs → other.
    const rec = m!.received.find((r) => r.entityId === 30);
    expect(rec!.comp).toEqual({ other: 4000 });
  });

  it("anchors the self trajectory on the recorder vehicle link when the arena join misses", () => {
    // The 15.9.0 drift shape: the arena's isSelf entry exists (identity
    // fields readable) but its entity slot misreads — no trajectory joins,
    // and the drift also poisons shipParamsId. The recorder's own vehicle
    // link must anchor the trajectory and the kind's shipId restores the
    // ship identity.
    const stream = baseStream();
    stream.recorderVehicleId = 10;
    stream.arenaPlayers = ARENA_PLAYERS.map((p) =>
      p.isSelf ? { ...p, entityId: 9999, shipParamsId: 9999 } : p,
    );
    const m = build(stream);
    expect(m).not.toBeNull();
    expect(m!.selfEntityId).toBe(10);
    expect(m!.selfPlayerId).toBe(77);
    expect(m!.selfName).toBe("Me");
    expect(m!.selfShipId).toBe(101);
    // Both ledgers attribute as usual off the anchored trajectory.
    expect(m!.dealt.find((r) => r.entityId === 20)!.damage).toBe(4000);
    expect(m!.received.find((r) => r.entityId === 30)!.damage).toBe(4000);
  });

  it("settles mirror shipId picks with the recorder vehicle link", () => {
    // Two entities share the relation-0 shipId (an enemy mirror pick, both
    // listed in the roster): the unique-shipId join stands down, and the
    // recorder link decides which trajectory is mine.
    const mirror = traj(60, 101, { x: 4000, z: 0 }, [
      { time: 0, value: 50000 },
      { time: 10, value: 50000 },
      { time: 11, value: 44000 },
      { time: 30, value: 44000 },
    ]);
    const stream = baseStream();
    stream.arenaPlayers = [];
    stream.recorderVehicleId = 10;
    stream.trajectories = [...stream.trajectories, mirror];
    stream.shotKills = [
      impact(11, 10, 905, 5),
      impact(11, 10, 4005, 0), // my hit near the mirror hull
      impact(15, 30, 10, 8),
    ];
    stream.achievements = [{ time: 5, playerId: 77, achievementId: 4293059504 }];
    const roster: VehicleEntry[] = [
      ...ROSTER,
      { id: 200, name: "MirrorFoe", relation: 2, shipId: 101, shipName: "SelfShip" },
    ];
    const m = buildSelfStats({ stream, roster, dataLang: "en-US" });
    expect(m).not.toBeNull();
    expect(m!.selfEntityId).toBe(10);
    // The recorder anchor settled the trajectory, but the roster fallback
    // still owes the identity: name, player id (and with it my achievements).
    expect(m!.selfPlayerId).toBe(77);
    expect(m!.selfName).toBe("Me");
    expect(m!.achievements.length).toBe(1);
    // The mirror keeps its own attributed row (unjoined — the shipId join
    // is ambiguous without an arena) and never masquerades as my hull.
    const mirrorRow = m!.dealt.find((r) => r.entityId === 60);
    expect(mirrorRow).toBeDefined();
    expect(mirrorRow!.damage).toBe(6000);
    expect(mirrorRow!.relation).toBeNull();
    expect(m!.taken).toBe(4000);
  });

  it("re-stamps kill skulls through the name join when the results key another id space", () => {
    // The 15.9.0 capture shape: the results' accountDBID keys are per-battle
    // session ids, the arena/roster join carries account dbids — the id
    // join never meets, and nicknames carry the kill attribution instead.
    const stream = baseStream();
    const mk = (name: string, id: number, team: number, shipId: number, killerId: number | null): unknown[] => {
      const a: unknown[] = new Array(538).fill(0);
      a[1] = name; a[6] = team; a[7] = shipId; a[9] = "asia";
      a[15] = 40000; a[20] = 0; a[21] = false; a[32] = 0;
      a[408] = killerId; a[426] = 1000;
      return a;
    };
    stream.battleResults = JSON.stringify({
      accountDBID: 2035526744,
      playersPublicInfo: {
        2035526744: mk("Me", 2035526744, 0, 101, null),
        2023650727: mk("Victim", 2023650727, 1, 102, 2035526744),
        2023363393: mk("Attacker", 2023363393, 1, 103, null),
      },
    });
    // The server's own frag counter for Me agrees with the killer ids.
    const payload = JSON.parse(stream.battleResults!) as {
      playersPublicInfo: Record<string, unknown[]>;
    };
    payload.playersPublicInfo["2035526744"][32] = 1;
    stream.battleResults = JSON.stringify(payload);
    const m = build(stream);
    // My kill of Victim re-stamps via NAME (her results id shares nothing
    // with the arena's 88), and no duplicate row is appended.
    const rows = m!.dealt.filter((r) => r.name === "Victim");
    expect(rows.length).toBe(1);
    expect(rows[0].killed).toBe(true);
    expect(m!.frags).toBe(1);
  });

  it("counts one salvo's damage once: every shell claims a share of the drop", () => {
    // Three shell events of one volley land inside the victim's ±window;
    // the old per-impact walk credited the full 4,000 drop three times
    // (12,000 on a 4,000 salvo — the corpus's dealt rows summed to a 2.4x
    // median of the results screen).
    const stream = baseStream();
    stream.shotKills = [
      impact(10.9, 10, 905, 5),
      impact(11.0, 10, 902, 3),
      impact(11.1, 10, 898, 1),
    ];
    const m = build(stream);
    const dealt = m!.dealt.find((r) => r.entityId === 20);
    expect(dealt!.damage).toBe(4000);
    expect(m!.frags).toBe(1); // the kill window still credits
  });

  it("splits a focused drop across crossfiring attackers in the received ledger", () => {
    // Two enemies' shells burst near me inside one window: my 4,000 HP drop
    // is claimed ONCE and split evenly — the received rows sum to the
    // hull's real loss instead of crediting both attackers in full (the
    // corpus's received rows summed to a 7.7x median of damage taken).
    const foe = traj(40, 104, { x: 300, z: 100 }, [
      { time: 0, value: 30000 },
      { time: 30, value: 30000 },
    ]);
    const stream = baseStream();
    stream.trajectories = [...stream.trajectories, foe];
    stream.shotKills = [
      impact(14.9, 30, 5, 2),
      impact(15.1, 40, -3, 6),
    ];
    const roster: VehicleEntry[] = [
      ...ROSTER,
      { id: 133, name: "Foe2", relation: 2, shipId: 104, shipName: "EnemyShip4" },
    ];
    stream.arenaPlayers = [
      ...ARENA_PLAYERS,
      { entityId: 40, teamId: 1, playerId: 133, shipParamsId: 104, maxHealth: 30000, name: "Foe2", isBot: false, avatarId: null, isSelf: false },
    ];
    const m = buildSelfStats({ stream, roster, dataLang: "en-US" });
    expect(m!.received.find((r) => r.entityId === 30)!.damage).toBe(2000);
    expect(m!.received.find((r) => r.entityId === 40)!.damage).toBe(2000);
    expect(m!.received.reduce((s, r) => s + r.damage, 0)).toBe(4000);
    expect(m!.taken).toBe(4000);
  });

  it("splits a crossfire drop in the dealt ledger too (teammate firing alongside)", () => {
    // My shell and an ally's shell burst inside the victim's window: the
    // drop splits evenly, so my row — and the heuristic fallback total —
    // read my 2,000 slice of the 4,000 that actually left the hull.
    const ally = traj(40, 104, { x: 1800, z: 0 }, [
      { time: 0, value: 20000 },
      { time: 30, value: 20000 },
    ]);
    const stream = baseStream();
    stream.trajectories = [...stream.trajectories, ally];
    stream.shotKills = [
      impact(10.9, 10, 905, 5),
      impact(11.0, 40, 897, 4), // the ally's shell, same window
    ];
    const roster: VehicleEntry[] = [
      ...ROSTER,
      { id: 111, name: "Stenga", relation: 1, shipId: 104, shipName: "AllyShip" },
    ];
    stream.arenaPlayers = [
      ...ARENA_PLAYERS,
      { entityId: 40, teamId: 0, playerId: 111, shipParamsId: 104, maxHealth: 20000, name: "Stenga", isBot: false, avatarId: null, isSelf: false },
    ];
    const m = buildSelfStats({ stream, roster, dataLang: "en-US" });
    expect(m!.dealt.find((r) => r.entityId === 20)!.damage).toBe(2000);
    expect(m!.damage).toBe(2000);
    // The ally's slice stays out of the enemies-only list.
    expect(m!.dealt.find((r) => r.entityId === 40)).toBeUndefined();
  });

  it("credits sequential salvos once each across adjacent claim windows", () => {
    // Two salvos 2 s apart, each drop inside its own salvo's window: the
    // victim loses 4,000 + 3,000 and the ledger reads exactly that, with
    // salvo B's two shell events splitting the second drop between them.
    const victim2 = traj(20, 102, { x: 900, z: 0 }, [
      { time: 0, value: 40000 },
      { time: 10, value: 40000 },
      { time: 11, value: 36000 },
      { time: 13, value: 33000 },
      { time: 30, value: 33000 },
    ]);
    const stream = baseStream();
    stream.trajectories = [stream.trajectories[0]!, victim2, stream.trajectories[2]!];
    stream.shotKills = [
      impact(10.9, 10, 905, 5), // salvo A: one shell event
      impact(12.9, 10, 904, 2), // salvo B: two shell events, one window
      impact(13.0, 10, 899, 6),
    ];
    const m = build(stream);
    expect(m!.dealt.find((r) => r.entityId === 20)!.damage).toBe(7000);
  });

  it("leaves impact-less HP drops unattributed (DoT stays out of the rows)", () => {
    // Fire/flood ticks carry no shot-kill events — the rows never see
    // them, the server totals do.
    const stream = baseStream();
    stream.shotKills = [];
    const m = build(stream);
    expect(m!.dealt.find((r) => r.entityId === 20)).toBeUndefined();
    expect(m!.received).toEqual([]);
    expect(m!.frags).toBe(0);
  });

  it("merges BattleResults figures even without a self trajectory", () => {
    // Every identity join missed but the battle settled: the early-exit
    // model still carries the server's authoritative totals, my kills and
    // my killer instead of an empty report.
    const stream = baseStream();
    stream.trajectories = [];
    stream.shotKills = [];
    stream.arenaPlayers = [];
    stream.damageStats = [{ time: 3, weapon: 1, category: 0, count: 2, total: 800 }];
    const mk = (name: string, team: number, shipId: number, damage: number, alive: boolean, frags: number, killerId: number | null): unknown[] => {
      const a: unknown[] = new Array(538).fill(0);
      a[1] = name; a[6] = team; a[7] = shipId; a[9] = "asia";
      a[15] = 50000; a[20] = alive ? 20000 : 0; a[21] = alive; a[32] = frags;
      a[408] = killerId; a[426] = damage;
      return a;
    };
    stream.battleResults = JSON.stringify({
      accountDBID: 77,
      playersPublicInfo: {
        77: mk("Me", 0, 101, 51938, false, 2, 55),
        55: mk("Killer", 1, 103, 8000, true, 0, null),
        88: mk("Victim", 1, 102, 2000, false, 0, 77),
      },
    });
    const m = build(stream);
    expect(m).not.toBeNull();
    expect(m!.selfEntityId).toBeNull();
    expect(m!.damage).toBe(51938);
    expect(m!.frags).toBe(2);
    expect(m!.sunk).toBe(true);
    expect(m!.final!.killerName).toBe("Killer");
    expect(m!.dealt.find((r) => r.name === "Victim")!.killed).toBe(true);
  });
});
