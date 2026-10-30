/** Tests for the mast-antenna gap healing: the bake drops the thin whip
 *  between a masthead and its antenna pole; healAntennaGaps must bridge
 *  exactly that case and nothing else (catapult aircraft, tight seams and
 *  free floaters all stay untouched). */
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { describe, expect, it } from "vitest";

import { healAntennaGaps } from "./antennaHeal";

/** An axis-aligned box mesh (position-only, welded indexing). */
function boxMesh(
  name: string,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
): THREE.Mesh {
  let geo: THREE.BufferGeometry = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  geo.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  // healAntennaGaps runs on the app's WELDED, position-only geometry — a
  // raw BoxGeometry duplicates every corner per face (normals differ) and
  // mergeVertices only fuses fully-matching vertices, so strip first.
  geo.deleteAttribute("normal");
  geo.deleteAttribute("uv");
  geo = mergeVertices(geo, 1e-4);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  mesh.name = name;
  return mesh;
}

/** Hull + superstructure block + antenna pole floating with a clear gap. */
function brokenMastModel(gap: number): THREE.Group {
  const model = new THREE.Group();
  model.add(boxMesh("hull_body", -50, 0, -100, 50, 10, 100));
  // Masthead block high on the hull, centred at x/z 0.
  model.add(boxMesh("superstructure", -4, 30, -4, 4, 34, 4));
  // Antenna pole: 2 wide, 14 tall, floating 'gap' above the masthead.
  model.add(boxMesh("superstructure", -1, 34 + gap, -1, 1, 48 + gap, 1));
  return model;
}

function gapHasGeometry(model: THREE.Object3D, yLo: number, yHi: number): boolean {
  let found = false;
  model.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      if (v.y >= yLo && v.y <= yHi && Math.abs(v.x) < 5 && Math.abs(v.z) < 5) found = true;
    }
  });
  return found;
}

describe("healAntennaGaps", () => {
  it("bridges a floating antenna pole down to its masthead", () => {
    const model = brokenMastModel(2); // gap = 4% of model height (0..50)
    const stats = healAntennaGaps(model);
    expect(stats.connectors).toBe(1);
    // The gap band (y 34..36 near the centreline) now has geometry.
    expect(gapHasGeometry(model, 34, 36)).toBe(true);
  });

  it("heals both masts when two poles float", () => {
    const model = brokenMastModel(2);
    model.add(boxMesh("misc", -30, 26, 58, -26, 30, 62)); // foremast head
    model.add(boxMesh("misc", -29, 32, 59, -27, 44, 61)); // floating pole
    const stats = healAntennaGaps(model);
    expect(stats.connectors).toBe(2);
  });

  it("never bridges a wide floater (catapult aircraft)", () => {
    const model = brokenMastModel(2);
    // A floatplane-sized wing floating high: wide XZ, short height.
    model.add(boxMesh("aircraft", -15, 40, -8, 15, 43, 8));
    const stats = healAntennaGaps(model);
    expect(stats.connectors).toBe(1); // only the mast pole, not the plane
  });

  it("leaves a pole floating beyond the bridgeable gap alone", () => {
    // gap 10 on a 50-tall model = 20% of height — past maxGapFrac, this is
    // a genuinely detached piece, not a dropped whip.
    const model = brokenMastModel(10);
    const stats = healAntennaGaps(model);
    expect(stats.connectors).toBe(0);
  });

  it("leaves sub-visible seams alone", () => {
    // gap 0.05 on a 50-tall model = 0.1% of height — under the threshold.
    const model = brokenMastModel(0.05);
    const stats = healAntennaGaps(model);
    expect(stats.connectors).toBe(0);
  });

  it("leaves a pole with nothing below it alone", () => {
    const model = new THREE.Group();
    model.add(boxMesh("hull_body", -50, 0, -100, 50, 10, 100));
    // Pole floats far off to the side, no masthead under it.
    model.add(boxMesh("superstructure", 80, 36, 0, 82, 50, 2));
    const stats = healAntennaGaps(model);
    expect(stats.connectors).toBe(0);
  });

  it("ignores meshes carrying armour thickness colours", () => {
    const model = brokenMastModel(2);
    for (const child of model.children) {
      const mesh = child as THREE.Mesh;
      const n = (mesh.geometry.attributes.position as THREE.BufferAttribute).count;
      mesh.geometry.setAttribute(
        "color",
        new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.5), 3),
      );
    }
    const stats = healAntennaGaps(model);
    expect(stats.connectors).toBe(0);
  });
});
