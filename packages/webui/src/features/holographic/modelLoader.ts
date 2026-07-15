/**
 * GLB model loading utilities for the holographic 3D scene.
 *
 * Ship and map models are pre-converted GLB files placed under
 * `src/res/models/ships/` and `src/res/models/maps/` (Vite's publicDir).
 * Since they live in the public directory, they are served at the root path
 * (e.g. `/models/ships/Montana.glb`). We discover available files via a
 * non-URL glob (just filename listing) and build public URLs from the stems.
 *
 * ## Skin → base model dedup
 * `src/res/data/ship_models.json` maps each shipId to a `baseName`.
 * We import it directly as a module (it lives in src/data, not src/res/data).
 */

import shipModelNames from "../../data/ship_models.json";

// ── Ship model stems (extracted from glob paths, NOT used as import URLs) ──
// We only need the filename stems to check which models exist; actual
// URLs are constructed as `/models/ships/<stem>.glb` (public dir root path).
const _shipGlob = import.meta.glob("../../res/models/ships/*.glb", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** All available ship model stems (lowercased filename without extension). */
const shipModelStems = new Set<string>();
for (const path of Object.keys(_shipGlob)) {
  const stem = path.split("/").pop()!.replace(/\.glb$/i, "").toLowerCase();
  shipModelStems.add(stem);
}

const _mapGlob = import.meta.glob("../../res/models/maps/*.glb", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

const mapModelStems = new Set<string>();
for (const path of Object.keys(_mapGlob)) {
  const stem = path.split("/").pop()!.replace(/\.glb$/i, "").toLowerCase();
  mapModelStems.add(stem);
}

/** Get the public URL for a ship GLB model. Returns null if no model exists
 *  under that stem. */
function shipModelUrl(stem: string): string | null {
  if (shipModelStems.has(stem.toLowerCase())) {
    return `/models/ships/${encodeURIComponent(stem)}.glb`;
  }
  return null;
}

function mapModelUrl(stem: string): string | null {
  if (mapModelStems.has(stem.toLowerCase())) {
    return `/models/maps/${encodeURIComponent(stem)}.glb`;
  }
  return null;
}

// ── Re-export public API with the same signatures ────────────────────────

export function resolveShipModelUrl(
  displayName: string | undefined,
  modelDir: string | undefined,
): string | null {
  if (displayName) {
    const url = shipModelUrl(displayName);
    if (url) return url;
  }
  if (modelDir) {
    const url = shipModelUrl(modelDir);
    if (url) return url;
  }
  return null;
}

interface ShipModelEntry {
  index: string;
  name: string;
  baseName: string;
  originShipName: string;
  hullModel: string;
}

const shipModelMap = shipModelNames as Record<string, ShipModelEntry>;

export function resolveShipModelByShipId(
  shipId: number | string | undefined,
  fallbackName?: string,
): string | null {
  if (shipId != null) {
    const entry = shipModelMap[String(shipId)];
    if (entry?.baseName) {
      const url = shipModelUrl(entry.baseName);
      if (url) return url;
    }
  }
  return resolveShipModelUrl(fallbackName, undefined);
}

export function resolveMapModelUrl(spaceId: string | undefined): string | null {
  if (!spaceId) return null;
  const clean = spaceId.replace(/^spaces\//, "").toLowerCase();
  return mapModelUrl(clean);
}

export interface ShipModelSpec {
  shipId: number;
  tier?: number | null;
  nation?: string | null;
  type?: string | null;
}

function resolveExact(spec: ShipModelSpec): string | null {
  if (spec.shipId == null) return null;
  const entry = shipModelMap[String(spec.shipId)];
  if (entry?.baseName) {
    return shipModelUrl(entry.baseName);
  }
  return null;
}

export function resolveFallbackModel(
  spec: ShipModelSpec,
  ships: ShipModelSpec[],
): string | null {
  const tier = spec.tier;
  if (tier == null) return null;

  const candidates = ships.filter(
    (s) => s.tier === tier && resolveExact(s) != null,
  );
  if (candidates.length === 0) return null;

  const nation = spec.nation?.toLowerCase();
  const type = spec.type?.toLowerCase();

  if (nation && type) {
    const hit = candidates.find(
      (s) => s.nation?.toLowerCase() === nation && s.type?.toLowerCase() === type,
    );
    const url = hit && resolveExact(hit);
    if (url) return url;
  }
  if (type) {
    const hit = candidates.find((s) => s.type?.toLowerCase() === type);
    const url = hit && resolveExact(hit);
    if (url) return url;
  }
  return resolveExact(candidates[0]);
}

export function resolveShipModelForEntry(
  ship: ShipModelSpec | null | undefined,
  encyclopedia: ShipModelSpec[],
): string | null {
  if (ship) {
    const exact = resolveExact(ship);
    if (exact) return exact;
    const fallback = resolveFallbackModel(ship, encyclopedia);
    if (fallback) return fallback;
  }
  for (const s of encyclopedia) {
    const url = resolveExact(s);
    if (url) return url;
  }
  return null;
}

// ── GLTF loading ──────────────────────────────────────────────────────────

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

let _loader: GLTFLoader | null = null;
function getLoader(): GLTFLoader {
  if (!_loader) _loader = new GLTFLoader();
  return _loader;
}

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

export function hasShipModels(): boolean {
  return shipModelStems.size > 0;
}

export function hasMapModels(): boolean {
  return mapModelStems.size > 0;
}
