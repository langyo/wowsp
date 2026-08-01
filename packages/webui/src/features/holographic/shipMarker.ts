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
 * about Y). The caller sets `rotation.y = Math.PI - yaw` each frame — the
 * scene mirrors world z into three.js space, which flips the yaw sense.
 */
import * as THREE from "three";

import { loadGlbModel } from "./modelLoader";
import { makeHoloMaterial } from "./holoShader";
import { holoColorsFor, type TeamRole } from "./teamColors";

/** Uniform scale factor applied to all ship models. Raw GLBs from the
 *  exporter preserve the ship's actual game-world proportions (BB ≈ 18u,
 *  DD ≈ 7u). A uniform multiplier keeps relative sizes correct whereas
 *  per-ship normalization to a fixed target makes all ships equal length. */
const SHIP_SCALE = 5.0;

/** Cache of decoded GLB root groups, keyed by resolved model URL. Cloning a
 *  cached group is far cheaper than re-parsing the GLB; identical ships in a
 *  match (common for mirror matchmaking) share one entry here. */
const glbCache = new Map<string, THREE.Group>();

interface BuildShipMarkerOpts {
  url: string;
  role: TeamRole;
}

/** Build a holographic ship marker for the map. Loads (or clones from cache)
 *  the GLB at `url`, applies uniform scale and role-tinted holographic shader. */
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

  // Recompute bounding box (baked GLBs drop POSITION min/max).
  model.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry?.attributes.position) {
      mesh.geometry.computeBoundingBox();
      mesh.geometry.computeBoundingSphere();
    }
  });

  // Apply uniform scale to preserve relative ship sizes (BB > DD).
  const box = new THREE.Box3().setFromObject(model);
  model.scale.setScalar(SHIP_SCALE);
  const center = box.getCenter(new THREE.Vector3()).multiplyScalar(SHIP_SCALE);
  model.position.sub(center);
  // Raise so the model's keel sits at y=0 (water surface).
  model.position.y += -box.min.y * SHIP_SCALE;

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
