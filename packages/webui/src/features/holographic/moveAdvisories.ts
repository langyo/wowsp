/**
 * E18 · G6 step 3: the AI movement-advice overlays (2D + 3D).
 *
 * The `decision_debug_report` IPC returns, for every alive team-known ship,
 * the E16 move model's 17-class judgement at the playhead: which relative
 * sector (22.5° each, own-heading frame) the model says the ship should
 * head for, or class 16 "no obvious movement". This module owns everything
 * both renderers share — the confidence color ramp (dim → bright as
 * topProb climbs, hue by allegiance) and the 3D floating-arrow pool — while
 * the 2D arrows are painted inside minimapPainter's rotated world frame.
 *
 * 3D convention notes (verified against the ship markers): the scene
 * mirrors world z (z' = -worldZ), and `mapBearingRad` rides the E16 label
 * frame atan2(dz, dx). A world direction (cos b, sin b) therefore lands at
 * scene (cos b, -sin b), which is exactly local +X rotated by
 * `rotation.y = b` — the arrows are built along local +X so a single
 * rotation.y orients them.
 */
import * as THREE from "three";
import type { DecisionDebugReport, MovementAdvice } from "@/api";
import type { MapInternals } from "./mapInternals";

/** Sector width in radians (16 sectors over the full circle — E16). */
export const MOVE_SECTOR_RAD = Math.PI / 8;

/** The runner-up sector's absolute bearing, derived from the top sector's
 * (both share the own-yaw reference: bearing = yaw + sector × 22.5°, so
 * second = top bearing + (second − top) × 22.5°). Null when the top class
 * is no-move (no reference bearing on the wire). */
export function secondBearingRad(adv: MovementAdvice): number | null {
  if (adv.mapBearingRad == null) return null;
  return adv.mapBearingRad + (adv.secondSector - adv.topSector) * MOVE_SECTOR_RAD;
}

/** Second-sector draw threshold — the pale short arrow only when the
 * runner-up clears it (mirrors the Rust contract doc). */
export const SECOND_SECTOR_DRAW_MIN = 0.15;

/** Hover height of the 3D advice arrows, world units. Ship hulls are tens
 *  of units long (models ≈ 4.5 m/unit) — 12 units (~54 m at model scale)
 *  clears masts and reads as "above the ship" without leaving the frame. */
export const MOVE_ARROW_HOVER_UNITS = 12;

/** Shaft length range by confidence (world units): 16 at topProb 0 up to
 *  36 at 1 — low-confidence advice reads as a short pale hint. */
const MOVE_ARROW_LEN_MIN = 16;
const MOVE_ARROW_LEN_SPAN = 20;
/** Cone head length / width relative constants (units). */
const HEAD_LEN = 7;
const HEAD_WIDTH = 4.5;
const SHAFT_WIDTH = 1.6;
/** The no-move 3D marker: a small hovering sphere ("hold position"). */
const HOLD_DOT_R = 3.2;

/** Dim → bright RGB endpoints per allegiance, lerped by confidence
 * (topProb). Recorder white, allies cyan, enemies amber — the same hues the
 * fire layer's rings use, kept distinguishable from the team green/red of
 * the hull glyphs. Returns 0–255 components for CSS rgba() reuse. */
export function adviceColorRgb(
  isRecorder: boolean,
  teamId: number,
  prob: number,
): [number, number, number] {
  const k = Math.min(1, Math.max(0, prob));
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * k);
  if (isRecorder) {
    return [lerp(170, 255), lerp(184, 255), lerp(200, 255)];
  }
  if (teamId === 0) {
    return [lerp(34, 96), lerp(130, 214), lerp(160, 255)];
  }
  return [lerp(158, 255), lerp(96, 176), lerp(34, 64)];
}

/** CSS rgba() for the 2D painter — alpha also ramps with confidence. */
export function adviceCssColor(
  isRecorder: boolean,
  teamId: number,
  prob: number,
  alpha = 1,
): string {
  const [r, g, b] = adviceColorRgb(isRecorder, teamId, prob);
  return `rgba(${r}, ${g}, ${b}, ${(alpha * (0.5 + 0.5 * Math.min(1, Math.max(0, prob)))).toFixed(3)})`;
}

/** One pooled 3D advice marker: a shaft+cone arrow along local +X (a
 * `rotation.y = mapBearingRad` orients it) plus a small hold dot shown
 * instead for the no-move class. One shared material per slot (per-arrow
 * color). */
export interface MoveAdviceArrowSlot {
  group: THREE.Group;
  shaft: THREE.Mesh;
  head: THREE.Mesh;
  holdDot: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
}

const arrowShaftGeo = new THREE.CylinderGeometry(
  SHAFT_WIDTH / 2,
  SHAFT_WIDTH / 2,
  1,
  6,
  1,
  false,
);
const arrowHeadGeo = new THREE.ConeGeometry(HEAD_WIDTH / 2, HEAD_LEN, 8);
const holdDotGeo = new THREE.SphereGeometry(HOLD_DOT_R, 10, 8);

function makeArrowSlot(color: number): MoveAdviceArrowSlot {
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
  });
  const group = new THREE.Group();
  // Cylinder/Cone default to +Y — lay them along local +X, origin at the
  // tail, so slot.group.rotation.y = mapBearingRad points the arrow.
  const shaft = new THREE.Mesh(arrowShaftGeo, material);
  shaft.rotation.z = -Math.PI / 2;
  const head = new THREE.Mesh(arrowHeadGeo, material);
  head.rotation.z = -Math.PI / 2;
  const holdDot = new THREE.Mesh(holdDotGeo, material);
  group.add(shaft, head, holdDot);
  return { group, shaft, head, holdDot, material };
}

function layoutArrow(
  slot: MoveAdviceArrowSlot,
  len: number,
  isHold: boolean,
  alpha: number,
): void {
  slot.shaft.visible = !isHold;
  slot.head.visible = !isHold;
  slot.holdDot.visible = isHold;
  slot.material.opacity = alpha;
  if (isHold) {
    slot.holdDot.position.set(0, 0, 0);
    return;
  }
  // Shaft occupies [0, len - HEAD_LEN]; the cone caps the tip.
  const shaftLen = Math.max(2, len - HEAD_LEN);
  slot.shaft.scale.set(1, shaftLen, 1);
  slot.shaft.position.set(shaftLen / 2, 0, 0);
  slot.head.position.set(shaftLen + HEAD_LEN / 2, 0, 0);
}

/** Re-sync the 3D advice arrow pool to the current report + playhead.
 * Called from `updateMarkersAt` (every marker refresh cadence); hidden or
 * absent layers collapse the whole pool to invisible. */
export function syncMoveAdvisories(ctx: MapInternals): void {
  const report: DecisionDebugReport | null = ctx.debugReport.value;
  const active = ctx.aiAnalysisOn.value && !!report && !!ctx.api.value?.scene;
  const pool = ctx.moveAdviceArrows;
  if (!active || !report) {
    for (const slot of pool) slot.group.visible = false;
    return;
  }
  // Collect (advice, isSecond) draw items in report order — primaries first.
  const items: { adv: MovementAdvice; isSecond: boolean }[] = [];
  for (const adv of report.movement) {
    items.push({ adv, isSecond: false });
    if (
      adv.topSector !== 16 &&
      adv.secondSector !== 16 &&
      adv.secondProb >= SECOND_SECTOR_DRAW_MIN
    ) {
      items.push({ adv, isSecond: true });
    }
  }
  let used = 0;
  for (const item of items) {
    const { adv, isSecond } = item;
    const marker = ctx.shipMarkers.find((m) => m.userData.entityId === adv.entityId);
    if (!marker || !marker.visible) continue;
    // Grow the pool lazily; slots are reused forever (disposed in
    // clearActors via disposeMoveAdviceArrows).
    while (pool.length <= used) {
      const slot = makeArrowSlot(0xffffff);
      ctx.api.value?.scene.add(slot.group);
      pool.push(slot);
    }
    const slot = pool[used++];
    slot.group.visible = true;
    const isHold = !isSecond && adv.topSector === 16;
    const prob = isSecond ? adv.secondProb : adv.topProb;
    const [r, g, b] = adviceColorRgb(adv.isRecorder, adv.teamId, prob);
    slot.material.color.setRGB(r / 255, g / 255, b / 255);
    const len = MOVE_ARROW_LEN_MIN + MOVE_ARROW_LEN_SPAN * prob;
    layoutArrow(slot, isSecond ? len * 0.55 : len, isHold, isSecond ? 0.45 : 0.92);
    slot.group.position.set(
      marker.position.x,
      marker.position.y + MOVE_ARROW_HOVER_UNITS,
      marker.position.z,
    );
    const bearing = isSecond ? secondBearingRad(adv) : adv.mapBearingRad;
    slot.group.rotation.set(0, bearing ?? 0, 0);
    slot.group.renderOrder = 3;
  }
  for (let i = used; i < pool.length; i++) pool[i].group.visible = false;
}

/** Dispose the pool (clearActors / unmount). */
export function disposeMoveAdviceArrows(ctx: MapInternals): void {
  const scene = ctx.api.value?.scene;
  for (const slot of ctx.moveAdviceArrows) {
    scene?.remove(slot.group);
    slot.material.dispose();
  }
  ctx.moveAdviceArrows = [];
}
