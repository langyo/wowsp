/**
 * Config store: the install list's presentation-level ignore list. Removing
 * a row must (a) drop it from the list, (b) keep `detect()` from
 * resurrecting it, and (c) answer `isIgnoredPath` so the data surfaces that
 * read the RUST scan — which knows nothing of this ignore — can leave the
 * client's replays out of the rail/charts together with its row. Re-pinning
 * the folder manually lifts the ignore. API mocked, no transport involved
 * (the pairing.test pattern).
 */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const detected = [
  { kind: "steam" as const, path: "D:/SteamLibrary/steamapps/common/World of Warships", realm: "asia" },
  { kind: "cn360" as const, path: "D:/World_of_Warships_CN360", realm: "cn" },
];

vi.mock("@/api", () => ({
  api: {
    getGameConfig: vi.fn(async () => ({ activePath: detected[0]!.path })),
    detectGameInstall: vi.fn(async () => detected.map((i) => ({ ...i }))),
    setGameConfig: vi.fn(async () => null),
    setGamePath: vi.fn(async (path: string) => ({
      kind: "manual" as const,
      path,
      realm: null,
    })),
  },
}));

import { useConfigStore } from "./config";

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe("install ignore list", () => {
  it("marks a removed install ignored and keeps detect() from resurrecting it", async () => {
    const store = useConfigStore();
    await store.detect();
    expect(store.installs).toHaveLength(2);
    expect(store.isIgnoredPath(detected[1]!.path)).toBe(false);

    await store.removeInstall(detected[1]!.path);
    expect(store.installs.map((i) => i.path)).toEqual([detected[0]!.path]);
    expect(store.isIgnoredPath(detected[1]!.path)).toBe(true);
    // Spelling-insensitive, like every other path comparison: the data
    // surfaces compare the RUST scan's spelling against this list.
    expect(store.isIgnoredPath("d:\\world_of_warships_cn360\\")).toBe(true);

    // A rescan (the 游戏路径 refresh button) must not bring the row back.
    await store.detect();
    expect(store.installs.map((i) => i.path)).toEqual([detected[0]!.path]);
    expect(store.isIgnoredPath(detected[1]!.path)).toBe(true);
  });

  it("lifts the ignore when the folder is pinned manually again", async () => {
    const store = useConfigStore();
    await store.detect();
    await store.removeInstall(detected[1]!.path);
    expect(store.isIgnoredPath(detected[1]!.path)).toBe(true);

    await store.setManualPath(detected[1]!.path);
    expect(store.isIgnoredPath(detected[1]!.path)).toBe(false);
    expect(store.installs.some((i) => i.path === detected[1]!.path)).toBe(true);
  });

  it("treats an unknown / empty path as not ignored", async () => {
    const store = useConfigStore();
    await store.detect();
    expect(store.isIgnoredPath("")).toBe(false);
    expect(store.isIgnoredPath(null)).toBe(false);
    expect(store.isIgnoredPath(undefined)).toBe(false);
    expect(store.isIgnoredPath("E:\\Never\\Installed")).toBe(false);
  });
});
