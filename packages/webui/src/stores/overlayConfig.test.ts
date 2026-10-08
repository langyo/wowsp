import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";

const { apiMock } = vi.hoisted(() => ({
  apiMock: { getOverlayConfig: vi.fn(), setOverlayConfig: vi.fn() },
}));
vi.mock("@/api", () => ({ api: apiMock }));
import { useOverlayConfigStore } from "./overlayConfig";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  setActivePinia(createPinia());
  apiMock.getOverlayConfig.mockResolvedValue({ table: "detect", roster: "plugin" });
  apiMock.setOverlayConfig.mockImplementation(async (table: string, roster: string) => ({ table, roster }));
});

describe("overlay settings persistence", () => {
  it("keeps every loader waiting for the same initial settings", async () => {
    const read = deferred<{ table: string; roster: string }>();
    apiMock.getOverlayConfig.mockReturnValueOnce(read.promise);
    const store = useOverlayConfigStore();
    const first = store.load();
    let secondFinished = false;
    const second = store.load().then(() => { secondFinished = true; });
    await flushPromises();
    expect(store.loaded).toBe(false);
    expect(secondFinished).toBe(false);
    expect(apiMock.getOverlayConfig).toHaveBeenCalledTimes(1);
    read.resolve({ table: "off", roster: "passive" });
    await Promise.all([first, second]);
    expect(store.loaded).toBe(true);
    expect(store.table).toBe("off");
  });

  it("loads the untouched setting before persisting a choice made during startup", async () => {
    const read = deferred<{ table: string; roster: string }>();
    apiMock.getOverlayConfig.mockReturnValueOnce(read.promise);
    const store = useOverlayConfigStore();
    const loading = store.load();
    const changing = store.setTable("off");
    await flushPromises();
    expect(apiMock.setOverlayConfig).not.toHaveBeenCalled();
    read.resolve({ table: "ingame", roster: "passive" });
    await Promise.all([loading, changing]);
    expect(apiMock.setOverlayConfig).toHaveBeenLastCalledWith("off", "passive");
    expect(store.table).toBe("off");
    expect(store.roster).toBe("passive");
  });

  it("orders writes and never applies an older reply over a newer choice", async () => {
    const store = useOverlayConfigStore();
    await store.load();
    const firstWrite = deferred<{ table: string; roster: string }>();
    apiMock.setOverlayConfig.mockReturnValueOnce(firstWrite.promise);
    const first = store.setTable("off");
    await flushPromises();
    const second = store.setRoster("passive");
    await flushPromises();
    expect(apiMock.setOverlayConfig).toHaveBeenCalledTimes(1);
    firstWrite.resolve({ table: "off", roster: "plugin" });
    await Promise.all([first, second]);
    expect(apiMock.setOverlayConfig).toHaveBeenLastCalledWith("off", "passive");
    expect(store.table).toBe("off");
    expect(store.roster).toBe("passive");
  });

  it("continues saving after a failure without losing the in-memory choices", async () => {
    const store = useOverlayConfigStore();
    await store.load();
    apiMock.setOverlayConfig.mockRejectedValueOnce(new Error("synthetic locked settings"));
    await store.setTable("off");
    await store.setRoster("passive");
    expect(apiMock.setOverlayConfig).toHaveBeenLastCalledWith("off", "passive");
    expect(store.table).toBe("off");
    expect(store.roster).toBe("passive");
  });
});
