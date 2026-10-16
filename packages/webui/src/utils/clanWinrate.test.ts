/** Tests for the clan-winrate lookup cache behind the hidden-profile 过街老鼠
 *  gate: successes pin forever, failures stay uncached (next call retries),
 *  and concurrent callers share one in-flight request per realm:clanId. The
 *  @/api transport is mocked at the module boundary — the happy-dom test env
 *  has no Tauri backend to invoke. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const lookupClanInfo = vi.fn();

vi.mock("@/api", () => ({
  api: {
    lookupClanInfo: (...args: unknown[]) => lookupClanInfo(...args),
  },
}));

describe("lookupClanWinrate", () => {
  // Each test re-imports the module for a fresh cache — module-scope Maps
  // would otherwise leak verdicts across cases.
  beforeEach(() => {
    vi.resetModules();
    lookupClanInfo.mockReset();
  });

  it("resolves the clan winrate and caches the success", async () => {
    lookupClanInfo.mockResolvedValue({ winrate: 56.2 });
    const { lookupClanWinrate } = await import("./clanWinrate");
    await expect(lookupClanWinrate("asia", 42)).resolves.toBe(56.2);
    // The second call is served from the cache — no second RPC.
    await expect(lookupClanWinrate("asia", 42)).resolves.toBe(56.2);
    expect(lookupClanInfo).toHaveBeenCalledTimes(1);
    // prAlgo stays unset: the aggregate winrate is algorithm-independent.
    expect(lookupClanInfo).toHaveBeenCalledWith(42, "asia");
  });

  it("does not cache failures — the next call retries", async () => {
    lookupClanInfo
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ winrate: 48 });
    const { lookupClanWinrate } = await import("./clanWinrate");
    await expect(lookupClanWinrate("eu", 7)).resolves.toBeNull();
    await expect(lookupClanWinrate("eu", 7)).resolves.toBe(48);
    expect(lookupClanInfo).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent callers onto one in-flight request", async () => {
    let release!: (v: { winrate: number }) => void;
    lookupClanInfo.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { lookupClanWinrate } = await import("./clanWinrate");
    const a = lookupClanWinrate("na", 9);
    const b = lookupClanWinrate("na", 9);
    release({ winrate: 51.5 });
    await expect(a).resolves.toBe(51.5);
    await expect(b).resolves.toBe(51.5);
    expect(lookupClanInfo).toHaveBeenCalledTimes(1);
  });

  it("keys the cache on realm AND clan id", async () => {
    lookupClanInfo
      .mockResolvedValueOnce({ winrate: 51 })
      .mockResolvedValueOnce({ winrate: 44 })
      .mockResolvedValueOnce({ winrate: 60 });
    const { lookupClanWinrate } = await import("./clanWinrate");
    await expect(lookupClanWinrate("na", 9)).resolves.toBe(51);
    // Same clan id on another realm, and another clan on the same realm —
    // distinct keys, three real requests.
    await expect(lookupClanWinrate("eu", 9)).resolves.toBe(44);
    await expect(lookupClanWinrate("na", 10)).resolves.toBe(60);
    expect(lookupClanInfo).toHaveBeenCalledTimes(3);
  });

  it("refuses garbage keys without an RPC (fail-open null)", async () => {
    const { lookupClanWinrate } = await import("./clanWinrate");
    // An empty realm (still resolving) or a non-finite clan id can only
    // produce a wrong answer — resolve like a failure, never invoke.
    await expect(lookupClanWinrate("", 9)).resolves.toBeNull();
    await expect(lookupClanWinrate("asia", Number.NaN)).resolves.toBeNull();
    expect(lookupClanInfo).not.toHaveBeenCalled();
  });
});
