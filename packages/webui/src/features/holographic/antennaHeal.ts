/**
 * Mast-antenna gap healing for the baked ship GLBs.
 *
 * The game-assets bake drops the thin whip section that connects a mast-top
 * antenna to its masthead — the antenna pole arrives as a free-floating
 * sliver a visible gap above the tower (Nelson's superstructure mesh, for
 * example, contains no triangles across a ~4%-of-height band under either
 * antenna pole). In the hologram the floating yardarm reads as a broken
 * mast.
 *
 * This pass finds pole-like disconnected components floating in the upper
 * half of the model and bridges each gap with a thin open tube, merged into
 * the component's own mesh so it inherits the same palette colour. All
 * thresholds are relative to the model's world bounding box, so the bake's
 * arbitrary units never matter. Catapult floatplanes are explicitly safe:
 * the XZ-diagonal gate rejects anything wider than a pole.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** Relative limits (fractions of the model's world bounding box). */
export const ANTENNA_HEAL_LIMITS = {
  /** A pole is narrow: XZ bbox diagonal stays under this fraction of the
   *  ship's longest horizontal dimension. A spotter floatplane's wingspan
   *  is ~10x this, so catapult aircraft are never candidates. */
  maxXZDiagFrac: 0.03,
  /** The component must be clearly taller than wide … */
  minPoleAspect: 1.5,
  /** … and have real height (fraction of model height). */
  minHeightFrac: 0.02,
  /** Only the upper half of the model is mast country. */
  minElevationFrac: 0.5,
  /** Bridgeable gap band: big enough to see, small enough to be a missing
   *  whip rather than a genuinely detached part (fractions of height). */
  minGapFrac: 0.004,
  maxGapFrac: 0.15,
  /** Sanity cap on the component's triangle count — an antenna is tens of
   *  triangles, not a whole tower. */
  maxTriangles: 600,
  /** The connector sinks this fraction of the model height into the
   *  geometry below and overshoots the pole's foot by this fraction of the
   *  pole's own height, so no hairline gap survives at either end. */
  sinkFrac: 0.006,
  topOverlapFrac: 0.05,
} as const;

export interface AntennaHealStats {
  /** Tubes actually merged into meshes. */
  connectors: number;
}

interface ComponentInfo {
  /** Vertex indices (into the mesh's position attribute) of the component. */
  verts: Set<number>;
  triangles: number;
  /** World-space bbox. */
  min: THREE.Vector3;
  max: THREE.Vector3;
}

interface TriSample {
  /** World-space XZ centroid and max Y of one triangle. */
  cx: number;
  cz: number;
  maxY: number;
  /** Vertex indices (for candidate-component self-exclusion). */
  v0: number;
  v1: number;
  v2: number;
}

interface MeshEntry {
  mesh: THREE.Mesh;
  /** Per-triangle world samples. The below-search runs on triangle
   *  centroids, not vertices: a big masthead/deck plate has no interior
   *  vertices, so a vertex scan would miss it entirely. */
  tris: TriSample[];
  comps: ComponentInfo[];
}

/** Connected components of one welded, indexed geometry, by shared vertex
 *  indices, with world-space bboxes. */
function componentsOf(
  geometry: THREE.BufferGeometry,
  matrixWorld: THREE.Matrix4,
): ComponentInfo[] {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const index = geometry.index;
  if (!index) return [];
  const parent = new Int32Array(pos.count);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (a: number): number => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) { const n = parent[a]; parent[a] = r; a = n; }
    return r;
  };
  for (let i = 0; i + 2 < index.count; i += 3) {
    const a = index.getX(i);
    parent[find(a)] = find(index.getX(i + 1));
    parent[find(a)] = find(index.getX(i + 2));
  }
  const byRoot = new Map<number, ComponentInfo>();
  const v = new THREE.Vector3();
  for (let i = 0; i + 2 < index.count; i += 3) {
    const root = find(index.getX(i));
    let comp = byRoot.get(root);
    if (!comp) {
      comp = {
        verts: new Set(),
        triangles: 0,
        min: new THREE.Vector3(Infinity, Infinity, Infinity),
        max: new THREE.Vector3(-Infinity, -Infinity, -Infinity),
      };
      byRoot.set(root, comp);
    }
    comp.triangles++;
    for (let k = 0; k < 3; k++) {
      const vi = index.getX(i + k);
      comp.verts.add(vi);
      v.fromBufferAttribute(pos, vi).applyMatrix4(matrixWorld);
      if (v.x < comp.min.x) comp.min.x = v.x;
      if (v.y < comp.min.y) comp.min.y = v.y;
      if (v.z < comp.min.z) comp.min.z = v.z;
      if (v.x > comp.max.x) comp.max.x = v.x;
      if (v.y > comp.max.y) comp.max.y = v.y;
      if (v.z > comp.max.z) comp.max.z = v.z;
    }
  }
  return [...byRoot.values()];
}

/** A thin open 4-sided tube (no caps — the hologram is DoubleSide) bridging
 *  world [y0, y1] at (cx, cz), expressed in the target mesh's LOCAL space. */
function makeConnector(
  cx: number, cz: number, y0: number, y1: number, r: number,
  worldToLocal: THREE.Matrix4,
): THREE.BufferGeometry {
  const positions = new Float32Array(8 * 3);
  const p = new THREE.Vector3();
  const corners = [[-r, -r], [r, -r], [r, r], [-r, r]];
  for (let i = 0; i < 4; i++) {
    p.set(cx + corners[i][0], y0, cz + corners[i][1]).applyMatrix4(worldToLocal);
    positions.set([p.x, p.y, p.z], i * 3);
    p.set(cx + corners[i][0], y1, cz + corners[i][1]).applyMatrix4(worldToLocal);
    positions.set([p.x, p.y, p.z], (4 + i) * 3);
  }
  const idx: number[] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    idx.push(i, j, 4 + j, i, 4 + j, 4 + i);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setIndex(idx);
  return geo;
}

/** Bridge every floating-antenna gap in the model, in place. Runs after the
 *  weld + debris prune and before normals are rebuilt, so connectors pick
 *  up the same crease-aware normals as the mesh they join. */
export function healAntennaGaps(model: THREE.Object3D): AntennaHealStats {
  const stats: AntennaHealStats = { connectors: 0 };
  model.updateMatrixWorld(true);

  const entries: MeshEntry[] = [];
  const modelMin = new THREE.Vector3(Infinity, Infinity, Infinity);
  const modelMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  model.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.attributes.position) return;
    const geo = mesh.geometry as THREE.BufferGeometry;
    // Armour-overlay meshes carry thickness vertex colours a connector can't
    // meaningfully replicate — and bare hull shells carry no antennas.
    if (geo.attributes.color) return;
    const comps = componentsOf(geo, mesh.matrixWorld);
    if (comps.length === 0) return;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const index = geo.index!;
    const tris: TriSample[] = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i + 2 < index.count; i += 3) {
      const v0 = index.getX(i), v1 = index.getX(i + 1), v2 = index.getX(i + 2);
      a.fromBufferAttribute(pos, v0).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, v1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, v2).applyMatrix4(mesh.matrixWorld);
      tris.push({
        cx: (a.x + b.x + c.x) / 3,
        cz: (a.z + b.z + c.z) / 3,
        maxY: Math.max(a.y, b.y, c.y),
        v0, v1, v2,
      });
    }
    for (const comp of comps) {
      modelMin.min(comp.min);
      modelMax.max(comp.max);
    }
    entries.push({ mesh, tris, comps });
  });
  if (entries.length === 0) return stats;

  const H = modelMax.y - modelMin.y;
  const L = Math.max(modelMax.x - modelMin.x, modelMax.z - modelMin.z);
  if (H <= 0 || L <= 0) return stats;

  for (const entry of entries) {
    for (const comp of entry.comps) {
      const dx = comp.max.x - comp.min.x;
      const dz = comp.max.z - comp.min.z;
      const dy = comp.max.y - comp.min.y;
      const xzDiag = Math.hypot(dx, dz);
      if (comp.triangles > ANTENNA_HEAL_LIMITS.maxTriangles) continue;
      if (xzDiag > ANTENNA_HEAL_LIMITS.maxXZDiagFrac * L) continue;
      if (dy < ANTENNA_HEAL_LIMITS.minPoleAspect * xzDiag) continue;
      if (dy < ANTENNA_HEAL_LIMITS.minHeightFrac * H) continue;
      if (comp.min.y < modelMin.y + ANTENNA_HEAL_LIMITS.minElevationFrac * H) continue;

      // Highest geometry strictly below the pole, inside its (expanded)
      // footprint, excluding the pole's own triangles.
      const margin = Math.max(0.5 * xzDiag, 0.008 * L);
      const x0 = comp.min.x - margin, x1 = comp.max.x + margin;
      const z0 = comp.min.z - margin, z1 = comp.max.z + margin;
      let belowY = -Infinity;
      for (const other of entries) {
        for (const tri of other.tris) {
          if (tri.maxY >= comp.min.y || tri.maxY <= belowY) continue;
          if (tri.cx < x0 || tri.cx > x1 || tri.cz < z0 || tri.cz > z1) continue;
          if (other === entry && (
            comp.verts.has(tri.v0) || comp.verts.has(tri.v1) || comp.verts.has(tri.v2)
          )) continue;
          belowY = tri.maxY;
        }
      }
      if (!Number.isFinite(belowY)) continue;
      const gap = comp.min.y - belowY;
      if (gap < ANTENNA_HEAL_LIMITS.minGapFrac * H) continue;
      if (gap > ANTENNA_HEAL_LIMITS.maxGapFrac * H) continue;

      const cx = (comp.min.x + comp.max.x) / 2;
      const cz = (comp.min.z + comp.max.z) / 2;
      const r = Math.min(Math.max(0.175 * xzDiag, 0.002 * L), 0.012 * L);
      const tube = makeConnector(
        cx, cz,
        belowY - ANTENNA_HEAL_LIMITS.sinkFrac * H,
        comp.min.y + ANTENNA_HEAL_LIMITS.topOverlapFrac * dy,
        r,
        entry.mesh.matrixWorld.clone().invert(),
      );
      // mergeGeometries demands identical attribute sets: mirror whatever the
      // host mesh still carries (in the app pipeline that's position-only —
      // normals arrive later from computeSmoothNormals — but a raw geometry
      // may still have normal/uv). Filler values are fine: the connector is
      // a structure hint, not a lit surface.
      const host = entry.mesh.geometry as THREE.BufferGeometry;
      for (const [name, attr] of Object.entries(host.attributes)) {
        if (name === "position") continue;
        const arr = new Float32Array(8 * attr.itemSize);
        if (name === "normal") for (let i = 0; i < 8; i++) arr[i * 3 + 1] = 1;
        tube.setAttribute(name, new THREE.BufferAttribute(arr, attr.itemSize));
      }
      const merged = mergeGeometries([host, tube]);
      if (!merged) continue;
      entry.mesh.geometry = merged;
      stats.connectors++;
    }
  }
  return stats;
}
