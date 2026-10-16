/**
 * Res-pack insights rail loaders: the FULL map-insights corpus and the
 * contributors list.
 *
 * The webui bundles only the lite companions (`@/res/map-insights.json`
 * and `@/res/contributors.json` — the tracked placeholders the corpus CLI
 * overwrites per release): the full corpus doc's 96×96 heat grids dwarf
 * everything else and serve no bundled purpose, so they ride the
 * content-addressed resource pack instead (`insights/` — the optional
 * third tree next to `models/` + `dogtags`, published by
 * scripts/release_models.py). A res-pack update then refreshes this data
 * WITHOUT an app release.
 *
 * Serving precedence, the loadMapBounds pattern: once the pack cache root
 * is wired (modelLoader's initModelPack calls wireInsightsPack), read
 * `<cacheRoot>/insights/<name>` through the Tauri asset protocol; on any
 * miss — unwired cache, pack without the insights tree, transport error,
 * or a payload that fails shape validation — fall back to the bundled
 * import. Dev never reads the pack (straight to the bundled doc, like
 * every other pack-aware loader's dev rung). Packs and installs without
 * the optional tree behave exactly as before.
 *
 * This module is deliberately three.js-free (unlike modelLoader.ts) so
 * settings-surface consumers can import the contributors loader without
 * dragging the 3D engine into their chunk.
 */
import bundledInsightsDoc from "@/res/map-insights.json";
import bundledContributorsDoc from "@/res/contributors.json";

// ── Pack wiring (set by modelLoader's initModelPack) ─────────────────────
let _convertFileSrc: ((path: string) => string) | null = null;
let _packRoot: string | null = null;

/** Wire the pack cache root for the insights rail. Called by
 *  modelLoader.initModelPack on success — the rail rides the same pack and
 *  the same startup wiring; unwired means "bundled fallback only". */
export function wireInsightsPack(
  convertFileSrc: ((path: string) => string) | null,
  root: string | null,
): void {
  _convertFileSrc = convertFileSrc;
  _packRoot = root;
}

/** Asset-protocol URL of one file under the pack's insights tree, or null
 *  when the pack cache is unwired (dev / plain browser / mobile bundle) —
 *  the caller then uses the bundled doc. */
function packInsightsUrl(name: string): string | null {
  if (import.meta.env.DEV || !_packRoot || !_convertFileSrc) return null;
  try {
    return _convertFileSrc(`${_packRoot}/insights/${name}`);
  } catch {
    return null;
  }
}

/** Fetch + parse one insights JSON from the pack; null on any miss (the
 *  caller falls back to the bundled doc). */
async function fetchPackJson(url: string): Promise<unknown> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return (await resp.json()) as unknown;
  } catch {
    return null;
  }
}

// ── The map-insights corpus doc ──────────────────────────────────────────

/** One cap observation of a corpus layout — the same shape the api's
 *  LearnedCapPoint carries (the corpus rows apply through the identical
 *  learned-layout path). */
export interface InsightsCapPoint {
  index: number;
  x: number;
  z: number;
  radius: number | null;
  team: number | null;
  appearT: number | null;
}

/** One 96×96 heat grid of the FULL corpus doc (the lite companion drops
 *  both). `bounds` is `[minX, minZ, maxX, maxZ]` — the observed coordinate
 *  extent the grid was binned over. */
export interface InsightsHeatGrid {
  bounds: [number, number, number, number];
  grid: number[][];
}

/** One (map, mode) row: the lite keys always present, the heat grids only
 *  in the full pack doc (optional — the bundled lite doc omits them). */
export interface InsightsModeRow {
  battleCount: number;
  capsSample: number;
  caps: InsightsCapPoint[];
  spawnHeat?: InsightsHeatGrid;
  trackHeat?: InsightsHeatGrid;
}

/** The map-insights envelope — a typed superset of the bundled lite doc
 *  (`version`/`generatedAt`/`unparsed`/`maps`; the placeholder's
 *  `generatedAt` is null, the corpus's is an RFC3339 stamp). */
export interface MapInsightsDoc {
  version: number;
  generatedAt: string | null;
  unparsed: number;
  maps: Record<string, { modes: Record<string, InsightsModeRow> }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Shape gate for a pack-sourced doc: the envelope plus every mode row's
 *  lite keys (what the consumers read) must hold; the heat grids are
 *  optional passthrough. Anything else falls back to the bundled doc. */
function isMapInsightsDoc(v: unknown): v is MapInsightsDoc {
  if (!isRecord(v)) return false;
  if (typeof v.version !== "number" || typeof v.unparsed !== "number") return false;
  if (v.generatedAt !== null && typeof v.generatedAt !== "string") return false;
  if (!isRecord(v.maps)) return false;
  for (const map of Object.values(v.maps)) {
    if (!isRecord(map) || !isRecord(map.modes)) return false;
    for (const mode of Object.values(map.modes)) {
      if (
        !isRecord(mode) ||
        typeof mode.battleCount !== "number" ||
        typeof mode.capsSample !== "number" ||
        !Array.isArray(mode.caps)
      ) {
        return false;
      }
    }
  }
  return true;
}

/** The bundled lite doc (the checked-in placeholder, or the corpus CLI's
 *  `-lite` companion once a release overwrites it) — the fallback every
 *  miss lands on. */
const BUNDLED_INSIGHTS = bundledInsightsDoc as MapInsightsDoc;

let _mapInsightsPromise: Promise<MapInsightsDoc> | null = null;

/** Lazy-load the map-insights corpus: the pack's FULL doc when the cache
 *  root is wired and the file is present and well-shaped, else the bundled
 *  lite doc. Cached like loadMapBounds (first call wins — call after the
 *  startup pack wiring, which every surface does). */
export function loadMapInsights(): Promise<MapInsightsDoc> {
  if (!_mapInsightsPromise) {
    _mapInsightsPromise = (async () => {
      const url = packInsightsUrl("map-insights.json");
      if (url) {
        const doc = await fetchPackJson(url);
        if (doc !== null && isMapInsightsDoc(doc)) return doc;
      }
      return BUNDLED_INSIGHTS;
    })();
  }
  return _mapInsightsPromise;
}

// ── The contributors doc ─────────────────────────────────────────────────

/** One row of the contributors list (contract §10 — `replay-drain credits`
 *  refreshes it; the placeholder ships empty). */
export interface ContributorEntry {
  name: string;
  realm: string;
  count: number;
}

export interface ContributorsDoc {
  version: number;
  generatedAt: string | null;
  contributors: ContributorEntry[];
}

function isContributorsDoc(v: unknown): v is ContributorsDoc {
  if (!isRecord(v)) return false;
  if (typeof v.version !== "number" || !Array.isArray(v.contributors)) return false;
  if (v.generatedAt !== null && typeof v.generatedAt !== "string") return false;
  return v.contributors.every(
    (c) =>
      isRecord(c) &&
      typeof c.name === "string" &&
      typeof c.realm === "string" &&
      typeof c.count === "number",
  );
}

const BUNDLED_CONTRIBUTORS = bundledContributorsDoc as ContributorsDoc;

let _contributorsPromise: Promise<ContributorsDoc> | null = null;

/** Lazy-load the contributors list: the pack's refreshed envelope when
 *  available, else the bundled placeholder (empty ⇒ exactly the pre-rail
 *  UI). Same cached-promise pattern as loadMapInsights. */
export function loadContributors(): Promise<ContributorsDoc> {
  if (!_contributorsPromise) {
    _contributorsPromise = (async () => {
      const url = packInsightsUrl("contributors.json");
      if (url) {
        const doc = await fetchPackJson(url);
        if (doc !== null && isContributorsDoc(doc)) return doc;
      }
      return BUNDLED_CONTRIBUTORS;
    })();
  }
  return _contributorsPromise;
}
