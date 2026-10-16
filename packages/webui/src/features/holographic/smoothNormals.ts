/**
 * Crease-aware vertex normals for the baked low-poly hulls.
 *
 * The baked collision shells ship POSITION only and — worse — their triangle
 * winding is essentially random (collision geometry never needed orientation;
 * ~72% of shared edges disagree). Winding-derived face normals therefore point
 * ± at random, naive averaging cancels them into garbage, and any winding-
 * trusting smooth-by-angle pass splits nearly every vertex, shading the hull
 * as per-triangle facets.
 *
 * This pass is winding-agnostic: face normals are clustered per vertex by
 * AXIS (|dot| against the cluster's running mean), each member is aligned to
 * the cluster axis before averaging, and the vertex is split where no cluster
 * within `creaseAngleDeg` admits the face — gradual panel runs shade smoothly
 * while true hard edges (chine, deck-to-side, box corners) stay crisp.
 *
 * Returns a NEW indexed geometry (position + normal + index). Any other
 * attribute present on the input (the armour overlay's thickness vertex
 * colours, uvs) is carried through per source vertex and duplicated
 * consistently wherever a crease splits a vertex.
 */
import * as THREE from "three";

export function computeSmoothNormals(
  geometry: THREE.BufferGeometry,
  creaseAngleDeg = 50,
): THREE.BufferGeometry {
  const posAttr = geometry.attributes.position as THREE.BufferAttribute;
  const carried = Object.keys(geometry.attributes)
    .filter((name) => name !== "position" && name !== "normal")
    .map((name) => ({
      name,
      attr: geometry.attributes[name] as THREE.BufferAttribute,
      out: [] as number[],
    }));
  const srcIndex = geometry.index;
  const vertexCount = posAttr.count;
  const triCount = (srcIndex ? srcIndex.count : vertexCount) / 3;
  const cosThreshold = Math.cos((creaseAngleDeg * Math.PI) / 180);
  const cornerOf = (t: number, c: number) =>
    srcIndex ? (srcIndex as THREE.BufferAttribute).getX(t * 3 + c) : t * 3 + c;

  // Face normals (degenerate faces stay zero and are skipped when averaging).
  const faceNormals = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const a = cornerOf(t, 0);
    const ax = posAttr.getX(a), ay = posAttr.getY(a), az = posAttr.getZ(a);
    const e1x = posAttr.getX(cornerOf(t, 1)) - ax, e1y = posAttr.getY(cornerOf(t, 1)) - ay, e1z = posAttr.getZ(cornerOf(t, 1)) - az;
    const e2x = posAttr.getX(cornerOf(t, 2)) - ax, e2y = posAttr.getY(cornerOf(t, 2)) - ay, e2z = posAttr.getZ(cornerOf(t, 2)) - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) {
      faceNormals[t * 3] = nx / len;
      faceNormals[t * 3 + 1] = ny / len;
      faceNormals[t * 3 + 2] = nz / len;
    }
  }

  // CSR: vertex → adjacent (face, corner) entries.
  const perVertex = new Uint32Array(vertexCount);
  for (let t = 0; t < triCount; t++) {
    perVertex[cornerOf(t, 0)]++;
    perVertex[cornerOf(t, 1)]++;
    perVertex[cornerOf(t, 2)]++;
  }
  const offsets = new Uint32Array(vertexCount + 1);
  for (let v = 0; v < vertexCount; v++) offsets[v + 1] = offsets[v] + perVertex[v];
  const adjFaces = new Uint32Array(offsets[vertexCount]);
  const adjCorner = new Uint32Array(offsets[vertexCount]);
  const fill = offsets.slice(0, vertexCount);
  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const v = cornerOf(t, c);
      const slot = fill[v]++;
      adjFaces[slot] = t;
      adjCorner[slot] = t * 3 + c;
    }
  }

  // Per corner: id of the vertex-local face-normal cluster it belongs to, and
  // the sign it was admitted with (±1, aligning its possibly-flipped winding
  // to the cluster axis before it is averaged).
  const cornerCluster = new Uint32Array(triCount * 3);
  const cornerSign = new Int8Array(triCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    const start = offsets[v], end = offsets[v + 1];
    // Running cluster means for this vertex (few entries in practice).
    const sums: number[][] = [];
    const counts: number[] = [];
    for (let slot = start; slot < end; slot++) {
      const f = adjFaces[slot];
      const nx = faceNormals[f * 3], ny = faceNormals[f * 3 + 1], nz = faceNormals[f * 3 + 2];
      let matched = -1;
      for (let cl = 0; cl < sums.length; cl++) {
        const s = sums[cl];
        const len = Math.hypot(s[0], s[1], s[2]);
        if (len < 1e-12) continue;
        // Axis similarity: winding is arbitrary in these meshes, so a face
        // whose normal opposes the cluster axis still belongs to it.
        let d = ((s[0] / len) * nx + (s[1] / len) * ny + (s[2] / len) * nz);
        if (d < 0) d = -d;
        if (d >= cosThreshold) { matched = cl; break; }
      }
      if (matched < 0) {
        sums.push([0, 0, 0]);
        counts.push(0);
        matched = sums.length - 1;
      }
      const s = sums[matched];
      const len = Math.hypot(s[0], s[1], s[2]);
      const d = len < 1e-12 ? 0 : (s[0] / len) * nx + (s[1] / len) * ny + (s[2] / len) * nz;
      const sign = d >= 0 ? 1 : -1;
      s[0] += sign * nx; s[1] += sign * ny; s[2] += sign * nz;
      counts[matched]++;
      cornerCluster[adjCorner[slot]] = matched;
      cornerSign[adjCorner[slot]] = sign;
    }
  }

  // Remap (vertex, cluster) pairs to output vertices; emit duplicated
  // positions where a crease split a vertex, with the cluster mean normal.
  const outIndex = new Uint32Array(triCount * 3);
  const remap = new Map<number, number>();
  const outPos: number[] = [];
  const outNor: number[] = [];
  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const corner = t * 3 + c;
      const v = cornerOf(t, c);
      const cl = cornerCluster[corner];
      // A vertex borders a handful of faces, so its cluster count is tiny —
      // 1024 slots per vertex is far beyond collision range.
      const key = v * 1024 + Math.min(cl, 1023);
      let out = remap.get(key);
      if (out == null) {
        out = outPos.length / 3;
        remap.set(key, out);
        outPos.push(posAttr.getX(v), posAttr.getY(v), posAttr.getZ(v));
        // getComponent decodes normalized integer attributes (GLTF vertex
        // colours may be normalized ubyte), so carried values stay exact.
        for (const c of carried) {
          for (let k = 0; k < c.attr.itemSize; k++) {
            c.out.push(c.attr.getComponent(v, k));
          }
        }
        // The cluster this corner joined is the (cl)th cluster created for
        // vertex v — recover its mean from the same greedy order by re-scanning
        // is wasteful, so recompute from the corner's own adjacent faces,
        // aligned by the sign each face was admitted with.
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (let slot = offsets[v]; slot < offsets[v + 1]; slot++) {
          if (cornerCluster[adjCorner[slot]] !== cl) continue;
          const f = adjFaces[slot];
          const sg = cornerSign[adjCorner[slot]];
          sx += sg * faceNormals[f * 3]; sy += sg * faceNormals[f * 3 + 1]; sz += sg * faceNormals[f * 3 + 2];
          cnt++;
        }
        const len = Math.hypot(sx, sy, sz);
        if (len > 1e-12) {
          outNor.push(sx / len, sy / len, sz / len);
        } else {
          // Fully degenerate corner: any stable direction; the shader's
          // vHasNormal check still reads a valid (non-zero) attribute here.
          outNor.push(0, 1, 0);
        }
      }
      outIndex[corner] = out;
    }
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(outPos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(outNor, 3));
  for (const c of carried) {
    out.setAttribute(c.name, new THREE.Float32BufferAttribute(c.out, c.attr.itemSize));
  }
  out.setIndex(new THREE.BufferAttribute(outIndex, 1));
  out.computeBoundingSphere();
  return out;
}
