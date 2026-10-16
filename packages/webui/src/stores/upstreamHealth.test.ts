/** Upstream-health store: the fault verdict rule (streak, freshness,
 *  success-recovery), episode keys, dismiss semantics and the debounced
 *  refresh plumbing. */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, type UpstreamHostReport } from "@/api";
import {
  faultKey,
  hostIsFailing,
  useUpstreamHealthStore,
  FAULT_STALE_SECS,
} from "./upstreamHealth";

function row(overrides: Partial<UpstreamHostReport> = {}): UpstreamHostReport {
  return {
    id: "vortex-cn",
    host: "vortex.wowsgame.cn",
    purpose: "statsVortex",
    realms: ["cn"],
    kind: "stats",
    recorded: true,
    consecutiveFailures: 0,
    lastSuccessTs: null,
    lastFailureTs: null,
    lastError: null,
    ...overrides,
  };
}

const NOW = 1_800_000_000;

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("hostIsFailing verdict", () => {
  it("needs the failure streak to reach two", () => {
    const one = row({ consecutiveFailures: 1, lastFailureTs: NOW - 10 });
    const two = row({ consecutiveFailures: 2, lastFailureTs: NOW - 10 });
    expect(hostIsFailing(one, NOW)).toBe(false);
    expect(hostIsFailing(two, NOW)).toBe(true);
  });

  it("goes stale after the stand-down window", () => {
    const fresh = row({ consecutiveFailures: 3, lastFailureTs: NOW - 60 });
    const stale = row({ consecutiveFailures: 3, lastFailureTs: NOW - FAULT_STALE_SECS - 1 });
    expect(hostIsFailing(fresh, NOW)).toBe(true);
    expect(hostIsFailing(stale, NOW)).toBe(false);
  });

  it("a success at or after the last failure recovers the host", () => {
    const recovered = row({
      consecutiveFailures: 0,
      lastFailureTs: NOW - 60,
      lastSuccessTs: NOW - 30,
    });
    expect(hostIsFailing(recovered, NOW)).toBe(false);
  });

  it("unrecorded hosts never fail", () => {
    const content = row({
      kind: "content",
      recorded: false,
      consecutiveFailures: 9,
      lastFailureTs: NOW - 10,
    });
    expect(hostIsFailing(content, NOW)).toBe(false);
  });

  it("rows without timestamps never fail", () => {
    expect(hostIsFailing(row({ consecutiveFailures: 5 }), NOW)).toBe(false);
  });
});

describe("faultKey", () => {
  it("is order-independent and ids-only", () => {
    const a = row({ id: "vortex-cn" });
    const b = row({ id: "clans-cn", host: "clans.wowsgame.cn" });
    expect(faultKey([a, b])).toBe(faultKey([b, a]));
    expect(faultKey([a, b])).toBe("clans-cn,vortex-cn");
  });

  it("changes when the failing cast changes", () => {
    const a = row({ id: "vortex-cn" });
    const b = row({ id: "clans-cn", host: "clans.wowsgame.cn" });
    expect(faultKey([a])).not.toBe(faultKey([a, b]));
  });
});

describe("upstreamHealth store", () => {
  it("dismisses the current episode and re-rings on a new host", () => {
    const store = useUpstreamHealthStore();
    const failing = [row({ id: "vortex-cn", consecutiveFailures: 3, lastFailureTs: NOW })];
    store.dismiss(failing);
    expect(store.dismissedKey).toBe(faultKey(failing));

    // Same episode: still silenced.
    const same = [row({ id: "vortex-cn", consecutiveFailures: 4, lastFailureTs: NOW + 5 })];
    expect(faultKey(same)).toBe(store.dismissedKey);
    // A NEW host joins: the key changes, the chip re-rings.
    const grown = [...same, row({ id: "clans-cn", host: "clans.wowsgame.cn" })];
    expect(faultKey(grown)).not.toBe(store.dismissedKey);
  });

  it("a healed episode clears the dismissal — the same hosts re-ring", async () => {
    const store = useUpstreamHealthStore();
    const failing = [row({ id: "vortex-cn", consecutiveFailures: 3, lastFailureTs: NOW })];
    store.dismiss(failing);
    expect(store.dismissedKey).toBe(faultKey(failing));

    // Everything heals (a success landed after the failures): the
    // next refresh retires the dismissal...
    vi.spyOn(api, "upstreamHealth").mockResolvedValueOnce([
      row({ id: "vortex-cn", consecutiveFailures: 0, lastFailureTs: NOW - 60, lastSuccessTs: NOW }),
    ]);
    await store.refresh();
    expect(store.dismissedKey).toBe("");

    // ...so the SAME host breaking again rings the chip instead of
    // staying silenced behind the stale dismissal.
    const reBroken = [row({ id: "vortex-cn", consecutiveFailures: 2, lastFailureTs: NOW + 60 })];
    expect(faultKey(reBroken)).not.toBe(store.dismissedKey);
  });

  it("refresh() replaces the table and survives a rejected invoke", async () => {
    const store = useUpstreamHealthStore();
    const table = [row({ consecutiveFailures: 2, lastFailureTs: NOW })];
    vi.spyOn(api, "upstreamHealth").mockResolvedValueOnce(table);
    await store.refresh();
    expect(store.entries).toEqual(table);

    vi.spyOn(api, "upstreamHealth").mockRejectedValueOnce(new Error("invoke down"));
    await store.refresh();
    // A failed refresh keeps the last table.
    expect(store.entries).toEqual(table);
  });

  it("scheduleRefresh debounces bursts into one invoke", async () => {
    vi.useFakeTimers();
    const store = useUpstreamHealthStore();
    const spy = vi.spyOn(api, "upstreamHealth").mockResolvedValue([]);
    store.scheduleRefresh();
    store.scheduleRefresh();
    store.scheduleRefresh();
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
