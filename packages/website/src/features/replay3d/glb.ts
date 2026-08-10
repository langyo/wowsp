/**
 * GLB loading for the site's live renderer: GLTFLoader + meshopt decoder
 * (site assets are re-baked with `gltf-transform optimize --compress meshopt`,
 * see scripts/bake_site_replay.py). Also tolerates the app's baked GLBs'
 * NUL-byte JSON-chunk padding, same as the app's modelLoader.
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

export async function loadGlb(url: string): Promise<THREE.Group> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  const fixed = fixGlbPadding(await resp.arrayBuffer());
  const blobUrl = URL.createObjectURL(new Blob([fixed], { type: "model/gltf-binary" }));
  try {
    const gltf = await getLoader().loadAsync(blobUrl);
    return gltf.scene;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
