/**
 * In-app resource-health diagnostic for the 3D replay view.
 *
 * The replay scene has ONE external dependency (the downloaded resource
 * pack) and several ways for it to disappear underneath a running app:
 * a cleanup agent prunes the cache, the pack moves, an ACL/permission
 * change breaks the Tauri asset protocol, the config loses the cache root,
 * or the pack predates the current map. Every one of those used to present
 * identically — a silent empty scene with placeholder cones.
 *
 * This module runs the CHECK CHAIN end to end and turns each link into one
 * report row:
 *
 *   1. res_cache_root — the RPC the loader itself calls (null/Some + path).
 *   2. asset protocol reachability — fetch(convertFileSrc(cacheRoot +
 *      "/.res-version.json")) built with the loader's OWN URL construction:
 *      one probe that exercises protocol + scope + file existence at once.
 *   3. pack population — the .res-version stamp, how many roster hulls are
 *      actually reachable, and the minimaps index entry count (the asset
 *      protocol cannot list directories; the roster + index stand in for a
 *      directory walk), next to the build-time bundled glob counts.
 *   4. this replay's map assets — minimaps.json exists AND carries the
 *      current replay's mapId, and the map GLB probe succeeds.
 *   5. per-roster-ship models — each roster ship's expected GLB name (the
 *      loader's cased-name rule, through shipModelUrlCandidates) probed with
 *      bounded concurrency; the missing list carries ship names.
 *   6. session load failures — the model loader's aggregated per-ship
 *      failures this session, with their last error.
 *
 * Classification: a cache miss that the embedded same-origin copy covers is
 * "fallback" (yellow) — that is an EXPECTED setup (the embedded pack serves
 * files the cache lacks), not a failure. Only BOTH sources missing is a
 * fail. Browser-only dev sessions (no Tauri shell) report the environment
 * state instead of pretending the pack exists; the embedded paths are still
 * probed so the chain works there too.
 *
 * The report is module state (a shallowRef) because the dev stats HUD is its
 * own Vue app (perfHud.ts) while the replay view owns the context. The HUD
 * gains a 资源 tab; the checks run AUTOMATICALLY once when a replay view
 * opens IF any ship model failed to load this session, so the silent-scene
 * case self-reports without anyone opening the HUD.
 */
import { ref, shallowRef, type Ref } from "vue";

import { resPackApi } from "@/api/modules/respack";
import { isNative } from "@/utils/platform";

import {
  bundledModelCounts,
  getShipModelLoadFailures,
  modelFileFromUrl,
  modelPackWiring,
  packFileUrl,
  resolveMapBoundsUrl,
  resolveMapModelUrl,
  shipModelUrlCandidates,
  subscribeShipModelLoadFailures,
  type ModelLoadFailure,
} from "./modelLoader";

/** Roster probes are capped: a large roster (and the candidate chain per
 *  ship) must never turn one diagnostic pass into a request storm. */
export const RESOURCE_HEALTH_MAX_SHIPS = 24;
/** Concurrent roster-ship probes (bounded, independent of the cap). */
export const RESOURCE_HEALTH_SHIP_CONCURRENCY = 6;
/** Candidates walked per ship — the loader's full chain is index → baseName
 *  → display name → offline-DB English name → CLR-stripped base (6 at most,
 *  already deduped). The bound only stops a pathological chain from turning
 *  one ship into an unbounded request run. */
export const RESOURCE_HEALTH_MAX_CANDIDATES = 6;
/** Per-request cap so a hung asset-protocol fetch cannot wedge the check. */
export const RESOURCE_HEALTH_PROBE_TIMEOUT_MS = 6000;

export type ResourceCheckId =
  | "cacheRoot"
  | "assetProtocol"
  | "pack"
  | "replayMap"
  | "shipModels"
  | "sessionFailures";

/** pass = green, fail = red, fallback = yellow (cache miss covered by the
 *  embedded copy, or a partial pack), info = neutral environment note. */
export type ResourceCheckStatus = "pass" | "fail" | "fallback" | "info";

export interface ResourceCheck {
  id: ResourceCheckId;
  status: ResourceCheckStatus;
  /** Paths / URLs / counts — deliberately not translated. */
  detail: string;
  /** Extra technical lines (e.g. the missing model files). */
  extra?: string[];
}

export interface ResourceHealthReport {
  ranAt: number;
  /** "browser" means no Tauri shell — the embedded /models/ paths serve. */
  environment: "tauri" | "browser";
  /** The replay map id the report was taken for ("" when unavailable). */
  mapId: string;
  checks: ResourceCheck[];
  /** Roster ships whose expected GLB missed in BOTH the cache and the
   *  embedded copy, as "stem(display name)". */
  missingShips: string[];
  /** Roster ships served by the embedded copy instead of the cache. */
  fallbackShips: string[];
}

/** One roster ship handed in by the replay view. */
export interface ReplayResourceShip {
  shipId: number | null;
  /** Display name shown in the report (roster ship name). */
  name: string;
  /** The loader's display-name fallback stem (roster's pre-resolved name). */
  fallbackName?: string | null;
}

/** The current replay view's inputs for checks 4/5. */
export interface ReplayResourceContext {
  mapId: string;
  /** Distinguishes two opens of the same map/roster (auto-run is per view). */
  replayPath?: string;
  ships: ReplayResourceShip[];
}

/** Injectable seams for tests (and for callers that already resolved a
 *  value): production leaves every field undefined and the live loader /
 *  RPC / platform are used. */
export interface ResourceHealthProbeOverrides {
  isTauri?: boolean;
  convertFileSrc?: ((path: string) => string) | null;
  cacheRoot?: string | null;
  resCacheRoot?: () => Promise<string | null>;
  fetch?: FetchLike;
  shipCandidates?: (
    shipId: number | string | null | undefined,
    fallbackName?: string,
  ) => string[];
  mapModelUrl?: (mapId: string) => string | null;
  minimapJsonUrl?: () => string;
  modelFileFromUrl?: (url: string) => string;
  sessionFailures?: () => readonly ModelLoadFailure[];
  bundledCounts?: () => { ships: number; maps: number };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface ProbeEnvironment {
  isTauri: boolean;
  convertFileSrc: ((path: string) => string) | null;
  cacheRoot: string | null;
  resCacheRoot: () => Promise<string | null>;
  fetch: FetchLike;
  shipCandidates: (
    shipId: number | string | null | undefined,
    fallbackName?: string,
  ) => string[];
  mapModelUrl: (mapId: string) => string | null;
  minimapJsonUrl: () => string;
  modelFileFromUrl: (url: string) => string;
  sessionFailures: () => readonly ModelLoadFailure[];
  bundledCounts: () => { ships: number; maps: number };
  /** Loader-form asset URL for a pack-relative file under `root`. */
  packUrl: (relPath: string, root: string | null) => string | null;
}

/** Build the probe environment from the live loader + RPC unless a test
 *  injects an override. */
function createProbeEnvironment(
  overrides: ResourceHealthProbeOverrides,
): ProbeEnvironment {
  const wiring = modelPackWiring();
  const convertFileSrc =
    overrides.convertFileSrc !== undefined
      ? overrides.convertFileSrc
      : wiring.convertFileSrc;
  const cacheRoot =
    overrides.cacheRoot !== undefined ? overrides.cacheRoot : wiring.cacheRoot;
  return {
    isTauri: overrides.isTauri ?? isNative(),
    convertFileSrc,
    cacheRoot,
    resCacheRoot: overrides.resCacheRoot ?? (() => resPackApi.resCacheRoot()),
    fetch: overrides.fetch ?? ((input, init) => fetch(input, init)),
    shipCandidates:
      overrides.shipCandidates ??
      ((shipId, fallbackName) =>
        shipModelUrlCandidates(shipId ?? undefined, fallbackName)),
    mapModelUrl: overrides.mapModelUrl ?? resolveMapModelUrl,
    minimapJsonUrl: overrides.minimapJsonUrl ?? resolveMapBoundsUrl,
    modelFileFromUrl: overrides.modelFileFromUrl ?? modelFileFromUrl,
    sessionFailures: overrides.sessionFailures ?? getShipModelLoadFailures,
    bundledCounts:
      overrides.bundledCounts ??
      (() => {
        const counts = bundledModelCounts();
        return { ships: counts.ships, maps: counts.maps };
      }),
    packUrl: (relPath, root) =>
      root && convertFileSrc
        ? packFileUrl(relPath, { cacheRoot: root, convertFileSrc })
        : null,
  };
}

// ── Probe primitives ────────────────────────────────────────────────────

type ProbeKind = "glb" | "json";

interface ProbeOutcome {
  ok: boolean;
  status?: number;
  /** Human-readable outcome (status + payload shape / transport error). */
  detail: string;
  /** Parsed JSON for kind "json" on success. */
  json?: unknown;
}

function errorMessage(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}

function displayUrl(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

function hasGlbMagic(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 4) return false;
  const head = new Uint8Array(bytes, 0, 4);
  return (
    head[0] === 0x67 && // g
    head[1] === 0x6c && // l
    head[2] === 0x54 && // T
    head[3] === 0x46 // F
  );
}

/** One plain fetch probe, validated by payload exactly like the loader
 *  (a .glb must carry the glTF magic; a .json must parse — an HTML SPA
 *  fallback under HTTP 200 is a MISS, not a hit). */
async function probeUrl(
  fetchImpl: FetchLike,
  url: string,
  kind: ProbeKind,
): Promise<ProbeOutcome> {
  const controller =
    typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), RESOURCE_HEALTH_PROBE_TIMEOUT_MS)
    : null;
  try {
    const resp = await fetchImpl(
      url,
      controller ? { signal: controller.signal } : undefined,
    );
    if (!resp.ok) {
      return { ok: false, status: resp.status, detail: `HTTP ${resp.status}` };
    }
    const bytes = await resp.arrayBuffer();
    if (kind === "glb") {
      if (!hasGlbMagic(bytes)) {
        return {
          ok: false,
          status: resp.status,
          detail: `HTTP ${resp.status} but the payload is not a GLB (no glTF magic)`,
        };
      }
      return {
        ok: true,
        status: resp.status,
        detail: `HTTP ${resp.status} (glTF, ${bytes.byteLength} B)`,
      };
    }
    let text = "";
    try {
      text = new TextDecoder().decode(bytes);
    } catch {
      return {
        ok: false,
        status: resp.status,
        detail: `HTTP ${resp.status} but the payload is not decodable text`,
      };
    }
    if (!/^\s*[[{]/.test(text)) {
      return {
        ok: false,
        status: resp.status,
        detail: `HTTP ${resp.status} but the payload is not JSON (HTML SPA fallback?)`,
      };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return {
        ok: false,
        status: resp.status,
        detail: `HTTP ${resp.status} but JSON.parse failed: ${errorMessage(e)}`,
      };
    }
    return {
      ok: true,
      status: resp.status,
      detail: `HTTP ${resp.status} (JSON, ${bytes.byteLength} B)`,
      json,
    };
  } catch (e) {
    return {
      ok: false,
      detail: controller?.signal.aborted
        ? `timed out after ${RESOURCE_HEALTH_PROBE_TIMEOUT_MS} ms`
        : `fetch failed: ${errorMessage(e)}`,
    };
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

interface SourcedProbe {
  status: "pass" | "fallback" | "fail";
  url: string;
  /** The embedded same-origin copy probed after a cache miss (asset URLs
   *  only; null for same-origin URLs and non-hit paths). */
  embeddedUrl: string | null;
  detail: string;
  json?: unknown;
}

/** The loader's embedded-copy recovery (see fetchModelResource): an asset
 *  URL maps to the same pack-relative file under /models/. */
function embeddedUrlFor(
  env: ProbeEnvironment,
  url: string,
): string | null {
  if (!url.startsWith("http://asset.localhost/")) return null;
  const rel = env.modelFileFromUrl(url);
  if (!rel || rel.includes("://") || rel.startsWith("/")) return null;
  return "/models/" + rel.replace(/^\/+/, "");
}

/** Probe the cache URL, then — on an asset-protocol miss — the embedded
 *  copy the loader itself falls back to. A hit on the second rung is
 *  "fallback" (yellow), not a fail. */
async function probeSourced(
  env: ProbeEnvironment,
  url: string,
  kind: ProbeKind,
): Promise<SourcedProbe> {
  const first = await probeUrl(env.fetch, url, kind);
  if (first.ok) {
    return {
      status: "pass",
      url,
      embeddedUrl: null,
      detail: `${displayUrl(url)} → ${first.detail}`,
      json: first.json,
    };
  }
  const embedded = embeddedUrlFor(env, url);
  if (!embedded) {
    return {
      status: "fail",
      url,
      embeddedUrl: null,
      detail: `${displayUrl(url)} → ${first.detail}`,
    };
  }
  const second = await probeUrl(env.fetch, embedded, kind);
  if (second.ok) {
    return {
      status: "fallback",
      url,
      embeddedUrl: embedded,
      detail: `${displayUrl(url)} → ${first.detail}; ${embedded} → ${second.detail}`,
      json: second.json,
    };
  }
  return {
    status: "fail",
    url,
    embeddedUrl: embedded,
    detail: `${displayUrl(url)} → ${first.detail}; ${embedded} → ${second.detail}`,
  };
}

// ── Roster ship probing (check 5) ───────────────────────────────────────

interface ShipProbeResult {
  ship: ReplayResourceShip;
  /** "stem(display name)" as reported to the user. */
  label: string;
  /** Expected pack-relative file ("ships/X.glb"), null when unresolved. */
  file: string | null;
  status: "pass" | "fallback" | "missing" | "unknown";
  detail: string;
}

function shipStemFromFile(file: string): string {
  const base = file.split("/").pop() ?? file;
  return base.replace(/\.glb$/i, "");
}

async function probeShip(
  env: ProbeEnvironment,
  ship: ReplayResourceShip,
): Promise<ShipProbeResult> {
  const name = ship.name.trim() || (ship.shipId != null ? `#${ship.shipId}` : "?");
  const candidates = env
    .shipCandidates(ship.shipId, ship.fallbackName ?? undefined)
    .slice(0, RESOURCE_HEALTH_MAX_CANDIDATES);
  if (candidates.length === 0) {
    return {
      ship,
      label: name,
      file: null,
      status: "unknown",
      detail: `no model stem (shipId ${ship.shipId ?? "?"}, name ${name})`,
    };
  }
  const expectedFile = env.modelFileFromUrl(candidates[0]!);
  const stem = shipStemFromFile(expectedFile);
  const label = `${stem}(${name})`;
  const misses: string[] = [];
  for (const candidate of candidates) {
    const probe = await probeSourced(env, candidate, "glb");
    if (probe.status === "pass") {
      return { ship, label, file: expectedFile, status: "pass", detail: probe.detail };
    }
    if (probe.status === "fallback") {
      return { ship, label, file: expectedFile, status: "fallback", detail: probe.detail };
    }
    misses.push(probe.detail);
  }
  return {
    ship,
    label,
    file: expectedFile,
    status: "missing",
    detail: `${misses[0] ?? "no candidate answered"}${
      candidates.length > 1
        ? ` (${candidates.length - 1} further candidate(s) also missed)`
        : ""
    }`,
  };
}

/** Probe roster ships with a bounded worker pool (order preserved). The
 *  roster is SAMPLED to RESOURCE_HEALTH_MAX_SHIPS so a large roster can only
 *  lengthen the chain linearly; the report shows the sampled count. */
async function probeShips(
  env: ProbeEnvironment,
  ships: readonly ReplayResourceShip[],
): Promise<ShipProbeResult[]> {
  const sample = ships.slice(0, RESOURCE_HEALTH_MAX_SHIPS);
  const results = new Array<ShipProbeResult | null>(sample.length).fill(null);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= sample.length) return;
      results[index] = await probeShip(env, sample[index]!);
    }
  };
  const workers = Math.min(RESOURCE_HEALTH_SHIP_CONCURRENCY, sample.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results.filter((result): result is ShipProbeResult => result != null);
}

/** Dedupe roster entries a replay can repeat (mirror picks, bots): one
 *  probe per ship id (or name when no id resolved). */
function dedupeShips(ships: readonly ReplayResourceShip[]): ReplayResourceShip[] {
  const seen = new Set<string>();
  const out: ReplayResourceShip[] = [];
  for (const ship of ships) {
    const key =
      ship.shipId != null ? `id:${ship.shipId}` : `name:${ship.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ship);
  }
  return out;
}

// ── The check chain ─────────────────────────────────────────────────────

async function collectReport(
  env: ProbeEnvironment,
  ctx: ReplayResourceContext,
): Promise<ResourceHealthReport> {
  // 1. res_cache_root RPC.
  let rpcRoot: string | null = null;
  let rpcError: string | null = null;
  if (env.isTauri) {
    try {
      rpcRoot = await env.resCacheRoot();
    } catch (e) {
      rpcError = errorMessage(e);
    }
  }
  const loaderRoot = env.cacheRoot;
  const effectiveRoot = loaderRoot ?? rpcRoot;
  const loaderNote =
    loaderRoot != null
      ? `loader cacheRoot = ${loaderRoot}`
      : "loader cacheRoot = null (unwired)";

  let cacheCheck: ResourceCheck;
  if (!env.isTauri) {
    cacheCheck = {
      id: "cacheRoot",
      status: "info",
      detail: `no Tauri shell (browser dev mode) — res_cache_root unavailable; ${loaderNote}`,
    };
  } else if (rpcError != null) {
    cacheCheck = {
      id: "cacheRoot",
      status: "fail",
      detail: `res_cache_root rejected: ${rpcError}; ${loaderNote}`,
    };
  } else if (rpcRoot == null) {
    cacheCheck = loaderRoot
      ? {
          id: "cacheRoot",
          status: "fallback",
          detail: `res_cache_root = null; ${loaderNote} — the root was wired through the ensure path`,
        }
      : {
          id: "cacheRoot",
          status: "fail",
          detail: `res_cache_root = null; ${loaderNote} — no resource pack on disk`,
        };
  } else {
    cacheCheck = {
      id: "cacheRoot",
      status: loaderRoot == null ? "fallback" : "pass",
      detail:
        `res_cache_root = ${rpcRoot}; ${loaderNote}` +
        (loaderRoot == null ? " — the model loader is not wired to it" : ""),
    };
  }

  // 2. Asset protocol reachability (+ the .res-version stamp for check 3).
  const stampRel = ".res-version.json";
  const stampUrl = env.packUrl(stampRel, effectiveRoot);
  let stampProbe: ProbeOutcome | null = null;
  let assetCheck: ResourceCheck;
  if (!env.isTauri) {
    assetCheck = {
      id: "assetProtocol",
      status: "info",
      detail:
        "no Tauri shell (browser dev mode) — asset protocol / convertFileSrc unavailable; the embedded /models/ paths are the only source",
    };
  } else if (!env.convertFileSrc) {
    assetCheck = {
      id: "assetProtocol",
      status: "fail",
      detail:
        "convertFileSrc is unavailable inside the Tauri webview — the asset protocol is not wired (tauri.conf.json > assetProtocol.enable)",
    };
  } else if (!effectiveRoot) {
    assetCheck = {
      id: "assetProtocol",
      status: "fail",
      detail: `no pack cache root (res_cache_root = null, ${loaderNote}) — nothing to probe`,
    };
  } else if (!stampUrl) {
    assetCheck = {
      id: "assetProtocol",
      status: "fail",
      detail: `could not build the asset URL for ${stampRel} (cacheRoot = ${effectiveRoot})`,
    };
  } else {
    stampProbe = await probeUrl(env.fetch, stampUrl, "json");
    if (stampProbe.ok) {
      const stamp = stampProbe.json as
        | { version?: unknown; treeSha256?: unknown }
        | null;
      const version =
        typeof stamp?.version === "string" ? stamp.version : "?";
      assetCheck = {
        id: "assetProtocol",
        status: "pass",
        detail: `fetch(${displayUrl(stampUrl)}) → ${stampProbe.detail}; stamp version ${version}`,
      };
    } else if (stampProbe.status === 404) {
      assetCheck = {
        id: "assetProtocol",
        status: "fallback",
        detail: `fetch(${displayUrl(stampUrl)}) → HTTP 404 — the asset protocol resolves the path but ${stampRel} is missing (pack not stamped)`,
      };
    } else if (stampProbe.status === 403 || stampProbe.status === 401) {
      assetCheck = {
        id: "assetProtocol",
        status: "fail",
        detail: `fetch(${displayUrl(stampUrl)}) → HTTP ${stampProbe.status} — assetProtocol.scope / permission does not cover the cache root`,
      };
    } else {
      assetCheck = {
        id: "assetProtocol",
        status: "fail",
        detail: `fetch(${displayUrl(stampUrl)}) → ${stampProbe.detail}`,
      };
    }
  }
  const stampPresent = stampProbe?.ok === true;

  // 4 inputs first (check 3 reports their summary): minimaps.json + map GLB.
  const mapId = ctx.mapId.trim();
  const minimapUrl = env.minimapJsonUrl();
  const minimapProbe = await probeSourced(env, minimapUrl, "json");
  const minimapKeys =
    minimapProbe.json != null && typeof minimapProbe.json === "object"
      ? Object.keys(minimapProbe.json as Record<string, unknown>)
      : null;
  const mapIdPresent =
    mapId && minimapKeys
      ? minimapKeys.some((key) => key.toLowerCase() === mapId.toLowerCase())
      : null;
  const mapGlbUrl = mapId ? env.mapModelUrl(mapId) : null;
  const mapGlbProbe = mapGlbUrl
    ? await probeSourced(env, mapGlbUrl, "glb")
    : null;

  let replayMapCheck: ResourceCheck;
  if (!mapId) {
    replayMapCheck = {
      id: "replayMap",
      status: "info",
      detail: "no replay mapId in this view — map assets not probed",
    };
  } else {
    const parts = [
      `minimaps.json ${minimapProbe.detail}`,
      `mapId ${mapId} ${mapIdPresent === true ? "is present" : mapIdPresent === false ? "is NOT in minimaps.json" : "could not be checked (index unreadable)"}`,
      mapGlbUrl
        ? `map glb ${mapGlbProbe!.detail}`
        : `map glb: no model stem resolved for mapId ${mapId}`,
    ];
    let status: ResourceCheckStatus = "pass";
    if (
      minimapProbe.status === "fail" ||
      mapIdPresent === false ||
      !mapGlbUrl ||
      mapGlbProbe?.status === "fail"
    ) {
      status = "fail";
    } else if (
      minimapProbe.status === "fallback" ||
      mapGlbProbe?.status === "fallback" ||
      mapIdPresent == null
    ) {
      status = "fallback";
    }
    replayMapCheck = {
      id: "replayMap",
      status,
      detail: parts.join("; "),
    };
  }

  // 5. Per-roster-ship models.
  const probedShips = await probeShips(env, ctx.ships);
  const missing = probedShips.filter((result) => result.status === "missing");
  const fallback = probedShips.filter((result) => result.status === "fallback");
  const unknown = probedShips.filter((result) => result.status === "unknown");
  const reachable = probedShips.filter(
    (result) => result.status === "pass" || result.status === "fallback",
  ).length;
  // The embedded same-origin pack (mobile APK bundle, portable fallback, or
  // a dev tree) answers when no cache root is wired. A null RPC + unwired
  // loader is then EXPECTED, not a failure — yellow fallback, matching the
  // per-ship classification.
  const embeddedEvidence =
    reachable > 0 ||
    minimapProbe.status === "pass" ||
    mapGlbProbe?.status === "pass";
  if (
    env.isTauri &&
    rpcRoot == null &&
    loaderRoot == null &&
    embeddedEvidence
  ) {
    cacheCheck = {
      id: "cacheRoot",
      status: "fallback",
      detail: `res_cache_root = null; ${loaderNote} — the embedded same-origin pack is serving (mobile bundle / portable fallback)`,
    };
  }

  let shipModelsCheck: ResourceCheck;
  if (ctx.ships.length === 0) {
    shipModelsCheck = {
      id: "shipModels",
      status: "info",
      detail: "no roster ships in this view — per-ship models not probed",
    };
  } else {
    const extra = missing
      .slice(0, 8)
      .map((result) => `missing: ${result.file ?? result.label}`);
    const fallbackFiles = fallback
      .slice(0, 8)
      .map((result) => `embedded fallback: ${result.file ?? result.label}`);
    let status: ResourceCheckStatus = "pass";
    if (missing.length > 0 || (unknown.length > 0 && reachable === 0)) {
      // No candidate at all for every ship is just as fatal as a probed
      // miss (the empty-pack silent scene): the loader never had a URL.
      status = "fail";
    } else if (unknown.length > 0 || fallback.length > 0) {
      status = "fallback";
    }
    shipModelsCheck = {
      id: "shipModels",
      status,
      detail:
        `probed ${probedShips.length}/${ctx.ships.length} roster ships (cap ${RESOURCE_HEALTH_MAX_SHIPS}, concurrency ${RESOURCE_HEALTH_SHIP_CONCURRENCY}) — ` +
        `${reachable} reachable, ${missing.length} missing, ${fallback.length} embedded fallback, ${unknown.length} no stem` +
        (missing[0] ? `; first miss: ${missing[0].detail}` : ""),
      extra: [...extra, ...fallbackFiles],
    };
  }

  // 3. Pack population (roster + index stand in for a directory listing).
  const bundled = env.bundledCounts();
  const minimapEntryCount = minimapKeys?.length;
  const stampDetail = stampProbe
    ? stampPresent
      ? `stamp present (${stampUrl ? displayUrl(stampUrl) : stampRel})`
      : `stamp missing (${stampUrl ? displayUrl(stampUrl) : stampRel} → ${stampProbe.detail})`
    : `stamp not probed (asset protocol unavailable)`;
  let packCheck: ResourceCheck;
  if (!env.isTauri) {
    packCheck = {
      id: "pack",
      status: "info",
      detail:
        `no Tauri shell (browser dev mode) — no pack cache to enumerate; ` +
        `bundled glob: ships ${bundled.ships}, maps ${bundled.maps}; ${stampDetail}`,
    };
  } else {
    let status: ResourceCheckStatus = "pass";
    if (!effectiveRoot) status = embeddedEvidence ? "fallback" : "fail";
    else if (stampPresent) {
      if (
        (probedShips.length > 0 && reachable === 0) ||
        minimapProbe.status === "fail"
      ) {
        status = "fail";
      }
    } else if (
      reachable > 0 ||
      fallback.length > 0 ||
      minimapProbe.status !== "fail"
    ) {
      status = "fallback";
    } else {
      status = "fail";
    }
    packCheck = {
      id: "pack",
      status,
      detail:
        `${stampDetail}; ships: ${reachable}/${probedShips.length} roster hulls reachable (${fallback.length} embedded) — the asset protocol cannot list directories; ` +
        `maps: ${minimapEntryCount ?? "?"} bounds entries in minimaps.json; bundled glob: ships ${bundled.ships}, maps ${bundled.maps}`,
    };
  }

  // 6. Session ship-model load failures.
  const failures = env.sessionFailures();
  const describeFailureTarget = (failure: ModelLoadFailure): string =>
    failure.label ?? (failure.file || "(unknown ship)");
  let failureCheck: ResourceCheck;
  if (failures.length === 0) {
    failureCheck = {
      id: "sessionFailures",
      status: "pass",
      detail: "no ship model load failures logged this session",
    };
  } else {
    const labelsByFile = new Map<string, string>();
    for (const result of probedShips) {
      if (result.file) labelsByFile.set(result.file, result.label);
    }
    failureCheck = {
      id: "sessionFailures",
      status: "fail",
      detail:
        `${failures.length} ship model load failure(s) this session; last: ` +
        `${describeFailureTarget(failures[0]!)} — ${failures[0]!.reason}`,
      extra: failures
        .slice(0, 8)
        .map(
          (failure) =>
            `${
              labelsByFile.get(failure.file) ??
              describeFailureTarget(failure)
            } — ${failure.reason}` +
            (failure.count > 1 ? ` (x${failure.count})` : ""),
        ),
    };
  }

  return {
    ranAt: Date.now(),
    environment: env.isTauri ? "tauri" : "browser",
    mapId,
    checks: [
      cacheCheck,
      assetCheck,
      packCheck,
      replayMapCheck,
      shipModelsCheck,
      failureCheck,
    ],
    // Ships with no resolvable stem have no "stem(name)" form — their label
    // (the display name) still names the missing hull.
    missingShips: [
      ...missing.map((result) => result.label),
      ...unknown.map((result) => result.label),
    ],
    fallbackShips: fallback.map((result) => result.label),
  };
}

// ── Session state (module-level: the HUD is its own Vue app) ────────────

const report = shallowRef<ResourceHealthReport | null>(null);
const running = ref(false);
const context = shallowRef<ReplayResourceContext | null>(null);

/** The dev HUD's 资源 tab reads these refs. `report` is null until a run
 *  (auto or manual) lands. */
export function useResourceHealth(): {
  report: Readonly<Ref<ResourceHealthReport | null>>;
  running: Readonly<Ref<boolean>>;
  context: Readonly<Ref<ReplayResourceContext | null>>;
} {
  return { report, running, context };
}

/** The last report (null before the first run). */
export function getResourceHealthReport(): ResourceHealthReport | null {
  return report.value;
}

let activeViewKey = "";
let autoRunConsumed = false;
let inFlight: Promise<ResourceHealthReport> | null = null;
let inFlightKey = "";

/** Run the full chain on demand (the 重新检查 button). Concurrent callers
 *  on the SAME view share the in-flight run; a NEW view queues its run
 *  behind the stale one instead of receiving (and discarding) its result. */
export function runResourceHealthChecks(
  overrides: ResourceHealthProbeOverrides = {},
): Promise<ResourceHealthReport> {
  const key = activeViewKey;
  if (inFlight) {
    if (inFlightKey === key) return inFlight;
    return inFlight
      .catch(() => undefined)
      .then(() => runResourceHealthChecks(overrides));
  }
  const env = createProbeEnvironment(overrides);
  const ctx = context.value ?? { mapId: "", ships: [] };
  inFlightKey = key;
  running.value = true;
  let run: Promise<ResourceHealthReport>;
  run = collectReport(env, ctx)
    .then((next) => {
      if (activeViewKey === key) report.value = next;
      return next;
    })
    .finally(() => {
      if (inFlight === run) {
        inFlight = null;
        running.value = false;
      }
    });
  inFlight = run;
  return run;
}

function maybeAutoRun(): void {
  if (autoRunConsumed) return;
  if (!context.value) return;
  if (getShipModelLoadFailures().length === 0) return;
  autoRunConsumed = true;
  void runResourceHealthChecks().catch(() => {
    // A failed probe must never surface as an unhandled rejection.
  });
}

/** Failure notifications arm the auto-run for a replay view that is already
 *  open: the first ship model to fail this session triggers the chain once. */
subscribeShipModelLoadFailures(() => {
  maybeAutoRun();
});

/** Hand the current replay view's map + roster to the checks (called from
 *  HolographicMap). A new view resets the report and re-arms the automatic
 *  run; a repeat call for the same view is a no-op. */
export function setReplayResourceContext(next: ReplayResourceContext): void {
  // Keep the full deduped roster in the context; the probe pass samples it
  // and the report shows both numbers (probed / total).
  const ships = dedupeShips(next.ships);
  const nextContext: ReplayResourceContext = {
    mapId: next.mapId ?? "",
    replayPath: next.replayPath ?? "",
    ships,
  };
  const key =
    `${nextContext.replayPath}|${nextContext.mapId}|` +
    ships
      .map((ship) => (ship.shipId != null ? ship.shipId : ship.name.toLowerCase()))
      .sort()
      .join(",");
  context.value = nextContext;
  if (key === activeViewKey) return;
  activeViewKey = key;
  autoRunConsumed = false;
  report.value = null;
  maybeAutoRun();
}

/** Clear the replay context when its view unmounts. */
export function clearReplayResourceContext(): void {
  context.value = null;
  activeViewKey = "";
  autoRunConsumed = false;
}

/** Test seam: drop the module's session state (report, context, in-flight
 *  guards). The model loader's failure list is separate — clear it through
 *  modelLoader.clearShipModelLoadFailures(). */
export function resetResourceHealthSession(): void {
  report.value = null;
  running.value = false;
  context.value = null;
  activeViewKey = "";
  autoRunConsumed = false;
  inFlight = null;
  inFlightKey = "";
}
