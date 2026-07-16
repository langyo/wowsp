/**
 * Ship-marker builder for the replay holographic map.
 *
 * Each ship on the map is rendered as a small 3D hologram of its actual ship
 * model (or a tier/nation/type fallback), tinted by team role (self/ally/enemy)
 * instead of the old flat cone. Because a match can have up to ~24 ships — and
 * many will be the same ship — decoded GLBs are cached by URL and cloned so
 * identical ships share one decoded scene graph (geometry + materials are not
 * re-parsed, only re-instantiated).
 *
 * The baked GLBs ship without POSITION accessor min/max (stripped during
 * baking), so per-geometry bounding boxes are recomputed before normalizing.
 *
 * Marker orientation: the model is normalized so its longest hull axis lies
 * along +Z (ship bow toward +Z at yaw 0), matching WoWS heading (yaw rotates
 * about Y). The caller sets `rotation.y = yaw` each frame.
 */
import * as THREE from "three";

import { loadGlbModel } from "./modelLoader";
import { makeHoloMaterial } from "./holoShader";
import { holoColorsFor, type TeamRole } from "./teamColors";

/** Target length (Three.js units) of a marker's longest axis on the map.
 *  Sized down from ShipStage's 200 — the map spans thousands of units, so a
 *  ship must read as a distinct token without swallowing its neighbors. */
const MARKER_LENGTH = 70;

/** Cache of decoded GLB root groups, keyed by resolved model URL. Cloning a
 *  cached group is far cheaper than re-parsing the GLB; identical ships in a
 *  match (common for mirror matchmaking) share one entry here. */
const glbCache = new Map<string, THREE.Group>();

interface BuildShipMarkerOpts {
  /** Resolved GLB URL (from the model loader). */
  url: string;
  /** Team role — drives the holographic tint. */
  role: TeamRole;
}

/** Build a holographic ship marker for the map. Loads (or clones from cache)
 *  the GLB at `url`, normalizes it to `MARKER_LENGTH` units, and applies the
 *  role-tinted holographic shader to every mesh. Resolves to the marker group,
 *  or rejects if the model fails to load (caller falls back to a cone).
 *
 *  The returned group's own materials are owned by the caller; geometry is
 *  shared with the cache, so DO NOT dispose geometry — use `disposeMarker()`. */
export async function buildShipMarker(opts: BuildShipMarkerOpts): Promise<THREE.Group> {
  const { url, role } = opts;

  // Load (or reuse) the decoded scene graph.
  let source = glbCache.get(url);
  if (!source) {
    source = await loadGlbModel(url);
    // Baked GLBs drop POSITION min/max — recompute so bounds logic works.
    source.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry?.attributes.position) {
        mesh.geometry.computeBoundingBox();
        mesh.geometry.computeBoundingSphere();
      }
    });
    glbCache.set(url, source);
  }

  // Clone the cached graph: geometry is shared, but we need our own materials
  // (per-role tint) and transforms.
  const model = cloneWithSharedGeometry(source);

  // Normalize: center + uniform-scale so the longest axis = MARKER_LENGTH.
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const scale = MARKER_LENGTH / maxDim;
  model.scale.setScalar(scale);
  const center = box.getCenter(new THREE.Vector3()).multiplyScalar(scale);
  model.position.sub(center);

  // Orient hull along +Z. Ships bake with bow along +X in some models; if the
  // model is wider than it is long, rotate it 90° so the long axis points Z.
  const scaledSize = size.multiplyScalar(scale);
  if (scaledSize.x > scaledSize.z) {
    model.rotation.y = Math.PI / 2;
    // Re-center after rotation (rotation is about the model origin, already centered).
  }

  // Apply the role-tinted holographic shader to every mesh. Collect first so
  // the wireframe overlay (added as a child) doesn't recurse during traverse.
  const { baseColor, fresnelColor } = holoColorsFor(role);
  const holoMat = makeHoloMaterial();
  holoMat.uniforms.baseColor.value.setHex(baseColor);
  holoMat.uniforms.fresnelColor.value.setHex(fresnelColor);
  const wireMat = new THREE.MeshBasicMaterial({
    color: baseColor,
    wireframe: true,
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
  });
  const meshes: THREE.Mesh[] = [];
  model.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
  });
  for (const mesh of meshes) {
    mesh.material = holoMat;
    const wire = new THREE.Mesh(mesh.geometry, wireMat);
    wire.raycast = () => {}; // overlay shouldn't intercept picks
    mesh.add(wire);
  }

  return model;
}

/** Clone a cached THREE.Group. `Object3D.clone()` is shallow on geometry —
 *  the clone shares the source's `BufferGeometry` instances (one GPU buffer
 *  per unique ship, reused across every marker of that ship), while still
 *  producing an independent transform tree. Materials come through as shared
 *  references too, but the caller replaces them per-role, so the clone's
 *  material references are simply discarded. */
function cloneWithSharedGeometry(source: THREE.Group): THREE.Group {
  return source.clone(true);
}

/** Dispose the per-marker materials on a marker built by `buildShipMarker`.
 *  Geometry is intentionally NOT disposed (it's shared via the cache); call
 *  `clearShipMarkerCache()` on unmount/replay-switch to release those. */
export function disposeMarker(marker: THREE.Group): void {
  const disposedMats = new Set<THREE.Material>();
  marker.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    const mats = Array.isArray(mat) ? mat : [mat];
    for (const m of mats) {
      if (!disposedMats.has(m)) {
        disposedMats.add(m);
        m.dispose();
      }
    }
  });
}

/** Drop the decoded-GLB cache entirely (geometry included). Call when leaving
 *  the replay view so the GPU memory from converted ship models is released. */
export function clearShipMarkerCache(): void {
  for (const group of glbCache.values()) {
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      const mats = Array.isArray(mat) ? mat : [mat];
      for (const m of mats) m.dispose();
    });
  }
  glbCache.clear();
}

/** Prefetch a model URL into the cache without building a marker. Useful for
 *  warming common ships; failures are swallowed (caller degrades to a cone). */
export function prefetchShipModel(url: string): Promise<void> {
  if (glbCache.has(url)) return Promise.resolve();
  return loadGlbModel(url)
    .then((g) => {
      g.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry?.attributes.position) {
          mesh.geometry.computeBoundingBox();
          mesh.geometry.computeBoundingSphere();
        }
      });
      glbCache.set(url, g);
    })
    .catch(() => {
      /* swallowed — marker build will retry/fallback */
    });
}
