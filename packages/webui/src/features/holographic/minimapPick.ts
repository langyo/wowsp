/**
 * Pure hit-testing for the enlarged 2D minimap's hover tooltips.
 *
 * The enlarged map ('2D view') is a 760-logical-px canvas painted by
 * `drawMinimap` (minimapPainter.ts): every entity is projected into the
 * painter's pan/zoom view window with
 *   px = (x - view.minX) / (view.maxX - view.minX) * 760
 *   py = (view.maxZ - z) / (view.maxZ - view.minZ) * 760
 * (world coordinates, z north-positive) and the whole world frame is then
 * rotated around the canvas centre by `mmRotationDeg`. This module mirrors
 * that exact pipeline in reverse — unrotate the pointer position around the
 * centre, project the candidate entities the same way, and answer the
 * nearest one — so a tooltip can never disagree with the marker it sits on.
 *
 * Deliberately DOM- and Vue-free (and `ctx`-free): the component hands in a
 * plain snapshot built from the shared MapInternals state, which also makes
 * the projection testable without a canvas. Per-frame use keeps the module
 * allocation-light — one plain object per input entity list is built by the
 * caller, and this module only allocates the winning target it returns.
 *
 * Hit tolerances are in LOGICAL canvas px (the same units the painter draws
 * in, so they scale with the element automatically). Ring-shaped entities
 * (capture points, fighter-patrol wards) are selected on their RING BAND —
 * the translucent ward fill deliberately does not capture hovers from ships
 * or aircraft sitting on top of it.
 */
import { TACTICAL_SIZE } from "./tactical/render";
import type { TeamRole } from "./teamColors";

/** Canvas centre the world-frame rotation spins around (logical px). */
const CANVAS_CENTRE = TACTICAL_SIZE / 2;

// ── Hit tolerances (logical px) ────────────────────────────────────────
/** Ship glyph half-extent on the enlarged map (the traced class glyph is
 *  34 px tall — a 13 px centre radius covers most of the hull). */
const SHIP_TOLERANCE_PX = 13;
/** Aircraft formation icons are 22 px; 14 px keeps neighbouring squadrons
 *  selectable without swallowing each other. */
const PLANE_TOLERANCE_PX = 14;
/** Torpedo triangles are 5.5 px half-width — keep the target tight so
 *  adjacent fish in one salvo stay individually hoverable. */
const TORPEDO_TOLERANCE_PX = 8;
/** Smoke start/end rings are 6 px; the timer tag sits above them, so the
 *  capture area is a little generous. */
const SMOKE_TOLERANCE_PX = 9;
/** Capture-point ring band: within 8 px of the drawn circumference, or
 *  12 px of the letter itself (the ring can be very small / letter-centric
 *  on a deep zoom). */
const CAP_RING_BAND_PX = 8;
const CAP_LETTER_RADIUS_PX = 12;
/** Capture rings are floored at 6 px by the painter — the picker must use
 *  the same floor or tiny zones would hover-test a ring nobody can see. */
const CAP_RING_MIN_PX = 6;
/** Fighter-patrol wards are selected on the drawn rim only (7 px band); the
 *  large translucent fill must never capture hovers from entities on top. */
const WARD_RING_BAND_PX = 7;
/** A lower-priority entity this close to the best higher-priority candidate
 *  loses the tie: priority order is ship > plane > torpedo > smoke > ward >
 *  cap (see TARGET_PRIORITY below). */
const PRIORITY_SLACK_PX = 3;

// ── Input snapshot ─────────────────────────────────────────────────────

/** The painter's visible world rect + world-frame rotation. */
export interface MinimapPickView {
  /** World-rect left/right/north/south (z north-positive) shown by the
   *  enlarged canvas — `computeViewBounds(ctx, full)`. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** World-frame rotation in degrees (the canvas `rotate()` convention,
   *  +`ctx.mmRotationDeg`). */
  rotationDeg: number;
}

/** One ship candidate (world coords from the marker pose the painter draws). */
export interface MinimapPickShip {
  entityId: number;
  role: TeamRole;
  /** World position (z north-positive; scene z = -z). */
  x: number;
  z: number;
  /** Player label (nickname; scripted NPCs carry their ship name). */
  label: string;
  /** Ship display name — empty when the replay carries no name for it. */
  shipName: string;
  /** GameParams ship class ("Battleship", "Destroyer", …) or null. */
  shipType: string | null;
  hp: number | null;
  maxHp: number | null;
  dead: boolean;
  /** Enemy whose trajectory froze past the un-spotted gap (last-known pose). */
  unspotted: boolean;
}

/** One aircraft squadron candidate (formation anchor pose). */
export interface MinimapPickPlane {
  planeId: number;
  /** Behavioural family (fighter / dive / torpedo / skip / rocket / bomber /
   *  scout / attack) — the tooltip maps it onto ships.plane.* labels. */
  planeType: string;
  role: TeamRole;
  /** GameParams attack-group size — kept for the pool-size/hover-signature
   *  join but NEVER user-facing: it is the attack-group size (423/936
   *  plane_types entries are 1), not the flying squadron strength, and the
   *  编队 ×1 tooltip it fed was the misleading report. The decoded fields
   *  below are what renders. */
  count: number;
  /** Planes launched this sortie (SquadronCreate.numPlanes, E27) — null on
   *  replays whose 3D stream predates the field. */
  launched?: number | null;
  /** Planes alive in flight right now — the planesHealth packed u64's
   *  digit count (E27), or the trail-derived live members when the state
   *  stream is absent (pre-E27 replays). */
  flying?: number | null;
  /** Squadron total-HP fraction 0..1 (SquadronHealthEvent, E27) — null
   *  before the first sample and on pre-E27 replays. */
  hp?: number | null;
  /** Controlling carrier's display label (null when unresolved). */
  carrierLabel: string | null;
  /** World position (z north-positive). */
  x: number;
  z: number;
}

/** One in-flight torpedo candidate. */
export interface MinimapPickTorpedo {
  /** World position (z north-positive). */
  x: number;
  z: number;
  ownerLabel: string;
  role: TeamRole;
  /** Seconds since launch. */
  ageS: number;
  /** Seconds until the fish despawns. */
  remainingS: number;
}

/** One smoke-screen cluster candidate. */
export interface MinimapPickSmoke {
  /** World position (z north-positive) of the cluster's current puff. */
  x: number;
  z: number;
  remainingS: number;
}

/** One capture-point candidate (a ring, not a dot). */
export interface MinimapPickCap {
  /** World position (z north-positive) of the zone centre. */
  x: number;
  z: number;
  letter: string;
  owner: 0 | 1 | 2;
  /** Seconds to finish the ongoing capture (null when nothing is capturing). */
  etaS: number | null;
  /** Zone radius in world units. */
  radiusWorld: number;
}

/** One fighter-patrol ward candidate (a rim, not a disc). */
export interface MinimapPickWard {
  /** World position (z north-positive) of the patrol centre. */
  x: number;
  z: number;
  role: TeamRole;
  /** Patrol radius in world units. */
  radiusWorld: number;
  ownerLabel: string | null;
}

/** Everything the picker may hover at one playhead instant. */
export interface MinimapPickInput {
  view: MinimapPickView;
  ships: MinimapPickShip[];
  planes: MinimapPickPlane[];
  torpedoes: MinimapPickTorpedo[];
  smokes: MinimapPickSmoke[];
  caps: MinimapPickCap[];
  wards: MinimapPickWard[];
}

// ── Output ─────────────────────────────────────────────────────────────

/** What the hover card renders for one hit entity. */
export type MinimapHoverTarget =
  | {
      kind: "ship";
      entityId: number;
      role: "self" | "ally" | "enemy";
      label: string;
      shipName: string;
      shipType: string | null;
      hp: number | null;
      maxHp: number | null;
      dead: boolean;
      unspotted: boolean;
    }
  | {
      kind: "plane";
      planeId: number;
      planeType: string;
      role: TeamRole;
      count: number;
      /** Planes launched this sortie (E27 numPlanes) — see
       *  MinimapPickPlane; null on pre-E27 replays. */
      launched?: number | null;
      /** Planes alive in flight (E27 planesHealth digit count or the
       *  trail-derived fallback). */
      flying?: number | null;
      /** Squadron total-HP fraction 0..1 (E27), null when unknown. */
      hp?: number | null;
      carrierLabel: string | null;
    }
  | {
      kind: "torpedo";
      ownerLabel: string;
      role: TeamRole;
      ageS: number;
      remainingS: number;
    }
  | { kind: "smoke"; remainingS: number }
  | {
      kind: "cap";
      letter: string;
      owner: 0 | 1 | 2;
      etaS: number | null;
      radiusWorld: number;
    }
  | {
      kind: "ward";
      role: TeamRole;
      radiusWorld: number;
      ownerLabel: string | null;
    };

// ── Projection helpers (exported for tests + the component) ────────────

/** World (x, north-positive z) → rotated canvas logical px, exactly like the
 *  painter's `zwx`/`zwz` projection followed by the canvas rotation. */
export function minimapLogicalOf(
  view: MinimapPickView,
  x: number,
  z: number,
): { lx: number; ly: number } {
  const spanX = view.maxX - view.minX;
  const spanZ = view.maxZ - view.minZ;
  const lx = spanX > 0 ? ((x - view.minX) / spanX) * TACTICAL_SIZE : Number.NaN;
  const ly = spanZ > 0 ? ((view.maxZ - z) / spanZ) * TACTICAL_SIZE : Number.NaN;
  return { lx, ly };
}

/** Canvas logical px → the un-rotated world-frame logical px. The painter
 *  spins the world frame by +rotationDeg around the canvas centre, so input
 *  must spin back by -θ before it can be compared against projections
 *  (the same helper shape the tactical board uses for pointer input). */
export function unrotateMinimapPoint(
  rotationDeg: number,
  lx: number,
  ly: number,
): { lx: number; ly: number } {
  const rad = (-rotationDeg * Math.PI) / 180;
  if (rad === 0) return { lx, ly };
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = lx - CANVAS_CENTRE;
  const dy = ly - CANVAS_CENTRE;
  return {
    lx: CANVAS_CENTRE + dx * cos - dy * sin,
    ly: CANVAS_CENTRE + dx * sin + dy * cos,
  };
}

/** Projected canvas logical px → the world point under it (inverse of
 *  minimapLogicalOf; used by tests and available for future drag/select
 *  gestures that want the entity-space position of a click). */
export function minimapWorldOf(
  view: MinimapPickView,
  lx: number,
  ly: number,
): { x: number; z: number } {
  const spanX = view.maxX - view.minX;
  const spanZ = view.maxZ - view.minZ;
  return {
    x: view.minX + (lx / TACTICAL_SIZE) * spanX,
    z: view.maxZ - (ly / TACTICAL_SIZE) * spanZ,
  };
}

// ── Tolerances / priority ──────────────────────────────────────────────

/** Priority order (higher wins within PRIORITY_SLACK_PX of the nearest
 *  candidate): ships first — they are what an operator reads — then
 *  aircraft, torpedoes, smoke, ward rims, and capture rings last (their
 *  large bands would otherwise swallow every dot near them). */
const TARGET_PRIORITY = [
  "ship",
  "plane",
  "torpedo",
  "smoke",
  "ward",
  "cap",
] as const;

// ── Picker ─────────────────────────────────────────────────────────────

/**
 * Entity under the pointer on the enlarged 2D map, or null.
 *
 * `lx`/`ly` are the pointer position in the enlarged canvas's LOGICAL
 * coordinates (0..760, i.e. client px scaled by the element's rendered
 * size), exactly as delivered by a DOM pointer event mapped through the
 * canvas bounding rect. The returned target carries only display data — the
 * caller resolves labels/strings when rendering the hover card.
 */
export function pickMinimapTarget(
  input: MinimapPickInput,
  lx: number,
  ly: number,
): MinimapHoverTarget | null {
  const view = input.view;
  const spanX = view.maxX - view.minX;
  const spanZ = view.maxZ - view.minZ;
  if (!(spanX > 0) || !(spanZ > 0)) return null;
  if (!Number.isFinite(lx) || !Number.isFinite(ly)) return null;
  const p = unrotateMinimapPoint(view.rotationDeg, lx, ly);
  const clickX = p.lx;
  const clickY = p.ly;
  // World → logical px scale factors (the painter's projection without the
  // per-call division).
  const scaleX = TACTICAL_SIZE / spanX;
  const scaleZ = TACTICAL_SIZE / spanZ;

  // Best candidate per kind: index + selection distance. Rings compare on
  // their band distance, dots on their centre distance.
  let shipIdx = -1;
  let shipD = Number.POSITIVE_INFINITY;
  let planeIdx = -1;
  let planeD = Number.POSITIVE_INFINITY;
  let torpIdx = -1;
  let torpD = Number.POSITIVE_INFINITY;
  let smokeIdx = -1;
  let smokeD = Number.POSITIVE_INFINITY;
  let wardIdx = -1;
  let wardD = Number.POSITIVE_INFINITY;
  let capIdx = -1;
  let capD = Number.POSITIVE_INFINITY;

  for (let i = 0; i < input.ships.length; i++) {
    const s = input.ships[i];
    const d = Math.hypot(
      (s.x - view.minX) * scaleX - clickX,
      (view.maxZ - s.z) * scaleZ - clickY,
    );
    if (d <= SHIP_TOLERANCE_PX && d < shipD) {
      shipD = d;
      shipIdx = i;
    }
  }
  for (let i = 0; i < input.planes.length; i++) {
    const s = input.planes[i];
    const d = Math.hypot(
      (s.x - view.minX) * scaleX - clickX,
      (view.maxZ - s.z) * scaleZ - clickY,
    );
    if (d <= PLANE_TOLERANCE_PX && d < planeD) {
      planeD = d;
      planeIdx = i;
    }
  }
  for (let i = 0; i < input.torpedoes.length; i++) {
    const s = input.torpedoes[i];
    const d = Math.hypot(
      (s.x - view.minX) * scaleX - clickX,
      (view.maxZ - s.z) * scaleZ - clickY,
    );
    if (d <= TORPEDO_TOLERANCE_PX && d < torpD) {
      torpD = d;
      torpIdx = i;
    }
  }
  for (let i = 0; i < input.smokes.length; i++) {
    const s = input.smokes[i];
    const d = Math.hypot(
      (s.x - view.minX) * scaleX - clickX,
      (view.maxZ - s.z) * scaleZ - clickY,
    );
    if (d <= SMOKE_TOLERANCE_PX && d < smokeD) {
      smokeD = d;
      smokeIdx = i;
    }
  }
  // Wards: rim band only — the fill must not capture entities on top.
  for (let i = 0; i < input.wards.length; i++) {
    const s = input.wards[i];
    const d = Math.hypot(
      (s.x - view.minX) * scaleX - clickX,
      (view.maxZ - s.z) * scaleZ - clickY,
    );
    const radiusPx = s.radiusWorld * scaleX;
    if (!Number.isFinite(radiusPx)) continue;
    const band = Math.abs(d - radiusPx);
    if (band <= WARD_RING_BAND_PX && band < wardD) {
      wardD = band;
      wardIdx = i;
    }
  }
  // Capture points: ring band OR the centre letter disc. A letter hit
  // compares on its own centre distance so a huge neighbouring ring's band
  // does not outrank the point under the cursor.
  for (let i = 0; i < input.caps.length; i++) {
    const s = input.caps[i];
    const d = Math.hypot(
      (s.x - view.minX) * scaleX - clickX,
      (view.maxZ - s.z) * scaleZ - clickY,
    );
    const radiusPx = Math.max(CAP_RING_MIN_PX, s.radiusWorld * scaleX);
    if (!Number.isFinite(radiusPx)) continue;
    const band = Math.abs(d - radiusPx);
    const onBand = band <= CAP_RING_BAND_PX;
    const onLetter = d <= CAP_LETTER_RADIUS_PX;
    if (!onBand && !onLetter) continue;
    const sel = onBand ? band : d;
    if (sel < capD) {
      capD = sel;
      capIdx = i;
    }
  }

  // Winner: the nearest candidate, but a higher-priority kind within
  // PRIORITY_SLACK_PX of that distance takes the tie.
  const bestD = Math.min(shipD, planeD, torpD, smokeD, wardD, capD);
  if (!Number.isFinite(bestD)) return null;
  const slackD = bestD + PRIORITY_SLACK_PX;
  if (shipIdx >= 0 && shipD <= slackD) {
    const s = input.ships[shipIdx];
    return {
      kind: "ship",
      entityId: s.entityId,
      role: s.role,
      label: s.label,
      shipName: s.shipName,
      shipType: s.shipType,
      hp: s.hp,
      maxHp: s.maxHp,
      dead: s.dead,
      unspotted: s.unspotted,
    };
  }
  if (planeIdx >= 0 && planeD <= slackD) {
    const s = input.planes[planeIdx];
    return {
      kind: "plane",
      planeId: s.planeId,
      planeType: s.planeType,
      role: s.role,
      count: s.count,
      launched: s.launched,
      flying: s.flying,
      hp: s.hp,
      carrierLabel: s.carrierLabel,
    };
  }
  if (torpIdx >= 0 && torpD <= slackD) {
    const s = input.torpedoes[torpIdx];
    return {
      kind: "torpedo",
      ownerLabel: s.ownerLabel,
      role: s.role,
      ageS: s.ageS,
      remainingS: s.remainingS,
    };
  }
  if (smokeIdx >= 0 && smokeD <= slackD) {
    return { kind: "smoke", remainingS: input.smokes[smokeIdx].remainingS };
  }
  if (wardIdx >= 0 && wardD <= slackD) {
    const s = input.wards[wardIdx];
    return {
      kind: "ward",
      role: s.role,
      radiusWorld: s.radiusWorld,
      ownerLabel: s.ownerLabel,
    };
  }
  if (capIdx >= 0 && capD <= slackD) {
    const s = input.caps[capIdx];
    return {
      kind: "cap",
      letter: s.letter,
      owner: s.owner,
      etaS: s.etaS,
      radiusWorld: s.radiusWorld,
    };
  }
  return null;
}

/** The priority order the tie-break uses (documented for consumers/tests). */
export const MINIMAP_TARGET_PRIORITY = TARGET_PRIORITY;
