/** Unit tests for the below-hull combat status rows heuristics. */
import { describe, expect, it } from "vitest";
import {
  buildShipStatusIndex,
  shipStatusAt,
  type ShellImpact,
  type ShipStatusSource,
} from "./shipStatusModel";
import { fmtSecs } from "./HoloShipStatus";
import type { EntityTrajectory, ShellLaunchEvent, TorpedoLaunch } from "@/api";

const launch = (
  time: number,
  ownerId: number,
  paramsId = 0,
): ShellLaunchEvent =>
  ({
    time,
    ownerId,
    paramsId,
    salvoId: 0,
    shotId: 0,
    x: 0,
    y: 0,
    z: 0,
    targetX: 0,
    targetY: 0,
    targetZ: 0,
    serverTimeLeft: 0,
    speed: 0,
    gunBarrelId: 0,
  }) as unknown as ShellLaunchEvent;

const torpLaunch = (time: number, ownerId: number): TorpedoLaunch =>
  ({
    time,
    ownerId,
    paramsId: 0,
    salvoId: 0,
    shotId: 0,
    x: 0,
    y: 0,
    z: 0,
    dirX: 1,
    dirY: 0,
    dirZ: 0,
    armed: true,
  }) as unknown as TorpedoLaunch;

/** Minimal ship trajectory: entityType 2 with a straight-line sample run. */
const ship = (
  entityId: number,
  opts?: {
    hp?: { time: number; value: number }[];
    x?: number;
    death?: number;
  },
): EntityTrajectory => {
  const x = opts?.x ?? 0;
  return {
    entityId,
    samples: [
      { time: 0, entityId, vehicleId: 0, x, y: 0, z: 0, yaw: 0 },
      { time: 600, entityId, vehicleId: 0, x, y: 0, z: 0, yaw: 0 },
    ],
    kind: {
      entityType: 2,
      vehicleId: 0,
      initialX: x,
      initialY: 0,
      initialZ: 0,
      creationTime: 0,
    },
    hpSamples: opts?.hp,
    deathTime: opts?.death,
  };
};

const src = (over: Partial<ShipStatusSource>): ShipStatusSource => ({
  trajectories: [],
  shellLaunches: [],
  torpedoes: [],
  shellImpacts: [],
  torpImpacts: [],
  smokes: [],
  ...over,
});

const impact = (over: Partial<ShellImpact>): ShellImpact => ({
  t: 10,
  x: 0,
  z: 0,
  ownerId: 99,
  ammo: "HE",
  ...over,
});

describe("gun / torpedo salvo cooldowns", () => {
  it("shows a brief flash after a lone salvo (no reload info)", () => {
    const idx = buildShipStatusIndex(
      src({
        trajectories: [ship(1)],
        shellLaunches: [launch(100, 1)],
      }),
    );
    const snap = shipStatusAt(idx.get(1), 100.5);
    expect(snap?.actions).toContainEqual(
      expect.objectContaining({ key: "gun", phase: "flash" }),
    );
    expect(idx.size).toBe(1);
  });

  it("renders a reload bar until the next salvo and hides it past the cap", () => {
    const idx = buildShipStatusIndex(
      src({
        trajectories: [ship(1)],
        shellLaunches: [launch(100, 1), launch(130, 1)],
      }),
    );
    const mid = shipStatusAt(idx.get(1), 115);
    expect(mid?.actions).toContainEqual(
      expect.objectContaining({ key: "gun", phase: "cooldown", secs: 15 }),
    );
    // Halfway through the reload → half the bar remaining.
    expect(mid?.actions[0].frac).toBeCloseTo(0.5, 1);
    // Beyond the flash + capped reload display of a trailing salvo: the last
    // salvo has no successor, so only the flash window shows.
    expect(shipStatusAt(idx.get(1), 135)?.actions.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("does not mistake air-dropped torpedoes for the ship's tubes", () => {
    const idx = buildShipStatusIndex(
      src({
        trajectories: [ship(1)],
        torpedoes: [torpLaunch(50, 77)],
      }),
    );
    expect(shipStatusAt(idx.get(1), 51)?.actions ?? []).toHaveLength(0);
  });

  it("carries each salvo's shell family for the gun tile icon", () => {
    // Real params ids from data/shell_types.json (203 mm HE / AP shells).
    const HE = 4292854768;
    const AP = 4293903344;
    const idx = buildShipStatusIndex(
      src({
        trajectories: [ship(1)],
        shellLaunches: [
          launch(100, 1, HE),
          launch(100.5, 1, HE), // same burst — one salvo
          launch(130, 1, AP),
        ],
      }),
    );
    // During the first salvo's flash AND its reload the tile stays HE.
    expect(shipStatusAt(idx.get(1), 100.3)?.actions).toContainEqual(
      expect.objectContaining({ key: "gun", ammo: "HE" }),
    );
    expect(shipStatusAt(idx.get(1), 115)?.actions).toContainEqual(
      expect.objectContaining({ key: "gun", ammo: "HE" }),
    );
    // The second salvo flips the sprite.
    expect(shipStatusAt(idx.get(1), 130.5)?.actions).toContainEqual(
      expect.objectContaining({ key: "gun", ammo: "AP" }),
    );
  });
});

describe("hit pills", () => {
  it("shows shell ammo + damage for an impact that dropped HP", () => {
    const idx = buildShipStatusIndex(
      src({
        trajectories: [
          ship(1, {
            hp: [
              { time: 9, value: 20000 },
              { time: 10.5, value: 17400 },
            ],
          }),
        ],
        shellImpacts: [impact({ t: 10, x: 0, z: 0, ownerId: 99, ammo: "AP" })],
      }),
    );
    const snap = shipStatusAt(idx.get(1), 10.6);
    expect(snap?.hits).toHaveLength(1);
    expect(snap?.hits[0]).toMatchObject({ kind: "shell", ammo: "AP", dmg: 2600 });
  });

  it("stays silent for splashes that took no HP", () => {
    const idx = buildShipStatusIndex(
      src({
        trajectories: [ship(1, { hp: [{ time: 0, value: 20000 }] })],
        shellImpacts: [impact({ t: 10 })],
      }),
    );
    expect(shipStatusAt(idx.get(1), 10.5)?.hits ?? []).toHaveLength(0);
  });

  it("does not attribute a ship's own impacts to itself", () => {
    const idx = buildShipStatusIndex(
      src({
        trajectories: [
          ship(1, {
            hp: [
              { time: 9, value: 20000 },
              { time: 10.5, value: 17400 },
            ],
          }),
        ],
        shellImpacts: [impact({ ownerId: 1 })],
      }),
    );
    expect(shipStatusAt(idx.get(1), 10.5)?.hits ?? []).toHaveLength(0);
  });

  it("splits two simultaneous impacts without double-counting drops", () => {
    const idx = buildShipStatusIndex(
      src({
        trajectories: [
          ship(1, {
            hp: [
              { time: 9, value: 20000 },
              { time: 10.2, value: 18500 },
              { time: 10.6, value: 17000 },
            ],
          }),
        ],
        shellImpacts: [
          impact({ t: 10.1, ammo: "HE" }),
          impact({ t: 10.5, ammo: "AP" }),
        ],
      }),
    );
    const snap = shipStatusAt(idx.get(1), 10.7);
    expect(snap?.hits).toHaveLength(2);
    const total = snap!.hits.reduce((s, h) => s + h.dmg, 0);
    expect(total).toBe(3000);
  });
});

describe("damage-over-time chips", () => {
  it("counts a fire down from the class base (30 s), not the observed span", () => {
    const hp = [{ time: 0, value: 20000 }];
    for (let i = 0; i < 10; i++) {
      hp.push({ time: 20 + i, value: 20000 - (i + 1) * 150 });
    }
    const idx = buildShipStatusIndex(
      src({ trajectories: [ship(1, { hp })] }),
    );
    // Ignited at t=20, class-less ship → 30 s base: at t=25 that's 25 s
    // left (the old behaviour read 5 s — the observed burn length).
    const snap = shipStatusAt(idx.get(1), 25);
    expect(snap?.dots).toContainEqual({ key: "fire", secs: 25, frac: 25 / 30 });
  });

  it("classifies ticks against the arena build health, not the late-spotted stream peak", () => {
    // First observed at 6000/40000 after taking damage elsewhere: against
    // the stream peak every 500-HP burn tick reads as a shell hit and the
    // fire never lights; the authoritative total keeps it a DoT tick.
    const hp = [{ time: 0, value: 6000 }];
    for (let i = 0; i < 5; i++) {
      hp.push({ time: 40 + i, value: 6000 - (i + 1) * 500 });
    }
    const byPeak = buildShipStatusIndex(src({ trajectories: [ship(1, { hp })] }));
    expect(shipStatusAt(byPeak.get(1), 44)?.dots ?? []).toHaveLength(0);
    const byArena = buildShipStatusIndex(
      src({
        trajectories: [ship(1, { hp })],
        maxHpByEntity: new Map([[1, 40000]]),
      }),
    );
    expect(shipStatusAt(byArena.get(1), 44)?.dots).toContainEqual(
      expect.objectContaining({ key: "fire" }),
    );
  });

  it("uses the 60 s fire base for battleships, carriers and hybrids", () => {
    const hp = [{ time: 0, value: 60000 }];
    for (let i = 0; i < 13; i++) {
      hp.push({ time: 100 + i, value: 60000 - (i + 1) * 150 });
    }
    for (const type of ["Battleship", "AirCarrier", "Auxiliary"]) {
      const idx = buildShipStatusIndex(
        src({
          trajectories: [ship(1, { hp })],
          shipTypes: new Map([[1, type]]),
        }),
      );
      const snap = shipStatusAt(idx.get(1), 110);
      expect(snap?.dots).toContainEqual(
        expect.objectContaining({ key: "fire", secs: 50 }),
      );
    }
  });

  it("uses the 30 s flood base for carriers and submarines", () => {
    const hp = [{ time: 0, value: 20000 }];
    for (let i = 0; i < 8; i++) {
      hp.push({ time: 30 + i, value: 20000 - (i + 1) * 200 });
    }
    const idx = buildShipStatusIndex(
      src({
        trajectories: [ship(1, { hp })],
        torpImpacts: [{ t: 28, x: 0, z: 0, ownerId: 99 }],
        shipTypes: new Map([[1, "AirCarrier"]]),
      }),
    );
    expect(shipStatusAt(idx.get(1), 32)?.dots).toContainEqual(
      expect.objectContaining({ key: "flood", secs: 28 }),
    );
  });

  it("re-anchors chained fires instead of vanishing at the base boundary", () => {
    const hp = [{ time: 0, value: 40000 }];
    for (let i = 0; i < 60; i++) {
      hp.push({ time: 20 + i, value: 40000 - (i + 1) * 150 });
    }
    const idx = buildShipStatusIndex(src({ trajectories: [ship(1, { hp })] }));
    // One continuous tick run from t=20 (base 30): the second ignition
    // anchors at t=50, so the chip must still show at t=55 — counting its
    // own fresh 30 s (25 left), not the dead first window.
    const late = shipStatusAt(idx.get(1), 55);
    expect(late?.dots).toContainEqual(expect.objectContaining({ key: "fire" }));
    expect(late?.dots[0].secs).toBeCloseTo(25, 5);
  });

  it("ends the chip when the ticks fall silent (early DCP)", () => {
    const hp = [
      { time: 0, value: 20000 },
      { time: 20, value: 19850 },
      { time: 21, value: 19700 },
      { time: 22, value: 19550 },
    ];
    const idx = buildShipStatusIndex(src({ trajectories: [ship(1, { hp })] }));
    // Still inside the tick-gap grace after the last tick → counting.
    expect(shipStatusAt(idx.get(1), 23)?.dots).toContainEqual(
      expect.objectContaining({ key: "fire" }),
    );
    // Ticks silent past the gap → extinguished, chip gone (even though the
    // 30 s base hasn't elapsed).
    expect(shipStatusAt(idx.get(1), 27)?.dots ?? []).toHaveLength(0);
  });

  it("keeps fractional seconds for the sub-ten tail of a burn", () => {
    const hp = [{ time: 0, value: 20000 }];
    for (let i = 0; i < 24; i++) {
      hp.push({ time: 100 + i, value: 20000 - (i + 1) * 150 });
    }
    const idx = buildShipStatusIndex(src({ trajectories: [ship(1, { hp })] }));
    const snap = shipStatusAt(idx.get(1), 121.7);
    expect(snap?.dots[0].secs).toBeCloseTo(8.3, 2);
  });

  it("arms flooding after a nearby torpedo detonation", () => {
    const hp = [{ time: 0, value: 20000 }];
    for (let i = 0; i < 8; i++) {
      hp.push({ time: 30 + i, value: 20000 - (i + 1) * 200 });
    }
    const idx = buildShipStatusIndex(
      src({
        trajectories: [ship(1, { hp })],
        torpImpacts: [{ t: 28, x: 0, z: 0, ownerId: 99 }],
      }),
    );
    expect(shipStatusAt(idx.get(1), 32)?.dots).toContainEqual(
      expect.objectContaining({ key: "flood", secs: 38 }),
    );
  });

  it("keeps a burn labelled fire when the torpedo lands on someone else", () => {
    const hp = [{ time: 0, value: 20000 }];
    for (let i = 0; i < 8; i++) {
      hp.push({ time: 30 + i, value: 20000 - (i + 1) * 200 });
    }
    const idx = buildShipStatusIndex(
      src({
        trajectories: [ship(1, { hp, x: 0 })],
        // Same arming window, but the fish connected 5 km away.
        torpImpacts: [{ t: 28, x: 5000, z: 0, ownerId: 99 }],
      }),
    );
    expect(shipStatusAt(idx.get(1), 32)?.dots).toContainEqual(
      expect.objectContaining({ key: "fire" }),
    );
  });

  it("ignores lone small drops (one-off damage, not a burn)", () => {
    const idx = buildShipStatusIndex(
      src({
        trajectories: [
          ship(1, {
            hp: [
              { time: 0, value: 20000 },
              { time: 10, value: 19900 },
            ],
          }),
        ],
      }),
    );
    expect(shipStatusAt(idx.get(1), 12)?.dots ?? []).toHaveLength(0);
  });
});

describe("fmtSecs", () => {
  it("shows one decimal below ten seconds, whole seconds above", () => {
    expect(fmtSecs(8.34)).toBe("8.3");
    expect(fmtSecs(9.94)).toBe("9.9");
    // Threshold at 9.95: rounding must never print "10.0" below "10".
    expect(fmtSecs(9.95)).toBe("10");
    expect(fmtSecs(10)).toBe("10");
    expect(fmtSecs(15.2)).toBe("16");
    expect(fmtSecs(60)).toBe("60");
  });
});

describe("smoke + repair attribution", () => {
  it("joins a smoke cluster to the nearest ship and shows its lifetime", () => {
    const idx = buildShipStatusIndex(
      src({
        trajectories: [ship(1, { x: 0 })],
        smokes: [{ t0: 40, endT: 130, x: 50, z: 0 }],
      }),
    );
    const snap = shipStatusAt(idx.get(1), 50);
    expect(snap?.actions).toContainEqual(
      expect.objectContaining({ key: "smoke", phase: "active" }),
    );
    // Halfway through the 90 s lifetime → ~80 s left.
    expect(snap?.actions[0].secs).toBe(80);
  });

  it("marks HP-rise spans as repair windows", () => {
    const idx = buildShipStatusIndex(
      src({
        trajectories: [
          ship(1, {
            hp: [
              { time: 0, value: 10000 },
              { time: 60, value: 9500 },
              { time: 61, value: 9800 },
              { time: 62, value: 10100 },
              { time: 64, value: 10150 },
            ],
          }),
        ],
      }),
    );
    const snap = shipStatusAt(idx.get(1), 61.5);
    expect(snap?.actions).toContainEqual(
      expect.objectContaining({ key: "repair", phase: "active" }),
    );
  });
});
