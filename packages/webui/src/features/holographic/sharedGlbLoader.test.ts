/**
 * The shared @wowsp/holo GLB loader (packages/holo/src/glbLoader.ts) is the
 * model path the MARKETING SITE's two 3D showcases use — ReplayLive and the
 * ShipLive stage — and it is exercised from here because this package owns
 * the frontend vitest harness.
 *
 * The contract under test is CSP-shaped, not cosmetic: the deployed site's
 * CSP allows no `blob:` in connect-src (packages/website/src/res/_headers,
 * mirrored in packages/pairing-relay/crates/relay-core/src/headers.rs), so
 * handing GLTFLoader a blob: URL — which the loader then re-FETCHES — got
 * that fetch blocked, and the terrain plus every ship model silently
 * vanished from the homepage while the JSON/PNG assets kept loading.
 * loadGlb must therefore fetch ONCE, parse the buffer in memory, and never
 * mint a blob URL.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as THREE from "three";

import { loadGlb } from "@wowsp/holo";

// scripts/model_convert/optimize_glbs.py bakes the real assets with
// `gltf-transform optimize --compress meshopt`; this 1.9 KB fixture is the
// same format (EXT_meshopt_compression), shared with modelLoader.test.ts.
const FIXTURE = join(
  process.cwd(),
  "src",
  "features",
  "holographic",
  "modelLoader.fixtures",
  "meshopt-cube.glb",
);

describe("@wowsp/holo loadGlb (site CSP contract)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches once, parses in memory, and never mints a blob: URL", async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE)).buffer;
    const fetched: string[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      fetched.push(url);
      return Promise.resolve(new Response(bytes));
    });
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");

    const group = await loadGlb("/models/ships/meshopt-cube.glb");

    // The CSP contract: no blob: URL is created (so none can be fetched).
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(fetched).toEqual(["/models/ships/meshopt-cube.glb"]);

    // A real (WebAssembly) meshopt decode still ran — this is the parse path,
    // not a degraded "empty scene" pass.
    const meshes: THREE.Mesh[] = [];
    group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    expect(meshes.length).toBeGreaterThan(0);
    expect(meshes[0]!.geometry.getAttribute("position").count).toBeGreaterThan(0);
  });
});
