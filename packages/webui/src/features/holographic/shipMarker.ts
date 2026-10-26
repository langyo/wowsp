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

import { SHIP_CLASS_LEN, shipClassTargetLen } from "@wowsp/holo";

import { loadGlbModel } from "./modelLoader";
import { makeHoloMaterial } from "./holoShader";
import { holoColorsFor, type TeamRole } from "./teamColors";

/** True-engine-scale class lengths live in the shared holo package (one
 *  source of truth for the app viewer AND the site demo). Re-exported so
 *  HolographicMap keeps a single local import point. */
export { SHIP_CLASS_LEN, shipClassTargetLen };

/** Cache of decoded GLB root groups, keyed by the requested model URL (or
 *  the URL candidate chain joined). Cloning a cached group is far cheaper
 *  than re-parsing the GLB; identical ships in a match (common for mirror
 *  matchmaking) share one entry here. */
const glbCache = new Map<string, THREE.Group>();

/** Merged single-geometry hulls, keyed by the decoded source group. The
 *  published pack still carries multi-mesh hulls (median ~40 meshes for
 *  T8-10 index bakes, p90 ~90): one draw per mesh dominated the fleet's
 *  submission cost (~1,900 draw calls for 20 visible ships). Each unique
 *  hull merges ONCE into a plain position+index buffer baked in the mesh's
 *  transform relative to the GLB root; every marker of that hull then
 *  renders as ONE mesh sharing that buffer. Null = merge impossible (the
 *  marker builder falls back to the per-mesh clone path). */
const mergedGeoCache = new Map<THREE.Group, THREE.BufferGeometry | null>();

/** Merge every mesh under `source` into a single indexed position buffer.
 *  Deliberately hand-rolled instead of BufferGeometryUtils.mergeGeometries:
 *  that helper requires identical attribute sets across inputs, while the
 *  baked hulls mix bare-position meshes with (occasionally) extra
 *  attributes — and the holo shader only ever reads POSITION (normals come
 *  from screen-space derivatives). Returns null when the source carries no
 *  usable geometry. */
function mergedHullGeometry(source: THREE.Group): THREE.BufferGeometry | null {
  const cached = mergedGeoCache.get(source);
  if (cached !== undefined) return cached;
  let result: THREE.BufferGeometry | null = null;
  try {
    source.updateMatrixWorld(true);
    const invRoot = source.matrixWorld.clone().invert();
    const parts: {
      attr: THREE.BufferAttribute;
      index: THREE.BufferAttribute | null;
      matrix: THREE.Matrix4;
    }[] = [];
    let totalVerts = 0;
    let totalIdx = 0;
    source.traverse((child) => {
      const mesh = child as THREE.Mesh;
      const pos = mesh.geometry?.getAttribute("position");
      if (!mesh.isMesh || !pos) return;
      // Interleaved position attributes would need strided reads — bail to
      // the per-mesh fallback rather than reading stride-contaminated data
      // silently. (The bakes never interleave; this is the safety net.)
      if ((pos as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) {
        throw new Error("interleaved position attribute");
      }
      // Hidden nodes were respected by the old clone path — skip them too.
      if (!mesh.visible) return;
      parts.push({
        attr: pos as THREE.BufferAttribute,
        index: mesh.geometry.getIndex(),
        matrix: new THREE.Matrix4().multiplyMatrices(invRoot, mesh.matrixWorld),
      });
      totalVerts += pos.count;
      totalIdx += mesh.geometry.getIndex()?.count ?? pos.count;
    });
    if (parts.length > 0 && totalVerts > 0) {
      const positions = new Float32Array(totalVerts * 3);
      // Uint32 indices: a merged hull can far exceed the 16-bit range.
      const indices = new Uint32Array(totalIdx);
      const v = new THREE.Vector3();
      let vBase = 0;
      let iOff = 0;
      for (const p of parts) {
        const arr = p.attr.array as ArrayLike<number>;
        for (let i = 0; i < p.attr.count; i++) {
          v.set(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]).applyMatrix4(p.matrix);
          const o = (vBase + i) * 3;
          positions[o] = v.x;
          positions[o + 1] = v.y;
          positions[o + 2] = v.z;
        }
        if (p.index) {
          const ia = p.index.array as ArrayLike<number>;
          for (let i = 0; i < p.index.count; i++) indices[iOff + i] = ia[i] + vBase;
          iOff += p.index.count;
        } else {
          for (let i = 0; i < p.attr.count; i++) indices[iOff + i] = i + vBase;
          iOff += p.attr.count;
        }
        vBase += p.attr.count;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.setIndex(new THREE.BufferAttribute(indices, 1));
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      result = geo;
    }
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[shipMarker] hull merge failed, falling back:", e);
    result = null; // fall back to the per-mesh path for this hull
  }
  mergedGeoCache.set(source, result);
  return result;
}

/** GLB cache key for a single URL or an ordered candidate chain. */
function glbCacheKey(url: string | string[]): string {
  return Array.isArray(url) ? url.join("\u0000") : url;
}

interface BuildShipMarkerOpts {
  /** Single model URL, or an ordered candidate chain walked by
   *  `loadGlbModel` until one candidate fetches and parses. */
  url: string | string[];
  role: TeamRole;
  /** WG ship-type string — picks the class target length the model is scaled to. */
  type?: string | null;
}

/** Scale `model` so its longest hull axis — the exporter lays bow-to-stern
 *  along Z — matches the ship class's true engine length, then centre it in
 *  XZ and drop the keel to y=0. */
function applyTrueScale(model: THREE.Group, type: string | null | undefined): void {
  // Pool sources arrive ALREADY normalized (a finished marker) — unwind that
  // transform so the hull is measured and re-scaled in raw GLB units. For the
  // fresh-clone path in buildShipMarker this is a no-op.
  model.position.set(0, 0, 0);
  model.scale.setScalar(1);
  model.rotation.set(0, 0, 0);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  // Hull axis is Z; the horizontal-axis fallback keeps the division finite
  // for degenerate/empty exports instead of producing NaN/Infinity.
  const hull = Math.max(size.z, size.x, 1e-6);
  const scale = shipClassTargetLen(type) / hull;
  model.scale.setScalar(scale);
  const center = box.getCenter(new THREE.Vector3()).multiplyScalar(scale);
  model.position.sub(center);
  // Raise so the model's keel sits at y=0 (water surface).
  model.position.y += -box.min.y * scale;
}

/** Build a holographic ship marker for the map. Loads (or clones from cache)
 *  the GLB at `url` (single URL or candidate chain), applies class-scaled
 *  true-size and role-tinted holographic shader. */
export async function buildShipMarker(opts: BuildShipMarkerOpts): Promise<THREE.Group> {
  const { url, role, type } = opts;
  const cacheKey = glbCacheKey(url);

  // Load (or reuse) the decoded scene graph.
  let source = glbCache.get(cacheKey);
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
    glbCache.set(cacheKey, source);
  }

  // Prefer ONE merged mesh per hull (see mergedHullGeometry): the marker
  // then costs a single draw instead of one per GLB mesh. Falls back to
  // the shared-geometry clone when a hull cannot merge.
  const { baseColor, fresnelColor } = holoColorsFor(role);
  const holoMat = makeHoloMaterial();
  holoMat.uniforms.baseColor.value.setHex(baseColor);
  holoMat.uniforms.fresnelColor.value.setHex(fresnelColor);
  holoMat.uniforms.uLinesGain.value = 0.3;

  const merged = mergedHullGeometry(source);
  let model: THREE.Group;
  let meshes: THREE.Mesh[];
  if (merged) {
    model = new THREE.Group();
    model.add(new THREE.Mesh(merged, holoMat));
  } else {
    model = cloneWithSharedGeometry(source);
    // Recompute bounding box (baked GLBs drop POSITION min/max).
    model.traverse((child) => {
      const m = child as THREE.Mesh;
      if (m.geometry?.attributes.position) {
        m.geometry.computeBoundingBox();
        m.geometry.computeBoundingSphere();
      }
    });
    meshes = [];
    model.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
    });
    for (const mesh of meshes) {
      mesh.material = holoMat;
    }
  }

  // Scale to the class's true engine length (see applyTrueScale).
  applyTrueScale(model, type);

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

/** Build a marker from an ALREADY-LOADED model (e.g. a substitute hull for a
 *  ship whose own GLB is missing or failed to load). Re-applies the same
 *  normalization + role tint as `buildShipMarker`, so the swap looks exactly
 *  like a real model load — scaled to `type`'s class length so a substitute
 *  hull can never tower over the marker it replaces. The source model is not
 *  mutated. */
export function buildMarkerFromSource(
  source: THREE.Group,
  role: TeamRole,
  type?: string | null,
): THREE.Group {
  const { baseColor, fresnelColor } = holoColorsFor(role);
  const holoMat = makeHoloMaterial();
  holoMat.uniforms.baseColor.value.setHex(baseColor);
  holoMat.uniforms.fresnelColor.value.setHex(fresnelColor);
  holoMat.uniforms.uLinesGain.value = 0.3;

  // Same merged-single-mesh preference as buildShipMarker (one draw per
  // hull); the substitute-hull pool shares the merged buffer too.
  const merged = mergedHullGeometry(source);
  let model: THREE.Group;
  if (merged) {
    model = new THREE.Group();
    model.add(new THREE.Mesh(merged, holoMat));
  } else {
    model = cloneWithSharedGeometry(source);
    // Recompute bounding box (baked GLBs drop POSITION min/max).
    model.traverse((child) => {
      const m = child as THREE.Mesh;
      if (m.geometry?.attributes.position) {
        m.geometry.computeBoundingBox();
        m.geometry.computeBoundingSphere();
      }
    });
    model.traverse((child) => {
      const m = child as THREE.Mesh;
      if (m.isMesh) m.material = holoMat;
    });
  }

  // Scale to the class's true engine length (see applyTrueScale).
  applyTrueScale(model, type);

  return model;
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
  // The merged hulls are independent buffers (they no longer share the GLB
  // geometries) — release them with the sources they were derived from.
  for (const geo of mergedGeoCache.values()) geo?.dispose();
  mergedGeoCache.clear();
}

/** Prefetch a model URL (or an ordered candidate chain — the winning
 *  candidate is cached under the whole chain's key) into the cache without
 *  building a marker. Useful for warming common ships; failures are
 *  swallowed (caller degrades to a cone). */
export function prefetchShipModel(url: string | string[]): Promise<void> {
  const cacheKey = glbCacheKey(url);
  if (glbCache.has(cacheKey)) return Promise.resolve();
  return loadGlbModel(url)
    .then((g) => {
      g.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry?.attributes.position) {
          mesh.geometry.computeBoundingBox();
          mesh.geometry.computeBoundingSphere();
        }
      });
      glbCache.set(cacheKey, g);
    })
    .catch(() => {
      /* swallowed — marker build will retry/fallback */
    });
}
