/** Tests for runtime model availability: the ship GLBs are gitignored, so a
 *  build from a fresh checkout globs an EMPTY res/models/ships directory.
 *  Once the Tauri shell wires the downloaded model-pack cache, URL
 *  construction must trust the stem (optimistic) instead of the build-time
 *  glob — otherwise every ship renders the placeholder hull even though the
 *  runtime pack is fully populated. */
import { beforeAll, describe, expect, it } from "vitest";

import { initModelPack, resolveShipModelByShipId, resolvePropModelUrl } from "./modelLoader";

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
