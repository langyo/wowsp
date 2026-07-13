/**
 * GLB model loading utilities for the holographic 3D scene.
 *
 * Ship and map models are pre-converted GLB files placed under
 * `src/res/models/ships/` and `src/res/models/maps/` by the one-time
 * conversion scripts (`scripts/model_convert/convert_ship.py` /
 * `convert_map.py`). These are static assets bundled by Vite.
 *
 * Design: the loaders are **optional** — if a GLB doesn't exist for a given
 * ship/map, the scene falls back to procedural geometry (cone markers /
 * grid helper). This lets the app work with zero models, and progressively
 * enriches as the user converts assets via the scripts.
 *
 * File naming convention (from the conversion scripts):
 *   ships: `<displayName>.glb` or `<modelDir>.glb` (e.g. "Montana.glb",
 *          "PASB510_Montana.glb")
 *   maps:  `<spaceId>.glb` (e.g. "15_NE_north.glb")
 *
 * ## Skin → base model dedup
 * Many ships are reskins of a base ship (ARP/AZUR/FBO/Black/collab variants)
 * and share the same 3D hull. `src/res/data/ship_models.json` (built by
 * `scripts/extract/build_ship_models.py`) maps each shipId to a `baseName` —
 * for a skin ship, the base ship's readable name. `resolveShipModelByShipId`
 * reads this so skins reuse the base's baked GLB, letting us delete ~170
 * duplicate model files.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import shipModelNames from "../../res/data/ship_models.json";

// Vite static asset glob: eagerly import all GLB files under src/res/models/.
// Returns a map of path → resolved URL string. Empty if no models exist yet.
// Uses a file-relative pattern; an absolute `/src/res/...` glob would trip
// Vite's "publicDir served at root" warning since src/res is the publicDir.
const shipModules = import.meta.glob("../../res/models/ships/*.glb", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

const mapModules = import.meta.glob("../../res/models/maps/*.glb", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** All available ship model URLs, keyed by lowercased filename stem. */
const shipModelUrls = new Map<string, string>();
for (const [path, url] of Object.entries(shipModules)) {
  const stem = path.split("/").pop()!.replace(/\.glb$/i, "").toLowerCase();
  shipModelUrls.set(stem, url);
}

/** All available map model URLs, keyed by lowercased space id. */
const mapModelUrls = new Map<string, string>();
for (const [path, url] of Object.entries(mapModules)) {
  const stem = path.split("/").pop()!.replace(/\.glb$/i, "").toLowerCase();
  mapModelUrls.set(stem, url);
}

/** Resolve a ship model URL by trying multiple naming conventions. */
export function resolveShipModelUrl(
  displayName: string | undefined,
  modelDir: string | undefined,
): string | null {
  if (displayName) {
    const key = displayName.toLowerCase();
    if (shipModelUrls.has(key)) return shipModelUrls.get(key)!;
  }
  if (modelDir) {
    const key = modelDir.toLowerCase();
    if (shipModelUrls.has(key)) return shipModelUrls.get(key)!;
  }
  return null;
}

/** Entry shape from ship_models.json. */
interface ShipModelEntry {
  index: string;
  name: string;
  baseName: string;
  originShipName: string;
  hullModel: string;
}

const shipModelMap = shipModelNames as Record<string, ShipModelEntry>;

/**
 * Resolve a ship model URL by shipId. This is the preferred resolver: it
 * consults `ship_models.json` and, for skin ships, follows `baseName` to the
 * underlying base model — so reskins reuse the base's baked GLB instead of
 * each keeping a duplicate file.
 *
 * Falls back to name-based resolution if the ship isn't in the map or its base
 * name has no model either.
 */
export function resolveShipModelByShipId(
  shipId: number | string | undefined,
  fallbackName?: string,
): string | null {
  if (shipId != null) {
    const entry = shipModelMap[String(shipId)];
    if (entry?.baseName) {
      const url = shipModelUrls.get(entry.baseName.toLowerCase());
      if (url) return url;
    }
  }
  return resolveShipModelUrl(fallbackName, undefined);
}

/** Resolve a map model URL by space id (e.g. "15_NE_north"). */
export function resolveMapModelUrl(spaceId: string | undefined): string | null {
  if (!spaceId) return null;
  // Strip any "spaces/" prefix.
  const clean = spaceId.replace(/^spaces\//, "").toLowerCase();
  return mapModelUrls.get(clean) ?? null;
}

/** Shared GLTFLoader instance (heavy to construct). */
let _loader: GLTFLoader | null = null;
function getLoader(): GLTFLoader {
  if (!_loader) _loader = new GLTFLoader();
  return _loader;
}

/** Load a GLB model from a URL. Returns a Promise<THREE.Group> (the scene
 *  root of the loaded model). Rejects on parse/load error.
 *
 *  The baked GLBs were repaired on disk by `scripts/model_convert/repair_glbs.py`
 *  (which fixed a negative bufferView byteLength + JSON-chunk null padding), so
 *  a plain GLTFLoader.load is sufficient. */
export function loadGlbModel(url: string): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    getLoader().load(
      url,
      (gltf) => resolve(gltf.scene),
      undefined,
      (err) => reject(err),
    );
  });
}

/** Check whether any ship models have been converted yet. */
export function hasShipModels(): boolean {
  return shipModelUrls.size > 0;
}

/** Check whether any map models have been converted yet. */
export function hasMapModels(): boolean {
  return mapModelUrls.size > 0;
}
