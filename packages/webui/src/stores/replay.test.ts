import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, type ReplayMeta } from "@/api";
import { useReplayStore } from "./replay";
import { useReplayParser } from "@/features/replay/useReplayParser";

vi.mock("@/api", () => ({
  api: { readReplayHeader: vi.fn(), listReplaysMeta: vi.fn() },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const meta = (path: string): ReplayMeta => ({ path, vehicles: [], raw: {} });

beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
});

describe("replay selection", () => {
  it("retains the selected card across remounts while its header is pending", async () => {
    const pending = deferred<ReplayMeta>();
    vi.mocked(api.readReplayHeader).mockReturnValue(pending.promise);
    const firstView = useReplayParser();
    const opened = firstView.open("cn-match.wowsreplay");
    const remountedView = useReplayParser();
    expect(remountedView.current.value).toBeNull();
    expect(remountedView.selectedPath.value).toBe("cn-match.wowsreplay");
    pending.resolve(meta("cn-match.wowsreplay"));
    await opened;
    expect(remountedView.selectedPath.value).toBe(remountedView.current.value?.path);
    remountedView.clear();
    expect(remountedView.selectedPath.value).toBeNull();
  });

  it("keeps the newest selection when headers finish in reverse order", async () => {
    const old = deferred<ReplayMeta>();
    const latest = deferred<ReplayMeta>();
    vi.mocked(api.readReplayHeader).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const store = useReplayStore();
    const first = store.open("old.wowsreplay");
    const second = store.open("latest.wowsreplay");
    latest.resolve(meta("latest.wowsreplay"));
    await second;
    old.resolve(meta("old.wowsreplay"));
    await first;
    expect(store.current?.path).toBe("latest.wowsreplay");
    expect(store.loading).toBe(false);
  });

  it("keeps loading the latest selection after an older request fails", async () => {
    const old = deferred<ReplayMeta>();
    const latest = deferred<ReplayMeta>();
    vi.mocked(api.readReplayHeader).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const store = useReplayStore();
    store.current = meta("previous.wowsreplay");
    const first = store.open("old.wowsreplay");
    const second = store.open("latest.wowsreplay");
    expect(store.current).toBeNull();
    old.reject("old replay unreadable");
    await first;
    expect(store.loading).toBe(true);
    expect(store.error).toBeNull();
    latest.resolve(meta("latest.wowsreplay"));
    await second;
    expect(store.current?.path).toBe("latest.wowsreplay");
  });

  it("does not reopen a selection after it was cleared", async () => {
    const pending = deferred<ReplayMeta>();
    vi.mocked(api.readReplayHeader).mockReturnValue(pending.promise);
    const store = useReplayStore();
    const opened = store.open("closed.wowsreplay");
    store.clear();
    expect(store.loading).toBe(false);
    pending.resolve(meta("closed.wowsreplay"));
    await opened;
    expect(store.current).toBeNull();
  });

  it("cancels a pending selection when its external card is removed", async () => {
    const pending = deferred<ReplayMeta>();
    vi.mocked(api.readReplayHeader).mockReturnValue(pending.promise);
    const store = useReplayStore();
    store.external = [{ path: "removed.wowsreplay", playerCount: 0 }];
    const opened = store.open("removed.wowsreplay");
    store.removeExternal("removed.wowsreplay");
    pending.resolve(meta("removed.wowsreplay"));
    await opened;
    expect(store.external).toEqual([]);
    expect(store.current).toBeNull();
    expect(store.loading).toBe(false);
  });

  it("keeps a different pending selection when another card is removed", async () => {
    const pending = deferred<ReplayMeta>();
    vi.mocked(api.readReplayHeader).mockReturnValue(pending.promise);
    const store = useReplayStore();
    store.current = meta("removed.wowsreplay");
    const opened = store.open("selected.wowsreplay");
    store.removeExternal("removed.wowsreplay");
    pending.resolve(meta("selected.wowsreplay"));
    await opened;
    expect(store.current?.path).toBe("selected.wowsreplay");
  });

  it("shows string errors returned by Tauri commands", async () => {
    vi.mocked(api.readReplayHeader).mockRejectedValue("invalid replay header");
    const store = useReplayStore();
    await store.open("bad.wowsreplay");
    expect(store.error).toBe("invalid replay header");
    expect(store.current).toBeNull();
    expect(store.loading).toBe(false);
    expect(await store.addExternal(["bad.wowsreplay"])).toEqual({
      added: [], failed: [{ path: "bad.wowsreplay", error: "invalid replay header" }],
    });
  });
});
