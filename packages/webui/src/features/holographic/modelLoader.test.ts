/** Tests for runtime model availability: the ship GLBs are gitignored, so a
 *  build from a fresh checkout globs an EMPTY res/models/ships directory.
 *  Once the Tauri shell wires the downloaded model-pack cache, URL
 *  construction must trust the stem (optimistic) instead of the build-time
 *  glob — otherwise every ship renders the placeholder hull even though the
 *  runtime pack is fully populated. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as THREE from "three";

import { registerRuntimeShipEntry, resetRuntimeShipEntries } from "@/utils/runtimeShipDb";
import {
  fetchModelResource,
  initModelPack,
  loadGlbModel,
  loadMapMinimapImage,
  noteMapMinimapLoadError,
  probeMinimapPackEra,
  resolveMapMinimapUrl,
  resolveShipModelByShipId,
  resolvePropModelUrl,
  shipDescriptionFromOfflineDb,
  shipNameFromOfflineDb,
  shipOfflineEntry,
  shipModelStemCandidates,
} from "./modelLoader";

// A shipId + model stem pair straight from ship_models.json (tracked data).
const SHIP_ID = 3246831056; // index "PRSS999"
const STEM = "PRSS999";

beforeAll(async () => {
  // Fake the Tauri asset protocol so URL construction has a converter to use.
  window.__TAURI_INTERNALS__ = {
    convertFileSrc: (p: string) => `http://asset.localhost/${encodeURIComponent(p)}`,
  };
  // Fake the shell's ensure_res_pack: cache root resolves immediately.
  await initModelPack(async () => "C:/cache-root");
});

describe("model availability with a wired pack cache", () => {
  it("builds an optimistic cache URL for a stem the build-time glob missed", () => {
    const url = resolveShipModelByShipId(SHIP_ID);
    expect(url).not.toBeNull();
    expect(url).toContain("asset.localhost");
    expect(decodeURIComponent(url!)).toContain("C:/cache-root/models/ships/" + STEM + ".glb");
  });

  it("stays null for ships without any model mapping", () => {
    // No shipId, no fallback name, no offline-DB entry — nothing to build from.
    expect(resolveShipModelByShipId(undefined)).toBeNull();
  });

  it("covers shared props optimistically too", () => {
    const url = resolvePropModelUrl("shell");
    expect(url).not.toBeNull();
    expect(decodeURIComponent(url!)).toContain("/models/props/shell.glb");
  });
});

describe("shipDescriptionFromOfflineDb", () => {
  // Yamato (shipId 4276041424) straight from the generated DB: the 国服
  // catalog text (zoo translation) and the 亚服 formal 简体 text must BOTH be
  // present and distinct — the WG API only ever serves one harmonized zh-cn.
  const YAMATO_ID = "4276041424";

  it("serves exact-language descriptions for the Chinese trio", () => {
    const zhCn = shipDescriptionFromOfflineDb(YAMATO_ID, "zh-CN");
    const zhSg = shipDescriptionFromOfflineDb(YAMATO_ID, "zh-SG");
    expect(typeof zhCn).toBe("string");
    expect((zhCn ?? "").length).toBeGreaterThan(0);
    expect(typeof zhSg).toBe("string");
    expect((zhSg ?? "").length).toBeGreaterThan(0);
    expect(zhCn).not.toBe(zhSg);
  });

  it("returns null for unknown ships or missing languages", () => {
    expect(shipDescriptionFromOfflineDb("999999999", "zh-CN")).toBeNull();
    expect(shipDescriptionFromOfflineDb(YAMATO_ID, "xx-XX")).toBeNull();
    expect(shipDescriptionFromOfflineDb(undefined, "zh-CN")).toBeNull();
  });
});

// ── Runtime registrations in the offline readers ──────────────────────────
// shipOfflineEntry/shipNameFromOfflineDb are the live panel's identity
// chain: a ship the bake predates must flow through them once the App side
// registered its GameParams identity — while a baked entry is never
// overridden by a registration.
describe("offline readers over runtime registrations", () => {
  const RT_ID = "999888777"; // absent from the baked DB

  afterEach(() => resetRuntimeShipEntries());

  it("wraps a runtime registration into the offline entry shape", () => {
    expect(shipOfflineEntry(RT_ID)).toBeNull();
    expect(shipNameFromOfflineDb(RT_ID, "zh-CN")).toBeNull();
    registerRuntimeShipEntry(RT_ID, {
      index: "PJSB719",
      tier: 9,
      type: "Battleship",
      nation: "japan",
      names: { en: "Hotaka 1944" },
    });
    expect(shipOfflineEntry(RT_ID)).toEqual({
      index: "PJSB719",
      tier: 9,
      type: "Battleship",
      nation: "japan",
      hp: null,
      names: { en: "Hotaka 1944" },
    });
    // The reader's lang → "en" → first-value fallback serves the runtime
    // name to every requested locale.
    expect(shipNameFromOfflineDb(RT_ID, "zh-CN")).toBe("Hotaka 1944");
    expect(shipNameFromOfflineDb(RT_ID)).toBe("Hotaka 1944");
  });

  it("keeps a baked entry ahead of a registration for the same id", () => {
    // Yamato's baked id (declared inside the shipDescriptionFromOfflineDb
    // describe above): registering over it must change nothing.
    registerRuntimeShipEntry("4276041424", { names: { en: "Fake" } });
    expect(shipNameFromOfflineDb("4276041424", "en-US")).toBe("Yamato");
  });
});

// ── shipModelStemCandidates: the ordered per-ship candidate chain ────────
// The Lesta (RU realm) colour/clone series names its ships "<Base Ship> CLR"
// ("Schlieffen CLR") but the model pack bakes only the base hull — the chain
// must end with the suffix-stripped stem so the base GLB is reachable.
describe("shipModelStemCandidates", () => {
  it("lists the ship_models index then baseName for a mapped ship", () => {
    // Schlieffen straight from the tracked data: index "PGSB210",
    // baseName "Schlieffen".
    expect(shipModelStemCandidates(4074714928)).toEqual(["PGSB210", "Schlieffen"]);
  });

  it("appends the CLR-stripped base for a Lesta CLR clone", () => {
    // A shipId both DBs are missing (the actual Lesta-clone row) with the
    // localized display name: the chain is the display name, then the base.
    expect(shipModelStemCandidates("999999999", "Schlieffen CLR")).toEqual([
      "Schlieffen CLR",
      "Schlieffen",
    ]);
  });

  it("matches the CLR suffix case-insensitively", () => {
    expect(shipModelStemCandidates("999999999", "schlieffen clr")).toEqual([
      "schlieffen clr",
      "schlieffen",
    ]);
  });

  it("leaves names without the CLR suffix alone (no duplicate append)", () => {
    expect(shipModelStemCandidates("999999999", "Schlieffen")).toEqual(["Schlieffen"]);
  });

  it("dedupes repeated stems, keeping the first position", () => {
    // fallbackName equal to the ship_models index: one entry only…
    expect(shipModelStemCandidates(4074714928, "PGSB210")).toEqual([
      "PGSB210",
      "Schlieffen",
    ]);
    // …and a REAL Lesta clone row (N. Carolina CLR): index "PASB808",
    // baseName "North", offline-DB English name "N. Carolina CLR" (a
    // case-insensitive duplicate of the display name), CLR strip appends
    // "N. Carolina" last.
    expect(shipModelStemCandidates(3447666672, "N. Carolina CLR")).toEqual([
      "PASB808",
      "North",
      "N. Carolina CLR",
      "N. Carolina",
    ]);
  });

  it("returns an empty chain for a ship with no data at all", () => {
    expect(shipModelStemCandidates("999999999")).toEqual([]);
    expect(shipModelStemCandidates(undefined)).toEqual([]);
  });
});

// ── fetchModelResource: the 0.3.0 "model routed to the webpage" bug ──────
// Tauri's asset resolver answers ANY unknown frontendDist path with the
// index.html SPA fallback under HTTP 200, and the dist lost its GLBs to the
// prune-baked-glb build step — so a rung that misses "succeeds" with HTML
// that GLTFLoader then chokes on (`Unexpected token '<'`). Every rung must
// be validated by payload, and every miss must fall through to the next
// source instead of poisoning the caller.
describe("fetchModelResource payload validation", () => {
  // Matches the fake convertFileSrc + cache root wired in beforeAll.
  const ASSET_URL =
    "http://asset.localhost/C%3A%2Fcache-root%2Fmodels%2Fships%2FPRSS999.glb";
  const EMBEDDED_URL = "/models/ships/PRSS999.glb";

  function glbBuffer(): ArrayBuffer {
    const buf = new ArrayBuffer(64);
    const view = new DataView(buf);
    for (let i = 0; i < 4; i++) view.setUint8(i, [0x67, 0x6c, 0x54, 0x46][i]!); // "glTF"
    view.setUint32(4, 2, true);
    view.setUint32(8, 64, true);
    return buf;
  }

  /** A real GLB as Tauri's asset protocol actually serves it: the mime
   *  table has no .glb entry, so the label degrades to text/html — the
   *  payload check must trust the glTF magic over the header. */
  function glbResponse(): Response {
    return new Response(glbBuffer(), {
      headers: { "content-type": "text/html" },
    });
  }

  /** Tauri's SPA fallback for a missing dist file: 200 + the app's HTML. */
  function spaFallback(): Response {
    return new Response(
      "<!DOCTYPE html><html><body><div id=app></div></body></html>",
      { headers: { "content-type": "text/html" } },
    );
  }

  /** Route-table fetch stub; returns the recorded call order. */
  function stubFetch(routes: Record<string, Response | Error>): string[] {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const hit = routes[url];
      if (hit instanceof Error) return Promise.reject(hit);
      return Promise.resolve(hit ?? new Response("not found", { status: 404 }));
    });
    return calls;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a real pack-cache GLB even though Tauri labels it text/html", async () => {
    const calls = stubFetch({ [ASSET_URL]: glbResponse() });
    const resp = await fetchModelResource(ASSET_URL);
    expect(resp.ok).toBe(true);
    expect(calls).toEqual([ASSET_URL]);
    const head = new Uint8Array(await resp.arrayBuffer(), 0, 4);
    expect(String.fromCharCode(...head)).toBe("glTF");
  });

  it("rejects instead of serving the index.html SPA fallback (the 0.3.0 bug)", async () => {
    // Cache misses; the embedded rung "hits" with the SPA HTML under 200 —
    // before the payload check this resolved and crashed GLTFLoader.
    const calls = stubFetch({ [ASSET_URL]: new Response("gone", { status: 404 }), [EMBEDDED_URL]: spaFallback() });
    await expect(fetchModelResource(ASSET_URL)).rejects.toThrow(/SPA fallback/);
    expect(calls).toEqual([ASSET_URL, EMBEDDED_URL]);
  });

  it("falls back to the embedded copy when the cache fetch dies in transport", async () => {
    const calls = stubFetch({
      [ASSET_URL]: new TypeError("Failed to fetch"), // proxy-eaten asset.localhost
      [EMBEDDED_URL]: glbResponse(),
    });
    const resp = await fetchModelResource(ASSET_URL);
    expect(resp.ok).toBe(true);
    expect(calls).toEqual([ASSET_URL, EMBEDDED_URL]);
  });

  it("rejects a plain origin URL answered by the SPA fallback (pack unwired)", async () => {
    // With the pack cache unwired every model URL is a bare /models/... path
    // on the app origin — the raw fetch used to pass the poisoned 200
    // straight through to GLTFLoader.
    stubFetch({ [EMBEDDED_URL]: spaFallback() });
    await expect(fetchModelResource(EMBEDDED_URL)).rejects.toThrow(/no usable source/);
  });

  it("validates JSON resources and still prefers the pack cache", async () => {
    const assetJson =
      "http://asset.localhost/C%3A%2Fcache-root%2Fmodels%2Fmaps%2Fminimaps.json";
    const embeddedJson = "/models/maps/minimaps.json";
    const calls = stubFetch({
      [assetJson]: spaFallback(),
      [embeddedJson]: new Response('{"spaces/00_CO_ocean":{"minX":0}}', {
        headers: { "content-type": "application/json" },
      }),
    });
    const resp = await fetchModelResource(assetJson);
    await expect(resp.json()).resolves.toEqual({
      "spaces/00_CO_ocean": { minX: 0 },
    });
    expect(calls).toEqual([assetJson, embeddedJson]);
  });
});

// ── meshopt-compressed pack GLBs through the real loader wiring ──────────
// scripts/model_convert/optimize_glbs.py re-bakes the pack with
// `gltf-transform optimize --compress meshopt` (EXT_meshopt_compression +
// KHR_mesh_quantization — the exact format the site's replay3d assets
// already ship). The loader must wire MeshoptDecoder or every optimized
// GLB dies with "THREE.GLTFLoader: setMeshoptDecoder() must be called…".
// This round-trips the module's own chain headlessly: stubbed fetch →
// fetchModelResource payload validation → fixGlbPadding → getLoader()
// (the wiring under test) → a REAL WebAssembly meshopt decode.
//
// The fixture (modelLoader.fixtures/meshopt-cube.glb, 1.9 KB) was produced
// once by gltf-transform from a hand-written subdivided-cube .gltf:
//   pnpm exec gltf-transform optimize cube.gltf meshopt-cube.glb \
//     --compress meshopt --simplify false
describe("meshopt-compressed GLB round-trip", () => {
  const MODEL_URL = "/models/ships/meshopt-cube.glb";
  const FIXTURE = join(
    process.cwd(),
    "src",
    "features",
    "holographic",
    "modelLoader.fixtures",
    "meshopt-cube.glb",
  );

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("decodes an EXT_meshopt_compression GLB through loadGlbModel", async () => {
    const buf = readFileSync(FIXTURE);
    const bytes = new Uint8Array(buf).buffer;

    // Guard the fixture's own integrity: a regenerated-but-uncompressed
    // fixture would make the assertions below protect nothing.
    const view = new DataView(bytes);
    expect(String.fromCharCode(
      view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
    )).toBe("glTF");
    const jsonLen = view.getUint32(12, true);
    const jsonHead = new TextDecoder().decode(new Uint8Array(bytes, 20, Math.min(jsonLen, 512)));
    expect(jsonHead).toContain("EXT_meshopt_compression");

    // happy-dom's fetch refuses blob: URLs, and the loader hands GLTFLoader
    // a blob URL — record createObjectURL's blobs and serve them from the
    // fetch stub so the REAL GLTFLoader/FileLoader path still runs.
    const blobs = new Map<string, Blob>();
    vi.spyOn(URL, "createObjectURL").mockImplementation((obj: Blob | MediaSource) => {
      const url = `blob:stub-${blobs.size}`;
      blobs.set(url, obj as Blob); // the loader only ever hands it Blobs
      return url;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      // three's FileLoader hands fetch a Request object — recover the real
      // URL from it instead of "[object Request]".
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.startsWith("blob:")) {
        const blob = blobs.get(url);
        if (blob) return blob.arrayBuffer().then((b) => new Response(b));
      }
      if (url === MODEL_URL) return Promise.resolve(new Response(bytes));
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const group = await loadGlbModel(MODEL_URL);

    const meshes: THREE.Mesh[] = [];
    group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    expect(meshes.length).toBeGreaterThan(0);
    const position = meshes[0]!.geometry.getAttribute("position");
    expect(position).toBeDefined();
    expect(position.count).toBeGreaterThan(0);
  });
});

// ── Minimap pack era (pre-WebP resource packs) ───────────────────────────
// The repo tree ships .webp since #1178, but a pack downloaded earlier
// holds .png on disk — the URL builder must follow the pack's actual era
// (probe at wiring time, confirmed cross-era retry as the backstop). The
// era flag only flips on a CONFIRMED .png hit: one transient miss (a
// resource-pack delta rewriting the cache mid-load) must resolve null
// for that map alone, never poison the family for the session. The flag
// is one-way MODULE state, so the unflipped-behavior tests run FIRST
// and the flipping tests run LAST inside this describe.
describe("minimap pack era fallback", () => {
  // A stem straight from the repo's minimap tree (tracked webp assets).
  const STEM = "00_CO_ocean";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to the repo glob's .webp extension", () => {
    const url = resolveMapMinimapUrl(STEM);
    expect(url).toBe(`/models/maps/minimaps/${STEM}.webp`);
  });

  it("resolves unknown spaces to null", () => {
    expect(resolveMapMinimapUrl("spaces/does_not_exist")).toBeNull();
  });

  it("noteMapMinimapLoadError re-probes instead of flipping blindly", async () => {
    // A reactive <img> miss probes the pack; with .png answering 404 the
    // family must stay .webp (the pre-fix blind flip 404'd every later
    // map's art until the app restarted).
    const fetchSpy = vi.fn().mockResolvedValue(new Response("gone", { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);

    noteMapMinimapLoadError();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0)); // let the probe settle
    expect(resolveMapMinimapUrl(STEM)).toBe(`/models/maps/minimaps/${STEM}.webp`);
  });

  it("loadMapMinimapImage retries the other extension without flipping first", async () => {
    const instances: Array<{ src: string; onload: (() => void) | null; onerror: (() => void) | null }> = [];
    class FakeImage {
      src = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        instances.push(this as never);
      }
    }
    vi.stubGlobal("Image", FakeImage);

    const pending = loadMapMinimapImage(STEM);
    await Promise.resolve(); // let the loader create the first image
    expect(instances.length).toBe(1);
    expect(instances[0]!.src).toBe(`/models/maps/minimaps/${STEM}.webp`);

    // The .webp miss: the loader retries .png directly — the family is
    // NOT flipped yet (a transient miss must not poison later loads).
    instances[0]!.onerror!();
    await Promise.resolve();
    expect(instances.length).toBe(2);
    expect(instances[1]!.src).toBe(`/models/maps/minimaps/${STEM}.png`);
    expect(resolveMapMinimapUrl(STEM)).toBe(`/models/maps/minimaps/${STEM}.webp`);

    // Both eras missed: null for THIS map, and the family stays .webp —
    // the next load starts at .webp again instead of 404ing on .png.
    instances[1]!.onerror!();
    await expect(pending).resolves.toBeNull();
    expect(resolveMapMinimapUrl(STEM)).toBe(`/models/maps/minimaps/${STEM}.webp`);
  });

  it("loadMapMinimapImage locks the family only after the .png retry loads", async () => {
    const instances: Array<{ src: string; onload: (() => void) | null; onerror: (() => void) | null }> = [];
    class FakeImage {
      src = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        instances.push(this as never);
      }
    }
    vi.stubGlobal("Image", FakeImage);

    const pending = loadMapMinimapImage(STEM);
    await Promise.resolve();
    instances[0]!.onerror!(); // .webp miss (a real pre-WebP pack)
    await Promise.resolve();
    expect(instances.length).toBe(2);
    expect(instances[1]!.src).toBe(`/models/maps/minimaps/${STEM}.png`);

    instances[1]!.onload!();
    await expect(pending).resolves.toBe(instances[1] as never);
    // Only NOW the family flips — later loads go straight to .png.
    expect(resolveMapMinimapUrl(STEM)).toBe(`/models/maps/minimaps/${STEM}.png`);
  });

  it("probeMinimapPackEra flips the family when the pack answers .png", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("png", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    probeMinimapPackEra();
    await vi.waitFor(() => {
      expect(resolveMapMinimapUrl(STEM)).toBe(`/models/maps/minimaps/${STEM}.png`);
    });
    // The fake convertFileSrc percent-encodes separators — decode before
    // asserting on the probed path. The family was already png-locked by
    // the preceding test (one-way module state), so the URL flip above is
    // trivial — the probe's own URL is what this test pins: exactly the
    // representative stem + .png, through the wired cache root.
    const probed = decodeURIComponent(String(fetchSpy.mock.calls[0]![0]));
    expect(probed).toContain(`/models/maps/minimaps/${STEM}.png`);
  });
});
