/** Prop/aircraft marker material rules.
 *
 * User report: the aircraft read as "broken triangles" in the follow-plane
 * camera. The prop builder gave EVERY marker one translucent MeshBasicMaterial
 * with depth-write off — correct for shells/torpedoes, but on a closed solid
 * model (the plane GLB) every face blends in draw order, so the model's own
 * triangles show through each other as patchy holes and stray shards. Callers
 * that want a solid marker pass opacity 1, which must switch to an OPAQUE,
 * depth-writing material.
 */
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";

vi.mock("./modelLoader", () => ({
  loadGlbModel: vi.fn(async () => {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(2, 1, 6),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    group.add(mesh);
    return group;
  }),
}));

import { buildPropMarker, clearPropMarkerCache } from "./propMarker";

const materialOf = (g: THREE.Group): THREE.MeshBasicMaterial => {
  let mat: THREE.MeshBasicMaterial | null = null;
  g.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
    if (m && (m as THREE.MeshBasicMaterial).isMeshBasicMaterial) mat = m;
  });
  return mat!;
};

describe("buildPropMarker material", () => {
  it("keeps the translucent, depth-write-off look for projectiles", async () => {
    const marker = await buildPropMarker({
      url: "/models/props/shell.glb",
      color: 0xffcc33,
      axis: "y",
      targetLen: 4,
    });
    const mat = materialOf(marker);
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(mat.color.getHex()).toBe(0xffcc33);
    clearPropMarkerCache();
  });

  it("switches to an opaque, depth-writing material at opacity 1 (aircraft)", async () => {
    const marker = await buildPropMarker({
      url: "/models/planes/PAAB001.glb",
      color: 0xffffff,
      axis: "z",
      targetLen: 7,
      opacity: 1,
    });
    const mat = materialOf(marker);
    expect(mat.transparent).toBe(false);
    expect(mat.depthWrite).toBe(true);
    expect(mat.opacity).toBe(1);
    clearPropMarkerCache();
  });

  it("renders aircraft double-sided (baked winding is inconsistent)", async () => {
    // Geometry probe: ~37% of directed edges in the baked plane GLBs have
    // no opposite — faces flip at random, so single-sided rendering culls
    // visible chunks (the torn look). Opaque aircraft draw both sides;
    // translucent shells keep front-side rendering.
    const marker = await buildPropMarker({
      url: "/models/planes/PAAB001.glb",
      color: 0xffffff,
      axis: "z",
      targetLen: 7,
      opacity: 1,
    });
    expect(materialOf(marker).side).toBe(THREE.DoubleSide);
    clearPropMarkerCache();
  });

  it("applies the π yaw offset inside the wrapper (mixed-orientation art)", async () => {
    // Aircraft art is authored both ways; the caller passes π for the −Z
    // half so the wrapper's outer group stays free for the per-frame yaw.
    const marker = await buildPropMarker({
      url: "/models/planes/PAAB001.glb",
      color: 0xffffff,
      axis: "z",
      targetLen: 7,
      opacity: 1,
      yawOffset: Math.PI,
    });
    const inner = marker.children[0];
    expect(inner).toBeDefined();
    // 180° about Y → |w| ≈ 0, |y| ≈ 1 (a full turn would be identity).
    expect(Math.abs(inner.quaternion.w)).toBeLessThan(1e-6);
    expect(Math.abs(inner.quaternion.y)).toBeCloseTo(1);
    // The outer group is untouched: the placement writes its yaw.
    expect(marker.quaternion.w).toBeCloseTo(1);
    clearPropMarkerCache();
  });

  it("scales the model so its forward axis measures targetLen", async () => {
    const marker = await buildPropMarker({
      url: "/models/planes/PAAB002.glb",
      color: 0xffffff,
      axis: "z",
      targetLen: 7,
      opacity: 1,
    });
    // The 6-long box is scaled to 7 → the outer group still measures 7.
    const box = new THREE.Box3().setFromObject(marker);
    expect(box.getSize(new THREE.Vector3()).z).toBeCloseTo(7, 5);
    expect(marker.userData.sharedGeometry).toBe(true);
    clearPropMarkerCache();
  });
});