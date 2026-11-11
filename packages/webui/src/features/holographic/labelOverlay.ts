/**
 * Screen-space label + overlay projection, extracted verbatim from
 * HolographicMap.tsx: the floating ship labels' canvas-pixel positions and
 * the constant-on-screen-size scaling for the cap letters / smoke countdown
 * sprites and overlay ring materials.
 */
import * as THREE from "three";
import { CAP_SPRITE_PX, SMOKE_SPRITE_PX } from "./screenOverlays";
import type { SquadronPlane } from "@/api";
import { samplesUpTo } from "./trajectoryMath";
import type { MapInternals } from "./mapInternals";

/** Camera distance under which the below-hull combat status rows render —
 *  at chase-cam range (~60 units) they always show; past this the whole
 *  map reads as labels anyway, and rows would turn to noise. */
export const STATUS_ROWS_MAX_DIST = 520;
/** Half a nominal hull along the heading, for the bow/stern screen-edge
 *  projection the rows anchor to (cosmetic — a BB's extra length just
 *  nudges the rows a few px). */
const HULL_HALF_LEN = 30;
/** Gap between the hull's lower screen edge and the first row. */
const STATUS_ROW_GAP_PX = 10;
/** Screen-space offset of the aircraft's below-row from its card anchor:
 *  the card sits above the formation, so the chips clear its lower edge. */
const PLANE_ROW_DY = 34;

/** Position one imperative label/status slot: translate3d keeps the write
 *  compositor-only (no layout), display gates on-screen visibility. The
 *  slots are plain wrapper divs (see HolographicMap's template) — writing
 *  them directly keeps the per-frame position churn OUT of Vue's render
 *  path; only low-frequency content (name/hp/status) re-renders. */
function applySlot(
  slot: HTMLDivElement | null | undefined,
  visible: boolean,
  x: number,
  y: number,
): void {
  if (!slot) return;
  if (!visible) {
    if (slot.style.display !== "none") slot.style.display = "none";
    return;
  }
  slot.style.transform = "translate3d(" + x.toFixed(1) + "px," + y.toFixed(1) + "px,0)";
  // "block", not "": the stylesheet ships the slots display:none by default
  // (so a not-yet-projected label can never flash at the layer origin), and
  // an empty inline display would let that default win again.
  if (slot.style.display === "none" || slot.style.display === "") slot.style.display = "block";
}

/** Project every visible marker's world position into screen pixels and
 *  write them into `ctx.shipLabels` (for OSD sampling / tooltips) and the
 *  imperative slot elements (for the actual DOM positioning). */
export function updateLabelPositions(ctx: MapInternals) {
  const cam = ctx.api.value?.camera;
  const rnd = ctx.api.value?.renderer;
  const el = ctx.container.value;
  const canvas = rnd?.domElement;
  if (!cam || !rnd || !el || !canvas) return;
  const labels = ctx.shipLabels.value;
  const hw = canvas.clientWidth / 2;
  const hh = canvas.clientHeight / 2;
  for (let i = 0; i < ctx.shipMarkers.length; i++) {
    const label = labels[i];
    if (!label) continue;
    const marker = ctx.shipMarkers[i];
    const dead =
      marker.userData.deathTime != null &&
      ctx.current.value >= (marker.userData.deathTime as number);
    if (!marker.visible && !dead) {
      label.visible = false;
      label.belowVisible = false;
      // The slot's display is the ONLY hide mechanism now (the template no
      // longer consumes label.visible) — skip paths must hide explicitly.
      applySlot(ctx.labelSlotEls.get("l" + label.entityId), false, 0, 0);
      applySlot(ctx.labelSlotEls.get("s" + label.entityId), false, 0, 0);
      continue;
    }
    // Sunk markers are hidden, but their position keeps tracking the live
    // sample — project it anyway so the "sunk" label follows the actual
    // coordinates (and the camera) instead of freezing at the death spot.
    // Project the marker's world position (offset 20 units upward so the
    // label sits above the ship silhouette, not buried inside it).
    ctx._projVec.copy(marker.position);
    ctx._projVec.y += 20;
    ctx._projVec.project(cam);
    // NDC → pixel within the canvas rect.
    label.x = (ctx._projVec.x * hw) + hw;
    label.y = (-ctx._projVec.y * hh) + hh;
    label.visible = ctx._projVec.z < 1;
    // Below-hull status rows: anchor at the hull's lower screen edge —
    // project bow and stern along the heading and take whichever sits
    // lower, so the rows hug the hull at any camera angle.
    const near =
      label.visible && !dead && cam.position.distanceTo(marker.position) <= STATUS_ROWS_MAX_DIST;
    let bottomY: number | null = null;
    if (near) {
      const yaw = marker.rotation.y;
      const fx = Math.sin(yaw) * HULL_HALF_LEN;
      const fz = -Math.cos(yaw) * HULL_HALF_LEN;
      for (const side of [1, -1]) {
        ctx._projVec.set(
          marker.position.x + fx * side,
          marker.position.y,
          marker.position.z + fz * side,
        );
        ctx._projVec.project(cam);
        if (ctx._projVec.z >= 1) {
          bottomY = null;
          break;
        }
        const py = (-ctx._projVec.y * hh) + hh;
        if (bottomY == null || py > bottomY) bottomY = py;
      }
    }
    label.belowVisible = near && bottomY != null;
    if (bottomY != null) {
      label.belowX = label.x;
      label.belowY = bottomY + STATUS_ROW_GAP_PX;
    }
    applySlot(ctx.labelSlotEls.get("l" + label.entityId), label.visible, label.x, label.y);
    applySlot(
      ctx.labelSlotEls.get("s" + label.entityId),
      label.belowVisible && label.status != null,
      label.belowX,
      label.belowY,
    );
  }
  // Aircraft labels project above the carrier's currently airborne
  // squadrons (the newest sample of the newest sortie).
  for (const [labelId] of ctx.planeLabelCarriers) {
    const label = labels.find((l) => l.entityId === labelId);
    if (!label || !label.visible) {
      // Carrier label not currently airborne-visible: hide its slots too —
      // INCLUDING the below-aircraft chip row, otherwise the last shown
      // consumables stick to the screen after the last sortie lands.
      if (label) {
        applySlot(ctx.labelSlotEls.get("l" + label.entityId), false, 0, 0);
        applySlot(ctx.labelSlotEls.get("s" + label.entityId), false, 0, 0);
      }
      continue;
    }
    let anchor: SquadronPlane | null = null;
    let anchorPlaneId: number | null = null;
    // The label projects the RENDERED wedge centroid the marker pass
    // publishes (planeWedge): the recorded lens ride draws the models ~80
    // units ahead of the camera, so projecting the trail sample parked the
    // aircraft card at the lens (off-screen) while the planes were elsewhere
    // (user report: no labels next to the aircraft).
    // Stable pick: a carrier can have several sorties airborne, and the
    // "newest sample" alternates between them tick to tick, which made the
    // card hop between two formations (the flicker the user reported).
    // Prefer the formation the map is RENDERING nearest the camera — that is
    // the one in view, and it is deterministic for a given frame.
    const bestWedgePlane = pickLabelWedgePlane(ctx, labelId, cam.position);
    for (const [planeId, labelOf] of ctx.planeLabelOfPlane) {
      if (labelOf !== labelId) continue;
      // With a rendered wedge for this carrier, only that formation's card
      // is considered — the sample scan below is the model-less fallback.
      if (bestWedgePlane >= 0 && planeId !== bestWedgePlane) continue;
      const trail = ctx.planeTrails.find((tr) => Math.floor(tr.id / 16) === planeId);
      if (!trail || trail.samples.length === 0) continue;

      // Playhead-accurate: the carrier's aircraft label must ride the sortie
      // the map is SHOWING, not the trail's end pose — the minimap merge
      // pads sparse-3D squadrons out to their sortie end, which otherwise
      // parks the label hundreds of units ahead of the rendered wedge.
      const at = samplesUpTo(trail.samples, ctx.current.value) - 1;
      if (at < 0) continue;
      const sp = trail.samples[at];
      if (!anchor || sp.time > anchor.time) {
        anchor = sp;
        anchorPlaneId = planeId;
      }
    }
    if (!anchor) {
      label.visible = false;
      applySlot(ctx.labelSlotEls.get("l" + label.entityId), false, 0, 0);
      applySlot(ctx.labelSlotEls.get("s" + label.entityId), false, 0, 0);
      continue;
    }
    // Project the RENDERED wedge when the marker pass published one (see
    // planeWedge); the trail sample is only the fallback for formations
    // without models.
    const wedge =
      anchorPlaneId != null ? ctx.planeWedge.get(anchorPlaneId) : undefined;
    const wx = wedge ? wedge.x : anchor.x;
    const wy = wedge ? wedge.y : anchor.y;
    const wz = wedge ? wedge.z : anchor.z;
    // Recorded/original camera: aircraft fly at the camera's altitude (no
    // 60 m patrol floor), so the label rides just above them; every other
    // view keeps the patrol-floor lift.
    const lift = ctx.planeRecordedView ? wy + 15 : Math.max(60, wy) + 30;
    ctx._projVec.set(wx, lift, -wz);
    ctx._projVec.project(cam);
    if (ctx._projVec.z >= 1 && Number.isFinite(ctx._projVec.z)) {
      // Behind the camera (a sharp recorded maneuver, or the hold-RMB free
      // look swinging away): the card used to VANISH for the whole stretch,
      // which read as labels "occasionally disappearing". The NDC of a
      // behind-camera point IS the negated bearing, so pinning it to a
      // screen-edge ring keeps the card visible and roughly pointing at the
      // formation (the non-finite guard covers the exact camera plane,
      // where the perspective divide yields ±Infinity/NaN).
      if (Number.isFinite(ctx._projVec.x) && Number.isFinite(ctx._projVec.y)) {
        const edge = behindCameraEdgeNdc(ctx._projVec.x, ctx._projVec.y);
        ctx._projVec.x = edge.x;
        ctx._projVec.y = edge.y;
        ctx._projVec.z = 0.5;
      }
    }
    label.x = (ctx._projVec.x * hw) + hw;
    label.y = (-ctx._projVec.y * hh) + hh;
    applySlot(ctx.labelSlotEls.get("l" + label.entityId), label.visible, label.x, label.y);
    // Below-aircraft chip row: HP/alive count ride the card, the consumables
    // and boost run UNDER the formation (user request). Visible whenever the
    // card is, as long as the replay streamed anything to show.
    const row = planeRowVisible(label);
    applySlot(
      ctx.labelSlotEls.get("s" + label.entityId),
      row && label.visible,
      label.x,
      label.y + PLANE_ROW_DY,
    );
  }
}

/** Pin an NDC point that projected BEHIND the camera onto the screen-edge
 *  ring (±0.8, inset so the centred card is not half-clipped): such
 *  projections are geometrically meaningless, but their direction still
 *  points roughly at the anchor, so off-screen cards stay readable instead
 *  of vanishing. Non-finite inputs (the exact camera plane divides to
 *  ±Infinity/NaN) collapse to the screen centre rather than poisoning the
 *  translate3d with NaN. */
export function behindCameraEdgeNdc(x: number, y: number): { x: number; y: number } {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 };
  const scale = 0.8 / Math.max(Math.abs(x), Math.abs(y), 1e-6);
  return { x: x * scale, y: y * scale };
}

/** Whether the below-aircraft chip row has anything to show: engine boost,
 *  the slow-down key, or any open consumable window. Pure so the row's
 *  visibility contract is unit-testable (a slow-only state must show the
 *  row — the PR that added planeSlow originally forgot this gate). */
export function planeRowVisible(label: {
  planeBoost?: boolean;
  planeSlow?: boolean;
  planeConsumables?: unknown[];
}): boolean {
  return (
    (label.planeBoost ? 1 : 0) +
    (label.planeSlow ? 1 : 0) +
    (label.planeConsumables?.length ?? 0)
  ) > 0;
}

/** Which formation's rendered wedge should carry a carrier's aircraft
 *  label: the one NEAREST the camera among the formations this label owns
 *  (deterministic `planeId` tie-break so a multi-sortie carrier cannot make
 *  the card hop between anchors tick to tick). −1 = none rendered, and the
 *  caller then falls back to the newest-sample scan. */
export function pickLabelWedgePlane(
  ctx: MapInternals,
  labelId: number,
  camPos: { x: number; y: number; z: number },
): number {
  let bestDist = Infinity;
  let best = -1;
  for (const [planeId, labelOf] of ctx.planeLabelOfPlane) {
    if (labelOf !== labelId) continue;
    const w = ctx.planeWedge.get(planeId);
    if (!w) continue;
    // Wedges are world coords, the camera is scene (z mirrored).
    const d = Math.hypot(w.x - camPos.x, w.y - camPos.y, w.z + camPos.z);
    if (d < bestDist - 1e-6 || (Math.abs(d - bestDist) <= 1e-6 && planeId < best)) {
      bestDist = d;
      best = planeId;
    }
  }
  return best;
}

/** Keep the screen-space overlays (cap/smoke/ward ring outlines, cap
 *  letters, smoke countdown) at a constant on-screen size: the Line2
 *  ring materials only need their viewport resolution uniform refreshed,
 *  while each text sprite gets a world scale derived from its distance
 *  to the camera so it always spans the same number of CSS pixels —
 *  zooming no longer inflates them into fat, blurry billboards. */
export function updateOverlayScale(ctx: MapInternals) {
  const cam = ctx.api.value?.camera;
  const el = ctx.container.value;
  if (!cam || !el) return;
  const vw = el.clientWidth || 800;
  const vh = el.clientHeight || 600;
  // World units per CSS pixel, per unit of camera distance: a sprite
  // whose world height is `dist * k * px` spans exactly `px` pixels.
  const k = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / vh;
  for (const mat of ctx.overlayLineMats) mat.resolution.set(vw, vh);
  const fitSprite = (sprite: THREE.Sprite, pxHeight: number, aspect: number) => {
    const dist = cam.position.distanceTo(sprite.position);
    const world = dist * k * pxHeight;
    sprite.scale.set(world * aspect, world, 1);
  };
  for (const s of ctx.capLetterSprites) fitSprite(s, CAP_SPRITE_PX, 1);
  for (const cl of ctx.smokeClusters) {
    if (cl.timeSprite) fitSprite(cl.timeSprite, SMOKE_SPRITE_PX, 2);
  }
}
