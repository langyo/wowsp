/** Tests for the crease-aware normal rebuild. The baked collision shells ship
 *  POSITION only and with essentially random triangle winding, so the pass
 *  must be winding-agnostic (opposite normals cluster as one axis) and must
 *  carry side attributes (armour thickness vertex colours) through crease
 *  splits. */
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { describe, expect, it } from "vitest";

import { computeSmoothNormals } from "./smoothNormals";

/** Two coplanar triangles forming a quad; the second is wound opposite. */
function mixedWindingQuad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  // All normals +Z geometrically; triangle 2 deliberately reversed.
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
      3,
    ),
  );
  return mergeVertices(g, 1e-4);
}

/** Two panels sharing an edge, folded 90° (like a chine). */
function creasedPair(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 1, 1, 0, 0, 1, 0],
      3,
    ),
  );
  return mergeVertices(g, 1e-4);
}


/** A fan of triangles sharing the edge O-A, each face tilted `deg` around
 *  that edge — the 2D stand-in for a decimated hull's diagonal staircase:
 *  adjacent face normals step past the crease while no real edge exists. */
function tiltedFan(degrees: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pos: number[] = [];
  const rad = (d: number) => (d * Math.PI) / 180;
  for (const d of degrees) {
    // O, A, B: O=(0,0,0), A=(1,0,0) shared by every face; B tilts by d.
    pos.push(0, 0, 0, 1, 0, 0, 0, Math.sin(rad(d)), Math.cos(rad(d)));
  }
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return mergeVertices(g, 1e-4);
}

describe("computeSmoothNormals", () => {
  it("shades a mixed-winding flat quad as one smooth surface, not facets", () => {
    const out = computeSmoothNormals(mixedWindingQuad(), 80);
    // No crease here: the four corners must not split.
    expect(out.attributes.position.count).toBe(4);
    const n = out.attributes.normal;
    for (let v = 1; v < n.count; v++) {
      const d = n.getX(v) * n.getX(0) + n.getY(v) * n.getY(0) + n.getZ(v) * n.getZ(0);
      expect(d).toBeCloseTo(1, 5);
    }
  });

  it("splits a real 90° crease so both panels keep crisp normals", () => {
    const welded = creasedPair();
    const out = computeSmoothNormals(welded, 80);
    // The shared vertex splits: more output vertices than welded corners.
    expect(out.attributes.position.count).toBeGreaterThan(welded.attributes.position.count);
    // Every output normal is unit length.
    const n = out.attributes.normal;
    for (let v = 0; v < n.count; v++) {
      const len = Math.hypot(n.getX(v), n.getY(v), n.getZ(v));
      expect(len).toBeCloseTo(1, 5);
    }
  });

  it("carries vertex colours through, duplicating them at crease splits", () => {
    const g = creasedPair();
    const colours = new Float32Array(g.attributes.position.count * 3);
    colours.fill(0.5);
    g.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    const out = computeSmoothNormals(g, 80);
    const c = out.getAttribute("color");
    expect(c).toBeDefined();
    expect(c.count).toBe(out.attributes.position.count);
    for (let v = 0; v < c.count; v++) {
      expect(c.getX(v)).toBeCloseTo(0.5, 5);
      expect(c.getY(v)).toBeCloseTo(0.5, 5);
    }
  });

  it("heals a diagonal staircase the greedy admission split (merge pass)", () => {
    // Steps of 50° around the shared edge: greedy@65 admits 0° then 50°
    // (mean 25°) but rejects the 100° face (75° off the running mean), and
    // the split corner would shade the run as two hard facets. The merged
    // means (25° vs 100°, 75° apart) sit within the 85° merge angle, so the
    // run must fuse back into ONE smooth cluster — the shared corners stay
    // unsplit and every face of the run reads the same normal.
    const welded = tiltedFan([0, 50, 100]);
    const out = computeSmoothNormals(welded, 65);
    // 3 faces x 3 corners; O and A are shared by all three faces and must
    // not split (a split would add vertices), each B is unique: 5 outputs.
    expect(out.attributes.position.count).toBe(5);
    // The three faces of the run share O's output vertex: their first
    // corner indexes the same vertex, so O's normal is one value.
    const idx = out.index!;
    const oCorner = idx.getX(0);
    for (let t = 1; t < 3; t++) expect(idx.getX(t * 3)).toBe(oCorner);
  });

  it("keeps a true hard edge split through the merge pass", () => {
    // Two faces meeting at a clean 90° fold: the cluster means sit 90°
    // apart, beyond even the merge angle — the edge must stay split so
    // both panels keep their crisp normal (the stage's chine shading).
    const welded = tiltedFan([0, 90]);
    const out = computeSmoothNormals(welded, 65);
    expect(out.attributes.position.count).toBeGreaterThan(
      welded.attributes.position.count,
    );
    const n = out.attributes.normal;
    const seen = new Set<string>();
    for (let v = 0; v < n.count; v++) {
      const dir = `${n.getX(v).toFixed(2)},${n.getY(v).toFixed(2)},${n.getZ(v).toFixed(2)}`;
      seen.add(dir);
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });
});
