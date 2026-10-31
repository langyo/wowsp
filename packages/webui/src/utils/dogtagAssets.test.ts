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
    // The Tauri shell signal initDogtagPack gates on (see utils/platform).
    window.__TAURI_INTERNALS__ = {
      convertFileSrc: () => "asset://localhost/x",
    };
  });

  it("resolves lookups from the bundled map before the pack lands", async () => {
    const { default: bundled } = await import("@/data/dogtags_map.json");
    const mod = await import("./dogtagAssets");
    const [sampleId, sampleRow] = Object.entries(bundled)[0];
    const id = Number(sampleId);
    expect(mod.dogtagEntry(id)?.[0]).toBe(sampleRow[0]);
    expect(mod.dogtagEntry(null)).toBeNull();
    expect(mod.dogtagEntry(1)).toBeNull();
  });

  it("keeps bundled URLs when the pack download fails", async () => {
    const mod = await import("./dogtagAssets");
    await mod.initDogtagPack(() => Promise.reject(new Error("offline")));
    expect(mod.dogtagAssetUrl("PCNP053.webp")).toBe("/dogtags/PCNP053.webp");
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
    expect(mod.dogtagAssetUrl("PCNP999.webp")).toBe("asset://localhost/C:/cache/dogtags/PCNP999.webp");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/dogtags/dogtags_map.json"),
    );
  });

  it("chains pack .webp → pack .png → bundled snapshot when the pack is wired", async () => {
    const fetchMock = mockFetch(PACK_MAP);
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("./dogtagAssets");
    await mod.initDogtagPack(() => Promise.resolve("C:/cache"));

    // Best-first: the pack's WebP, the same path as PNG (a legacy all-.png
    // pack generation), then the bundled same-origin snapshot — so one
    // missing pack file degrades a single part instead of every badge.
    expect(mod.dogtagUrlChain("PCNP999.webp")).toEqual([
      "asset://localhost/C:/cache/dogtags/PCNP999.webp",
      "asset://localhost/C:/cache/dogtags/PCNP999.png",
      "/dogtags/PCNP999.webp",
    ]);
    // Directory parts chain the same way.
    expect(mod.dogtagUrlChain("PCNA001/border.webp")).toEqual([
      "asset://localhost/C:/cache/dogtags/PCNA001/border.webp",
      "asset://localhost/C:/cache/dogtags/PCNA001/border.png",
      "/dogtags/PCNA001/border.webp",
    ]);
  });

  it("serves only the bundled snapshot in the chain when the pack is absent", async () => {
    const mod = await import("./dogtagAssets");
    await mod.initDogtagPack(() => Promise.reject(new Error("offline")));
    expect(mod.dogtagUrlChain("PCNP053.webp")).toEqual(["/dogtags/PCNP053.webp"]);
  });

  it("falls back to the bundled map when the pack map fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    const mod = await import("./dogtagAssets");
    await mod.initDogtagPack(() => Promise.resolve("C:/cache"));
    expect(mod.dogtagEntry(9999999999)).toBeNull();
    expect(mod.dogtagAssetUrl("PCNA001/border.webp")).toBe(
      "asset://localhost/C:/cache/dogtags/PCNA001/border.webp",
    );
  });

  it("keeps bundled URLs in a plain browser even when a cache root is reported", async () => {
    // `?mobileApp=1` browser emulation: the mock backend answers
    // res_cache_root with a Windows path, but without the Tauri shell
    // convertFileSrc would throw at call time — initDogtagPack must stay
    // unwired and every URL resolve from the bundled publicDir instead.
    delete window.__TAURI_INTERNALS__;
    const fetchMock = mockFetch(PACK_MAP);
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("./dogtagAssets");
    await mod.initDogtagPack(() => Promise.resolve("C:/cache"));
    expect(convertFileSrc).not.toHaveBeenCalled();
    expect(mod.dogtagAssetUrl("PCNP053.webp")).toBe("/dogtags/PCNP053.webp");
    expect(mod.dogtagEntry(9999999999)).toBeNull();
  });
});

describe("map entry coercion (bundled + pack)", () => {
  // Both sources feed the same tuple map whose 3rd slot the renderer reads as
  // the plate/border tint. A post-merge review dropped that slot and the whole
  // suite stayed green, and the pack path (the UNTRUSTED source) was a
  // wholesale assertion with no length guard at all.
  function withInternals(): { path: string } {
    delete window.__TAURI_INTERNALS__;
    window.__TAURI_INTERNALS__ = { convertFileSrc: (p: string) => `asset://localhost/${p}` };
    return { path: "C:/cache" };
  }

  it("keeps the 3-element tuple the renderer reads, and skips malformed rows", async () => {
    withInternals();
    const fetchMock = mockFetch({
      "4238887856": ["PCNP053", "Patch", "#ff0000"], // 3-tuple: tint wins
      "123": ["ONLY_ONE"], // too short
      "456": ["A", "B", "C", "D"], // too long
      "789": ["A", 42], // non-string cell
      "9999999999": ["PCNP999", "Patch"],
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    const mod = await import("./dogtagAssets");
    await mod.initDogtagPack(() => Promise.resolve("C:/cache"));

    expect(mod.dogtagEntry(4238887856)).toEqual(["PCNP053", "Patch", "#ff0000"]);
    expect(mod.dogtagEntry(9999999999)).toEqual(["PCNP999", "Patch"]);
    // Malformed rows are SKIPPED, not asserted into a shape the lookups would
    // index off the end of.
    expect(mod.dogtagEntry(123)).toBeNull();
    expect(mod.dogtagEntry(456)).toBeNull();
    expect(mod.dogtagEntry(789)).toBeNull();
  });
});
