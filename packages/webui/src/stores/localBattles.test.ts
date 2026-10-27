/** LocalBattles store: same-window cache, concurrent dedupe, the pending
 *  decode follow-up rounds (bounded), the force path and per-account keys. */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, type LocalBattleLog } from "@/api";
import { MAX_PENDING_ROUNDS, useLocalBattlesStore } from "./localBattles";

vi.mock("@/api", () => ({
  api: {
    readLocalBattleLog: vi.fn(),
  },
}));

function log(overrides: Partial<LocalBattleLog> = {}): LocalBattleLog {
  return {
    battles: [],
    scanned: 0,
    decoded: 0,
    cacheHits: 0,
    pending: 0,
    ...overrides,
  };
}

const FROM = 1_759_000_000;
const TO = 1_760_000_000;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("localBattles store", () => {
  it("serves the same window from cache without re-invoking", async () => {
    const store = useLocalBattlesStore();
    vi.mocked(api.readLocalBattleLog).mockResolvedValue(log({ decoded: 6 }));

    const first = await store.load(101, "asia", FROM, TO);
    const second = await store.load(101, "asia", FROM, TO);

    expect(api.readLocalBattleLog).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    // The store's reactive Map hands back a proxy — compare by value.
    expect(store.logFor(101, "asia")).toEqual(first);
    expect(store.windowFor(101, "asia")).toEqual({ fromSec: FROM, toSec: TO });
  });

  it("dedupes concurrent identical loads into one request", async () => {
    const store = useLocalBattlesStore();
    vi.mocked(api.readLocalBattleLog).mockResolvedValue(log({ decoded: 6 }));

    const [a, b] = await Promise.all([
      store.load(101, "asia", FROM, TO),
      store.load(101, "asia", FROM, TO),
    ]);

    expect(api.readLocalBattleLog).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("fetches a different window", async () => {
    const store = useLocalBattlesStore();
    vi.mocked(api.readLocalBattleLog).mockResolvedValue(log());

    await store.load(101, "asia", FROM, TO);
    await store.load(101, "asia", FROM - 86400, TO);

    expect(api.readLocalBattleLog).toHaveBeenCalledTimes(2);
    expect(store.windowFor(101, "asia")).toEqual({ fromSec: FROM - 86400, toSec: TO });
  });

  it("force re-invokes even for a cached window", async () => {
    const store = useLocalBattlesStore();
    vi.mocked(api.readLocalBattleLog).mockResolvedValue(log());

    await store.load(101, "asia", FROM, TO);
    await store.load(101, "asia", FROM, TO, { force: true });

    expect(api.readLocalBattleLog).toHaveBeenCalledTimes(2);
  });

  it("follows up while the backend reports pending decode work", async () => {
    const store = useLocalBattlesStore();
    vi.mocked(api.readLocalBattleLog)
      .mockResolvedValueOnce(log({ pending: 2, decoded: 4 }))
      .mockResolvedValueOnce(log({ pending: 0, decoded: 6 }));

    const result = await store.load(101, "asia", FROM, TO);

    expect(api.readLocalBattleLog).toHaveBeenCalledTimes(2);
    expect(result.decoded).toBe(6);
    expect(result.pending).toBe(0);
  });

  it("caps the pending follow-up rounds", async () => {
    const store = useLocalBattlesStore();
    vi.mocked(api.readLocalBattleLog).mockResolvedValue(log({ pending: 3 }));

    const result = await store.load(101, "asia", FROM, TO);

    // one initial round + MAX_PENDING_ROUNDS follow-ups
    expect(api.readLocalBattleLog).toHaveBeenCalledTimes(1 + MAX_PENDING_ROUNDS);
    expect(result.pending).toBe(3);
    expect(store.loading).toBe(false);
  });

  it("records the error and clears loading on failure", async () => {
    const store = useLocalBattlesStore();
    vi.mocked(api.readLocalBattleLog).mockRejectedValue(new Error("decode failed"));

    await expect(store.load(101, "asia", FROM, TO)).rejects.toThrow("decode failed");
    expect(store.error).toBe("decode failed");
    expect(store.loading).toBe(false);
  });

  it("does not let a superseded window replace the current range", async () => {
    const store = useLocalBattlesStore();
    // The OLDER request (one-day window) resolves LAST — it must not
    // overwrite the newer window the user switched to.
    let resolveOld!: (value: LocalBattleLog) => void;
    let resolveNew!: (value: LocalBattleLog) => void;
    vi.mocked(api.readLocalBattleLog)
      .mockImplementationOnce(
        () => new Promise<LocalBattleLog>((resolve) => (resolveOld = resolve)),
      )
      .mockImplementationOnce(
        () => new Promise<LocalBattleLog>((resolve) => (resolveNew = resolve)),
      );

    const oldWindow = store.load(101, "asia", FROM - 86400, FROM);
    const newWindow = store.load(101, "asia", FROM, TO);

    resolveNew(log({ decoded: 7 }));
    await newWindow;
    resolveOld(log({ decoded: 1 }));
    await oldWindow;

    // The stale completion wrote neither the account's window nor its log…
    expect(store.windowFor(101, "asia")).toEqual({ fromSec: FROM, toSec: TO });
    expect(store.logFor(101, "asia")?.decoded).toBe(7);

    // …but switching back to the old window serves it from cache instantly.
    const switchedBack = await store.load(101, "asia", FROM - 86400, FROM);
    expect(switchedBack.decoded).toBe(1);
    expect(api.readLocalBattleLog).toHaveBeenCalledTimes(2);
    expect(store.windowFor(101, "asia")).toEqual({ fromSec: FROM - 86400, toSec: FROM });
  });

  it("adopts the joined window when switching back to a still-loading range", async () => {
    const store = useLocalBattlesStore();
    let resolveFirst!: (value: LocalBattleLog) => void;
    vi.mocked(api.readLocalBattleLog)
      .mockImplementationOnce(
        () => new Promise<LocalBattleLog>((resolve) => (resolveFirst = resolve)),
      )
      .mockResolvedValueOnce(log({ decoded: 2 }));

    const first = store.load(101, "asia", FROM, TO);
    // Switch to another window, which completes first…
    await store.load(101, "asia", FROM - 86400, FROM);
    expect(store.windowFor(101, "asia")).toEqual({ fromSec: FROM - 86400, toSec: FROM });
    // …then switch BACK to the first range while it is still decoding.
    const joined = store.load(101, "asia", FROM, TO);
    expect(api.readLocalBattleLog).toHaveBeenCalledTimes(2); // same in-flight call

    resolveFirst(log({ decoded: 1 }));
    await joined;
    await first;

    expect(store.windowFor(101, "asia")).toEqual({ fromSec: FROM, toSec: TO });
    expect(store.logFor(101, "asia")?.decoded).toBe(1);
  });

  it("keeps accounts isolated", async () => {
    const store = useLocalBattlesStore();
    vi.mocked(api.readLocalBattleLog)
      .mockResolvedValueOnce(log({ decoded: 1 }))
      .mockResolvedValueOnce(log({ decoded: 2 }));

    const first = await store.load(101, "asia", FROM, TO);
    const second = await store.load(202, "asia", FROM, TO);

    expect(api.readLocalBattleLog).toHaveBeenCalledTimes(2);
    expect(store.logFor(101, "asia")).toEqual(first);
    expect(store.logFor(202, "asia")).toEqual(second);
    expect(store.logFor(303, "asia")).toBeNull();
  });
});
