/**
 * GLB model loading utilities for the holographic 3D scene.
 *
 * Ship and map models are pre-converted GLB files. Availability is discovered
 * two ways: the build-time glob over `src/res/models/{ships,maps,planes,
 * props}/*.glb` (the tracked publicDir copies — the GLBs themselves are
 * gitignored, so fresh checkouts glob EMPTY), and the runtime model pack the
 * Tauri shell downloads from GitHub Releases (`res-latest`) into
 * `%LOCALAPPDATA%/WoWSP/models/` on first launch. When the pack cache is
 * wired, URLs are constructed OPTIMISTICALLY for any stem — a build without
 * bundled GLBs must still serve models from the runtime cache; a stem the
 * pack doesn't have 404s into the per-ship fallback chain (substitute hull →
 * placeholder), exactly like any other load failure.
 *
 * MOBILE (phone app build): the pack ships inside the APK's assets, and the
 * webui build keeps the GLBs (WOWSP_MOBILE_BUNDLE=1 skips prune-baked-glb).
 * Startup wires the pack cache ONLY when a downloaded update is serving
 * (AppShell → res_cache_root); otherwise initModelPack stays unwired and
 * every URL below resolves SAME-ORIGIN (`/models/...`) straight out of the
 * read-only APK assets — the exact fallback the unwired state already
 * produces. `fetchModelResource`'s GLB-magic validation keeps the WebView's
 * SPA-fallback answers from poisoning loads there too.
 *
 * ## Skin → base model dedup
 * `src/data/ship_models.json` maps each shipId to a `baseName`.
 */

import shipModelNames from "../../data/ship_models.json";
import shipNamesDbRaw from "../../data/ship_names.json";
import shipDescriptionsDbRaw from "../../data/ship_descriptions.json";
import nationNamesDbRaw from "../../data/nation_names.json";
import { isTauri } from "@/utils/platform";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// ── Model-pack cache (populated by initModelPack) ───────────────────────
let _modelCacheRoot: string | null = null;
let _convertFileSrc: ((path: string) => string) | null = null;

/** Call once at startup to wire up the downloaded model pack.  Safe to call
 *  multiple times — only the first invocation actually fetches. */
export async function initModelPack(fetch: () => Promise<string>): Promise<void> {
  if (_modelCacheRoot) return;
  // Lazy-load convertFileSrc. The npm module resolves in plain browsers
  // too, but the call itself needs the Tauri internals — unwired here (null)
  // every URL below falls back to the same-origin /models/... paths, which
  // is exactly what `?mobileApp=1` browser emulation wants.
  try {
    const mod = await import("@tauri-apps/api/core");
    _convertFileSrc = isTauri() ? mod.convertFileSrc : null;
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

/** Whether the model-pack cache is wired up (initModelPack succeeded). */
export function isModelPackReady(): boolean {
  return _modelCacheRoot != null;
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
  hullModel: string | null;
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
  // The Tauri asset protocol also works under `tauri dev` (the vite origin
  // runs inside the tauri webview), and fetchModelResource prefers the pack
  // cache for asset URLs (the dist only carries the 2D subset since the
  // prune-baked-glb step) — so the embedded rung only wins for files the
  // cache lacks, which is exactly the desired precedence.
  if (cacheRoot && _convertFileSrc) {
    return _convertFileSrc(`${cacheRoot}/models/${kind}/${cased}.glb`);
  }
  return `/models/${kind}/${cased}.glb`;
}

/** Cache URL for a stem the build-time glob doesn't know, or null when the
 *  pack cache isn't wired (plain-browser dev) or the asset protocol is
 *  unavailable. The GLBs are gitignored, so builds from a fresh checkout glob
 *  an EMPTY directory even though the runtime model pack (downloaded by the
 *  shell, thousands of ships) sits fully populated — gating URL construction
 *  on the glob alone made every ship render the placeholder hull in such
 *  builds. Trusting the stem moves availability to runtime; a file the pack
 *  lacks simply 404s into the normal per-ship fallback. */
function optimisticCacheUrl(
  kind: "ships" | "maps" | "planes" | "props",
  stem: string,
): string | null {
  if (!_modelCacheRoot || !_convertFileSrc) return null;
  try {
    return toUrl(_modelCacheRoot, kind, stem);
  } catch {
    return null;
  }
}

function shipModelUrl(stem: string): string | null {
  const key = stem.toLowerCase();
  const cased = shipCasedByLower.get(key);
  return cased ? toUrl(_modelCacheRoot, "ships", cased) : optimisticCacheUrl("ships", stem);
}

function mapModelUrl(stem: string): string | null {
  const key = stem.toLowerCase();
  const cased = mapCasedByLower.get(key);
  return cased ? toUrl(_modelCacheRoot, "maps", cased) : optimisticCacheUrl("maps", stem);
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
  // GLB filenames are English stems — a localized display name (the
  // encyclopedia store overlays names per the data-language setting) never
  // matches. Try the offline DB's English name before giving up.
  const english = shipNameFromOfflineDb(shipId, "en-US");
  if (english) {
    const url = shipModelUrl(english);
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

/** URL of the game's own hull silhouette bitmap for a ship
 *  (gui/ships_silhouettes/<INDEX>.png, shipped under res/models/silhouettes).
 *  This is the exact in-game HP plaque art — no outline extraction. */
export function shipSilhouetteUrl(shipId: number | string | undefined): string | null {
  if (shipId == null) return null;
  const entry = shipModelMap[String(shipId)];
  const index = entry?.index;
  if (!index) return null;
  return "/models/silhouettes/" + index + ".png";
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

// ── Offline ship-description DB (zh zoo/formal split) ───────────────────
// `ship_descriptions.json` is produced by
// `scripts/model_convert/extract_ship_descriptions.py` from the game gettext
// catalogs. The WG encyclopedia API serves the same harmonized CN
// simplified-Chinese description (IJN ships as animals, Yamato = 鲸) on every
// realm; the 国服 zoo text and the 亚服 formal 简/繁 texts live ONLY in the
// client catalogs, so the Chinese trio is baked here for the overlay.

interface ShipDescriptionEntry {
  descriptions: Record<string, string>;
}
const shipDescriptionMap =
  (shipDescriptionsDbRaw as Record<string, ShipDescriptionEntry>) ?? {};

/** Localized ship description from the offline DB, EXACT language only —
 *  unlike shipNameFromOfflineDb there is no cross-language fallback: when the
 *  entry (or its translation for `lang`) is missing, null is returned and the
 *  caller keeps the WG API description, which is already language-appropriate
 *  (only the zh-CN/zh-SG/zh-TW realm split needs this overlay at all). */
export function shipDescriptionFromOfflineDb(
  shipId: number | string | undefined,
  lang?: string,
): string | null {
  if (shipId == null) return null;
  const entry = shipDescriptionMap[String(shipId)];
  const text = lang ? entry?.descriptions[lang] : undefined;
  return text ?? null;
}

/** Localized nation label from the baked game-file DB (nation_names.json,
 *  produced by scripts/model_convert/extract_nation_names.py). The WG API
 *  only returns nation codes; the display names follow the selected data
 *  language — including the 国服-only X-系 harmonized names (R系/M系/...)
 *  which no WG locale file carries. `nation` accepts both WG API codes
 *  ("uk", "ussr") and GameParams codes ("united_kingdom", "russia"); the DB
 *  bakes both spellings. Falls back en-US → null. */
export function nationNameFromDb(
  nation: string | undefined | null,
  lang?: string,
): string | null {
  if (!nation) return null;
  const key = nation.toLowerCase();
  const db = nationNamesDbRaw as Record<string, Record<string, string>>;
  for (const code of lang ? [lang, "en-US"] : ["en-US"]) {
    const label = db[code]?.[key];
    if (label) return label;
  }
  return null;
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
  return cased ? toUrl(_modelCacheRoot, "planes", cased) : optimisticCacheUrl("planes", index);
}

/** Shared projectile prop GLB ("shell" | "torpedo"), if baked. */
export function resolvePropModelUrl(name: "shell" | "torpedo"): string | null {
  const cased = propCasedByLower.get(name);
  return cased ? toUrl(_modelCacheRoot, "props", cased) : optimisticCacheUrl("props", name);
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
    _mapBoundsPromise = fetchModelResource(url)
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
    _silhouettesPromise = fetchModelResource(url)
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

/**
 * Fetch a model-pack resource with an automatic fallback to the embedded
 * copy. The pack ships twice: inside the binary (frontendDist, a 2D-only
 * snapshot served from the app origin at `/models/...`) and in the cache
 * directory (served via the asset protocol). The CACHE copy is the primary
 * source — it tracks the published (possibly updated) content-addressed
 * pack, and an older embedded snapshot must never shadow a newer cached
 * file (the pre-0.4 embedded-first order caused exactly that staleness).
 * The embedded copy stays the fallback: for files the cache does not carry
 * and for machines whose system proxy/PAC routes `*.localhost`
 * pseudo-hosts through the proxy (Clash-style PACs only bypass bare
 * `localhost`) — those failures surface as raw "Failed to fetch"
 * TypeErrors; non-ok responses cover an incomplete cache.
 *
 * A miss can never be detected via the status code alone: Tauri's asset
 * resolver answers ANY unknown frontendDist path with the index.html SPA
 * fallback under HTTP 200 (`get_asset`'s `{path}.html` → `{path}/index.html`
 * → `index.html` ladder). The dist hasn't carried the GLBs since the
 * prune-baked-glb build step, so every embedded rung (and every plain
 * `/models/...` URL built while the pack cache is unwired) "succeeds" with
 * the app's own HTML — which then dies inside GLTFLoader as
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`. Each candidate
 * is therefore validated by its payload before it counts as a hit (GLB
 * magic / JSON value start / non-HTML), and anything else — a non-2xx, a
 * poisoned 200, or a transport-level failure — falls through to the next
 * candidate instead of poisoning the caller.
 */
function payloadMatches(url: string, resp: Response, bytes: ArrayBuffer): boolean {
  // Order matters: Tauri's asset protocol labels REAL .glb files text/html
  // (its mime table has no .glb entry and the content sniff can't match one
  // either, so the Html fallback kicks in), so the content-type gate must
  // only arbitrate extensions whose payload we cannot sniff ourselves.
  const path = (decodeURIComponent(url).split(/[?#]/)[0] ?? url).toLowerCase();
  if (path.endsWith(".glb")) {
    if (bytes.byteLength < 4) return false;
    const head = new Uint8Array(bytes, 0, 4);
    // "glTF" — the binary container magic every baked model starts with.
    return head[0] === 0x67 && head[1] === 0x6c && head[2] === 0x54 && head[3] === 0x46;
  }
  if (path.endsWith(".json")) {
    const head = new TextDecoder().decode(bytes.slice(0, 64));
    return /^\s*[[{]/.test(head);
  }
  return !(resp.headers.get("content-type") ?? "").includes("text/html");
}

/** One fetch attempt: a validated hit, or the human-readable reason it
 *  missed (status / SPA fallback / transport error) for the caller to log
 *  and step past. */
async function fetchCandidate(
  url: string,
): Promise<{ resp: Response; bytes: ArrayBuffer } | string> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return `HTTP ${resp.status} fetching ${url}`;
    const bytes = await resp.arrayBuffer();
    if (!payloadMatches(url, resp, bytes)) {
      return `${url}: missing file answered by the index.html SPA fallback`;
    }
    return { resp, bytes };
  } catch (e) {
    return `${url}: ${(e as Error).message ?? String(e)}`;
  }
}

export async function fetchModelResource(url: string): Promise<Response> {
  const isAsset = url.startsWith("http://asset.localhost/");
  // The asset URL is percent-encoded (backslashes and slashes alike), so
  // the cache-relative tail must be recovered from the DECODED form.
  const embedded = isAsset
    ? "/models/" + (decodeURIComponent(url).split("/models/")[1] ?? "")
    : url;
  const candidates = isAsset ? [url, embedded] : [url];
  const misses: string[] = [];
  for (const candidate of candidates) {
    const attempt = await fetchCandidate(candidate);
    if (typeof attempt !== "string") {
      return new Response(attempt.bytes, {
        status: attempt.resp.status,
        headers: attempt.resp.headers,
      });
    }
    misses.push(attempt);
    console.warn(`[modelLoader] ${attempt}, trying next source`);
  }
  throw new Error(`no usable source for ${url} (${misses.join("; ")})`);
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
  return fetchModelResource(url)
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
