/**
 * Tactical zones: torpedo-spread sectors and consumable range rings a plan
 * places on the map (the "what does this order light up / threaten" layer).
 *
 * A zone is a committed ELEMENT of the tactical document (undo, timeline,
 * profile export all come free), but its parameters are BAKED at commit
 * time from the launching unit's lineup stats — torpedo reach from the
 * selected torpedo data, radar/hydro reach from the consumable kit — so the
 * element stays self-contained even after the lineup changes.
 *
 * Torpedoes GROW with the timeline: from the launch point the sector's arc
 * sweeps outward at torpedo speed until it reaches maximum range, which is
 * what makes scrubbing the clock a "where is the danger NOW" read.
 * Consumable rings are static circles that live for the consumable's
 * (estimated) duration and fade out.
 *
 * Pure and DOM-free (unit-tested).
 */
import type { Vec2 } from "./types";

export type ZoneType = "torpedo" | "radar" | "hydro" | "smoke";

export const ZONE_TYPES: readonly ZoneType[] = ["torpedo", "radar", "hydro", "smoke"];

/** Zones that render as a sector (aimed); consumables render full circles. */
export function zoneIsSector(type: ZoneType): boolean {
  return type === "torpedo";
}

/** One committed zone element's shape (mirrors the stored element fields —
 *  see types.ts `ZoneElement`; this interface is what the math consumes). */
export interface ZoneLike {
  zoneType: ZoneType;
  at: Vec2;
  /** Radians clockwise from north — the sector's aim for torpedoes. */
  heading: number;
  /** Battle seconds the zone activates at. */
  t0: number;
  /** Full radius in world units (torpedo max range / consumable reach). */
  radius: number;
  /** Sector half-angle in radians (torpedo spread); 0 = full circle. */
  halfAngle: number;
  /** World units per second (torpedo run speed; 0 for static rings). */
  speed: number;
  /** Seconds the zone stays active after t0 (static rings). */
  durS: number;
}

export interface ZoneParams {
  radius: number;
  halfAngle: number;
  speed: number;
  durS: number;
}

/** Default torpedo run speed: 62 kn ≈ a mid-fleet long-range torpedo; the
 *  exact launcher speed is not in the baked assets, so every spread uses
 *  this estimate (documented — refine when torpedo ammo data ships). */
export const TORPEDO_SPEED_UNITS_S = (62 * 0.514444) / 30;

/** Torpedo spread half-angle: a wide salvo's envelope (~ ±15° of aim). */
export const TORPEDO_HALF_ANGLE = (15 * Math.PI) / 180;

/** Estimated consumable durations (seconds) — WG varies these per ship and
 *  module; the baked kit carries only ranges. Radar 30 s / hydro 120 s /
 *  smoke 90 s cover the stock hulls the planner argues about. */
export const ZONE_DURATIONS_S: Record<ZoneType, number> = {
  torpedo: 0, // bounded by run distance, not duration
  radar: 30,
  hydro: 120,
  smoke: 90,
};

/** Smoke screen cloud radius (world units) — the replay viewer's cluster
 *  radius (42 units ≈ 1.3 km), reused so plan smoke reads like real smoke. */
export const SMOKE_RADIUS_UNITS = 42;

/** Reach source for one zone type off a unit's resolved lineup stats. */
export interface ZoneStatSource {
  /** Longest torpedo range, world units (undefined = no torpedoes). */
  torpRadius?: number;
  /** Radar detection radius, world units (undefined = none). */
  radarRadius?: number;
  /** Hydroacoustic radius, world units (undefined = none). */
  hydroRadius?: number;
  /** Whether the unit can lay smoke at all. */
  smoke: boolean;
}

/** Resolve the baked-at-commit parameters of a zone from the launching
 *  unit's stats. Returns null when the unit cannot field that zone at all
 *  (radar on a DD without one) — the caller then never offers the item. */
export function zoneParamsOf(type: ZoneType, src: ZoneStatSource): ZoneParams | null {
  switch (type) {
    case "torpedo":
      if (src.torpRadius == null || src.torpRadius <= 0) return null;
      return {
        radius: src.torpRadius,
        halfAngle: TORPEDO_HALF_ANGLE,
        speed: TORPEDO_SPEED_UNITS_S,
        durS: 0,
      };
    case "radar":
      if (src.radarRadius == null || src.radarRadius <= 0) return null;
      return { radius: src.radarRadius, halfAngle: 0, speed: 0, durS: ZONE_DURATIONS_S.radar };
    case "hydro":
      if (src.hydroRadius == null || src.hydroRadius <= 0) return null;
      return { radius: src.hydroRadius, halfAngle: 0, speed: 0, durS: ZONE_DURATIONS_S.hydro };
    case "smoke":
      if (!src.smoke) return null;
      return { radius: SMOKE_RADIUS_UNITS, halfAngle: 0, speed: 0, durS: ZONE_DURATIONS_S.smoke };
  }
}

/** Zone radius at battle time t: the torpedo sweep (clamped to full range)
 *  or a static ring's constant radius. 0 = not on the board yet. */
export function zoneRadiusAt(z: ZoneLike, t: number): number {
  if (t < z.t0) return 0;
  if (z.speed > 0) {
    return Math.min(z.radius, z.speed * (t - z.t0));
  }
  return z.radius;
}

/** Is the zone's effect over by t? (A torpedoes spread ends when it reaches
 *  max range; a ring ends when its duration lapses.) */
export function zoneEndedAt(z: ZoneLike): number {
  if (z.speed > 0) return z.t0 + z.radius / z.speed;
  return z.durS > 0 ? z.t0 + z.durS : Infinity;
}

/** Fade curve: pop in over 0.4 s, hold, fade out over the last 1.5 s —
 *  enough motion that scrubbing past a ring's end reads as "it's gone". */
export function zoneAlphaAt(z: ZoneLike, t: number): number {
  if (t < z.t0) return 0;
  const end = zoneEndedAt(z);
  if (t >= end) return 0;
  const since = t - z.t0;
  const fadeIn = Math.min(1, since / 0.4);
  const remain = end - t;
  const fadeOut = Math.min(1, remain / 1.5);
  return Math.min(fadeIn, fadeOut);
}

/** Sector boundary points (world) of an aimed zone at radius `radius`:
 *  the two flanks plus the arc between them, for hit-testing/drawing. */
export function zoneSectorPoints(z: ZoneLike, radius: number): Vec2[] {
  if (radius <= 0) return [];
  if (!zoneIsSector(z.zoneType) || z.halfAngle <= 0) return [{ ...z.at }];
  const pts: Vec2[] = [z.at];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const a = z.heading - z.halfAngle + ((z.halfAngle * 2) / steps) * i;
    pts.push({ x: z.at.x + Math.sin(a) * radius, z: z.at.z + Math.cos(a) * radius });
  }
  return pts;
}

/** Hit-test a zone at world point p at time t (selection / eraser). */
export function zoneHitTest(z: ZoneLike, p: Vec2, t: number, pad: number): boolean {
  const r = zoneRadiusAt(z, t);
  if (r <= 0) return false;
  const dx = p.x - z.at.x;
  const dz = p.z - z.at.z;
  const d = Math.hypot(dx, dz);
  if (d > r + pad) return false;
  if (!zoneIsSector(z.zoneType) || z.halfAngle <= 0) return true;
  if (d <= pad) return true; // inside the apex
  const bearing = Math.atan2(dx, dz);
  let diff = bearing - z.heading;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return Math.abs(diff) <= z.halfAngle + pad / Math.max(d, 1);
}
