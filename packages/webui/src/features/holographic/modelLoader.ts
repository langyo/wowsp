/**
 * GLB model loading utilities for the holographic 3D scene.
 *
 * Ship and map models are pre-converted GLB files placed under
 * `src/res/models/ships/` and `src/res/models/maps/` (Vite's publicDir).
 * Model availability is discovered at build time via import.meta.glob; the
 * resolved URLs are used directly so Vite handles dev/prod URL mapping.
 *
 * ## Skin → base model dedup
 * `src/data/ship_models.json` maps each shipId to a `baseName`.
 */

import shipModelNames from "../../data/ship_models.json";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// ── Ship model URLs (stem → Vite-resolved URL) ──────────────────────────
const _shipGlob = import.meta.glob("../../res/models/ships/*.glb", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

const shipUrlByStem = new Map<string, string>();
for (const [path, url] of Object.entries(_shipGlob)) {
  const stem = path.split("/").pop()!.replace(/\.glb$/i, "").toLowerCase();
  shipUrlByStem.set(stem, url);
}

// ── Map model URLs ───────────────────────────────────────────────────────
const _mapGlob = import.meta.glob("../../res/models/maps/*.glb", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

const mapUrlByStem = new Map<string, string>();
for (const [path, url] of Object.entries(_mapGlob)) {
  const stem = path.split("/").pop()!.replace(/\.glb$/i, "").toLowerCase();
  mapUrlByStem.set(stem, url);
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

function shipModelUrl(stem: string): string | null {
  return shipUrlByStem.get(stem.toLowerCase()) ?? null;
}

function mapModelUrl(stem: string): string | null {
  return mapUrlByStem.get(stem.toLowerCase()) ?? null;
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
  return shipUrlByStem.size > 0;
}

export function hasMapModels(): boolean {
  return mapUrlByStem.size > 0;
}
