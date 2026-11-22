/**
 * resourceHealth — the replay 3D view's in-app dependency diagnostic.
 *
 * The contract under test: each failure class of the check chain maps to
 * exactly one report row; the probes use the loader's own URL construction
 * (convertFileSrc + cache root / the same-origin embedded paths); a cache
 * miss covered by the embedded copy is "fallback" (yellow), only BOTH
 * misses is a fail; and the per-roster-ship probe reports the missing ships
 * with names (the silent-empty-scene answer).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearShipModelLoadFailures,
  loadGlbModel,
  modelFileFromUrl,
  noteShipModelUnavailable,
} from "./modelLoader";
import {
  clearReplayResourceContext,
  getResourceHealthReport,
  resetResourceHealthSession,
  runResourceHealthChecks,
  setReplayResourceContext,
  type ReplayResourceShip,
  type ResourceCheck,
  type ResourceCheckId,
  type ResourceHealthProbeOverrides,
  type ResourceHealthReport,
} from "./resourceHealth";

const CACHE_ROOT = "C:/cache-root";
const ASSET_PREFIX = "http://asset.localhost/";

function assetUrl(rel: string): string {
  return ASSET_PREFIX + encodeURIComponent(CACHE_ROOT + "/" + rel);
}

function packUrl(rel: string): string {
  return assetUrl(rel);
}

function glbResponse(): Response {
  // Four magic bytes are all the probe validates (the loader's payloadMatches
  // rule) — content beyond that is GLTFLoader's business.
  const bytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0, 0, 0, 0]);
  return new Response(bytes.buffer);
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(): Response {
  return new Response("<!DOCTYPE html><html><body>SPA</body></html>", {
    headers: { "content-type": "text/html" },
  });
}

function statusResponse(status: number): Response {
  return new Response("gone", { status });
}

type FetchRoute = (url: string) => Response | Promise<Response>;

function routedFetch(route: FetchRoute): (url: string) => Promise<Response> {
  return async (url) => route(url);
}

function baseOverrides(
  overrides: ResourceHealthProbeOverrides,
): ResourceHealthProbeOverrides {
  return {
    isTauri: true,
    cacheRoot: CACHE_ROOT,
    convertFileSrc: (path) => ASSET_PREFIX + encodeURIComponent(path),
    resCacheRoot: async () => CACHE_ROOT,
    shipCandidates: () => [],
    mapModelUrl: () => null,
    minimapJsonUrl: () => packUrl("models/maps/minimaps.json"),
    modelFileFromUrl,
    sessionFailures: () => [],
    bundledCounts: () => ({ ships: 0, maps: 0 }),
    ...overrides,
  };
}

function reportCheck(
  report: ResourceHealthReport,
  id: ResourceCheckId,
): ResourceCheck {
  const found = report.checks.find((check) => check.id === id);
  expect(found).toBeDefined();
  return found!;
}

async function runChecks(
  context: { mapId?: string; ships?: ReplayResourceShip[] },
  overrides: ResourceHealthProbeOverrides,
): Promise<ResourceHealthReport> {
  setReplayResourceContext({
    mapId: context.mapId ?? "",
    replayPath: "test-replay",
    ships: context.ships ?? [],
  });
  return runResourceHealthChecks(overrides);
}

const ONE_SHIP: ReplayResourceShip[] = [{ shipId: 1, name: "Alpha" }];

beforeEach(() => {
  resetResourceHealthSession();
  clearShipModelLoadFailures();
});

afterEach(() => {
  clearReplayResourceContext();
  resetResourceHealthSession();
  clearShipModelLoadFailures();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the check chain", () => {
  it("reports a fully healthy tauri pack with every check green", async () => {
    const seen: string[] = [];
    const report = await runChecks(
      { mapId: "15_NE_north", ships: ONE_SHIP },
      baseOverrides({
        fetch: routedFetch((url) => {
          seen.push(url);
          if (url === packUrl(".res-version.json")) {
            return jsonResponse({ version: "res-2026.1", treeSha256: "abc" });
          }
          if (url === packUrl("models/maps/minimaps.json")) {
            return jsonResponse({ "15_NE_north": { minX: 0, maxX: 1, minZ: 0, maxZ: 1 } });
          }
          if (url === packUrl("models/maps/15_ne_north.glb")) return glbResponse();
          if (url === packUrl("models/ships/alpha.glb")) return glbResponse();
          return statusResponse(404);
        }),
        shipCandidates: () => [packUrl("models/ships/alpha.glb")],
        mapModelUrl: () => packUrl("models/maps/15_ne_north.glb"),
        sessionFailures: () => [],
        bundledCounts: () => ({ ships: 0, maps: 0 }),
      }),
    );

    expect(report.environment).toBe("tauri");
    expect(report.mapId).toBe("15_NE_north");
    expect(report.checks.map((check) => check.id)).toEqual([
      "cacheRoot",
      "assetProtocol",
      "pack",
      "replayMap",
      "shipModels",
      "sessionFailures",
    ]);
    expect(report.checks.map((check) => check.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    expect(report.missingShips).toEqual([]);
    expect(report.fallbackShips).toEqual([]);
    // The RPC and the probe paths are the loader's own (cache root in the
    // detail; the decoded asset path visible, not a percent blob).
    expect(reportCheck(report, "cacheRoot").detail).toContain(CACHE_ROOT);
    expect(reportCheck(report, "assetProtocol").detail).toContain(
      CACHE_ROOT + "/.res-version.json",
    );
    expect(reportCheck(report, "assetProtocol").detail).toContain("res-2026.1");
    // The chain actually hit every rung it claims.
    expect(seen).toContain(packUrl(".res-version.json"));
    expect(seen).toContain(packUrl("models/maps/minimaps.json"));
    expect(seen).toContain(packUrl("models/maps/15_ne_north.glb"));
    expect(seen).toContain(packUrl("models/ships/alpha.glb"));
  });

  it("reports no Tauri shell and probes the embedded paths in browser dev", async () => {
    let rpcCalls = 0;
    const report = await runChecks(
      { mapId: "15_NE_north", ships: ONE_SHIP },
      baseOverrides({
        isTauri: false,
        cacheRoot: null,
        convertFileSrc: null,
        resCacheRoot: async () => {
          rpcCalls += 1;
          return CACHE_ROOT;
        },
        fetch: routedFetch((url) => {
          if (url === "/models/maps/minimaps.json") {
            return jsonResponse({ "15_NE_north": {} });
          }
          if (url === "/models/maps/15_ne_north.glb") return glbResponse();
          if (url === "/models/ships/alpha.glb") return glbResponse();
          return statusResponse(404);
        }),
        shipCandidates: () => ["/models/ships/alpha.glb"],
        mapModelUrl: () => "/models/maps/15_ne_north.glb",
        minimapJsonUrl: () => "/models/maps/minimaps.json",
      }),
    );

    expect(rpcCalls).toBe(0); // no Tauri shell -> never invoke the RPC
    expect(report.environment).toBe("browser");
    expect(reportCheck(report, "cacheRoot").status).toBe("info");
    expect(reportCheck(report, "cacheRoot").detail).toContain("no Tauri shell");
    expect(reportCheck(report, "assetProtocol").status).toBe("info");
    expect(reportCheck(report, "pack").status).toBe("info");
    expect(reportCheck(report, "replayMap").status).toBe("pass");
    expect(reportCheck(report, "shipModels").status).toBe("pass");
    expect(reportCheck(report, "sessionFailures").status).toBe("pass");
  });

  it("reports a rejected res_cache_root RPC with the command error", async () => {
    const report = await runChecks(
      { ships: [] },
      baseOverrides({
        resCacheRoot: async () => {
          throw new Error("res_cache_root is not registered");
        },
        fetch: routedFetch(() => statusResponse(404)),
      }),
    );
    const cache = reportCheck(report, "cacheRoot");
    expect(cache.status).toBe("fail");
    expect(cache.detail).toContain("res_cache_root rejected");
    expect(cache.detail).toContain("not registered");
  });

  it("fails the cache-root link when the RPC answers null and the loader is unwired", async () => {
    const report = await runChecks(
      { ships: ONE_SHIP },
      baseOverrides({
        cacheRoot: null,
        resCacheRoot: async () => null,
        fetch: routedFetch(() => statusResponse(404)),
        shipCandidates: () => ["/models/ships/alpha.glb"],
        minimapJsonUrl: () => "/models/maps/minimaps.json",
      }),
    );

    expect(reportCheck(report, "cacheRoot").status).toBe("fail");
    expect(reportCheck(report, "cacheRoot").detail).toContain("res_cache_root = null");
    expect(reportCheck(report, "assetProtocol").status).toBe("fail");
    expect(reportCheck(report, "assetProtocol").detail).toContain("no pack cache root");
    expect(reportCheck(report, "pack").status).toBe("fail");
  });

  it("marks the unwired cache as fallback when the embedded pack serves (mobile bundle)", async () => {
    const report = await runChecks(
      { mapId: "15_NE_north", ships: ONE_SHIP },
      baseOverrides({
        cacheRoot: null,
        resCacheRoot: async () => null,
        fetch: routedFetch((url) => {
          if (url === "/models/maps/minimaps.json") {
            return jsonResponse({ "15_NE_north": {} });
          }
          if (url === "/models/maps/15_ne_north.glb") return glbResponse();
          if (url === "/models/ships/alpha.glb") return glbResponse();
          return statusResponse(404);
        }),
        shipCandidates: () => ["/models/ships/alpha.glb"],
        mapModelUrl: () => "/models/maps/15_ne_north.glb",
        minimapJsonUrl: () => "/models/maps/minimaps.json",
      }),
    );
    expect(reportCheck(report, "cacheRoot").status).toBe("fallback");
    expect(reportCheck(report, "cacheRoot").detail).toContain("embedded same-origin");
    expect(reportCheck(report, "pack").status).toBe("fallback");
    expect(reportCheck(report, "replayMap").status).toBe("pass");
    expect(reportCheck(report, "shipModels").status).toBe("pass");
  });

  it("surfaces a transport failure on the asset protocol as the smoking gun", async () => {
    const report = await runChecks(
      { ships: [] },
      baseOverrides({
        fetch: routedFetch(() => {
          throw new TypeError("Failed to fetch");
        }),
      }),
    );

    const asset = reportCheck(report, "assetProtocol");
    expect(asset.status).toBe("fail");
    expect(asset.detail).toContain("fetch failed");
    expect(asset.detail).toContain("Failed to fetch");
    expect(asset.detail).toContain(CACHE_ROOT + "/.res-version.json");
    // The RPC itself is healthy — the protocol is the broken link.
    expect(reportCheck(report, "cacheRoot").status).toBe("pass");
  });

  it("classifies a 403 as a scope/permission gap", async () => {
    const report = await runChecks(
      { ships: [] },
      baseOverrides({
        fetch: routedFetch((url) =>
          url === packUrl(".res-version.json")
            ? statusResponse(403)
            : statusResponse(404),
        ),
      }),
    );
    const asset = reportCheck(report, "assetProtocol");
    expect(asset.status).toBe("fail");
    expect(asset.detail).toContain("HTTP 403");
    expect(asset.detail).toContain("scope");
  });

  it("treats a reachable 404 stamp as fallback, not a protocol failure", async () => {
    const report = await runChecks(
      { mapId: "15_NE_north", ships: ONE_SHIP },
      baseOverrides({
        fetch: routedFetch((url) => {
          if (url === packUrl(".res-version.json")) return statusResponse(404);
          if (url === packUrl("models/maps/minimaps.json")) {
            return jsonResponse({ "15_NE_north": {} });
          }
          if (url === packUrl("models/maps/15_ne_north.glb")) return glbResponse();
          if (url === packUrl("models/ships/alpha.glb")) return glbResponse();
          return statusResponse(404);
        }),
        shipCandidates: () => [packUrl("models/ships/alpha.glb")],
        mapModelUrl: () => packUrl("models/maps/15_ne_north.glb"),
      }),
    );
    expect(reportCheck(report, "assetProtocol").status).toBe("fallback");
    expect(reportCheck(report, "assetProtocol").detail).toContain("HTTP 404");
    expect(reportCheck(report, "assetProtocol").detail).toContain(".res-version.json");
    // The stamp is missing but the pack content is reachable -> yellow pack.
    expect(reportCheck(report, "pack").status).toBe("fallback");
  });

  it("rejects an HTML SPA fallback wearing a 200 as a stamp", async () => {
    const report = await runChecks(
      { ships: [] },
      baseOverrides({
        fetch: routedFetch((url) =>
          url === packUrl(".res-version.json")
            ? htmlResponse()
            : statusResponse(404),
        ),
      }),
    );
    const asset = reportCheck(report, "assetProtocol");
    expect(asset.status).toBe("fail");
    expect(asset.detail).toContain("not JSON");
  });
});

describe("replay map assets (check 4)", () => {
  it("fails when minimaps.json exists but does not carry this replay mapId", async () => {
    const report = await runChecks(
      { mapId: "44_NE_other", ships: [] },
      baseOverrides({
        fetch: routedFetch((url) => {
          if (url === packUrl(".res-version.json")) {
            return jsonResponse({ version: "v1" });
          }
          if (url === packUrl("models/maps/minimaps.json")) {
            return jsonResponse({ "15_NE_north": {} });
          }
          if (url === packUrl("models/maps/44_ne_other.glb")) return glbResponse();
          return statusResponse(404);
        }),
        mapModelUrl: () => packUrl("models/maps/44_ne_other.glb"),
      }),
    );
    const map = reportCheck(report, "replayMap");
    expect(map.status).toBe("fail");
    expect(map.detail).toContain("44_NE_other");
    expect(map.detail).toContain("NOT in minimaps.json");
  });

  it("classifies a map GLB served only by the embedded copy as fallback", async () => {
    const cacheUrl = packUrl("models/maps/15_ne_north.glb");
    const embeddedUrl = "/models/maps/15_ne_north.glb";
    const report = await runChecks(
      { mapId: "15_NE_north", ships: [] },
      baseOverrides({
        fetch: routedFetch((url) => {
          if (url === packUrl(".res-version.json")) {
            return jsonResponse({ version: "v1" });
          }
          if (url === packUrl("models/maps/minimaps.json")) {
            return jsonResponse({ "15_NE_north": {} });
          }
          if (url === cacheUrl) return statusResponse(404);
          if (url === embeddedUrl) return glbResponse();
          return statusResponse(404);
        }),
        mapModelUrl: () => cacheUrl,
      }),
    );
    const map = reportCheck(report, "replayMap");
    expect(map.status).toBe("fallback");
    expect(map.detail).toContain(embeddedUrl);
    expect(report.missingShips).toEqual([]);
  });
});

describe("per-roster-ship models (check 5)", () => {
  const SHIPS: ReplayResourceShip[] = [
    { shipId: 11, name: "Lion" },
    { shipId: 12, name: "Monarch" },
    { shipId: 13, name: "Hanzo" },
  ];
  const candidatesByShip = new Map<number, string[]>([
    [11, [packUrl("models/ships/ydshade.glb")]],
    [12, [packUrl("models/ships/kase_joti.glb")]],
    [13, [packUrl("models/ships/hanzo.glb")]],
  ]);

  function shipFetch(url: string): Response {
    if (url === packUrl(".res-version.json")) return jsonResponse({ version: "v1" });
    if (url === packUrl("models/maps/minimaps.json")) return jsonResponse({});
    if (url === packUrl("models/ships/hanzo.glb")) return glbResponse();
    // ydshade: cache miss, embedded copy present -> fallback.
    if (url === "/models/ships/ydshade.glb") return glbResponse();
    // kase_joti: both rungs miss -> missing.
    return statusResponse(404);
  }

  it("derives the missing list with ship names and marks the embedded fallback", async () => {
    const report = await runChecks(
      { ships: SHIPS },
      baseOverrides({
        fetch: routedFetch(shipFetch),
        shipCandidates: (shipId) => candidatesByShip.get(Number(shipId)) ?? [],
      }),
    );

    const ships = reportCheck(report, "shipModels");
    expect(ships.status).toBe("fail");
    expect(report.missingShips).toEqual(["kase_joti(Monarch)"]);
    expect(report.fallbackShips).toEqual(["ydshade(Lion)"]);
    expect(ships.detail).toContain("1 missing");
    expect(ships.detail).toContain("1 embedded fallback");
    expect(ships.detail).toContain("first miss:");
    expect(report.missingShips.join(", ")).not.toContain("hanzo");
    expect(ships.extra?.join(" | ")).toContain("ships/kase_joti.glb");
  });

  it("passes when every roster hull resolves, and carries no missing list", async () => {
    const report = await runChecks(
      { ships: ONE_SHIP },
      baseOverrides({
        fetch: routedFetch((url) => {
          if (url === packUrl(".res-version.json")) {
            return jsonResponse({ version: "v1" });
          }
          if (url === packUrl("models/maps/minimaps.json")) return jsonResponse({});
          if (url === packUrl("models/ships/alpha.glb")) return glbResponse();
          return statusResponse(404);
        }),
        shipCandidates: () => [packUrl("models/ships/alpha.glb")],
      }),
    );
    expect(reportCheck(report, "shipModels").status).toBe("pass");
    expect(report.missingShips).toEqual([]);
    expect(report.fallbackShips).toEqual([]);
  });

  it("fails when no roster ship has a resolvable model URL (empty pack)", async () => {
    const report = await runChecks(
      {
        ships: [
          { shipId: 1, name: "Lion" },
          { shipId: 2, name: "Monarch" },
        ],
      },
      baseOverrides({
        fetch: routedFetch((url) => {
          if (url === packUrl(".res-version.json")) {
            return jsonResponse({ version: "v1" });
          }
          if (url === packUrl("models/maps/minimaps.json")) return jsonResponse({});
          return statusResponse(404);
        }),
        shipCandidates: () => [],
      }),
    );
    const ships = reportCheck(report, "shipModels");
    expect(ships.status).toBe("fail");
    expect(report.missingShips).toEqual(["Lion", "Monarch"]);
    expect(ships.detail).toContain("0 reachable");
    expect(ships.detail).toContain("no stem");
  });

  it("caps the roster probe count on a large roster", async () => {
    const ships: ReplayResourceShip[] = Array.from({ length: 40 }, (_, i) => ({
      shipId: 1000 + i,
      name: "Ship" + i,
    }));
    let shipFetches = 0;
    const report = await runChecks(
      { ships },
      baseOverrides({
        fetch: routedFetch((url) => {
          if (decodeURIComponent(url).includes("/ships/")) shipFetches += 1;
          if (url === packUrl(".res-version.json")) {
            return jsonResponse({ version: "v1" });
          }
          if (url === packUrl("models/maps/minimaps.json")) return jsonResponse({});
          return statusResponse(404);
        }),
        shipCandidates: (shipId) => [
          packUrl("models/ships/ship" + Number(shipId) + ".glb"),
        ],
      }),
    );
    // 24 ships x (cache rung + embedded rung) — bounded, and the report
    // says the roster was sampled.
    expect(shipFetches).toBe(48);
    expect(reportCheck(report, "shipModels").detail).toContain("probed 24/40");
  });
});

describe("session load failures (check 6)", () => {
  it("aggregates the model loader logged per-ship failures with the last error", async () => {
    const report = await runChecks(
      { ships: ONE_SHIP },
      baseOverrides({
        fetch: routedFetch((url) => {
          if (url === packUrl(".res-version.json")) {
            return jsonResponse({ version: "v1" });
          }
          if (url === packUrl("models/maps/minimaps.json")) return jsonResponse({});
          if (url === packUrl("models/ships/alpha.glb")) return glbResponse();
          return statusResponse(404);
        }),
        shipCandidates: () => [packUrl("models/ships/alpha.glb")],
        sessionFailures: () => [
          {
            file: "ships/gone.glb",
            chain: ["ships/gone.glb", "ships/Backup.glb"],
            reason: "ships/gone.glb: missing from the model pack",
            at: 1,
            count: 2,
          },
        ],
      }),
    );

    const failures = reportCheck(report, "sessionFailures");
    expect(failures.status).toBe("fail");
    expect(failures.detail).toContain("1 ship model load failure(s)");
    expect(failures.detail).toContain("ships/gone.glb");
    expect(failures.detail).toContain("missing from the model pack");
    expect(failures.extra?.join(" | ")).toContain("(x2)");
  });

  it("passes when the session logged no ship model failure", async () => {
    const report = await runChecks(
      { ships: [] },
      baseOverrides({
        fetch: routedFetch((url) =>
          url === packUrl(".res-version.json")
            ? jsonResponse({ version: "v1" })
            : statusResponse(404),
        ),
        sessionFailures: () => [],
      }),
    );
    expect(reportCheck(report, "sessionFailures").status).toBe("pass");
    expect(reportCheck(report, "sessionFailures").detail).toContain(
      "no ship model load failures",
    );
  });
});

describe("run queueing", () => {
  it("queues a new view's run behind an in-flight run instead of reusing it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setReplayResourceContext({
      mapId: "map-a",
      replayPath: "slow",
      ships: [],
    });
    const slow = runResourceHealthChecks(
      baseOverrides({
        fetch: routedFetch(async () => {
          await gate;
          return statusResponse(404);
        }),
      }),
    );
    // A new view arrives while the first run is still fetching.
    setReplayResourceContext({
      mapId: "map-b",
      replayPath: "fast",
      ships: [],
    });
    const fast = runResourceHealthChecks(
      baseOverrides({
        fetch: routedFetch(() => statusResponse(404)),
      }),
    );
    release();
    const [slowReport, fastReport] = await Promise.all([slow, fast]);
    expect(slowReport.mapId).toBe("map-a");
    expect(fastReport.mapId).toBe("map-b");
    // Only the CURRENT view's report lands in the shared state.
    expect(getResourceHealthReport()!.mapId).toBe("map-b");
  });
});

describe("automatic run on replay-view open", () => {
  function stubFetchForAutoRun(): void {
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("minimaps.json")) return Promise.resolve(jsonResponse({}));
      return Promise.resolve(statusResponse(404));
    });
  }

  it("runs once when the view opens with a session ship-model failure", async () => {
    // No failure yet: opening the view must NOT run the chain.
    setReplayResourceContext({
      mapId: "15_NE_north",
      replayPath: "auto-1",
      ships: [],
    });
    expect(getResourceHealthReport()).toBeNull();

    stubFetchForAutoRun();
    await loadGlbModel("/models/ships/Missing.glb").catch(() => {});
    // The failure notification arms the run for the already-open view.
    await vi.waitFor(() => expect(getResourceHealthReport()).not.toBeNull());
    const first = getResourceHealthReport();
    expect(reportCheck(first!, "sessionFailures").status).toBe("fail");

    // A second failure in the SAME view must not run again.
    await loadGlbModel("/models/ships/AlsoMissing.glb").catch(() => {});
    await Promise.resolve();
    expect(getResourceHealthReport()).toBe(first);

    // A new view (new replayPath) re-arms exactly once.
    setReplayResourceContext({
      mapId: "44_NE_other",
      replayPath: "auto-2",
      ships: [],
    });
    await vi.waitFor(() => {
      const next = getResourceHealthReport();
      expect(next).not.toBeNull();
      expect(next).not.toBe(first);
    });
    expect(getResourceHealthReport()!.mapId).toBe("44_NE_other");
  });

  it("auto-runs for a structurally unavailable ship (no model URL at all)", async () => {
    setReplayResourceContext({
      mapId: "15_NE_north",
      replayPath: "no-url",
      ships: [],
    });
    stubFetchForAutoRun();
    noteShipModelUnavailable("Lion", "no model URL");
    await vi.waitFor(() => expect(getResourceHealthReport()).not.toBeNull());
    expect(
      reportCheck(getResourceHealthReport()!, "sessionFailures").detail,
    ).toContain("Lion");
  });

  it("does not auto-run when the view opens with no session failure", async () => {
    setReplayResourceContext({
      mapId: "15_NE_north",
      replayPath: "quiet",
      ships: [],
    });
    await Promise.resolve();
    expect(getResourceHealthReport()).toBeNull();
  });
});
