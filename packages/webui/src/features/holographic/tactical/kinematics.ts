/**
 * Ship-movement estimation for the plan board's RTS-style orders.
 *
 * The replay viewer interpolates RECORDED positions; a plan has none, so an
 * order (click a unit, click a destination) needs a forward model of how a
 * hull covers ground: full-power acceleration, a turn arc at the ship's
 * class rate, a straight leg, and — for a "stop here" order — an optional
 * terminal turn onto the author's chosen arrival heading plus the decel to
 * rest. Everything here is a PLANNING ESTIMATE in world units and battle
 * seconds, deliberately simple and documented, not a replay-accurate
 * simulation of WG's engine physics.
 *
 * Pure and DOM-free — same contract as model.ts / plan.ts (unit-tested).
 */
import type { Vec2 } from "./types";

/** Knots → metres/second. */
export const KN_TO_MS = 0.514444;

/** Class-tuned model parameters. WG publishes none of this; the constants
 *  summarise community-measured ballistics: destroyers spool up and swing
 *  quickly, battleships take half a minute to reach full power. Turn rates
 *  are sustained-rate envelopes at speed, in degrees per second. */
export interface ShipKinematics {
  /** Top speed in knots (baked live stats `spd`). */
  topSpeedKn: number;
  /** Seconds from stop to full power, roughly linear throttle. */
  accelS: number;
  /** Sustained turn rate at speed (radians per second, positive). */
  turnRate: number;
}

const CLASS_PARAMS: Record<string, { accelS: number; turnDegS: number }> = {
  AirCarrier: { accelS: 30, turnDegS: 1.6 },
  Battleship: { accelS: 38, turnDegS: 2.2 },
  Cruiser: { accelS: 28, turnDegS: 2.8 },
  Destroyer: { accelS: 22, turnDegS: 3.6 },
  Submarine: { accelS: 20, turnDegS: 3.4 },
};

const DEFAULT_PARAMS = { accelS: 30, turnDegS: 2.6 };

/** World units per nautical mile-ish sanity band — guards a corrupted
 *  `spd` field from producing an absurd path. */
const MAX_SPEED_KN = 60;

export function kinematicsOf(topSpeedKn: number | undefined, shipType: string | undefined): ShipKinematics {
  const p = CLASS_PARAMS[shipType ?? ""] ?? DEFAULT_PARAMS;
  const kn = Math.max(5, Math.min(MAX_SPEED_KN, topSpeedKn ?? 30));
  return { topSpeedKn: kn, accelS: p.accelS, turnRate: (p.turnDegS * Math.PI) / 180 };
}

/** A unit's pose: position plus heading (radians clockwise from north). */
export interface Pose {
  at: Vec2;
  heading: number;
}

/** An order the estimator plans: cruise to `to` (keep way), or arrive there
 *  on `arriveHeading` and decelerate to rest (`stop`). */
export interface LegRequest {
  from: Pose;
  to: Vec2;
  kin: ShipKinematics;
  /** Terminal heading constraint (radians clockwise from north). */
  arriveHeading?: number | null;
  /** Decelerate to rest at the destination (a stop order). */
  stop?: boolean;
}

/** The planned leg: the sailed polyline (world points, start inclusive) and
 *  the battle seconds it takes. */
export interface LegPlan {
  path: Vec2[];
  durS: number;
  /** Heading the hull points at when the leg ends. */
  arriveHeading: number;
  /** World distance sailed (the arc detours make this exceed the crow
   *  flies distance — that gap is the "why not straight" the author sees). */
  distance: number;
}

/** Wrap an angle to (−π, π]. */
export function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

/** Time to cover `dist` metres accelerating linearly from v0 toward vmax
 *  (then holding). Closed form of the two-phase solution. */
function travelTime(dist: number, v0: number, vmax: number, accel: number): number {
  if (dist <= 0) return 0;
  const dToMax = Math.max(0, (vmax * vmax - v0 * v0) / (2 * accel));
  if (dist >= dToMax) {
    const tToMax = (vmax - v0) / accel;
    return tToMax + (dist - dToMax) / vmax;
  }
  return (-v0 + Math.sqrt(v0 * v0 + 2 * accel * dist)) / accel;
}

/** Sample a constant-radius turn: from `p` on heading `h0`, turning
 *  `delta` radians (sign = direction), radius `r`. Returns the arc points
 *  (excluding the start) plus the end pose. */
function turnArc(p: Vec2, h0: number, delta: number, r: number, stepRad: number): {
  pts: Vec2[];
  end: Pose;
} {
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / stepRad));
  const pts: Vec2[] = [];
  let h = h0;
  // Turning circle centre: 90° clockwise of the heading for a right turn.
  const sign = delta >= 0 ? 1 : -1;
  const cx = p.x + Math.cos(h0) * r * sign;
  const cz = p.z - Math.sin(h0) * r * sign;
  for (let i = 1; i <= steps; i++) {
    h = h0 + (delta * i) / steps;
    // The point stays r away from the centre, on the side opposite the turn.
    pts.push({ x: cx - Math.cos(h) * r * sign, z: cz + Math.sin(h) * r * sign });
  }
  return { pts, end: { at: pts[pts.length - 1], heading: h } };
}

/** Angular sampling density of the drawn arcs (≈2° per point). */
const ARC_STEP_RAD = (2 * Math.PI) / 180;

/** Plan a leg: initial turn onto the bearing of the target, a straight run,
 *  an optional terminal turn onto the arrival heading, and (for stop
 *  orders) the decel to rest. The two arcs are approximated independently —
 *  the terminal arc's chord is laid back along the approach line — which
 *  lands within a few metres of the exact arc-line-arc solution and keeps
 *  the estimator monotonic and side-effect free. */
export function planLeg(req: LegRequest): LegPlan {
  const { from, to, kin } = req;
  const dx = to.x - from.at.x;
  const dz = to.z - from.at.z;
  const crow = Math.hypot(dx, dz);
  const v = kin.topSpeedKn * KN_TO_MS / 30; // world units per second
  const accel = v / kin.accelS; // units/s² (linear 0→v over accelS)
  const v0 = v * 0.5; // a plan usually starts already underway

  if (crow < 1e-3) {
    const h = req.arriveHeading ?? from.heading;
    return { path: [from.at, { ...from.at }], durS: req.stop ? v0 / accel : 0, arriveHeading: h, distance: 0 };
  }

  const bearing = Math.atan2(dx, dz);
  const d1 = wrapAngle(bearing - from.heading);

  // Turn radius at speed: v = ω r → the ship's own rate limits the arc.
  const r = Math.max(1, v / kin.turnRate);

  // Terminal turn (stop orders with a facing): chord the terminal arc lays
  // back along the approach line.
  const d2 = req.arriveHeading != null ? wrapAngle(req.arriveHeading - bearing) : 0;
  const chord2 = Math.abs(d2) > 1e-4 ? 2 * r * Math.sin(Math.abs(d2) / 2) : 0;

  const arc1 = Math.abs(d1) > 1e-4 ? turnArc(from.at, from.heading, d1, r, ARC_STEP_RAD) : null;
  const p1 = arc1 ? arc1.end.at : from.at;
  const dir = { x: Math.sin(bearing), z: Math.cos(bearing) };
  const lineEnd = {
    x: to.x - dir.x * chord2,
    z: to.z - dir.z * chord2,
  };
  const lineLen = Math.max(0, Math.hypot(lineEnd.x - p1.x, lineEnd.z - p1.z));

  // Arc time = angle / rate at full speed (already underway); the straight
  // leg pays the acceleration curve from half speed.
  const arc1S = Math.abs(d1) / kin.turnRate;
  const arc2S = Math.abs(d2) / kin.turnRate;
  const lineS = travelTime(lineLen, v0, v, accel);
  const decelS = req.stop ? v / (accel * 0.6) : 0; // WG decel ≈ 0.6× accel

  const path: Vec2[] = [from.at];
  if (arc1) path.push(...arc1.pts);
  // Keep the straight leg a single segment — the renderer smooths it.
  if (lineLen > 0.5) {
    path.push(p1, lineEnd);
  } else if (path.length === 1) {
    path.push({ ...p1 });
  }
  if (chord2 > 0.5) {
    const arc2 = turnArc(lineEnd, bearing, d2, r, ARC_STEP_RAD);
    path.push(...arc2.pts);
  } else {
    path.push({ x: to.x, z: to.z });
  }

  const distance =
    Math.abs(d1) * r + lineLen + Math.abs(d2) * r;
  return {
    path,
    durS: arc1S + lineS + arc2S + decelS,
    arriveHeading: req.arriveHeading ?? (chord2 > 1e-4 ? req.arriveHeading! : bearing),
    distance,
  };
}
