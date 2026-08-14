/**
 * GLB model loading utilities for the holographic 3D scene.
 *
 * Ship and map models are pre-converted GLB files placed under
 * `src/res/models/ships/` and `src/res/models/maps/` (Vite's publicDir).
 * Model availability is discovered lazily: we only collect filenames from
 * glob keys without eagerly importing hundreds of binary assets.
 *
 * In production the Tauri shell downloads the latest model pack from GitHub
 * Releases (tag `res-latest`) on first launch and caches it under
 * `%LOCALAPPDATA%/WoWSP/models/`.  When the cache is available, models are
 * served via `convertFileSrc`; during development (or when the download hasn't
 * completed yet), publicDir paths are used as a fallback.
 *
 * ## Skin → base model dedup
 * `src/data/ship_models.json` maps each shipId to a `baseName`.
 */

import shipModelNames from "../../data/ship_models.json";
import shipNamesDbRaw from "../../data/ship_names.json";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// ── Model-pack cache (populated by initModelPack) ───────────────────────
let _modelCacheRoot: string | null = null;
let _convertFileSrc: ((path: string) => string) | null = null;

/** Call once at startup to wire up the downloaded model pack.  Safe to call
 *  multiple times — only the first invocation actually fetches. */
export async function initModelPack(fetch: () => Promise<string>): Promise<void> {
  if (_modelCacheRoot) return;
  // Lazy-load convertFileSrc — only available in Tauri context.
  try {
    const mod = await import("@tauri-apps/api/core");
    _convertFileSrc = mod.convertFileSrc;
  } catch {
    _convertFileSrc = null;
  }
  try {
    _modelCacheRoot = await fetch();
    console.log("[modelLoader] using cache:", _modelCacheRoot);
  } catch {
    console.warn("[modelLoader] model pack unavailable, falling back to publicDir");
  }
}

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

// ── Plane model availability (keyed by GameParams index, e.g. PJAF206) ───
const _planeGlobKeys = Object.keys(
  import.meta.glob("../../res/models/planes/*.glb"),
);
const planeCasedByLower = new Map<string, string>();
for (const path of _planeGlobKeys) {
  const original = path.split("/").pop()!.replace(/\.glb$/i, "");
  planeCasedByLower.set(original.toLowerCase(), original);
}

// ── Shared projectile props (shell, torpedo) ─────────────────────────────
const _propGlobKeys = Object.keys(
  import.meta.glob("../../res/models/props/*.glb"),
);
const propCasedByLower = new Map<string, string>();
for (const path of _propGlobKeys) {
  const original = path.split("/").pop()!.replace(/\.glb$/i, "");
  propCasedByLower.set(original.toLowerCase(), original);
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
// When the model-pack cache is available, serve via convertFileSrc; otherwise
// fall back to publicDir paths.

function toUrl(
  cacheRoot: string | null,
  kind: "ships" | "maps" | "planes" | "props",
  cased: string,
): string {
  // In dev mode Vite serves models via publicDir; convertFileSrc only works
  // in production where the webview origin is tauri://localhost.
  if (!import.meta.env.DEV && cacheRoot && _convertFileSrc) {
    return _convertFileSrc(`${cacheRoot}/models/${kind}/${cased}.glb`);
  }
  return `/models/${kind}/${cased}.glb`;
}

function shipModelUrl(stem: string): string | null {
  const key = stem.toLowerCase();
  const cased = shipCasedByLower.get(key);
  return cased ? toUrl(_modelCacheRoot, "ships", cased) : null;
}

function mapModelUrl(stem: string): string | null {
  const key = stem.toLowerCase();
  const cased = mapCasedByLower.get(key);
  return cased ? toUrl(_modelCacheRoot, "maps", cased) : null;
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
    if (entry?.index) {
      const url = shipModelUrl(entry.index);
      if (url) return url;
    }
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

/** Ship display name from the baked model DB (ship_models.json). `baseName`
 *  is the English ship name for most entries; entries whose base is just the
 *  WG index code (e.g. "PRSC709", "PASA026640") yield null. Last-resort
 *  ship-name fallback when the encyclopedia lacks the ship (event/premium
 *  ships, offline mock). */
export function shipNameFromModelDb(shipId: number | string | undefined): string | null {
  if (shipId == null) return null;
  const entry = shipModelMap[String(shipId)];
  const base = entry?.baseName?.trim();
  if (!base || base === entry?.index || /^P[A-Z]{3}\d{3,6}$/.test(base)) return null;
  return base;
}

/** Cased model filename stem for a ship (the key used by silhouettes.json).
 *  Tries the WG index then the baseName, matching the GLB filename on disk. */
export function shipModelStem(
  shipId: number | string | undefined,
  fallbackName?: string,
): string | null {
  if (shipId != null) {
    const entry = shipModelMap[String(shipId)];
    for (const cand of [entry?.index, entry?.baseName]) {
      if (!cand) continue;
      const cased = shipCasedByLower.get(cand.toLowerCase());
      if (cased) return cased;
    }
  }
  if (fallbackName) {
    const cased = shipCasedByLower.get(fallbackName.toLowerCase());
    if (cased) return cased;
  }
  return null;
}

// ── Offline ship-name DB (GameParams + game gettext catalogs) ───────────
// `ship_names.json` covers EVERY ship (incl. event/clone ships the WG
// encyclopedia misses) with localized names per WG language code, produced
// by `scripts/model_convert/extract_ship_names.py`.

interface ShipNameEntry {
  index: string;
  tier?: number | null;
  type?: string | null;
  nation?: string | null;
  /** Max hull HP across upgrade modules (GameParams), when available. */
  hp?: number | null;
  names: Record<string, string>;
}
const shipNameMap =
  (shipNamesDbRaw as Record<string, ShipNameEntry>) ?? {};

/** Full offline DB entry for a shipId, if present. */
export function shipOfflineEntry(
  shipId: number | string | undefined,
): ShipNameEntry | null {
  if (shipId == null) return null;
  return shipNameMap[String(shipId)] ?? null;
}

/** Localized ship name from the complete offline DB. `lang` is the WG
 *  language code ("zh-cn", "zh-sg", "en", ...); falls back to English. */
export function shipNameFromOfflineDb(
  shipId: number | string | undefined,
  lang?: string,
): string | null {
  const entry = shipOfflineEntry(shipId);
  if (!entry) return null;
  if (lang && entry.names[lang]) return entry.names[lang];
  const values = Object.values(entry.names);
  return entry.names["en"] ?? (values.length > 0 ? values[0] : null);
}

export function resolveMapModelUrl(spaceId: string | undefined): string | null {
  if (!spaceId) return null;
  const clean = spaceId.replace(/^spaces\//, "").toLowerCase();
  return mapModelUrl(clean);
}

/** Plane model GLB by GameParams index (e.g. "PJAF206"), if baked. */
export function resolvePlaneModelUrl(index: string | undefined): string | null {
  if (!index) return null;
  const cased = planeCasedByLower.get(index.toLowerCase());
  return cased ? toUrl(_modelCacheRoot, "planes", cased) : null;
}

/** Shared projectile prop GLB ("shell" | "torpedo"), if baked. */
export function resolvePropModelUrl(name: "shell" | "torpedo"): string | null {
  const cased = propCasedByLower.get(name);
  return cased ? toUrl(_modelCacheRoot, "props", cased) : null;
}

// ── Minimap base art (game minimap composite) + world bounds ────────────
// `minimaps/<spaceId>.png` is the water+land composite the game itself draws
// on the in-battle minimap; `minimaps.json` carries each map's world bounds
// (space.settings chunks x100 — the same coordinate frame as replay entity
// positions and the baked terrain GLBs). Both are produced by
// `scripts/model_convert/extract_minimaps.py`.

export interface MapBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const _minimapGlobKeys = Object.keys(
  import.meta.glob("../../res/models/maps/minimaps/*.png"),
);
const minimapCasedByLower = new Map<string, string>();
for (const path of _minimapGlobKeys) {
  const original = path.split("/").pop()!.replace(/\.png$/i, "");
  minimapCasedByLower.set(original.toLowerCase(), original);
}

/** URL of the game's own minimap art for a space id, if extracted. */
export function resolveMapMinimapUrl(spaceId: string | undefined): string | null {
  if (!spaceId) return null;
  const clean = spaceId.replace(/^spaces\//, "").toLowerCase();
  const cased = minimapCasedByLower.get(clean);
  if (!cased) return null;
  if (!import.meta.env.DEV && _modelCacheRoot && _convertFileSrc) {
    return _convertFileSrc(`${_modelCacheRoot}/models/maps/minimaps/${cased}.png`);
  }
  return `/models/maps/minimaps/${cased}.png`;
}

let _mapBoundsPromise: Promise<Map<string, MapBounds>> | null = null;

/** Lazy-load `minimaps.json` (space id → world bounds). Missing file or
 *  parse failure yields an empty map — callers fall back to data bounds. */
export function loadMapBounds(): Promise<Map<string, MapBounds>> {
  if (!_mapBoundsPromise) {
    const url =
      !import.meta.env.DEV && _modelCacheRoot && _convertFileSrc
        ? _convertFileSrc(`${_modelCacheRoot}/models/maps/minimaps.json`)
        : "/models/maps/minimaps.json";
    _mapBoundsPromise = fetch(url)
      .then((r) => (r.ok ? r.json() : {}))
      .then((j) => new Map(Object.entries(j) as [string, MapBounds][]))
      .catch(() => new Map<string, MapBounds>());
  }
  return _mapBoundsPromise;
}

let _silhouettesPromise: Promise<Record<string, { path: string }>> | null = null;

/** Lazy-load the hull silhouettes (keyed by the GLB filename). In production
 *  these come from the downloaded model pack, not the bundled publicDir. */
export function loadSilhouettes(): Promise<Record<string, { path: string }>> {
  if (!_silhouettesPromise) {
    const url =
      !import.meta.env.DEV && _modelCacheRoot && _convertFileSrc
        ? _convertFileSrc(_modelCacheRoot + "/models/silhouettes.json")
        : "/models/silhouettes.json";
    _silhouettesPromise = fetch(url)
      .then((r) => (r.ok ? r.json() : {}))
      .then((j) => j as Record<string, { path: string }>)
      .catch(() => ({} as Record<string, { path: string }>));
  }
  return _silhouettesPromise;
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
  const type = spec.type?.toLowerCase();

  // Pool = encyclopedia ships + the offline DB (covers event/clone ships the
  // encyclopedia misses). A model URL only exists for shipIds that ship_models
  // knows, so candidates that resolveExact can't find are simply skipped.
  const pool: ShipModelSpec[] = [...ships];
  const seen = new Set<number>();
  for (const s of ships) seen.add(s.shipId);
  for (const [sidStr, e] of Object.entries(shipNameMap)) {
    const sid = Number(sidStr);
    if (!Number.isFinite(sid) || seen.has(sid)) continue;
    pool.push({ shipId: sid, tier: e.tier, nation: e.nation, type: e.type });
  }
  const match = (t: number | null | undefined, n: string | null | undefined, ty: string | null | undefined) =>
    pool.filter(
      (s) =>
        (t == null || s.tier === t) &&
        (n == null || s.nation?.toLowerCase() === n) &&
        (ty == null || s.type?.toLowerCase() === ty),
    );
  const firstUrl = (list: ShipModelSpec[]): string | null => {
    for (const s of list) {
      const url = resolveExact(s);
      if (url) return url;
    }
    return null;
  };

  // 1. Same class, nearby tier (±1).
  if (tier != null && type) {
    const nearby = match(tier, null, type);
    const url = firstUrl(
      nearby.sort((a, b) => Math.abs((a.tier ?? 99) - tier) - Math.abs((b.tier ?? 99) - tier)),
    );
    if (url) return url;
  }
  // 2. Same class, any tier.
  if (type) {
    const url = firstUrl(match(null, null, type));
    if (url) return url;
  }
  // 3. USA tier-8 ship of the same class.
  if (type) {
    const url = firstUrl(match(8, "usa", type));
    if (url) return url;
  }
  // 4. Absolute fallback: USA tier-8 cruiser.
  return firstUrl(match(8, "usa", "cruiser"));
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
// Some baked GLBs have NUL-byte (0x00) JSON-chunk padding instead of the
// spec-mandated 0x20 (space).  fetch + fix the buffer before handing it to
// GLTFLoader so all generated models load regardless.

let _loader: GLTFLoader | null = null;
function getLoader(): GLTFLoader {
  if (!_loader) _loader = new GLTFLoader();
  return _loader;
}

function fixGlbPadding(buffer: ArrayBuffer): ArrayBuffer {
  const view = new DataView(buffer);
  if (buffer.byteLength < 20) return buffer;
  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
  );
  if (magic !== "glTF") return buffer;

  // JSON chunk starts at offset 12: 4B length + 4B type
  const jsonLen = view.getUint32(12, true);
  const jsonStart = 20;
  const jsonEnd = jsonStart + jsonLen;

  // Replace trailing NUL bytes in the JSON chunk with spaces (0x20).
  const bytes = new Uint8Array(buffer);
  let fixed = false;
  for (let i = jsonEnd - 1; i >= jsonStart && bytes[i] === 0; i--) {
    bytes[i] = 0x20; // space
    fixed = true;
  }
  if (fixed) console.log("[modelLoader] fixed GLB JSON-chunk NUL padding");
  return buffer;
}

export function loadGlbModel(url: string): Promise<THREE.Group> {
  console.log("[modelLoader] loading:", url);
  return fetch(url)
    .then((resp) => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
      return resp.arrayBuffer();
    })
    .then((raw) => {
      const fixed = fixGlbPadding(raw);
      const blob = new Blob([fixed], { type: "model/gltf-binary" });
      const blobUrl = URL.createObjectURL(blob);
      return new Promise<THREE.Group>((resolve, reject) => {
        getLoader().load(
          blobUrl,
          (gltf) => {
            URL.revokeObjectURL(blobUrl);
            console.log("[modelLoader] loaded:", url);
            resolve(gltf.scene);
          },
          undefined,
          (err) => {
            URL.revokeObjectURL(blobUrl);
            console.error("[modelLoader] failed:", url, err);
            reject(err);
          },
        );
      });
    });
}

export function hasShipModels(): boolean {
  return shipCasedByLower.size > 0;
}

export function hasMapModels(): boolean {
  return mapCasedByLower.size > 0;
}
