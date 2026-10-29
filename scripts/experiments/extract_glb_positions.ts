/**
 * Extract world-space POSITION vertices from a WoWSP map GLB — including
 * the EXT_meshopt_compression + KHR_mesh_quantization packs the model
 * pipeline now ships (optimize_glbs.py output), which bake_terrain_los.py's
 * stdlib GLB reader cannot parse (buffer 1 is virtual: the compressed
 * streams live in the BIN chunk and decode through the meshopt WASM).
 *
 * Decoding rides three's self-contained MeshoptDecoder (embedded WASM, no
 * network, no DOM — resolves from the webui workspace install). Output is a
 * float32 .npy (N x 3, world space) the baker consumes via --positions.
 *
 * Runs on plain node >= 22.6 via --experimental-strip-types (erasable
 * syntax only — no enums/namespaces; the annotations are documentation).
 *
 * Usage:
 *   node --experimental-strip-types scripts/experiments/extract_glb_positions.ts \
 *       --glb "$LOCALAPPDATA/WoWSP/models/maps/00_CO_ocean.glb" \
 *       --out scripts/experiments/out/00_CO_ocean.positions.npy
 *   (or --manifest <file> with one "glb<TAB>out" line per map for batches)
 */
import fs from 'node:fs';
import path from 'node:path';
import { MeshoptDecoder } from '../../packages/webui/node_modules/three/examples/jsm/libs/meshopt_decoder.module.js';

const args = process.argv.slice(2);
const get = (flag: string): string | null => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

const gltfComponent = {
  5120: { array: Int8Array, size: 1 },
  5121: { array: Uint8Array, size: 1 },
  5122: { array: Int16Array, size: 2 },
  5123: { array: Uint16Array, size: 2 },
  5125: { array: Uint32Array, size: 4 },
  5126: { array: Float32Array, size: 4 },
};
const gltfNComp = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function parseGlb(file: string) {
  const data = fs.readFileSync(file);
  if (data.readUInt32LE(0) !== 0x46546c67) throw new Error(`not a GLB: ${file}`);
  let cur = 12;
  let json = null;
  let bin = null;
  while (cur + 8 <= data.length) {
    const len = data.readUInt32LE(cur);
    const type = data.readUInt32LE(cur + 4);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8', cur + 8, cur + 8 + len));
    else if (type === 0x4e4942) bin = new Uint8Array(data.buffer, data.byteOffset + cur + 8, len);
    cur += 8 + len;
  }
  if (!json || !bin) throw new Error(`GLB missing JSON/BIN chunk: ${file}`);
  return { json, bin };
}

type GltfNode = {
  matrix?: number[];
  rotation?: number[];
  scale?: number[];
  translation?: number[];
  name?: string;
  mesh?: number;
  children?: number[];
};

/** Column-major glTF node matrix -> Float64 (row-major 4x4 for our math). */
function nodeMatrix(node: GltfNode) {
  let m;
  if (node.matrix) {
    const c = node.matrix; // column-major
    m = [
      c[0], c[4], c[8], c[12],
      c[1], c[5], c[9], c[13],
      c[2], c[6], c[10], c[14],
      c[3], c[7], c[11], c[15],
    ];
  } else {
    // TRS path. Every map GLB in the shipped model pack is a single node with
    // a yaw-free TRS (verified when this extractor was added); a future pack
    // that rotates map nodes would need quaternion handling here — assert
    // loudly instead of silently baking wrong coordinates.
    if (node.rotation && node.rotation.some((v, i) => Math.abs(v - [0, 0, 0, 1][i]) > 1e-6)) {
      throw new Error(
        `node ${JSON.stringify(node.name ?? "?")} carries a rotation; this extractor only handles map TRS without rotation — extend it before baking`,
      );
    }
    const { scale = [1, 1, 1], translation = [0, 0, 0] } = node;
    m = [
      scale[0], 0, 0, translation[0],
      0, scale[1], 0, translation[1],
      0, 0, scale[2], translation[2],
      0, 0, 0, 1,
    ];
  }
  return m;
}

function matMul(a: number[], b: number[]): number[] {
  const out = new Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
    }
  }
  return out;
}

async function decodeAccessor(gltf: ReturnType<typeof parseGlb>, accIndex: number) {
  const { json, bin } = gltf;
  const acc = json.accessors[accIndex];
  const view = json.bufferViews[acc.bufferView];
  const comp = gltfComponent[acc.componentType];
  const ncomp = gltfNComp[acc.type];
  if (!comp || !ncomp) throw new Error(`unsupported accessor ${accIndex}`);
  const ext = view.extensions && view.extensions.EXT_meshopt_compression;
  let bytes;
  let stride;
  if (ext) {
    const source = bin.slice(ext.byteOffset, ext.byteOffset + ext.byteLength);
    stride = ext.byteStride || comp.size * ncomp;
    const filter = ext.filter || 'NONE';
    const mode = ext.mode; // 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES' (string)
    bytes = await MeshoptDecoder.decodeGltfBufferAsync(ext.count, stride, source, mode, filter);
  } else {
    stride = view.byteStride || comp.size * ncomp;
    const start = (view.byteOffset || 0) + (acc.byteOffset || 0);
    bytes = bin.slice(start, start + acc.count * stride);
  }
  // KHR_mesh_quantization: integer attributes with normalized=true map to
  // [-1, 1] (signed: divide by 32767/127; the glTF spec's exact divisors).
  const signed = comp.array === Int8Array || comp.array === Int16Array || comp.array === Int32Array;
  const normDiv = acc.normalized
    ? (signed ? (comp.size === 1 ? 127 : comp.size === 2 ? 32767 : 2147483647)
              : (comp.size === 1 ? 255 : comp.size === 2 ? 65535 : 4294967295))
    : null;
  return { bytes, stride, comp, ncomp, count: acc.count, normDiv };
}

function readVec(decode: Awaited<ReturnType<typeof decodeAccessor>>, vertexIndex: number) {
  const { bytes, stride, comp, ncomp, normDiv } = decode;
  const base = vertexIndex * stride;
  const dv = new DataView(bytes.buffer, bytes.byteOffset + base, stride);
  const out = new Array(ncomp);
  for (let c = 0; c < ncomp; c++) {
    const o = c * comp.size;
    let v =
      comp.array === Int8Array ? dv.getInt8(o) :
      comp.array === Uint8Array ? dv.getUint8(o) :
      comp.array === Int16Array ? dv.getInt16(o, true) :
      comp.array === Uint16Array ? dv.getUint16(o, true) :
      comp.array === Uint32Array ? dv.getUint32(o, true) :
      dv.getFloat32(o, true);
    if (normDiv !== null) v /= normDiv;
    out[c] = v;
  }
  return out;
}

async function extractPositions(glbPath: string) {
  const gltf = parseGlb(glbPath);
  const { json } = gltf;
  // World matrices: walk every root's children chain.
  const world = new Map();
  const visit = (nodeIndex, parent) => {
    const node = json.nodes[nodeIndex];
    const m = matMul(parent, nodeMatrix(node));
    world.set(nodeIndex, m);
    for (const c of node.children || []) visit(c, m);
  };
  const roots = (json.scenes && json.scenes[(json.scene || 0)] && json.scenes[(json.scene || 0)].nodes) || [];
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const r of roots) visit(r, identity);
  // Rootless nodes (flat exports) still get their own matrix.
  (json.nodes || []).forEach((n, i) => { if (!world.has(i)) world.set(i, nodeMatrix(n)); });

  const chunks = [];
  for (let mi = 0; mi < (json.meshes || []).length; mi++) {
    const owners = (json.nodes || []).map((n, i) => (n.mesh === mi ? i : -1)).filter((i) => i >= 0);
    const mats = owners.length ? owners.map((i) => world.get(i)) : [identity];
    for (const mat of mats) {
      for (const prim of json.meshes[mi].primitives || []) {
        const pos = prim.attributes && prim.attributes.POSITION;
        if (pos === undefined) continue;
        const dec = await decodeAccessor(gltf, pos);
        if (dec.ncomp !== 3) continue;
        const out = new Float64Array(dec.count * 3);
        for (let v = 0; v < dec.count; v++) {
          const [x, y, z] = readVec(dec, v);
          out[v * 3] = mat[0] * x + mat[1] * y + mat[2] * z + mat[3];
          out[v * 3 + 1] = mat[4] * x + mat[5] * y + mat[6] * z + mat[7];
          out[v * 3 + 2] = mat[8] * x + mat[9] * y + mat[10] * z + mat[11];
        }
        chunks.push(out);
      }
    }
  }
  if (!chunks.length) throw new Error(`no POSITION geometry: ${glbPath}`);
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return merged;
}

function writeNpy(file: string, verts: Float32Array) {
  const n = verts.length / 3;
  const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${n}, 3), }`;
  const pad = 64 - ((10 + header.length) % 64);
  const headLen = header.length + pad;
  const headBuf = Buffer.alloc(10 + headLen);
  headBuf.write('\x93NUMPY', 0, 'binary'); // bytes 0-5 magic
  headBuf.writeUInt8(1, 6); // version major at 6
  headBuf.writeUInt8(0, 7); // version minor at 7
  headBuf.writeUInt16LE(headLen, 8); // header length u16 at 8-9
  headBuf.write(header + ' '.repeat(pad), 10, 'utf8');
  fs.writeFileSync(file, Buffer.concat([headBuf, Buffer.from(verts.buffer, verts.byteOffset, verts.byteLength)]));
}

async function one(glb: string, out: string) {
  const verts = await extractPositions(glb);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  writeNpy(out, verts);
  console.log(`[extract] ${path.basename(glb)} -> ${out} (${verts.length / 3} verts)`);
}

const manifest = get('--manifest');
if (manifest) {
  const lines = fs.readFileSync(manifest, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  await MeshoptDecoder.ready;
  for (const line of lines) {
    const [glb, out] = line.split('\t');
    await one(glb, out);
  }
} else {
  const glb = get('--glb');
  const out = get('--out');
  if (!glb || !out) {
    console.error('usage: extract_glb_positions.ts --glb <x.glb> --out <x.npy> | --manifest <file>');
    process.exit(2);
  }
  await MeshoptDecoder.ready;
  await one(glb, out);
}
