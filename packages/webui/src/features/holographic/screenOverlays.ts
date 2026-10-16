/**
 * Screen-space overlay construction for the holographic map's 3D scene,
 * extracted verbatim from HolographicMap.tsx: the constant pixel sizes of
 * the zoom-independent overlays, the Line2 ring builder and the cap-letter
 * sprite painter.
 */
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { OsdTone } from "./osdContrast";

// --- Screen-space overlay sizing -------------------------------------------
//
// The cap/smoke/ward rings and the cap-letter / smoke-countdown sprites used
// to be sized in world units (fat torus + fixed sprite scale), so zooming in
// blew them up into fat donuts and blurry billboards. They are now sized in
// SCREEN pixels: the rings are Line2 objects whose pixel linewidth never
// changes, and the sprites get a distance-derived world scale each frame so
// they always occupy the same number of CSS pixels. Canvas resolutions are
// bumped accordingly so the textures stay supersampled (crisp) at that size.

/** Constant on-screen sizes (CSS px) for the zoom-independent overlays. */
export const CAP_RING_PX = 3;
export const SMOKE_RING_PX = 2;
export const WARD_RING_PX = 2;
export const CAP_SPRITE_PX = 64;
export const SMOKE_SPRITE_PX = 30;

/** Circle tessellation for the screen-space rings (closed loop). */
const OVERLAY_RING_SEGMENTS = 96;

/** Flat circle vertex positions in the XZ plane (closed loop). */
export function circlePositions(radius: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= OVERLAY_RING_SEGMENTS; i++) {
    const a = (i / OVERLAY_RING_SEGMENTS) * Math.PI * 2;
    pts.push(Math.cos(a) * radius, 0, Math.sin(a) * radius);
  }
  return pts;
}

/** Build a flat circle in the XZ plane as a Line2 with a pixel linewidth. */
export function makeOverlayRing(radius: number, pxWidth: number, opacity: number): Line2 {
  const geom = new LineGeometry();
  geom.setPositions(circlePositions(radius));
  const mat = new LineMaterial({
    color: 0xffffff,
    transparent: true,
    opacity,
    depthWrite: false,
    // worldUnits defaults to false → linewidth is screen pixels.
    linewidth: pxWidth,
  });
  const line = new Line2(geom, mat);
  // Gameplay overlays draw above the weather mask (order 6, see
  // weatherScene.STORM_ORDER) — the 2D painter's layer order, where the
  // rings sit on top of the storm darkening.
  line.renderOrder = OVERLAY_RING_ORDER;
  return line;
}

/** Transparent-pass slot for gameplay rings/letters — above the storm
 *  mask (6), below nothing else the scene layers. */
export const OVERLAY_RING_ORDER = 7;

/** Paint the cap-point sprite: big zone letter on top, optional capture
 *  countdown below. Shared by the initial draw and the per-frame redraw so
 *  both stay on the same hi-res layout. `tone` picks the ink: light (the
 *  historical white) or dark (OSD auto-contrast over a bright backdrop —
 *  see osdContrast.ts); the amber ETA darkens one step with the ink. */
export function paintCapSprite(
  canvas: HTMLCanvasElement,
  letter: string,
  eta: string,
  tone: OsdTone = "light",
) {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = tone === "dark" ? "rgba(31, 41, 55, 0.92)" : "rgba(255,255,255,0.8)";
  ctx.font = "bold 140px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(letter, canvas.width / 2, canvas.height * 0.34);
  if (eta) {
    ctx.fillStyle = tone === "dark" ? "rgba(180, 83, 9, 0.95)" : "rgba(251,191,36,0.95)";
    ctx.font = "bold 56px sans-serif";
    ctx.fillText(eta, canvas.width / 2, canvas.height * 0.78);
  }
}

/** Paint a smoke cluster's remaining-seconds tag. Same ink semantics as
 *  paintCapSprite: the shadow flips with the ink so the countdown reads
 *  over both the dark sea and its own bright smoke / cyclone wash. */
export function paintSmokeCountdown(
  canvas: HTMLCanvasElement,
  text: string,
  tone: OsdTone = "light",
) {
  const c2d = canvas.getContext("2d")!;
  c2d.clearRect(0, 0, canvas.width, canvas.height);
  c2d.fillStyle = tone === "dark" ? "rgba(31, 41, 55, 0.92)" : "rgba(255,255,255,0.9)";
  c2d.font = "bold 80px sans-serif";
  c2d.textAlign = "center";
  c2d.textBaseline = "middle";
  c2d.shadowColor = tone === "dark" ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.9)";
  c2d.shadowBlur = 12;
  c2d.fillText(text, canvas.width / 2, canvas.height / 2);
  c2d.shadowBlur = 0;
}
