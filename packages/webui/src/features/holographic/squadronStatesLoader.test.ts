/** Unit tests for the squadron-state loader (cached once per replay
 *  path, failure-tolerant). The api module is mocked; every test re-imports
 *  the loader so its module-level cache starts fresh. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api", () => ({ api: { readReplaySquadronStates: vi.fn() } }));

const events = (planeId: number) => ({ health: [{ time: 1, planeId, hp: 1 }] });

beforeEach(() => {
  vi.resetModules();
});

async function freshLoader() {
  const { api } = await import("@/api");
  const loader = await import("./squadronStatesLoader");
  return { fetch: vi.mocked(api.readReplaySquadronStates), loader };
}

describe("loadSquadronStates", () => {
  it("fetches once per path and shares the resolved promise", async () => {
    const { fetch, loader } = await freshLoader();
    fetch.mockResolvedValue(events(1));
    const [a, b] = await Promise.all([
      loader.loadSquadronStates("replay A"),
      loader.loadSquadronStates("replay A"),
    ]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("replay A");
    expect(a).toBe(b);
  });

  it("fetches distinct paths separately", async () => {
    const { fetch, loader } = await freshLoader();
    fetch.mockResolvedValueOnce(events(1)).mockResolvedValueOnce(events(2));
    await Promise.all([
      loader.loadSquadronStates("replay A"),
      loader.loadSquadronStates("replay B"),
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("resolves EMPTY on failure and retries on the next call", async () => {
    const { fetch, loader } = await freshLoader();
    fetch.mockRejectedValueOnce(new Error("transport boom"));
    // Successes after the rejection prove the evicted entry re-fetches
    // instead of poisoning the cache with EMPTY for the session.
    fetch.mockResolvedValue(events(1));
    const failed = await loader.loadSquadronStates("replay A");
    expect(failed).toBe(loader.EMPTY_SQUADRON_STATES);
    const retried = await loader.loadSquadronStates("replay A");
    expect(retried).toEqual(events(1));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps only the most recent paths (FIFO retention)", async () => {
    const { fetch, loader } = await freshLoader();
    fetch.mockResolvedValue(events(1));
    await loader.loadSquadronStates("A");
    await loader.loadSquadronStates("B");
    await loader.loadSquadronStates("C");
    // D evicts A: re-loading A must fetch again, C stays cached.
    await loader.loadSquadronStates("D");
    await loader.loadSquadronStates("C");
    await loader.loadSquadronStates("A");
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});
