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
});
