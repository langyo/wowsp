/** Tests for runtime model availability: the ship GLBs are gitignored, so a
 *  build from a fresh checkout globs an EMPTY res/models/ships directory.
 *  Once the Tauri shell wires the downloaded model-pack cache, URL
 *  construction must trust the stem (optimistic) instead of the build-time
 *  glob — otherwise every ship renders the placeholder hull even though the
 *  runtime pack is fully populated. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  fetchModelResource,
  initModelPack,
  resolveShipModelByShipId,
  resolvePropModelUrl,
  shipDescriptionFromOfflineDb,
} from "./modelLoader";

// A shipId + model stem pair straight from ship_models.json (tracked data).
const SHIP_ID = 3246831056; // index "PRSS999"
const STEM = "PRSS999";

beforeAll(async () => {
  // Fake the Tauri asset protocol so URL construction has a converter to use.
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
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
