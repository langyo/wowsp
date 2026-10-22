/** Tests for the interleaved-attribute flattener. The meshopt-compressed
 *  pack GLBs hand GLTFLoader's attributes back interleaved, and geometry
 *  passes that assume plain attributes (three's mergeVertices among them)
 *  misconstruct them — this must flatten them losslessly, including the
 *  normalized integer attributes KHR_mesh_quantization produces. */
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { describe, expect, it } from "vitest";

import { deinterleaveGeometry } from "./deinterleave";

const POSITIONS = [0.25, 0.5, 0.75, 1.5, -2.25, 3.0, -4.0, 5.0, -6.5];
const GREYS = [64, 128, 255];

/** POSITION (float vec3) + COLOR (normalized ubyte vec3) interleaved with
 *  1 byte of padding per record, mirroring the compressed pack's layout:
 *  like GLTFLoader, each accessor gets its own typed-array VIEW of the
 *  shared record buffer (one InterleavedBuffer per component type). */
function interleavedGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const stride = 16; // 12 bytes position + 3 bytes colour + 1 byte pad
  const buffer = new ArrayBuffer(stride * 3);
  const f32 = new Float32Array(buffer);
  const u8 = new Uint8Array(buffer);
  for (let v = 0; v < 3; v++) {
    f32[(v * stride) / 4 + 0] = POSITIONS[v * 3];
    f32[(v * stride) / 4 + 1] = POSITIONS[v * 3 + 1];
    f32[(v * stride) / 4 + 2] = POSITIONS[v * 3 + 2];
    u8[v * stride + 12] = GREYS[v];
    u8[v * stride + 13] = GREYS[v];
    u8[v * stride + 14] = GREYS[v];
  }
  g.setAttribute(
    "position",
    new THREE.InterleavedBufferAttribute(
      new THREE.InterleavedBuffer(new Float32Array(buffer, 0, 4 * 3), 4),
      3, 0, false,
    ),
  );
  g.setAttribute(
    "color",
    new THREE.InterleavedBufferAttribute(
      new THREE.InterleavedBuffer(new Uint8Array(buffer, 0, stride * 3), stride),
      3, 12, true,
    ),
  );
  g.setIndex([0, 1, 2]);
  return g;
}

describe("deinterleaveGeometry", () => {
  it("flattens interleaved attributes into plain BufferAttributes", () => {
    const g = interleavedGeometry();
    expect(
      (g.attributes.position as unknown as { isInterleavedBufferAttribute: boolean })
        .isInterleavedBufferAttribute,
    ).toBe(true);
    deinterleaveGeometry(g);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const col = g.attributes.color as THREE.BufferAttribute;
    expect(
      (pos as unknown as { isInterleavedBufferAttribute?: boolean })
        .isInterleavedBufferAttribute,
    ).toBeUndefined();
    expect(pos.count).toBe(3);
    for (let v = 0; v < 3; v++) {
      expect(pos.getX(v)).toBeCloseTo(POSITIONS[v * 3], 6);
      expect(pos.getY(v)).toBeCloseTo(POSITIONS[v * 3 + 1], 6);
      expect(pos.getZ(v)).toBeCloseTo(POSITIONS[v * 3 + 2], 6);
      // The normalized ubyte colours decode to their 0..1 fractions.
      expect(col.getX(v)).toBeCloseTo(GREYS[v] / 255, 5);
    }
  });

  it("leaves plain float geometries untouched (no re-wrapping)", () => {
    const g = new THREE.BufferGeometry();
    const attr = new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3);
    g.setAttribute("position", attr);
    deinterleaveGeometry(g);
    expect(g.attributes.position).toBe(attr);
  });

  it("lets mergeVertices weld what used to crash on interleaved input", () => {
    const g = interleavedGeometry();
    deinterleaveGeometry(g);
    // The weld must fuse the 3 corners — and must not throw (the regression
    // this module exists for surfaced as "Cannot set properties of
    // undefined (setting 'NaN')" inside mergeVertices' scratch copy).
    const merged = mergeVertices(g, 1e-4);
    expect(merged.attributes.position.count).toBe(3);
  });
});
