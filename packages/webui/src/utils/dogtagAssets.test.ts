/** Tests for the dog-tag asset overlay: bundled-map lookups, the pack map
 *  overlay (pack wins per id) and the pack-aware part image URLs. The Tauri
 *  core module is mocked so initDogtagPack exercises the real fetch flow. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const convertFileSrc = vi.fn((path: string) => `asset://localhost/${encodeURI(path)}`);

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => convertFileSrc(path),
}));

/** The pack's map payload: one id already in the bundled snapshot plus one
 *  medal this build has never heard of. */
const PACK_MAP = {
  "4238887856": ["PCNP053", "Patch"],
  "9999999999": ["PCNP999", "Patch"],
};

function mockFetch(map: unknown, ok = true) {
  return vi.fn(async (url: string) => ({
    ok,
    json: async () => {
      if (url.endsWith("dogtags_map.json")) return map;
      throw new Error("unexpected json fetch: " + url);
    },
  }));
}

describe("dogtagAssets", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    convertFileSrc.mockClear();
  });

  it("resolves lookups from the bundled map before the pack lands", async () => {
    const { default: bundled } = await import("@/data/dogtags_map.json");
    const mod = await import("./dogtagAssets");
    const sample = Object.entries(bundled as unknown as Record<string, [string, string]>)[0];
    const id = Number(sample[0]);
    expect(mod.dogtagEntry(id)?.[0]).toBe(sample[1][0]);
    expect(mod.dogtagEntry(null)).toBeNull();
    expect(mod.dogtagEntry(1)).toBeNull();
  });

  it("keeps bundled URLs when the pack download fails", async () => {
    const mod = await import("./dogtagAssets");
    await mod.initDogtagPack(() => Promise.reject(new Error("offline")));
    expect(mod.dogtagAssetUrl("PCNP053.png")).toBe("/dogtags/PCNP053.png");
  });

  it("overlays the pack map and rewrites part URLs to the cache", async () => {
    const fetchMock = mockFetch(PACK_MAP);
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("./dogtagAssets");
    await mod.initDogtagPack(() => Promise.resolve("C:/cache"));

    // Pack wins per id, bundled entries stay intact, and the rewritten URL
    // points into the pack cache via convertFileSrc.
    expect(mod.dogtagEntry(4238887856)?.[0]).toBe("PCNP053");
    expect(mod.dogtagEntry(9999999999)?.[0]).toBe("PCNP999");
    // The overlay merges — an id only the bundled map knows survives.
    expect(mod.dogtagEntry(3247393712)?.[0]).toBe("PCNB999");
    expect(mod.dogtagAssetUrl("PCNP999.png")).toBe("asset://localhost/C:/cache/dogtags/PCNP999.png");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/dogtags/dogtags_map.json"),
    );
  });

  it("falls back to the bundled map when the pack map fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    const mod = await import("./dogtagAssets");
    await mod.initDogtagPack(() => Promise.resolve("C:/cache"));
    expect(mod.dogtagEntry(9999999999)).toBeNull();
    expect(mod.dogtagAssetUrl("PCNA001/border.png")).toBe(
      "asset://localhost/C:/cache/dogtags/PCNA001/border.png",
    );
  });
});
