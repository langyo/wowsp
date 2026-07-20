/**
 * GLB model loading utilities for the holographic 3D scene.
 *
 * Ship and map models are pre-converted GLB files placed under
 * `src/res/models/ships/` and `src/res/models/maps/` (Vite's publicDir).
 * Model availability is discovered lazily: we only collect filenames from
 * glob keys without eagerly importing hundreds of binary assets.  At runtime
 * models are served via their public URL (`/models/ships/<stem>.glb`), not
 * through Vite's module graph — this avoids duplicate assets in the build
 * output and eliminates the "Assets in the public directory" warnings.
 *
 * ## Skin → base model dedup
 * `src/data/ship_models.json` maps each shipId to a `baseName`.
 */

import shipModelNames from "../../data/ship_models.json";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// ── Ship model availability (lowercase → original-casing stem map) ──────
const _shipGlobKeys = Object.keys(
  import.meta.glob("../../res/models/ships/*.glb"),
);
const shipCasedByLower = new Map<string, string>();
for (const path of _shipGlobKeys) {
  const original = path.split("/").pop()!.replace(/\.glb$/i, "");
  shipCasedByLower.set(original.toLowerCase(), original);
}

// ── Map model availability ───────────────────────────────────────────────
const _mapGlobKeys = Object.keys(
  import.meta.glob("../../res/models/maps/*.glb"),
);
const mapCasedByLower = new Map<string, string>();
for (const path of _mapGlobKeys) {
  const original = path.split("/").pop()!.replace(/\.glb$/i, "");
  mapCasedByLower.set(original.toLowerCase(), original);
}

// ── ship_models.json mapping ─────────────────────────────────────────────
interface ShipModelEntry {
  index: string;
  name: string;
  baseName: string;
  originShipName: string;
  hullModel: string;
}
const shipModelMap = shipModelNames as Record<string, ShipModelEntry>;

// ── URL resolvers ────────────────────────────────────────────────────────
// All models live under publicDir (src/res), so the public URL is the path
// relative to the public root.  Filename casing is preserved.

function shipModelUrl(stem: string): string | null {
  const key = stem.toLowerCase();
  const cased = shipCasedByLower.get(key);
  return cased ? `/models/ships/${cased}.glb` : null;
}

function mapModelUrl(stem: string): string | null {
  const key = stem.toLowerCase();
  const cased = mapCasedByLower.get(key);
  return cased ? `/models/maps/${cased}.glb` : null;
}

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
  // Direct name lookup bypasses ship_models.json (handles ships not yet
  // mapped, or custom skins whose GLB filename matches the ship name).
  if (fallbackName) {
    const url = shipModelUrl(fallbackName);
    if (url) return url;
  }
  return null;
}

export function resolveMapModelUrl(spaceId: string | undefined): string | null {
  if (!spaceId) return null;
  const clean = spaceId.replace(/^spaces\//, "").toLowerCase();
  return mapModelUrl(clean);
}

// ── Fallback resolution (tier / nation / type) ──────────────────────────

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
    const url = shipModelUrl(entry.baseName);
    if (url) return url;
  }
  return null;
}

export function resolveFallbackModel(
  spec: ShipModelSpec,
  ships: ShipModelSpec[],
): string | null {
  const tier = spec.tier;
  const nation = spec.nation?.toLowerCase();
  const type = spec.type?.toLowerCase();

  // Try same tier + same nation + same type.
  if (tier != null && nation && type) {
    for (const s of ships) {
      if (
        s.tier === tier &&
        s.nation?.toLowerCase() === nation &&
        s.type?.toLowerCase() === type
      ) {
        const url = resolveExact(s);
        if (url) return url;
      }
    }
  }

  // Try same tier + same type (any nation).
  if (tier != null && type) {
    for (const s of ships) {
      if (s.tier === tier && s.type?.toLowerCase() === type) {
        const url = resolveExact(s);
        if (url) return url;
      }
    }
  }

  // Try same tier (any type/nation).
  if (tier != null) {
    for (const s of ships) {
      if (s.tier === tier) {
        const url = resolveExact(s);
        if (url) return url;
      }
    }
  }

  // Try same type (any tier/nation).
  if (type) {
    for (const s of ships) {
      if (s.type?.toLowerCase() === type) {
        const url = resolveExact(s);
        if (url) return url;
      }
    }
  }

  // Absolute fallback: any available model.
  for (const s of ships) {
    const url = resolveExact(s);
    if (url) return url;
  }

  return null;
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
  // Ultimate fallback: any model in the encyclopedia.
  for (const s of encyclopedia) {
    const url = resolveExact(s);
    if (url) return url;
  }
  return null;
}

// ── GLTF loading ──────────────────────────────────────────────────────────

let _loader: GLTFLoader | null = null;
function getLoader(): GLTFLoader {
  if (!_loader) _loader = new GLTFLoader();
  return _loader;
}

export function loadGlbModel(url: string): Promise<THREE.Group> {
  console.log("[modelLoader] loading:", url);
  return new Promise((resolve, reject) => {
    getLoader().load(
      url,
      (gltf) => {
        console.log("[modelLoader] loaded:", url);
        resolve(gltf.scene);
      },
      undefined,
      (err) => {
        console.error("[modelLoader] failed:", url, err);
        reject(err);
      },
    );
  });
}

export function hasShipModels(): boolean {
  return shipCasedByLower.size > 0;
}

export function hasMapModels(): boolean {
  return mapCasedByLower.size > 0;
}
