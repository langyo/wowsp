/**
 * GLB loading shared by every three.js surface — the app's holographic
 * ship stage and the marketing site's replay/ship showcases. The app ships
 * a richer chain-walking loader of its own (features/holographic/
 * modelLoader.ts); everything else goes through here.
 *
 * Two hard-won rules:
 *
 *  1. GLTFLoader + meshopt decoder — baked assets are compressed with
 *     `gltf-transform optimize --compress meshopt` (see
 *     scripts/bake_site_replay.py).
 *  2. NEVER hand GLTFLoader a `blob:` URL. The loader re-FETCHES whatever
 *     URL it is given, and the deployed site's CSP allows no `blob:` in
 *     connect-src (packages/website/src/res/_headers, mirrored in
 *     relay-core) — the fetch was silently blocked, which dropped the whole
 *     terrain + every ship model on the site's homepage while the JSON/PNG
 *     assets kept loading. The URL is fetched HERE and the ArrayBuffer is
 *     handed straight to `parseAsync`: no second request, no CSP edge, and
 *     one less round-trip. It also tolerates the app's baked GLBs' NUL-byte
 *     JSON-chunk padding, same as the app's modelLoader.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

let _loader: GLTFLoader | null = null;

function getLoader(): GLTFLoader {
  if (!_loader) {
    _loader = new GLTFLoader();
    _loader.setMeshoptDecoder(MeshoptDecoder);
  }
  return _loader;
}

function fixGlbPadding(buffer: ArrayBuffer): ArrayBuffer {
  const view = new DataView(buffer);
  if (buffer.byteLength < 20) return buffer;
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== "glTF") return buffer;
  const jsonLen = view.getUint32(12, true);
  const bytes = new Uint8Array(buffer);
  for (let i = 20 + jsonLen - 1; i >= 20 && bytes[i] === 0; i--) bytes[i] = 0x20;
  return buffer;
}

/** Fetch a GLB and parse it in memory. The returned group is caller-owned
 *  (dispose its geometries/materials); concurrent calls are safe — every
 *  parse builds its own GLTFParser. */
export async function loadGlb(url: string): Promise<THREE.Group> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  const buffer = fixGlbPadding(await resp.arrayBuffer());
  const gltf = await getLoader().parseAsync(buffer, "");
  return gltf.scene;
}
