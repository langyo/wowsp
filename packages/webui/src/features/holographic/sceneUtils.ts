/**
 * Small three.js / geometry helpers shared inside the holographic map,
 * extracted verbatim from HolographicMap.tsx: the camera frustum's
 * ground-plane corners (minimap camera cone), a generic Object3D dispose
 * walk (scene teardown), an XZ rect clamp (projectile paths kept inside the
 * playable map), and the export camera's layer-mask assembly (the clip must
 * render the live view's visible set plus its export-only layers). Pure
 * utilities — no component state.
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
