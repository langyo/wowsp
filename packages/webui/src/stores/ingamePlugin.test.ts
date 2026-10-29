import { createPinia, setActivePinia } from "pinia";
import { nextTick, reactive } from "vue";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import { useGameStatusStore } from "./gameStatus";
import { useIngamePluginStore } from "./ingamePlugin";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  runProbe: vi.fn(),
  setSafeMode: vi.fn(),
}));
vi.mock("@/api", () => ({
  api: { ingamePluginStatus: vi.fn(), modHubSetSafeMode: mocks.setSafeMode },
}));
vi.mock("@/stores/config", () => ({ useConfigStore: mocks.config }));
vi.mock("@/stores/pluginUpdates", () => ({
  usePluginUpdatesStore: () => ({ probeBusy: null, runProbe: mocks.runProbe }),
}));

type Status = Awaited<ReturnType<typeof api.ingamePluginStatus>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const INSTALLED: Status = { installed: true, outdated: true, resMods: "test-res-mods", discussion: 1 };
const ABSENT: Status = { installed: false, outdated: false, resMods: "", discussion: 2 };
const SAFE: Status = { installed: false, outdated: false, safeMode: true, resMods: "", discussion: 2 };
const RESTORED: Status = { installed: true, outdated: false, safeMode: false, resMods: "test-res-mods", discussion: 1 };
let config = reactive({ activeInstall: { path: "C:/GameA" } as { path: string } | null });

beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
  config = reactive({ activeInstall: { path: "C:/GameA" } as { path: string } | null });
  mocks.config.mockReturnValue(config);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("plugin status request identity", () => {
  it.each(["success", "failure"])("ignores a previous install's late %s", async (outcome) => {
    const old = deferred<Status>();
    vi.mocked(api.ingamePluginStatus).mockReturnValueOnce(old.promise).mockResolvedValueOnce(ABSENT);
    const store = useIngamePluginStore();
    config.activeInstall = { path: "C:/GameB" };
    await flushPromises();
    if (outcome === "success") old.resolve(INSTALLED);
    else old.reject(new Error("old root locked"));
    await flushPromises();
    expect(store.gameRoot).toBe("C:/GameB");
    expect(store.installed).toBe(false);
    expect(store.probed).toBe(true);
    expect(store.discussion).toBe(2);
  });

  it("does not restore an old install after the selection is cleared", async () => {
    const old = deferred<Status>();
    vi.mocked(api.ingamePluginStatus).mockReturnValueOnce(old.promise);
    const store = useIngamePluginStore();
    config.activeInstall = null;
    await nextTick();
    old.resolve(INSTALLED);
    await flushPromises();
    expect(store.installed).toBe(false);
    expect(store.outdated).toBe(false);
    expect(store.probed).toBe(false);
    expect(store.discussion).toBeNull();
  });

  it("clears the previous install's action state while the next root is being probed", async () => {
    const pending = deferred<Status>();
    vi.mocked(api.ingamePluginStatus).mockResolvedValueOnce(INSTALLED).mockReturnValueOnce(pending.promise);
    const store = useIngamePluginStore();
    await flushPromises();
    config.activeInstall = { path: "C:/GameB" };
    const stateWhileLoading = { installed: store.installed, outdated: store.outdated, probed: store.probed, discussion: store.discussion };
    pending.resolve(ABSENT);
    await flushPromises();
    expect(stateWhileLoading).toEqual({ installed: false, outdated: false, probed: false, discussion: null });
  });

  it("clears probe-reported realms immediately when the active game install changes", () => {
    vi.useFakeTimers();
    vi.mocked(api.ingamePluginStatus).mockResolvedValue(ABSENT);
    const store = useIngamePluginStore();
    store.applyTelemetryIdentity({ t: Date.now(), battle: "battle-a", self: { realm: "asia" }, identity: { TestPlayer: { realm: "asia" } } });
    expect(store.liveSelfRealm).toBe("asia");
    config.activeInstall = { path: "C:/GameB" };
    expect(store.liveSelfRealm).toBe("");
    expect(store.playerRealms).toEqual({});
  });

  it("does not extend the previous battle's self realm with an identity-only payload", () => {
    vi.useFakeTimers();
    vi.mocked(api.ingamePluginStatus).mockResolvedValue(ABSENT);
    const store = useIngamePluginStore();
    store.applyTelemetryIdentity({ t: Date.now(), battle: "battle-a", self: { realm: "asia" }, identity: { OldPlayer: { realm: "asia" } } });
    store.applyTelemetryIdentity({ t: Date.now(), battle: "battle-b", identity: { NewPlayer: { realm: "eu" } } });
    expect(store.liveSelfRealm).toBe("");
    expect(store.playerRealms).toEqual({ NewPlayer: "eu" });
    store.applyTelemetryIdentity({ t: Date.now(), battle: "battle-b", self: { realm: "eu" } });
    expect(store.liveSelfRealm).toBe("eu");
    expect(store.playerRealms).toEqual({ NewPlayer: "eu" });
  });

  it("does not undo a newer probe after a plugin operation on the same root", async () => {
    const old = deferred<Status>();
    vi.mocked(api.ingamePluginStatus).mockReturnValueOnce(old.promise).mockResolvedValueOnce(ABSENT);
    const store = useIngamePluginStore();
    await store.refresh();
    old.resolve(INSTALLED);
    await flushPromises();
    expect(store.installed).toBe(false);
    expect(store.outdated).toBe(false);
    expect(store.discussion).toBe(2);
  });

  it("retains the same install's status during refresh, then clears all fields on a current failure", async () => {
    const pending = deferred<Status>();
    vi.mocked(api.ingamePluginStatus).mockResolvedValueOnce(INSTALLED).mockReturnValueOnce(pending.promise);
    const store = useIngamePluginStore();
    await flushPromises();
    const refreshing = store.refresh();
    expect(store.installed).toBe(true);
    expect(store.discussion).toBe(1);
    pending.reject(new Error("current root unavailable"));
    await refreshing;
    expect(store.installed).toBe(false);
    expect(store.probed).toBe(false);
    expect(store.discussion).toBeNull();
  });

  it("expires the new install's identity from its own last payload", () => {
    vi.useFakeTimers();
    vi.mocked(api.ingamePluginStatus).mockResolvedValue(ABSENT);
    const store = useIngamePluginStore();
    store.applyTelemetryIdentity({ t: Date.now(), battle: "battle-a", self: { realm: "asia" } });
    vi.advanceTimersByTime(20_000);
    config.activeInstall = { path: "C:/GameB" };
    store.applyTelemetryIdentity({ t: Date.now(), battle: "battle-b", self: { realm: "eu" } });
    vi.advanceTimersByTime(20_000);
    expect(store.liveSelfRealm).toBe("eu");
    vi.advanceTimersByTime(15_000);
    expect(store.liveSelfRealm).toBe("");
    expect(store.playerRealms).toEqual({});
  });
});

describe("ingamePlugin safe mode", () => {
  it("parses safeMode from the status and reads an absent field as off", async () => {
    // True from the status payload, false when an older shell omits the
    // optional field on the next probe of the same root.
    vi.mocked(api.ingamePluginStatus).mockResolvedValueOnce(SAFE).mockResolvedValueOnce(ABSENT);
    const store = useIngamePluginStore();
    await flushPromises();
    expect(store.safeMode).toBe(true);
    expect(store.state).toBe("absent");

    await store.refresh();
    expect(store.safeMode).toBe(false);
  });

  it("clears safeMode with the previous install while the next root is probed", async () => {
    const pending = deferred<Status>();
    vi.mocked(api.ingamePluginStatus).mockResolvedValueOnce(SAFE).mockReturnValueOnce(pending.promise);
    const store = useIngamePluginStore();
    await flushPromises();
    expect(store.safeMode).toBe(true);

    config.activeInstall = { path: "C:/GameB" };
    // The root switch retires the old install's snapshot synchronously —
    // the quarantine belongs to that install, never to the new one.
    expect(store.safeMode).toBe(false);
    pending.resolve(ABSENT);
    await flushPromises();
    expect(store.safeMode).toBe(false);
  });

  it("repairSafeMode refuses the target install's running client without an RPC", async () => {
    vi.mocked(api.ingamePluginStatus).mockResolvedValue(SAFE);
    const store = useIngamePluginStore();
    await flushPromises();
    useGameStatusStore().processes = [
      {
        running: true,
        pid: 7,
        kind: "manual",
        realm: null,
        exePath: null,
        matchedInstall: { kind: "manual", path: "C:/GameA" },
      },
    ];

    expect(await store.repairSafeMode()).toBe("resources.gameRunningBlock");
    expect(mocks.setSafeMode).not.toHaveBeenCalled();
    expect(mocks.runProbe).not.toHaveBeenCalled();
  });

  it("repairSafeMode turns mods back on first, repairs, then re-probes", async () => {
    vi.mocked(api.ingamePluginStatus).mockResolvedValue(RESTORED).mockResolvedValueOnce(SAFE);
    mocks.setSafeMode.mockResolvedValue(false);
    mocks.runProbe.mockResolvedValue(null);
    const store = useIngamePluginStore();
    await flushPromises();

    expect(await store.repairSafeMode()).toBeNull();
    expect(mocks.setSafeMode).toHaveBeenCalledWith("C:/GameA", false);
    expect(mocks.runProbe).toHaveBeenCalledWith("C:/GameA", "install");
    // The awaited post-repair probe publishes the restored health state.
    expect(store.safeMode).toBe(false);
    expect(store.installed).toBe(true);
  });

  it("repairSafeMode surfaces a setter refusal raw and never runs the install", async () => {
    vi.mocked(api.ingamePluginStatus).mockResolvedValue(SAFE);
    mocks.setSafeMode.mockRejectedValue(new Error("res_mods is locked by the game"));
    const store = useIngamePluginStore();
    await flushPromises();

    expect(await store.repairSafeMode()).toBe("res_mods is locked by the game");
    expect(mocks.runProbe).not.toHaveBeenCalled();
  });

  it("repairSafeMode maps the backend's running-client guard sentence", async () => {
    // Defensive fallback for a stale game-status snapshot: the frontend
    // pre-check misses, the backend refuses with its English sentence, and
    // the caller's toast must still render the localized line.
    vi.mocked(api.ingamePluginStatus).mockResolvedValue(SAFE);
    mocks.setSafeMode.mockRejectedValue(
      new Error("World of Warships is running from C:/GameA (pid 7) — close that client first"),
    );
    const store = useIngamePluginStore();
    await flushPromises();

    expect(await store.repairSafeMode()).toBe("resources.gameRunningBlock");
    expect(mocks.runProbe).not.toHaveBeenCalled();
  });
});
