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
    getGameConfig: vi.fn(async () => ({ activePath: detected[0]!.path, replayDirs: [] })),
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
import { api, type GameInstall } from "@/api";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  setActivePinia(createPinia());
});

describe("active installation persistence", () => {
  const manual = { kind: "manual" as const, path: "E:/CustomWoWS", realm: "eu" };

  it("restores a remembered manual path even when automatic detection finds another client", async () => {
    vi.mocked(api.getGameConfig).mockResolvedValueOnce({ activePath: manual.path, replayDirs: [] });
    vi.mocked(api.setGamePath).mockResolvedValueOnce(manual);
    const store = useConfigStore();
    await store.load();
    await store.detect();
    expect(store.activeInstall).toEqual(manual);
    expect(store.installs).toContainEqual(manual);
    expect(api.setGameConfig).toHaveBeenLastCalledWith(manual.path);
  });

  it("keeps a valid manually added client selected on a later rescan", async () => {
    const store = useConfigStore();
    await store.detect();
    await store.setManualPath(manual.path);
    await store.detect();
    expect(store.activeInstall?.path).toBe(manual.path);
    expect(store.installs.some((i) => i.path === manual.path)).toBe(true);
  });

  it("does not let an older scan replace a manual selection made while it was pending", async () => {
    const store = useConfigStore();
    await store.detect();
    const scan = deferred<GameInstall[]>();
    vi.mocked(api.detectGameInstall).mockReturnValueOnce(scan.promise);
    const pending = store.detect();
    await store.setManualPath(manual.path);
    scan.resolve(detected);
    await pending;
    expect(store.activeInstall?.path).toBe(manual.path);
    expect(store.installs.some((i) => i.path === manual.path)).toBe(true);
    expect(api.setGameConfig).toHaveBeenLastCalledWith(manual.path);
  });

  it("keeps the newest scan result and busy state when scans complete out of order", async () => {
    const old = deferred<GameInstall[]>();
    const latest = deferred<GameInstall[]>();
    vi.mocked(api.detectGameInstall).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const store = useConfigStore();
    const first = store.detect();
    const second = store.detect();
    old.resolve([detected[0]!]);
    await first;
    expect(store.detecting).toBe(true);
    latest.resolve([detected[1]!]);
    await second;
    expect(store.activeInstall).toEqual(detected[1]);
    expect(store.detecting).toBe(false);
  });

  it("serializes captured selections so the last choice is the final persisted value", async () => {
    const store = useConfigStore();
    await store.detect();
    vi.mocked(api.setGameConfig).mockClear();
    const firstWrite = deferred<{ activePath: string | null; replayDirs: string[] }>();
    vi.mocked(api.setGameConfig).mockReturnValueOnce(firstWrite.promise);
    const first = store.selectInstall(detected[1]!.path);
    const second = store.selectInstall(detected[0]!.path);
    await Promise.resolve();
    expect(api.setGameConfig).toHaveBeenCalledTimes(1);
    expect(api.setGameConfig).toHaveBeenLastCalledWith(detected[1]!.path);
    firstWrite.resolve({ activePath: detected[1]!.path, replayDirs: [] });
    await Promise.all([first, second]);
    expect(api.setGameConfig).toHaveBeenLastCalledWith(detected[0]!.path);
  });

  it("reports explicit save errors and permits the next selection to persist", async () => {
    const store = useConfigStore();
    await store.detect();
    vi.mocked(api.setGameConfig).mockRejectedValueOnce(new Error("synthetic disk failure"));
    await expect(store.selectInstall(detected[1]!.path)).rejects.toThrow("synthetic disk failure");
    expect(store.activeInstall).toEqual(detected[0]);
    await store.selectInstall(detected[0]!.path);
    expect(api.setGameConfig).toHaveBeenLastCalledWith(detected[0]!.path);
  });

  it("does not publish a scan that started while a manual path was validating", async () => {
    const store = useConfigStore();
    const previous = { ...manual, path: "F:/OtherCustomWoWS" };
    vi.mocked(api.setGamePath).mockResolvedValueOnce(previous);
    await store.setManualPath(previous.path);
    const validation = deferred<GameInstall>();
    const revalidation = deferred<GameInstall>();
    vi.mocked(api.setGamePath)
      .mockReturnValueOnce(validation.promise)
      .mockReturnValueOnce(revalidation.promise);
    const selecting = store.setManualPath(manual.path);
    const detecting = store.detect();
    await Promise.resolve();
    expect(api.setGamePath).toHaveBeenLastCalledWith(previous.path);
    validation.resolve(manual);
    await selecting;
    revalidation.resolve(previous);
    await detecting;
    expect(store.activeInstall).toEqual(manual);
    expect(store.installs).toContainEqual(manual);
  });

  it("lets a scan following a failed choice use the last committed selection", async () => {
    const store = useConfigStore();
    await store.detect();
    const write = deferred<{ activePath: string | null; replayDirs: string[] }>();
    vi.mocked(api.setGameConfig).mockReturnValueOnce(write.promise);
    const selecting = store.selectInstall(detected[1]!.path);
    const failure = expect(selecting).rejects.toThrow("synthetic disk failure");
    const scanning = store.detect();
    await Promise.resolve();
    write.reject(new Error("synthetic disk failure"));
    await Promise.all([failure, scanning]);
    expect(store.activeInstall).toEqual(detected[0]);
    expect(api.setGameConfig).toHaveBeenLastCalledWith(detected[0]!.path);
  });

  it("keeps the last saved selection when two rapid choices both fail to save", async () => {
    vi.mocked(api.detectGameInstall).mockResolvedValueOnce([...detected, manual]);
    const store = useConfigStore();
    await store.detect();
    const firstWrite = deferred<{ activePath: string | null; replayDirs: string[] }>();
    const secondWrite = deferred<{ activePath: string | null; replayDirs: string[] }>();
    vi.mocked(api.setGameConfig).mockReturnValueOnce(firstWrite.promise).mockReturnValueOnce(secondWrite.promise);
    const first = expect(store.selectInstall(detected[1]!.path)).rejects.toThrow("first save failed");
    const second = expect(store.selectInstall(manual.path)).rejects.toThrow("second save failed");
    firstWrite.reject(new Error("first save failed"));
    await first;
    secondWrite.reject(new Error("second save failed"));
    await second;
    expect(store.activeInstall).toEqual(detected[0]);
  });

  it("does not publish an explicit choice until its write succeeds", async () => {
    const store = useConfigStore();
    await store.detect();
    const write = deferred<{ activePath: string | null; replayDirs: string[] }>();
    vi.mocked(api.setGameConfig).mockReturnValueOnce(write.promise);
    const selecting = store.selectInstall(detected[1]!.path);
    const scanning = store.detect();
    await Promise.resolve();
    expect(store.activeInstall).toEqual(detected[0]);
    write.resolve({ activePath: detected[1]!.path, replayDirs: [] });
    await Promise.all([selecting, scanning]);
    expect(store.activeInstall).toEqual(detected[1]);
    expect(api.setGameConfig).toHaveBeenLastCalledWith(detected[1]!.path);
  });

  it.each([false, true])("keeps a clicked row when an already-saving scan removes it (save failure=%s)", async (fails) => {
    const store = useConfigStore();
    await store.detect();
    const scanWrite = deferred<{ activePath: string | null; replayDirs: string[] }>();
    vi.mocked(api.detectGameInstall).mockResolvedValueOnce([detected[0]!]);
    vi.mocked(api.setGameConfig).mockClear().mockReturnValueOnce(scanWrite.promise);
    const scanning = store.detect();
    await vi.waitFor(() => expect(api.setGameConfig).toHaveBeenCalledTimes(1));
    if (fails) vi.mocked(api.setGameConfig).mockRejectedValueOnce(new Error("selection save failed"));
    const selecting = store.selectInstall(detected[1]!.path);
    const selectionResult = fails
      ? expect(selecting).rejects.toThrow("selection save failed")
      : expect(selecting).resolves.toBeUndefined();
    scanWrite.resolve({ activePath: detected[0]!.path, replayDirs: [] });
    await Promise.all([scanning, selectionResult]);
    expect(api.setGameConfig).toHaveBeenLastCalledWith(detected[1]!.path);
    expect(store.activeInstall).toEqual(detected[fails ? 0 : 1]);
    if (!fails) expect(store.installs).toContainEqual(detected[1]);
  });

  it("clears an earlier queued removal when the user explicitly reselects that row", async () => {
    const store = useConfigStore();
    await store.detect();
    const removing = store.removeInstall(detected[1]!.path);
    const selecting = store.selectInstall(detected[1]!.path);
    await Promise.all([removing, selecting]);
    expect(store.activeInstall).toEqual(detected[1]);
    expect(store.installs).toContainEqual(detected[1]);
    expect(store.isIgnoredPath(detected[1]!.path)).toBe(false);
  });

  it("remembers a clicked removal even if an already-saving scan removes its row first", async () => {
    const store = useConfigStore();
    await store.detect();
    const scanWrite = deferred<{ activePath: string | null; replayDirs: string[] }>();
    vi.mocked(api.detectGameInstall).mockResolvedValueOnce([detected[0]!]);
    vi.mocked(api.setGameConfig).mockClear().mockReturnValueOnce(scanWrite.promise);
    const scanning = store.detect();
    await vi.waitFor(() => expect(api.setGameConfig).toHaveBeenCalledTimes(1));
    const removing = store.removeInstall(detected[1]!.path);
    scanWrite.resolve({ activePath: detected[0]!.path, replayDirs: [] });
    await Promise.all([scanning, removing]);
    expect(store.isIgnoredPath(detected[1]!.path)).toBe(true);
    await store.detect();
    expect(store.installs).toEqual([detected[0]]);
  });

  it.each([false, true])("quietly ignores superseded manual validation (failure=%s)", async (fails) => {
    const store = useConfigStore();
    await store.detect();
    const validation = deferred<GameInstall>();
    vi.mocked(api.setGamePath).mockReturnValueOnce(validation.promise);
    const selecting = store.setManualPath(manual.path);
    await store.selectInstall(detected[1]!.path);
    if (fails) validation.reject(new Error("superseded folder validation failed"));
    else validation.resolve(manual);
    await expect(selecting).resolves.toBeNull();
    expect(store.activeInstall).toEqual(detected[1]);
    expect(store.installs).not.toContainEqual(manual);
    expect(api.setGameConfig).toHaveBeenLastCalledWith(detected[1]!.path);
  });

  it("restores a failed manual re-add without dropping its ignore entry", async () => {
    const store = useConfigStore();
    await store.detect();
    await store.removeInstall(detected[1]!.path);
    vi.mocked(api.setGameConfig).mockRejectedValueOnce(new Error("synthetic disk failure"));
    await expect(store.setManualPath(detected[1]!.path)).rejects.toThrow("synthetic disk failure");
    expect(store.activeInstall).toEqual(detected[0]);
    expect(store.installs).toEqual([detected[0]]);
    expect(store.isIgnoredPath(detected[1]!.path)).toBe(true);
  });

  it("restores the active row and ignore state if removing it cannot be saved", async () => {
    const store = useConfigStore();
    await store.detect();
    vi.mocked(api.setGameConfig).mockRejectedValueOnce(new Error("synthetic disk failure"));
    await expect(store.removeInstall(detected[0]!.path)).rejects.toThrow("synthetic disk failure");
    expect(store.activeInstall).toEqual(detected[0]);
    expect(store.installs).toEqual(detected);
    expect(store.isIgnoredPath(detected[0]!.path)).toBe(false);
  });

  it("does not restore stale startup config after an explicit selection", async () => {
    const read = deferred<{ activePath: string | null; replayDirs: string[] }>();
    vi.mocked(api.getGameConfig).mockReturnValueOnce(read.promise);
    const store = useConfigStore();
    const loading = store.load();
    await store.detect();
    await store.selectInstall(detected[1]!.path);
    read.resolve({ activePath: detected[0]!.path, replayDirs: [] });
    await loading;
    await store.detect();
    expect(store.activeInstall).toEqual(detected[1]);
  });
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
