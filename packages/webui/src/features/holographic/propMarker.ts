/**
 * Projectile / aircraft marker builder for the holographic 3D scene.
 *
 * Small baked GLBs (shell, torpedo, planes) share one decode cache and are
 * cloned per use. Each marker is wrapped so callers can drive it exactly like
 * the primitive meshes it replaces:
 *
 * - `axis: "y"` — the model's forward (+Z, WoWs convention) is remapped to
 *   local +Y, so the outer group works with
 *   `quaternion.setFromUnitVectors(up, dir)` (shells along their arc tangent,
 *   torpedoes along their travel direction).
 * - `axis: "z"` — forward stays +Z, so the outer group works with plain
 *   `rotation.y` yaw (aircraft).
 *
 * The model is centered on its bounding-box center and scaled so its size
 * along the forward axis equals `targetLen` (scene units).
 */
import * as THREE from "three";

import { loadGlbModel } from "./modelLoader";

const glbCache = new Map<string, Promise<THREE.Group>>();

/** Shared decode with in-flight dedup: a match start fires ~220 shell-trace
 *  swaps (plus one per torpedo) at once, and a result-only cache made every
 *  concurrent call miss and re-fetch + re-parse the SAME two prop GLBs.
 *  Caching the PROMISE collapses them into one load; failures are dropped
 *  from the cache so a later caller can retry. */
function loadShared(url: string): Promise<THREE.Group> {
  const pending = glbCache.get(url);
  if (pending) return pending;
  const load = loadGlbModel(url)
    .then((g) => {
      g.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry?.attributes.position) {
          mesh.geometry.computeBoundingBox();
          mesh.geometry.computeBoundingSphere();
        }
      });
      return g;
    })
    .catch((e) => {
      // Evict only OUR entry: a post-clear reload may already have installed
      // a newer promise for the same URL by the time this one rejects.
      if (glbCache.get(url) === load) glbCache.delete(url);
      throw e;
    });
  glbCache.set(url, load);
  return load;
}

export interface BuildPropOpts {
  url: string;
  /** Tint color (shell ammo color, plane type color, white torpedo). */
  color: number;
  /** "y": forward remapped to +Y (arc-tangent quaternions); "z": keep +Z. */
  axis: "y" | "z";
  /** Scene-unit size of the model along its forward axis. */
  targetLen: number;
  opacity?: number;
}

export async function buildPropMarker(opts: BuildPropOpts): Promise<THREE.Group> {
  const source = await loadShared(opts.url);
  const model = source.clone(true);

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  // Tint every mesh with a flat emissive-less material (matches the existing
  // battle-effect style: bright, depth-write off).
  const mat = new THREE.MeshBasicMaterial({
    color: opts.color,
    transparent: true,
    opacity: opts.opacity ?? 0.95,
    depthWrite: false,
  });
  const meshes: THREE.Mesh[] = [];
  model.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
  });
  for (const m of meshes) m.material = mat;

  // Center, scale to targetLen along +Z, then remap axis if requested.
  model.position.copy(center.clone().negate());
  const inner = new THREE.Group();
  inner.add(model);
  const scale = opts.targetLen / Math.max(size.z, 1e-6);
  inner.scale.setScalar(scale);
  if (opts.axis === "y") {
    // Rotating -90° about X maps local +Z onto +Y (forward now along +Y).
    inner.rotation.x = -Math.PI / 2;
  }

  const outer = new THREE.Group();
  outer.add(inner);
  // Geometry is shared with the decode cache (clone(true) keeps the same
  // BufferGeometry instances) — callers must not dispose it per-marker.
  outer.userData.sharedGeometry = true;
  return outer;
}

/** Release the shared prop cache (call when leaving the replay view). */
export function clearPropMarkerCache(): void {
  for (const group of glbCache.values()) {
    void group
      .then((g) => {
        g.traverse((o) => {
          const mesh = o as THREE.Mesh;
          mesh.geometry?.dispose();
          const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
          if (!mat) return;
          for (const m of Array.isArray(mat) ? mat : [mat]) m.dispose();
        });
      })
      .catch(() => {
        /* failed loads hold nothing */
      });
  }
  glbCache.clear();
}
