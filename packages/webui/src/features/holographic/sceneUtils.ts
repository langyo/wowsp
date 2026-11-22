/**
 * Small three.js / geometry helpers shared inside the holographic map,
 * extracted verbatim from HolographicMap.tsx: the camera frustum's
 * ground-plane corners (minimap camera cone), a generic Object3D dispose
 * walk (scene teardown), an XZ rect clamp (projectile paths kept inside the
 * playable map), the export camera's layer-mask assembly (the clip must
 * render the live view's visible set plus its export-only layers), and the
 * 3D export's god-view symbol scale (true-scale hulls are ~2 px slivers at
 * full-map range, so the clip draws them as constant-screen-size tactical
 * symbols). Pure utilities — no component state.
 */
import * as THREE from "three";

export function frustumCorners(cam: THREE.PerspectiveCamera): THREE.Vector3[] {
  const hw = 0.5;
  const hh = hw / cam.aspect;
  const corners: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) {
    const sx = i === 0 || i === 3 ? -hw : hw;
    const sy = i < 2 ? -hh : hh;
    const pt = new THREE.Vector3(sx, sy, 1).unproject(cam);
    const ray = pt.clone().sub(cam.position).normalize();
    const t = -(cam.position.y) / ray.y;
    corners.push(cam.position.clone().add(ray.multiplyScalar(t)));
  }
  return corners;
}

/** Dispose an Object3D generically — primitive mesh or wrapped GLB group.
 *  Materials are always disposed (per-instance). Geometry is disposed too,
 *  EXCEPT for GLB-derived groups (userData.sharedGeometry): their buffers
 *  are shared with the decode cache and must survive until the cache is
 *  cleared on unmount. */
export function disposeAny(obj: THREE.Object3D): void {
  const shared = obj.userData.sharedGeometry === true;
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!shared) mesh.geometry?.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) m.dispose();
  });
}

/** three.js packs layer indices into a uint32 mask (`Layers`); 0..31. */
export const MAX_LAYER_INDEX = 31;

/**
 * The EXPORT camera's layer mask: every layer the LIVE camera enables, plus
 * the take's export-only layers (the in-scene ship-label cards on
 * `EXPORT_LABEL_LAYER`).
 *
 * The clip renders the replay's own scene, so its visible set must be the
 * live view's visible set — never a subset. Hand-listing indices at the
 * export camera (its historical shape: the fresh camera's default layer 0
 * plus the label layer) silently drops every object that sits on a layer
 * outside that list: the take then renders some classes and not others —
 * terrain and label cards without the hull models, say — with nothing in the
 * code marking the omission. Copying the live mask keeps the two in
 * lock-step by construction: a class moved to another layer still exports,
 * and a new layer needs no export-side edit.
 *
 * Bit indices outside `Layers`' 0..31 range are ignored (JS shifts would
 * wrap them onto another channel). */
export function exportCameraLayerMask(
  liveMask: number,
  exportOnlyLayers: readonly number[] = [],
): number {
  let mask = liveMask;
  for (const layer of exportOnlyLayers) {
    if (Number.isInteger(layer) && layer >= 0 && layer <= MAX_LAYER_INDEX) {
      mask |= 1 << layer;
    }
  }
  return mask;
}

/** Apply {@link exportCameraLayerMask} to the take's camera. The live camera
 *  is only READ — the export never mutates the user's camera/layers. */
export function adoptExportCameraLayers(
  exportCamera: THREE.Camera,
  liveCamera: THREE.Camera,
  exportOnlyLayers: readonly number[] = [],
): void {
  exportCamera.layers.mask = exportCameraLayerMask(
    liveCamera.layers.mask,
    exportOnlyLayers,
  );
}

/* ── The 3D export's god-view hull symbols ───────────────────────────────
 *  The clip's god camera frames the WHOLE map from tens of km away. At that
 *  distance a true-scale hull is a ~2 px sliver: it is there in the frame,
 *  but invisible beside the screen-constant 92x40 px label cards. So the 3D
 *  take draws each hull as a TACTICAL-MAP SYMBOL: its true size up close, and
 *  enlarged just enough to hold a constant on-screen length at god-view
 *  range — the label cards' own distance math
 *  (worldPerLogicalPx = distance * 2*tan(fov/2) / bufferWidth).
 *
 *  The scale is provisional (the symbol is clamped to at least its true size
 *  and to a hard cap), so this returns a WORLD-LENGTH MULTIPLIER: the caller
 *  applies it to the hull (and its placeholder cone) for the export render
 *  only, restoring the live scale immediately afterwards.
 *
 *  `bufferWidth` is the logical buffer `targetPx` is measured in — the map
 *  square's own logical edge (EXPORT_LOGICAL), the same space the label cards
 *  are sized in. Both therefore stay resolution-independent: the 56 px symbol
 *  can never out-grow the 92 px card on a 720p clip or a 4K one. */

/** On-screen length of a hull symbol in the clip's logical map px — under
 *  the label card's 92 px width, so the card stays strictly dominant. */
export const GOD_SYMBOL_TARGET_PX = 56;
/** Floor: a hull is never shrunk below its true engine scale (close range
 *  keeps the live view's exact look; the symbol only ever expands). */
export const GOD_SYMBOL_MIN_SCALE = 1;
/** Hard cap: a broken/absurd extent measurement can never inflate a hull
 *  into a screen-filling blob (a 40x battleship already fills the square at
 *  full-map range). */
export const GOD_SYMBOL_MAX_SCALE = 40;

/** The world-length multiplier that makes a `modelWorldLength`-long hull span
 *  `targetPx` on screen at `distance`, clamped to [minScale, maxScale].
 *
 *  A degenerate input (non-finite / non-positive distance, fov, target,
 *  buffer width or model length) answers `minScale`: an unmeasurable hull
 *  keeps its true scale instead of producing a NaN transform. */
export function godViewSymbolScale(
  distance: number,
  fovDeg: number,
  targetPx: number,
  bufferWidth: number,
  modelWorldLength: number,
  minScale: number = GOD_SYMBOL_MIN_SCALE,
  maxScale: number = GOD_SYMBOL_MAX_SCALE,
): number {
  const lo = Number.isFinite(minScale) ? minScale : GOD_SYMBOL_MIN_SCALE;
  const hi = Number.isFinite(maxScale) ? maxScale : GOD_SYMBOL_MAX_SCALE;
  const clamp = (v: number): number => Math.min(hi, Math.max(lo, v));
  const usable =
    Number.isFinite(distance) &&
    distance > 0 &&
    Number.isFinite(fovDeg) &&
    fovDeg > 0 &&
    fovDeg < 180 &&
    Number.isFinite(targetPx) &&
    targetPx > 0 &&
    Number.isFinite(bufferWidth) &&
    bufferWidth > 0 &&
    Number.isFinite(modelWorldLength) &&
    modelWorldLength > 0;
  if (!usable) return clamp(GOD_SYMBOL_MIN_SCALE);
  // The world width that maps to `targetPx` at this depth (the cards'
  // formula), divided by the hull's own length.
  const worldLen =
    (distance * 2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2) * targetPx) /
    bufferWidth;
  return clamp(worldLen / modelWorldLength);
}

/** Clamp an XZ point into a rect (null rect = no clamp). */
export function clampXZ(
  x: number,
  z: number,
  rect: { minX: number; maxX: number; minZ: number; maxZ: number } | null,
): { x: number; z: number } {
  if (!rect) return { x, z };
  return {
    x: Math.min(rect.maxX, Math.max(rect.minX, x)),
    z: Math.min(rect.maxZ, Math.max(rect.minZ, z)),
  };
}
