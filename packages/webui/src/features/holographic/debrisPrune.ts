/**
 * Bake-artifact prune for the holographic ship/airframe GLBs.
 *
 * `bake_model.py` decimates by vertex clustering; two artifacts survive it and
 * read as junk under the stage's rim-lit transparency:
 *
 *  - NEEDLE triangles — the clustering collapses a corner into a far cell, so a
 *    triangle keeps a large bounding box while its area collapses to nothing.
 *    Its edge rasterizes as a faint one-pixel hairline: the "floating wire"
 *    hanging over the superstructure in the ship stage.
 *  - DETACHED micro-fragments — rigging / halyard / decoration leftovers whose
 *    contact with the rest of the ship did not survive the bake. They read as
 *    debris drifting off the hull.
 *
 * Both are measured against the model's own extent: the bake works in per-ship
 * units and the stage only normalizes afterwards. The same thresholds live in
 * `scripts/model_convert/bake_model.py` (`cull_floating_artifacts`) so future
 * bakes never emit the artifacts — keep the two in sync.
 *
 * Call it on the WELDED geometry, before `computeSmoothNormals`: the prune
 * rewrites index buffers, and the normals must be built from what renders.
 */
import * as THREE from "three";

export interface DebrisPruneLimits {
  /** Distance (fraction of the model extent) within which two parts count as
   *  touching — contact is what makes a part attached instead of floating. */
  contactPct: number;
  /** A needle is at most this many triangles... */
  needleMaxTriangles: number;
  /** ... at least this long (fraction of the model extent)... */
  needleMinExtentPct: number;
  /** ... and this empty: surface area / (half the bbox's largest face). A real
   *  sheet — a plate, a funnel casing, even a thin antenna wire — fills its
   *  bounding box at ≈1 per triangle, while a sliver whose corners collapsed
   *  towards one line drops to ≈0.02. Measured on the baked pack: real sheets
   *  sit at 0.5–2.3, collapsed slivers at 0.008–0.21. */
  needleMinFill: number;
  /** Detached fragments with at most this many triangles are dropped ... */
  microMaxTriangles: number;
  /** ... unless they span more than this fraction of the model: a group that
   *  wide is structure (or a rigging run), and the body pick — the widest
   *  group — must never be able to elect a floating artifact and let the real
   *  hull fall under the triangle clause. */
  microSpanCeilingPct: number;
  /** Larger detached fragments go only while their bounding box stays under
   *  this fraction of the model extent (a detached mast or boat spans more)... */
  microMaxExtentPct: number;
  /** ... and their triangle count stays under this cap. */
  microExtentTriangleCap: number;
}

/** Calibrated on the FULL baked pack (2777 GLBs, welded and pruned the way the
 *  stage does): 0.42 % of all triangles go, median 0.28 % per model, p99 4.6 %.
 *  Hulls and airframes stay well under 2 % except on dense small models (a
 *  submarine drops ~5 % — interior tube geometry and bow specks); the separate
 *  *_armor.glb collision shells, which the viewer never prunes, reach 12 %.
 *  Every dropped fragment is small by construction — ≤ 200 triangles, ≤ 3 % of
 *  the extent, ≤ 25 % for the handful-of-triangles clause — and the largest
 *  single artifact found spanned 60 % of its ship's length.
 *  Exported so tests and tuning share one source of truth. */
export const DEBRIS_PRUNE_LIMITS: DebrisPruneLimits = {
  contactPct: 0.005,
  needleMaxTriangles: 8,
  needleMinExtentPct: 0.015,
  needleMinFill: 0.25,
  microMaxTriangles: 12,
  microSpanCeilingPct: 0.25,
  microMaxExtentPct: 0.03,
  microExtentTriangleCap: 200,
};

export interface DebrisPruneStats {
  /** Triangles dropped as degenerate needles. */
  needleTriangles: number;
  /** Detached fragments dropped whole (how many) + their triangles. */
  detachedGroups: number;
  detachedTriangles: number;
  trianglesBefore: number;
  trianglesAfter: number;
  /** The biggest fragments that went, largest first (diagnostics: a prune that
   *  starts eating fittings shows up here rather than in a screenshot). */
  largestDropped: Array<{ mesh: string; triangles: number; extent: number }>;
}

/** Union-find over a fixed label set. */
class UnionFind {
  private readonly parent: Int32Array;

  constructor(size: number) {
    this.parent = new Int32Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }

  find(a: number): number {
    let root = a;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[a] !== root) {
      const next = this.parent[a];
      this.parent[a] = root;
      a = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/** One mesh of the model: its triangle corners and its vertices in a shared
 *  (model-root) frame — positions live in geometry space, while the extent and
 *  the contact test span every mesh. */
interface Part {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  position: THREE.BufferAttribute;
  /** Three vertex indices per triangle (non-indexed geometry reads 0,1,2,…). */
  corners: Uint32Array;
  triangleCount: number;
  /** xyz per vertex, transformed into the model's own space. */
  world: Float64Array;
  /** Triangle → component id (index into the component table). */
  triangleComponent: Int32Array;
}

interface Component {
  part: number;
  triangles: number[];
  /** Unique vertex indices (a vertex belongs to exactly one component). */
  vertices: number[];
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  area: number;
}

/** Drop bake artifacts from every mesh of `model`, in place. A model with no
 *  artifacts keeps its geometry objects untouched (no copies, no reindexing). */
export function pruneModelDebris(
  model: THREE.Object3D,
  limits: DebrisPruneLimits = DEBRIS_PRUNE_LIMITS,
): DebrisPruneStats {
  const stats: DebrisPruneStats = {
    needleTriangles: 0,
    detachedGroups: 0,
    detachedTriangles: 0,
    trianglesBefore: 0,
    trianglesAfter: 0,
    largestDropped: [],
  };

  const parts: Part[] = [];
  model.updateMatrixWorld(true);
  model.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    const position = geometry?.attributes?.position as THREE.BufferAttribute | undefined;
    if (!geometry || !position || position.count === 0) return;
    const index = geometry.getIndex();
    const triangleCount = Math.floor((index ? index.count : position.count) / 3);
    if (triangleCount === 0) return;
    const corners = new Uint32Array(triangleCount * 3);
    for (let i = 0; i < corners.length; i++) corners[i] = index ? index.getX(i) : i;
    parts.push({
      mesh, geometry, position, corners, triangleCount,
      world: new Float64Array(position.count * 3),
      triangleComponent: new Int32Array(triangleCount),
    });
  });
  const trianglesBefore = parts.reduce((n, p) => n + p.triangleCount, 0);
  stats.trianglesBefore = trianglesBefore;
  stats.trianglesAfter = trianglesBefore;
  if (parts.length === 0) return stats;

  // Vertices in one shared frame (distances and ratios survive the rigid
  // per-node transforms the exporter may leave on the nodes).
  const v = new THREE.Vector3();
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const part of parts) {
    const pos = part.position;
    const world = part.world;
    const matrix = part.mesh.matrixWorld;
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(matrix);
      world[i * 3] = v.x;
      world[i * 3 + 1] = v.y;
      world[i * 3 + 2] = v.z;
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.z < minZ) minZ = v.z;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
      if (v.z > maxZ) maxZ = v.z;
    }
  }
  const x = (part: Part, vertex: number) => part.world[vertex * 3];
  const y = (part: Part, vertex: number) => part.world[vertex * 3 + 1];
  const z = (part: Part, vertex: number) => part.world[vertex * 3 + 2];
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  if (!(extent > 0)) return stats;
  /** Keep the biggest dropped fragments for the diagnostics field. */
  const recordDropped = (mesh: string, triangles: number, span: number) => {
    const list = stats.largestDropped;
    if (list.length >= 8 && triangles <= list[list.length - 1].triangles) return;
    list.push({ mesh: mesh || "misc", triangles, extent: span });
    list.sort((a, b) => b.triangles - a.triangles);
    list.length = Math.min(list.length, 8);
  };

  // ── Components: shared-vertex islands within each mesh. The bake welds
  //    coincident vertices, so index adjacency is the right connectivity.
  const components: Component[] = [];
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    const uf = new UnionFind(part.position.count);
    for (let t = 0; t < part.triangleCount; t++) {
      uf.union(part.corners[t * 3], part.corners[t * 3 + 1]);
      uf.union(part.corners[t * 3], part.corners[t * 3 + 2]);
    }
    const labelOfRoot = new Map<number, number>();
    for (let t = 0; t < part.triangleCount; t++) {
      const root = uf.find(part.corners[t * 3]);
      let label = labelOfRoot.get(root);
      if (label === undefined) {
        label = components.length;
        labelOfRoot.set(root, label);
        components.push({
          part: pi, triangles: [], vertices: [],
          minX: Infinity, minY: Infinity, minZ: Infinity,
          maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
          area: 0,
        });
      }
      part.triangleComponent[t] = label;
      components[label].triangles.push(t);
    }
    const vertexLabel = new Int32Array(part.position.count).fill(-1);
    for (let t = 0; t < part.triangleCount; t++) {
      const label = part.triangleComponent[t];
      for (let c = 0; c < 3; c++) vertexLabel[part.corners[t * 3 + c]] = label;
    }
    for (let i = 0; i < part.position.count; i++) {
      if (vertexLabel[i] >= 0) components[vertexLabel[i]].vertices.push(i);
    }
  }

  // ── Per-component bounds and surface area.
  for (const comp of components) {
    const part = parts[comp.part];
    for (const vertex of comp.vertices) {
      const px = x(part, vertex), py = y(part, vertex), pz = z(part, vertex);
      // Malformed coordinates are skipped rather than propagated: a NaN bound
      // or a NaN sample would silence every comparison it takes part in (a
      // NaN distance reads as "no contact" and a NaN span never wins a pick).
      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
      if (px < comp.minX) comp.minX = px;
      if (py < comp.minY) comp.minY = py;
      if (pz < comp.minZ) comp.minZ = pz;
      if (px > comp.maxX) comp.maxX = px;
      if (py > comp.maxY) comp.maxY = py;
      if (pz > comp.maxZ) comp.maxZ = pz;
    }
    for (const t of comp.triangles) {
      const i0 = part.corners[t * 3], i1 = part.corners[t * 3 + 1], i2 = part.corners[t * 3 + 2];
      const abx = x(part, i1) - x(part, i0);
      const aby = y(part, i1) - y(part, i0);
      const abz = z(part, i1) - z(part, i0);
      const acx = x(part, i2) - x(part, i0);
      const acy = y(part, i2) - y(part, i0);
      const acz = z(part, i2) - z(part, i0);
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      const area = 0.5 * Math.hypot(nx, ny, nz);
      if (Number.isFinite(area)) comp.area += area;
    }
  }

  // ── Rule 1 — needles the clustering left behind: a handful of triangles
  //    whose bounding box is long yet whose surface area collapsed, so an edge
  //    of the sliver paints as a floating hairline.
  const drop = parts.map((p) => new Uint8Array(p.triangleCount));
  for (const comp of components) {
    if (comp.triangles.length > limits.needleMaxTriangles) continue;
    const bx = comp.maxX - comp.minX, by = comp.maxY - comp.minY, bz = comp.maxZ - comp.minZ;
    const longest = Math.max(bx, by, bz);
    if (longest < limits.needleMinExtentPct * extent) continue;
    const mid = Math.min(Math.max(bx, by), Math.max(by, bz), Math.max(bx, bz));
    // A non-finite area (broken coordinates) is treated as the degenerate
    // sliver it behaves like, so it is dropped rather than trusted.
    const fill = comp.area / Math.max(0.5 * longest * mid, 1e-12);
    if (comp.area > 0 && fill > limits.needleMinFill) continue;
    for (const t of comp.triangles) drop[comp.part][t] = 1;
    stats.needleTriangles += comp.triangles.length;
    recordDropped(parts[comp.part].mesh.name, comp.triangles.length, longest);
  }

  // ── Rule 2 — detached fragments. Contact spans the WHOLE model (an AA mount
  //    meets the deck in another mesh) and is measured on surfaces, not on a
  //    vertex hash alone: a fitting can rest in the MIDDLE of a coarse plate
  //    whose corners are far away. Stage 1 (vertex cells, cheap) links what
  //    touches; stage 2 refines the few components stage 1 left detached with
  //    an exact point-to-triangle test against the model's coarse triangles.
  const contactEps = limits.contactPct * extent;
  const eps2 = contactEps * contactEps;
  const contactUf = new UnionFind(components.length);
  // Cell key = cx + cy*SPAN + cz*SPAN². A cell is `contactEps` wide, so a model
  // spans at most 1/contactPct = 200 cells per axis — far below SPAN.
  const SPAN = 8192;
  const cellKey = (gx: number, gy: number, gz: number) => gx + gy * SPAN + gz * SPAN * SPAN;
  const cellX = (px: number) => Math.floor((px - minX) / contactEps);
  const cellY = (py: number) => Math.floor((py - minY) / contactEps);
  const cellZ = (pz: number) => Math.floor((pz - minZ) / contactEps);

  // ── Stage 1: cell occupancy. Hash every vertex into a cell the size of the
  //    contact distance and sweep each sample's 3×3×3 neighbourhood; two
  //    samples within `contactEps` of each other attach their components. The
  //    comparison is a plain point distance (cheap), and a stale root cache
  //    keeps already-linked pairs off the union-find.
  const sampleComp: number[] = [];
  const sampleXyz: number[] = [];
  const cellSamples = new Map<number, number[]>(); // cell key → sample ids
  for (let ci = 0; ci < components.length; ci++) {
    const comp = components[ci];
    const part = parts[comp.part];
    for (const vertex of comp.vertices) {
      const px = x(part, vertex), py = y(part, vertex), pz = z(part, vertex);
      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
      const id = sampleComp.length;
      sampleComp.push(ci);
      sampleXyz.push(px, py, pz);
      const key = cellKey(cellX(px), cellY(py), cellZ(pz));
      const bucket = cellSamples.get(key);
      if (bucket) bucket.push(id);
      else cellSamples.set(key, [id]);
    }
  }
  // Already-linked pairs dominate the sweep, and `find` per pair costs more
  // than the distance test itself. The cache answers the common case with two
  // array reads; a stale entry only makes a pair get tested again — never a
  // wrong decision, since a stale cache can only ever report "different".
  const rootCache = new Int32Array(components.length);
  let unionsSinceRefresh = 0;
  const refreshRoots = () => {
    for (let i = 0; i < components.length; i++) rootCache[i] = contactUf.find(i);
    unionsSinceRefresh = 0;
  };
  refreshRoots();
  const linkSamples = (i: number, j: number) => {
    const ci = sampleComp[i];
    const cj = sampleComp[j];
    if (ci === cj || rootCache[ci] === rootCache[cj]) return;
    const dx = sampleXyz[i * 3] - sampleXyz[j * 3];
    const dy = sampleXyz[i * 3 + 1] - sampleXyz[j * 3 + 1];
    const dz = sampleXyz[i * 3 + 2] - sampleXyz[j * 3 + 2];
    if (dx * dx + dy * dy + dz * dz > eps2) return;
    contactUf.union(ci, cj);
    if (++unionsSinceRefresh >= 256) refreshRoots();
  };
  // Every unordered cell pair is visited once: the 13 offsets that sort after
  // (0,0,0) cover the cross-cell pairs, the within-cell pass the rest. Two
  // samples within `contactEps` sit in cells at most one step apart.
  const offsets: number[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx < 0 || (dx === 0 && dy < 0) || (dx === 0 && dy === 0 && dz <= 0)) continue;
        offsets.push(dx, dy, dz);
      }
    }
  }
  for (const [key, bucket] of cellSamples) {
    for (let a = 0; a < bucket.length; a++) {
      for (let b = a + 1; b < bucket.length; b++) linkSamples(bucket[a], bucket[b]);
    }
    const gz = Math.floor(key / (SPAN * SPAN));
    const rest = key - gz * SPAN * SPAN;
    const gy = Math.floor(rest / SPAN);
    const gx = rest - gy * SPAN;
    for (let o = 0; o < offsets.length; o += 3) {
      const other = cellSamples.get(
        cellKey(gx + offsets[o], gy + offsets[o + 1], gz + offsets[o + 2]),
      );
      if (!other) continue;
      for (const i of bucket) {
        for (const j of other) linkSamples(i, j);
      }
    }
  }

  // ── Stage 2: the coarse plates. A vertex alone proves nothing about a plate
  //    whose corners are far apart, so components stage 1 left out of the body
  //    (and only those — they are the prune candidates) get an exact
  //    point-to-triangle pass against triangles longer than the contact
  //    distance, indexed in a multi-level grid so insertion stays bounded
  //    however long a plate is.
  interface Group {
    triangles: number;
    /** Triangles neither dropped as needles nor all there is: the body must be
     *  built from geometry that survives rule 1, or a lone needle spanning the
     *  model's diagonal would out-span the hull and the hull would be the
     *  "detached fragment". */
    surviving: number;
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
    members: number[];
    /** Longest bbox side — the body is the group that spans the model. */
    span: number;
  }
  /** Current groups over the live union-find. Re-run after every union pass:
   *  stage 2 merges what stage 1 left apart. */
  const collectGroups = () => {
    const groups = new Map<number, Group>();
    for (let ci = 0; ci < components.length; ci++) {
      const root = contactUf.find(ci);
      let group = groups.get(root);
      if (!group) {
        group = {
          triangles: 0,
          surviving: 0,
          minX: Infinity, minY: Infinity, minZ: Infinity,
          maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
          members: [],
          span: 0,
        };
        groups.set(root, group);
      }
      const comp = components[ci];
      const mask = drop[comp.part];
      let alive = 0;
      for (const t of comp.triangles) if (!mask[t]) alive++;
      group.triangles += comp.triangles.length;
      group.surviving += alive;
      group.minX = Math.min(group.minX, comp.minX);
      group.minY = Math.min(group.minY, comp.minY);
      group.minZ = Math.min(group.minZ, comp.minZ);
      group.maxX = Math.max(group.maxX, comp.maxX);
      group.maxY = Math.max(group.maxY, comp.maxY);
      group.maxZ = Math.max(group.maxZ, comp.maxZ);
      group.members.push(ci);
    }
    for (const group of groups.values()) {
      group.span = Math.max(
        group.maxX - group.minX,
        group.maxY - group.minY,
        group.maxZ - group.minZ,
      );
    }
    return groups;
  };
  /** The body: the group that spans the model — the hull / fuselage / main
   *  structure. Judging by triangle count instead is fragile: a cluster of
   *  fittings that lost contact but still touch each other can out-count a
   *  coarse hull, and the prune would then eat the hull itself. */
  const pickBody = (groups: Map<number, Group>): Group | null => {
    let body: Group | null = null;
    for (const group of groups.values()) {
      if (group.surviving === 0) continue;
      if (
        !body ||
        group.span > body.span ||
        (group.span === body.span && group.surviving > body.surviving)
      ) {
        body = group;
      }
    }
    return body;
  };

  // Only components stage 2 can still rescue pay for the exact pass: the ones
  // outside the body whose group is small enough that the drop rule could ever
  // apply. A group already past the triangle cap only grows when stage 2
  // merges more into it, so its members can never be pruned.
  const groupsBefore = collectGroups();
  const bodyMembers = new Set(pickBody(groupsBefore)?.members ?? []);
  const prunableGroup = new Set<number>();
  for (const [root, group] of groupsBefore) {
    if (group.surviving > 0 && group.triangles <= limits.microExtentTriangleCap) {
      prunableGroup.add(root);
    }
  }
  const coarseCandidates: number[] = [];
  for (let ci = 0; ci < components.length; ci++) {
    if (bodyMembers.has(ci)) continue;
    if (!prunableGroup.has(contactUf.find(ci))) continue;
    coarseCandidates.push(ci);
  }
  if (coarseCandidates.length > 0) {
    // Four levels reach 256× the contact distance, and no triangle can be
    // longer than the model extent (200× at the default contact distance):
    // the level choice bounds every insertion to ≤ ~5³ cells of its level.
    const LEVELS = 4;
    const levelCell = (k: number) => contactEps * 4 * 4 ** k;
    const levelGrids: Array<Map<number, number[]>> = [];
    for (let k = 0; k < LEVELS; k++) levelGrids.push(new Map());
    const coarseComp: number[] = [];
    const coarseXyz: number[] = [];
    for (let ci = 0; ci < components.length; ci++) {
      const comp = components[ci];
      const part = parts[comp.part];
      // EVERY triangle is indexed, however small: a fitting can rest on the
      // interior of a sliver whose corners are all farther than the contact
      // distance away, which is exactly the case stage 1 cannot see.
      for (const t of comp.triangles) {
        const i0 = part.corners[t * 3], i1 = part.corners[t * 3 + 1], i2 = part.corners[t * 3 + 2];
        const ax = x(part, i0), ay = y(part, i0), az = z(part, i0);
        const bx = x(part, i1), by = y(part, i1), bz = z(part, i1);
        const cx = x(part, i2), cy = y(part, i2), cz = z(part, i2);
        const loX = Math.min(ax, bx, cx), hiX = Math.max(ax, bx, cx);
        const loY = Math.min(ay, by, cy), hiY = Math.max(ay, by, cy);
        const loZ = Math.min(az, bz, cz), hiZ = Math.max(az, bz, cz);
        const longest = Math.max(hiX - loX, hiY - loY, hiZ - loZ);
        let level = 0;
        while (level < LEVELS - 1 && longest / 4 > levelCell(level)) level++;
        const id = coarseComp.length;
        coarseComp.push(ci);
        coarseXyz.push(ax, ay, az, bx, by, bz, cx, cy, cz);
        const cell = levelCell(level);
        const grid = levelGrids[level];
        const gx0 = Math.floor((loX - minX) / cell), gx1 = Math.floor((hiX - minX) / cell);
        const gy0 = Math.floor((loY - minY) / cell), gy1 = Math.floor((hiY - minY) / cell);
        const gz0 = Math.floor((loZ - minZ) / cell), gz1 = Math.floor((hiZ - minZ) / cell);
        for (let gx = gx0; gx <= gx1; gx++) {
          for (let gy = gy0; gy <= gy1; gy++) {
            for (let gz = gz0; gz <= gz1; gz++) {
              const key = cellKey(gx, gy, gz);
              const bucket = grid.get(key);
              if (bucket) bucket.push(id);
              else grid.set(key, [id]);
            }
          }
        }
      }
    }
    if (coarseComp.length > 0) {
      for (const ci of coarseCandidates) {
        const comp = components[ci];
        const part = parts[comp.part];
        for (const vertex of comp.vertices) {
          const px = x(part, vertex), py = y(part, vertex), pz = z(part, vertex);
          let hit = false;
          for (let level = 0; level < LEVELS && !hit; level++) {
            const cell = levelCell(level);
            const gx = Math.floor((px - minX) / cell);
            const gy = Math.floor((py - minY) / cell);
            const gz = Math.floor((pz - minZ) / cell);
            const grid = levelGrids[level];
            // A cell holds at least the contact distance in every direction, so
            // a plate within reach always has a cell inside this 3×3×3 block.
            for (let dx = -1; dx <= 1 && !hit; dx++) {
              for (let dy = -1; dy <= 1 && !hit; dy++) {
                for (let dz = -1; dz <= 1 && !hit; dz++) {
                  const bucket = grid.get(cellKey(gx + dx, gy + dy, gz + dz));
                  if (!bucket) continue;
                  for (const id of bucket) {
                    const other = coarseComp[id];
                    // Only a FOREIGN group proves contact: a triangle of the
                    // component's own island sits at distance 0 by definition
                    // and would otherwise end the search immediately.
                    if (other === ci || contactUf.find(other) === contactUf.find(ci)) continue;
                    if (pointTriangleDistance2(px, py, pz, coarseXyz, id) <= eps2) {
                      contactUf.union(ci, other);
                      hit = true;
                      break;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  const groups = collectGroups();
  const body = pickBody(groups);
  for (const group of groups.values()) {
    if (group === body) continue;
    if (group.surviving === 0) continue; // nothing but needles — already counted
    if (group.triangles > limits.microExtentTriangleCap) continue;
    const longest = Math.max(
      group.maxX - group.minX,
      group.maxY - group.minY,
      group.maxZ - group.minZ,
    );
    // A structure spanning a quarter of the model is never debris, whatever
    // its triangle count: that guard also keeps a pathological body pick (a
    // long floating sheet out-spanning a coarse hull) from deleting the hull.
    if (longest > limits.microSpanCeilingPct * extent) continue;
    // A handful of triangles is a fragment however far it stretches; anything
    // larger must ALSO be small in size, so a detached mast, boom or boat —
    // structure the bake happened to cut loose — is never mistaken for debris.
    const micro =
      group.triangles <= limits.microMaxTriangles ||
      (longest <= limits.microMaxExtentPct * extent && group.triangles <= limits.microExtentTriangleCap);
    if (!micro) continue;
    stats.detachedGroups += 1;
    for (const ci of group.members) {
      const comp = components[ci];
      for (const t of comp.triangles) {
        if (drop[comp.part][t]) continue;
        drop[comp.part][t] = 1;
        stats.detachedTriangles += 1;
      }
    }
    recordDropped(parts[components[group.members[0]].part].mesh.name, group.triangles, longest);
  }

  if (stats.needleTriangles + stats.detachedTriangles === 0) return stats;

  // ── Rebuild only the meshes that lost triangles.
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    const mask = drop[pi];
    let removed = 0;
    for (let t = 0; t < part.triangleCount; t++) removed += mask[t];
    if (removed === 0) continue;
    part.mesh.geometry = rebuildWithoutTriangles(part, mask);
  }
  stats.trianglesAfter = stats.trianglesBefore - stats.needleTriangles - stats.detachedTriangles;
  return stats;
}

/** Squared distance from a point to one triangle of `triXyz` (9 coordinates per
 *  triangle) — the exact surface distance, so a fitting resting on a coarse
 *  plate counts as attached however far the plate's corners are.
 *  Voronoi-region walk of Ericson, Real-Time Collision Detection §5.1.5. */
export function pointTriangleDistance2(
  px: number, py: number, pz: number,
  triXyz: number[],
  id: number,
): number {
  const o = id * 9;
  const ax = triXyz[o], ay = triXyz[o + 1], az = triXyz[o + 2];
  const bx = triXyz[o + 3], by = triXyz[o + 4], bz = triXyz[o + 5];
  const cx = triXyz[o + 6], cy = triXyz[o + 7], cz = triXyz[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  // Fully degenerate triangles — two corners collapsed onto one another, or
  // exactly collinear points, both of which a cluster bake emits — have no
  // interior to project onto and drive the region walk's divisions into
  // rounding noise (measured: up to ×400 overstatement). Their surface IS their
  // edges, so measure against each of them.
  const bcx = bx - cx, bcy = by - cy, bcz = bz - cz;
  const crossX = aby * acz - abz * acy;
  const crossY = abz * acx - abx * acz;
  const crossZ = abx * acy - aby * acx;
  const cross2 = crossX * crossX + crossY * crossY + crossZ * crossZ;
  const longestEdge2 = Math.max(
    abx * abx + aby * aby + abz * abz,
    acx * acx + acy * acy + acz * acz,
    bcx * bcx + bcy * bcy + bcz * bcz,
  );
  if (cross2 <= 1e-18 * longestEdge2 * longestEdge2) {
    return Math.min(
      segmentDistance2(px, py, pz, ax, ay, az, bx, by, bz),
      segmentDistance2(px, py, pz, ax, ay, az, cx, cy, cz),
      segmentDistance2(px, py, pz, bx, by, bz, cx, cy, cz),
    );
  }
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    // The 1e-30 floors keep a degenerate (zero-area) triangle — common in a
    // cluster bake — from dividing by zero into a NaN distance, which would
    // read as "no contact" and leave an attached fitting floating.
    const v = d1 / Math.max(d1 - d3, 1e-30);
    const qx = apx - v * abx, qy = apy - v * aby, qz = apz - v * abz;
    return qx * qx + qy * qy + qz * qz;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / Math.max(d2 - d6, 1e-30);
    const qx = apx - w * acx, qy = apy - w * acy, qz = apz - w * acz;
    return qx * qx + qy * qy + qz * qz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / Math.max(d4 - d3 + (d5 - d6), 1e-30);
    // closest = b + w·(c - b), and (c - b) = (cp - bp), so the vector from it
    // to the query point is bp + w·(cp - bp).
    const qx = bpx + w * (cpx - bpx), qy = bpy + w * (cpy - bpy), qz = bpz + w * (cpz - bpz);
    return qx * qx + qy * qy + qz * qz;
  }
  const denom = 1 / Math.max(va + vb + vc, 1e-30);
  const v = vb * denom, w = vc * denom;
  const qx = apx - (v * abx + w * acx);
  const qy = apy - (v * aby + w * acy);
  const qz = apz - (v * abz + w * acz);
  return qx * qx + qy * qy + qz * qz;
}

/** Squared distance from a point to the segment ab. */
function segmentDistance2(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const ab2 = abx * abx + aby * aby + abz * abz;
  if (ab2 <= 1e-24) return apx * apx + apy * apy + apz * apz;
  const t = Math.min(Math.max((apx * abx + apy * aby + apz * abz) / ab2, 0), 1);
  const qx = apx - t * abx, qy = apy - t * aby, qz = apz - t * abz;
  return qx * qx + qy * qy + qz * qz;
}

/** Copy `part`'s geometry without the flagged triangles, carrying every vertex
 *  attribute through a remap (vertices left unreferenced fall away). */
function rebuildWithoutTriangles(part: Part, mask: Uint8Array): THREE.BufferGeometry {
  const src = part.geometry;
  const slotOf = new Int32Array(part.position.count).fill(-1);
  const keptCorners: number[] = [];
  let slots = 0;
  for (let t = 0; t < part.triangleCount; t++) {
    if (mask[t]) continue;
    for (let c = 0; c < 3; c++) {
      const vertex = part.corners[t * 3 + c];
      if (slotOf[vertex] < 0) slotOf[vertex] = slots++;
      keptCorners.push(vertex);
    }
  }
  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(src.attributes)) {
    const attr = src.attributes[name] as THREE.BufferAttribute;
    const values = new Float32Array(slots * attr.itemSize);
    for (let vertex = 0; vertex < part.position.count; vertex++) {
      const slot = slotOf[vertex];
      if (slot < 0) continue;
      for (let k = 0; k < attr.itemSize; k++) {
        values[slot * attr.itemSize + k] = attr.getComponent(vertex, k) as number;
      }
    }
    out.setAttribute(name, new THREE.Float32BufferAttribute(values, attr.itemSize, false));
  }
  const index = new Uint32Array(keptCorners.length);
  for (let i = 0; i < keptCorners.length; i++) index[i] = slotOf[keptCorners[i]];
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}
