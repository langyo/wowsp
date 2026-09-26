/**
 * Screen-space overlay construction for the holographic map's 3D scene,
 * extracted verbatim from HolographicMap.tsx: the constant pixel sizes of
 * the zoom-independent overlays, the Line2 ring builder and the cap-letter
 * sprite painter.
 */
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

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
  return new Line2(geom, mat);
}

/** Paint the cap-point sprite: big zone letter on top, optional capture
 *  countdown below. Shared by the initial draw and the per-frame redraw so
 *  both stay on the same hi-res layout. */
export function paintCapSprite(canvas: HTMLCanvasElement, letter: string, eta: string) {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.font = "bold 140px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(letter, canvas.width / 2, canvas.height * 0.34);
  if (eta) {
    ctx.fillStyle = "rgba(251,191,36,0.95)";
    ctx.font = "bold 56px sans-serif";
    ctx.fillText(eta, canvas.width / 2, canvas.height * 0.78);
  }
}
