/**
 * Screen-space label + overlay projection, extracted verbatim from
 * HolographicMap.tsx: the floating ship labels' canvas-pixel positions and
 * the constant-on-screen-size scaling for the cap letters / smoke countdown
 * sprites and overlay ring materials.
 */
import * as THREE from "three";
import { CAP_SPRITE_PX, SMOKE_SPRITE_PX } from "./screenOverlays";
import type { SquadronPlane } from "@/api";
import type { MapInternals } from "./mapInternals";

/** Project every visible marker's world position into screen pixels and
 *  write them into `ctx.shipLabels` so the overlay <div>s track the ships. */
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
  }
  // Aircraft labels project above the carrier's currently airborne
  // squadrons (the newest sample of the newest sortie).
  for (const [labelId] of ctx.planeLabelCarriers) {
    const label = labels.find((l) => l.entityId === labelId);
    if (!label || !label.visible) continue;
    let anchor: SquadronPlane | null = null;
    for (const [planeId, labelOf] of ctx.planeLabelOfPlane) {
      if (labelOf !== labelId) continue;
      const trail = ctx.planeTrails.find((tr) => Math.floor(tr.id / 16) === planeId);
      if (!trail || trail.samples.length === 0) continue;
      const sp = trail.samples[trail.samples.length - 1];
      if (!anchor || sp.time > anchor.time) anchor = sp;
    }
    if (!anchor) { label.visible = false; continue; }
    ctx._projVec.set(anchor.x, Math.max(60, anchor.y) + 30, -anchor.z);
    ctx._projVec.project(cam);
    label.x = (ctx._projVec.x * hw) + hw;
    label.y = (-ctx._projVec.y * hh) + hh;
    if (ctx._projVec.z >= 1) label.visible = false;
  }
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
