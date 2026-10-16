/**
 * Small three.js / geometry helpers shared inside the holographic map,
 * extracted verbatim from HolographicMap.tsx: the camera frustum's
 * ground-plane corners (minimap camera cone), a generic Object3D dispose
 * walk (scene teardown), and an XZ rect clamp (projectile paths kept inside
 * the playable map). Pure utilities — no component state.
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
