/**
 * Bake the aircraft GLB FORWARD-orientation table (res/models/plane_forward.json).
 *
 * The pack's aircraft art is authored both ways: the baked profile of the
 * shipped models shows ~480 of 872 classifiable airframes with their nose at
 * local −Z and ~390 at +Z (the GLB nodes carry only a uniform scale and
 * translation, no rotation). The game renders them correctly through its own
 * airframe frame, but WoWSP places every plane with one yaw convention, so the
 * −Z half used to fly tail-first.
 *
 * Classifier (no rendering needed): the TAIL end carries the horizontal
 * stabilisers (large top-view area) and the fin (tallest y), the NOSE carries
 * the thin spinner/prop; the wing centre sits closer to the nose. Three
 * independent votes are combined; ambiguous models are left out of the table
 * (the runtime then leaves them untouched).
 *
 * Usage (needs the baked GLBs in the worktree; run from the REPO ROOT —
 * three is resolved through process.cwd()/packages/webui/node_modules):
 *   node scripts/model_convert/extract_plane_forward.js <planes-dir> <out.json>
 *
 * Ambiguous models (64 of 936: floats/struts fool the votes) are omitted,
 * which the runtime treats as nose +Z (unrotated) — the safe default.
 *
 * Output: { "<INDEX>": 1 | -1 } — 1 = nose at local +Z, −1 = nose at −Z.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
const threeRoot = path.join(process.cwd(), 'packages', 'webui', 'node_modules', 'three');
const THREE = await import(pathToFileURL(path.join(threeRoot, 'build', 'three.module.js')).href);
const { GLTFLoader } = await import(pathToFileURL(path.join(threeRoot, 'examples', 'jsm', 'loaders', 'GLTFLoader.js')).href);
const { MeshoptDecoder } = await import(pathToFileURL(path.join(threeRoot, 'examples', 'jsm', 'libs', 'meshopt_decoder.module.js')).href);
globalThis.self = globalThis;
const dir = process.argv[2];
const outFile = process.argv[3];
const only = [];
const files = only.length ? only.map((s) => s + '.glb') : fs.readdirSync(dir).filter((f) => f.endsWith('.glb')).sort();
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

async function load(idx) {
  const buf = fs.readFileSync(path.join(dir, idx + '.glb'));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise((res, rej) => loader.parse(ab, '', res, rej));
  gltf.scene.updateMatrixWorld(true);
  const tris = [];
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    const pos = g.getAttribute('position');
    const idxA = g.getIndex();
    const n = idxA ? idxA.count : pos.count;
    const v = new THREE.Vector3();
    const get = (i) => { const k = idxA ? idxA.getX(i) : i; return v.fromBufferAttribute(pos, k).applyMatrix4(o.matrixWorld).clone(); };
    for (let i = 0; i + 2 < n; i += 3) tris.push([get(i), get(i + 1), get(i + 2)]);
  });
  return tris;
}

function classify(idx, tris) {
  const zs = tris.flat().map((v) => v.z);
  const zmin = Math.min(...zs), zmax = Math.max(...zs), span = Math.max(1e-6, zmax - zmin);
  const band = span * 0.14;
  let areaMin = 0, areaMax = 0, yMin = -Infinity, yMax = -Infinity;
  let wsum = 0, wz = 0;
  for (const [a, b, c] of tris) {
    const cz = (a.z + b.z + c.z) / 3;
    // top-view triangle area (x-z)
    const area = Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) / 2;
    if (cz - zmin <= band) areaMin += area;
    if (zmax - cz <= band) areaMax += area;
    for (const p of [a, b, c]) {
      if (p.z - zmin <= band) yMin = Math.max(yMin, p.y);
      if (zmax - p.z <= band) yMax = Math.max(yMax, p.y);
      const w = Math.abs(p.x);
      wsum += w; wz += w * p.z;
    }
  }
  const wingFrac = wsum > 0 ? (wz / wsum - zmin) / span : 0.5;
  const votes = [];
  if (Math.abs(areaMax - areaMin) / Math.max(1e-6, Math.max(areaMin, areaMax)) > 0.15) votes.push(areaMin > areaMax ? 1 : -1);
  if (Math.abs(yMax - yMin) / Math.max(1e-6, Math.max(yMax, yMin)) > 0.06) votes.push(yMin > yMax ? 1 : -1);
  if (Math.abs(wingFrac - 0.5) > 0.08) votes.push(wingFrac < 0.5 ? -1 : 1);
  const plus = votes.filter((v) => v === 1).length;
  const minus = votes.filter((v) => v === -1).length;
  const sign = plus > minus ? 1 : minus > plus ? -1 : 0;
  return { sign, votes, areaMin: +areaMin.toFixed(4), areaMax: +areaMax.toFixed(4), yMin: +yMin.toFixed(3), yMax: +yMax.toFixed(3), wingFrac: +wingFrac.toFixed(2) };
}

const table = {};
const stats = { plusZ: 0, minusZ: 0, ambiguous: 0 };
const ambiguous = [];
for (const f of files) {
  const idx = f.slice(0, -4);
  let tris;
  try { tris = await load(idx); } catch (e) { stats.ambiguous++; ambiguous.push(idx + ':load'); continue; }
  const c = classify(idx, tris);
  if (c.sign === 0) { stats.ambiguous++; ambiguous.push(idx); continue; }
  table[idx] = c.sign;
  if (c.sign === 1) stats.plusZ++; else stats.minusZ++;
}
const sorted = {};
for (const k of Object.keys(table).sort()) sorted[k] = table[k];
fs.writeFileSync(outFile, JSON.stringify(sorted) + '\n');
console.log('models', files.length, 'table', Object.keys(sorted).length, JSON.stringify(stats));
console.log('ambiguous', ambiguous.length, ambiguous.slice(0, 12).join(' '));