/**
 * De-interleave GLTF vertex attributes into plain `BufferAttribute`s.
 *
 * The pack's meshopt-compressed GLBs (`optimize_glbs.py` → gltf-transform
 * `--compress meshopt`) store their vertex data interleaved, and GLTFLoader
 * hands those back as `InterleavedBufferAttribute`s. The stage's geometry
 * passes assume plain attributes: three's own `mergeVertices` builds its
 * scratch copy with `new attr.constructor(array, itemSize, normalized)` —
 * a signature `InterleavedBufferAttribute` does not have (its third
 * argument is an element OFFSET), so the first scratch write dies as
 * `TypeError: Cannot set properties of undefined (setting 'NaN')` and the
 * whole model load fails. Call this on a geometry before any per-vertex
 * processing; geometries without interleaved attributes pass through
 * untouched (no copies, no re-wrapping).
 *
 * Values are read through `getComponent`, not `getX`: it denormalizes the
 * `KHR_mesh_quantization` normalized-integer attributes the compressed
 * pack writes, so those decode to the model's own units and downstream
 * tolerance math (the weld's 1e-4, the debris prune's extent ratios)
 * behaves as it does on the float bakes.
 */
import * as THREE from "three";

export function deinterleaveGeometry(geometry: THREE.BufferGeometry): void {
  for (const name of Object.keys(geometry.attributes)) {
    const attr = geometry.attributes[name] as THREE.BufferAttribute & {
      isInterleavedBufferAttribute?: boolean;
    };
    if (!attr.isInterleavedBufferAttribute) continue;
    const count = attr.count;
    const itemSize = attr.itemSize;
    const out = new Float32Array(count * itemSize);
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < itemSize; k++) {
        out[i * itemSize + k] = attr.getComponent(i, k);
      }
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(out, itemSize, false));
  }
}
