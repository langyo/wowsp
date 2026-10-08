/** Tests for the bake-artifact prune. The baked GLBs are coarse vertex-clustered
 *  meshes whose junk takes two shapes: needle triangles (a long bounding box
 *  with a collapsed surface — they paint as floating hairlines) and detached
 *  micro-fragments (rigging leftovers that lost contact with the hull). Both
 *  must go while real thin geometry — a railing sheet, an attached fitting —
 *  survives, and a clean model must not be copied at all. */
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { describe, expect, it } from "vitest";

import { DEBRIS_PRUNE_LIMITS, pointTriangleDistance2, pruneModelDebris } from "./debrisPrune";

/** A model in which every entry is its own named mesh — the shape the bake
 *  writes and the stage loads. Attributes other than position (and the vertex
 *  colours ShipStage keeps for the armor overlay) come off before the weld —
 *  mergeVertices only fuses vertices whose attributes all match — so a box
 *  arrives as one island of 8 vertices rather than six loose faces. */
function modelWith(parts: Array<[string, THREE.BufferGeometry]>): THREE.Object3D {
  const root = new THREE.Object3D();
  for (const [name, geometry] of parts) {
    const stripped = geometry.clone();
    for (const attr of Object.keys(stripped.attributes)) {
      if (attr !== "position" && attr !== "color") stripped.deleteAttribute(attr);
    }
    const mesh = new THREE.Mesh(mergeVertices(stripped, 1e-4));
    mesh.name = name;
    root.add(mesh);
  }
  return root;
}

/** Axis-aligned box centred at `center`. */
function box(size: number, center: [number, number, number]): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(size, size, size);
  g.translate(center[0], center[1], center[2]);
  return g;
}

/** The collapsed-cell shape the clustering leaves behind: three nearly
 *  collinear points whose bounding box is large while the surface area is a
 *  sliver. Anchored at `at`, which can sit ON the deck to keep it attached. */
function needle(
  length: number,
  height: number,
  at: [number, number, number],
): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const [x, y, z] = at;
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        x, y, z,
        x + length, y + height, z + length * 0.33,
        x + length * 0.96, y + height * 0.97, z + length * 0.33,
      ],
      3,
    ),
  );
  return g;
}

/** A flat plate `size` across, lying at height `y` (2 triangles unless
 *  subdivided by the caller). */
function plate(size: number, y: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(size, size);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

/** A thin but real sheet (a railing / antenna wire): length × width, filled. */
function sheet(length: number, width: number, at: [number, number, number]): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(length, width);
  g.rotateX(-Math.PI / 2);
  g.translate(at[0], at[1], at[2]);
  return g;
}

/** Triangle count of everything under `root`. */
function countTriangles(root: THREE.Object3D): number {
  let tris = 0;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : mesh.geometry.attributes.position.count;
    tris += Math.floor(count / 3);
  });
  return tris;
}

describe("pruneModelDebris", () => {
  it("attaches a fitting hovering above a collapsed reference triangle", () => {
    // a<->b collapsed (a cluster-bake shape): the deck's surface is its a–c
    // edge, so a fitting 0.25 above it is attached, and the collapsed triangle
    // itself goes as a needle.
    const deck = new THREE.BufferGeometry();
    deck.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-5, 0, 0, -5, 0, 0, 5, 0, 0], 3),
    );
    const model = modelWith([["deck", deck], ["mount", box(0.4, [0, 0.45, 0])]]);
    const stats = pruneModelDebris(model);
    expect(stats.detachedGroups).toBe(0);
    expect(stats.needleTriangles).toBe(1);
    // The mount's 12 triangles survive; the collapsed deck triangle is gone.
    expect(countTriangles(model)).toBe(12);
  });

  it("drops a needle spike rising off the deck and keeps the hull untouched", () => {
    const model = modelWith([
      ["hull", box(10, [0, 0, 0])],
      // Anchored on the deck at y = 5 (the hull's top face), spiking upward.
      ["superstructure", needle(1.2, 3.5, [0, 5, 0])],
    ]);
    const hullGeometry = (model.children[0] as THREE.Mesh).geometry;
    const stats = pruneModelDebris(model);
    expect(stats.needleTriangles).toBe(1);
    expect(stats.detachedGroups).toBe(0);
    expect(stats.trianglesBefore - stats.trianglesAfter).toBe(1);
    // The hull mesh keeps its own geometry object: no needless copies.
    expect((model.children[0] as THREE.Mesh).geometry).toBe(hullGeometry);
    expect(countTriangles(model)).toBe(12);
  });

  it("keeps a thin but real sheet (a filled railing/wire) on the deck", () => {
    const model = modelWith([
      ["hull", box(10, [0, 0, 0])],
      // 4 units long, 0.02 wide, lying on the deck: real surface, no sliver.
      ["railing", sheet(4, 0.02, [0, 5.0, 0])],
    ]);
    const stats = pruneModelDebris(model);
    expect(stats.needleTriangles).toBe(0);
    expect(stats.detachedTriangles).toBe(0);
    expect(stats.trianglesBefore).toBe(stats.trianglesAfter);
  });

  it("does not touch a model with no artifacts (no geometry copies)", () => {
    const model = modelWith([
      ["hull", box(10, [0, 0, 0])],
      ["superstructure", sheet(6, 0.03, [0, 5.0, 0])],
    ]);
    const before = model.children.map((c) => (c as THREE.Mesh).geometry);
    const stats = pruneModelDebris(model);
    expect(stats.needleTriangles).toBe(0);
    expect(stats.detachedGroups).toBe(0);
    expect(stats.trianglesBefore).toBe(stats.trianglesAfter);
    model.children.forEach((child, i) => {
      expect((child as THREE.Mesh).geometry).toBe(before[i]);
    });
  });

  it("drops detached micro-fragments and keeps attached ones", () => {
    const model = modelWith([
      ["hull", box(10, [0, 0, 0])],
      // Resting on the deck (touching): a fitting, not debris.
      ["aa_mount_1", box(0.4, [0, 5.2, 0])],
      // 1 unit above the deck, touching nothing: rigging debris.
      ["superstructure", box(0.3, [0, 6, 0])],
    ]);
    const stats = pruneModelDebris(model);
    expect(stats.detachedGroups).toBe(1);
    expect(stats.detachedTriangles).toBe(12);
    // The hull (12) and the attached mount (12) survive.
    expect(stats.trianglesAfter).toBe(24);
  });

  it("keeps a floating structure spanning too much to be debris", () => {
    const model = modelWith([
      ["hull", box(10, [0, 0, 0])],
      // Floating clear of the deck and 3 units across: past the bbox cap, and
      // past the span ceiling too (structure, not debris).
      ["superstructure", new THREE.BoxGeometry(3, 3, 3, 4, 4, 4).translate(0, 8, 0)],
    ]);
    const stats = pruneModelDebris(model);
    expect(stats.detachedGroups).toBe(0);
    expect(stats.needleTriangles).toBe(0);
    expect(stats.trianglesAfter).toBe(stats.trianglesBefore);
  });

  it("keeps a floating fragment whose triangle count passes the cap", () => {
    const model = modelWith([
      ["hull", box(10, [0, 0, 0])],
      // Small enough to fit the bbox gate (0.2 units = 2 % of the extent) but
      // 432 triangles, above the 200-triangle cap.
      ["superstructure", new THREE.BoxGeometry(0.2, 0.2, 0.2, 6, 6, 6).translate(0, 8, 0)],
    ]);
    const stats = pruneModelDebris(model);
    expect(stats.detachedGroups).toBe(0);
    expect(stats.trianglesAfter).toBe(stats.trianglesBefore);
  });

  it("never deletes the model itself when a floating sheet out-spans the hull", () => {
    const model = modelWith([
      ["hull", box(10, [0, 0, 0])],
      // A filled 14-unit sheet (a real surface, not a needle) floating above a
      // 10-unit hull: the body pick follows the widest group, so only the span
      // ceiling keeps the hull from being pruned as a "fragment".
      ["rig", sheet(14, 1, [0, 12, 0])],
    ]);
    const stats = pruneModelDebris(model);
    expect(countTriangles(model)).toBeGreaterThanOrEqual(12);
    expect(stats.largestDropped.some((d) => d.mesh === "hull")).toBe(false);
  });

  it("treats contact as transitive across meshes (a chain to the hull anchors it)", () => {
    const model = modelWith([
      ["hull", box(10, [0, 0, 0])],
      // Resting on the deck (bottom at y = 5, the hull's top plane), and a
      // second fitting standing on THAT one (its bottom at 5.4): the chain
      // reaches the hull, so neither is floating.
      ["aa_mount_1", box(0.4, [0, 5.2, 0])],
      ["aa_mount_2", box(0.4, [0, 5.6, 0])],
    ]);
    const stats = pruneModelDebris(model);
    expect(stats.detachedGroups).toBe(0);
    expect(stats.detachedTriangles).toBe(0);
  });

  it("keeps the surviving triangles of a partially pruned mesh intact", () => {
    // One mesh holding a real plate AND a needle: the prune must rebuild it
    // with the plate alone — right triangles, right vertex values.
    // The plate rests on the deck (y = 5, the hull's top plane) so it is a
    // genuinely attached surface; the spike is the artifact in the same mesh.
    const plate = new THREE.PlaneGeometry(2, 2);
    plate.rotateX(-Math.PI / 2);
    plate.translate(0, 5, 0);
    const spike = needle(1.2, 3.5, [0, 5, 0]);
    const merged = new THREE.BufferGeometry();
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    for (const g of [plate, spike]) {
      const p = g.attributes.position as THREE.BufferAttribute;
      const base = pos.length / 3;
      for (let v = 0; v < p.count; v++) {
        pos.push(p.getX(v), p.getY(v), p.getZ(v));
        col.push((v + 3) / 6, 0.5, 0.25);
      }
      const index = g.getIndex();
      if (index) for (let i = 0; i < index.count; i++) idx.push(index.getX(i) + base);
      else for (let i = 0; i < p.count; i++) idx.push(i + base);
    }
    merged.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    merged.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    merged.setIndex(idx);
    const model = modelWith([["hull", box(10, [0, 0, 0])], ["mixed", merged]]);
    const stats = pruneModelDebris(model);
    expect(stats.needleTriangles).toBe(1);
    const rebuilt = (model.children[1] as THREE.Mesh).geometry;
    expect(rebuilt.getIndex()?.count).toBe(6); // the plate's two triangles
    const colour = rebuilt.getAttribute("color");
    expect(colour.count).toBe(rebuilt.attributes.position.count);
    expect(rebuilt.attributes.position.count).toBe(4);
    for (let v = 0; v < colour.count; v++) {
      // carried exactly (getComponent decodes nothing here — plain floats)
      expect(colour.getY(v)).toBeCloseTo(0.5, 6);
      expect(colour.getZ(v)).toBeCloseTo(0.25, 6);
    }
  });

  it("carries vertex attributes through the rebuilt geometry", () => {
    const spike = needle(1.2, 3.5, [0, 5, 0]);
    const colors = new Float32Array(spike.attributes.position.count * 3);
    colors.fill(0.25);
    spike.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const model = modelWith([["hull", box(10, [0, 0, 0])], ["superstructure", spike]]);
    const stats = pruneModelDebris(model);
    expect(stats.needleTriangles).toBe(1);
    const rebuilt = (model.children[1] as THREE.Mesh).geometry;
    // The spike was the whole mesh: nothing is left, but the attribute schema
    // and the (empty) index must still be well-formed.
    expect(rebuilt.getAttribute("color")).toBeDefined();
    expect(rebuilt.getAttribute("color").count).toBe(rebuilt.attributes.position.count);
    expect(rebuilt.getIndex()?.count ?? 0).toBe(0);
  });

  it("never lets a lone needle claim the body role", () => {
    const model = modelWith([
      ["hull", box(10, [0, 0, 0])],
      // A spike LONGER than the hull spans it: only rule 1's book-keeping (a
      // needle-only group cannot be the body) keeps the hull from being read as
      // the "detached fragment" here.
      ["superstructure", needle(14, 9, [0, 6, 0])],
    ]);
    const stats = pruneModelDebris(model);
    expect(stats.largestDropped.some((d) => d.mesh === "hull")).toBe(false);
    expect(countTriangles(model)).toBeGreaterThanOrEqual(12);
  });

  it("drops an unattached spike through the contact rule alone", () => {
    const model = modelWith([
      ["hull", box(60, [0, 0, 0])],
      // A 1-triangle island floating above the deck. Needles are disabled here
      // so this test isolates rule 2 and the body contest: the spike spans less
      // than the hull (and well under the span ceiling), so the hull stays the
      // body and the spike goes as a detached fragment.
      ["superstructure", needle(10, 6, [0, 32, 0])],
    ]);
    const stats = pruneModelDebris(model, { ...DEBRIS_PRUNE_LIMITS, needleMaxTriangles: 0 });
    expect(stats.needleTriangles).toBe(0);
    expect(stats.detachedGroups).toBe(1);
    expect(stats.detachedTriangles).toBe(1);
    expect(countTriangles(model)).toBe(12);
  });
  it("attaches a fragment resting on the MIDDLE of a big plate", () => {
    const size = 60;
    const model = modelWith([
      ["plate", plate(size, 0)],
      // A 0.3 box hovering 0.005 above the plate's centre: every plate vertex
      // is 30 units away, so only a point-to-triangle test can see the contact.
      ["mount", box(0.3, [0, 0.155, 0])],
    ]);
    const stats = pruneModelDebris(model);
    expect(stats.detachedGroups).toBe(0);
    expect(stats.trianglesAfter).toBe(stats.trianglesBefore);
  });

  it("attaches a fragment on a SMALL triangle of a big structure", () => {
    // The plate is subdivided, so the triangle under the fragment is small
    // while the component around it spans the model.
    const plate = new THREE.PlaneGeometry(60, 60, 120, 120);
    plate.rotateX(-Math.PI / 2);
    const model = modelWith([["plate", plate], ["mount", box(0.3, [0.1, 0.155, 0.1])]]);
    const stats = pruneModelDebris(model);
    expect(stats.detachedGroups).toBe(0);
  });

  it("measures to the b–c edge, not to a mirrored point behind b", () => {
    // (2,2,0) against the hypotenuse of a right triangle: the closest point on
    // b–c is (0.5, 0.5, 0), so the squared distance is 4.5. A sign error in
    // that branch reports 6.5 instead.
    const tri = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    expect(pointTriangleDistance2(2, 2, 0, tri, 0)).toBeCloseTo(4.5, 9);
    // Same edge, the other way round: the mirrored point would be off the
    // triangle entirely.
    expect(pointTriangleDistance2(0.5, 0.5, 3, tri, 0)).toBeCloseTo(9, 9);
  });

  it("measures degenerate triangles against their edges, not into NaN", () => {
    // A zero-area triangle (two corners collapsed, or collinear points — a
    // cluster bake emits both) must measure against its edges: the region walk
    // divides by quantities that vanish and used to report up to ×400 the true
    // distance, which reads as "no contact" and floats an attached fragment.
    const collinear = [1, 0, 0, 3, 0, 0, 2, 0, 0];
    expect(pointTriangleDistance2(0, 0, 0, collinear, 0)).toBeCloseTo(1, 9);
    expect(pointTriangleDistance2(2, 3, 0, collinear, 0)).toBeCloseTo(9, 9);
    // a == b: the triangle is the segment a–c.
    const collapsed = [0, 0, 0, 0, 0, 0, 5, 0, 0];
    expect(pointTriangleDistance2(5, 0, 0, collapsed, 0)).toBeCloseTo(0, 9);
    expect(pointTriangleDistance2(2.5, 1, 0, collapsed, 0)).toBeCloseTo(1, 9);
    expect(pointTriangleDistance2(0, 3, 4, collapsed, 0)).toBeCloseTo(25, 9);
  });
});
