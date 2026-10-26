/**
 * mergedHullGeometry is reachable only through the marker builders (it is
 * module-private), so this suite exercises the merge through
 * buildMarkerFromSource — the no-GLB path — with synthetic sources:
 *   - a multi-mesh source collapses to ONE mesh sharing one geometry,
 *   - the merged vertices land where the per-mesh transforms put them,
 *   - non-indexed meshes are indexed on merge.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildMarkerFromSource } from "./shipMarker";

function meshAt(
  x: number,
  y: number,
  z: number,
  indexed = true,
): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0]),
      3,
    ),
  );
  if (indexed) geo.setIndex([0, 1, 2]);
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial()).translateX(x)
    .translateY(y)
    .translateZ(z) as THREE.Mesh;
}

function multiMeshSource(): THREE.Group {
  const g = new THREE.Group();
  g.add(meshAt(0, 0, 0));
  const nested = new THREE.Group().translateY(2);
  nested.add(meshAt(5, 0, 0));
  g.add(nested);
  return g;
}

describe("merged ship hull geometry (buildMarkerFromSource)", () => {
  it("collapses a multi-mesh source into a single mesh", () => {
    const marker = buildMarkerFromSource(multiMeshSource(), "ally");
    const meshes: THREE.Mesh[] = [];
    marker.traverse((c) => {
      if ((c as THREE.Mesh).isMesh) meshes.push(c as THREE.Mesh);
    });
    expect(meshes.length).toBe(1);
    const geo = meshes[0].geometry;
    // 2 source triangles, both baked in — merged index is explicit.
    expect(geo.getAttribute("position").count).toBe(6);
    expect(geo.getIndex()?.count).toBe(6);
  });

  it("bakes per-mesh transforms into the merged vertices", () => {
    const marker = buildMarkerFromSource(multiMeshSource(), "ally");
    const mesh = marker.children[0] as THREE.Mesh;
    const pos = mesh.geometry.getAttribute("position");
    const v = new THREE.Vector3();
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      xs.push(v.x);
      ys.push(v.y);
    }
    // applyTrueScale only applies a UNIFORM scale + offset to the root, so
    // the source layout survives in the merged buffer as relative extents:
    // mesh 1 spans x 0..1 at y 0..1, the nested one x 5..6 at y 2..3.
    const xr = Math.max(...xs) - Math.min(...xs);
    const yr = Math.max(...ys) - Math.min(...ys);
    expect(xr).toBeCloseTo(6, 5);
    expect(yr).toBeCloseTo(3, 5);
    // The two source triangles stay distinct after the merge: 6 vertices,
    // and exactly two of them share the minimum y (mesh 1's base row).
    const minY = Math.min(...ys);
    expect(ys.filter((y) => Math.abs(y - minY) < 1e-4).length).toBe(2);
  });

  it("indexes non-indexed source meshes", () => {
    const g = new THREE.Group();
    g.add(meshAt(0, 0, 0, false));
    const marker = buildMarkerFromSource(g, "enemy");
    const mesh = marker.children[0] as THREE.Mesh;
    expect(mesh.geometry.getIndex()).not.toBeNull();
    expect(mesh.geometry.getIndex()?.count).toBe(3);
  });

  it("falls back to per-mesh clones for geometry-less sources", () => {
    const g = new THREE.Group();
    g.add(new THREE.Object3D());
    const marker = buildMarkerFromSource(g, "self");
    const meshes: THREE.Mesh[] = [];
    marker.traverse((c) => {
      if ((c as THREE.Mesh).isMesh) meshes.push(c as THREE.Mesh);
    });
    expect(meshes.length).toBe(0);
  });

  it("decodes correct triangles through the merged index", () => {
    const marker = buildMarkerFromSource(multiMeshSource(), "ally");
    const mesh = marker.children[0] as THREE.Mesh;
    const pos = mesh.geometry.getAttribute("position");
    const idx = mesh.geometry.getIndex()!;
    const v = new THREE.Vector3();
    const xs: number[] = [];
    const ys: number[] = [];
    // A dropped +vBase offset would point mesh 2's indices at mesh 1's
    // vertices; decoding every triangle through the index pins it.
    for (let i = 0; i < idx.count; i++) {
      v.fromBufferAttribute(pos, idx.getX(i));
      xs.push(v.x);
      ys.push(v.y);
    }
    expect(xs.filter((x) => x > 4).length).toBe(3); // mesh 2: 3 verts past x=4
    expect(ys.filter((y) => y > 1.5).length).toBe(3); // and past y=1.5
  });

  it("bakes nested rotations, not just translations", () => {
    const g = new THREE.Group();
    const nested = new THREE.Group().rotateZ(Math.PI / 2).translateX(2);
    nested.add(meshAt(0, 0, 0));
    g.add(nested);
    const marker = buildMarkerFromSource(g, "ally");
    const pos = (marker.children[0] as THREE.Mesh).geometry.getAttribute("position");
    const v = new THREE.Vector3();
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      xs.push(v.x);
      ys.push(v.y);
    }
    // Object3D.translateX moves along the ROTATED x axis, so the local
    // matrix is R·(v + (2,0,0)): the source triangle (x 0..1, y 0..1)
    // lands at x -1..0, y 2..3 — rotation and translation interleaved.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1, 5);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(1, 5);
    expect(Math.min(...xs)).toBeCloseTo(-1, 5);
    expect(Math.min(...ys)).toBeCloseTo(2, 5);
  });

  it("shares one merged buffer across markers of the same source", () => {
    const src = multiMeshSource();
    const a = buildMarkerFromSource(src, "ally");
    const b = buildMarkerFromSource(src, "enemy");
    const geoA = (a.children[0] as THREE.Mesh).geometry;
    const geoB = (b.children[0] as THREE.Mesh).geometry;
    expect(geoA).toBe(geoB); // one buffer per hull, shared
    expect((a.children[0] as THREE.Mesh).material).not.toBe(
      (b.children[0] as THREE.Mesh).material, // per-role materials still own
    );
  });
});
