/** pluginUpdates store: freshness aggregation (catalog ledger records +
 *  probe hash status) per install, the sequential all-installs one-click
 *  batch pass with overall progress folding (the running client's install
 *  skipped with a warning), and the SHARED per-item orchestration (busy
 *  table + freshness fan-out) every update surface routes through.
 *  The api module is mocked; the config/gameStatus stores are real
 *  (their refs are set directly). */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { useToast } from "@celestia-island/hikari";

import type { CatalogEntry, ModInstallRecord } from "@/api";
import { setLocale } from "@/i18n";
import { useConfigStore } from "@/stores/config";

vi.mock("@/api", () => {
  return {
    api: {
      modCatalogRefresh: vi.fn(),
      modHubRecords: vi.fn(),
      ingamePluginStatus: vi.fn(),
      ingamePluginInstall: vi.fn(),
      ingamePluginUninstall: vi.fn(),
      modCatalogInstall: vi.fn(),
      modCatalogUninstall: vi.fn(),
      modHubSafeMode: vi.fn(),
      listenDownloadProgress: vi.fn((_handler: unknown) => () => undefined),
    },
  };
});

import { api } from "@/api";
import { useGameStatusStore } from "./gameStatus";
import { useIngamePluginStore } from "./ingamePlugin";
import { failureDetail, usePluginUpdatesStore } from "./pluginUpdates";

const GAME = "D:\\Games\\World of Warships";
const OTHER = "E:\\OtherClient";

function entry(id: string, version: string, supersedes?: Record<string, string>): CatalogEntry {
  return {
    id,
    category: "voice",
    discussion: 1,
    version,
    game: "*",
    bundled: false,
    delisted: false,
    presets: [],
    tags: [],
    title: id,
    nameZh: id,
    nameEn: id,
    description: "",
    authors: [],
    packages: [],
    i18n: {},
    ...(supersedes ? { supersedes } : {}),
  } as CatalogEntry;
}

function record(id: string, version: string, gameRoot = ""): ModInstallRecord {
  return {
    id,
    name: `mod-${id}`,
    version,
    category: "voice",
    source: "mod-hub",
    discussion: 1,
    preset: null,
    binVersion: "1",
    installedAt: "",
    files: [],
    restoreDir: null,
    gameRoot,
  };
}

/** Hand-resolved promise for tests that must hold an internal RPC open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

const mocked = {
  refresh: vi.mocked(api.modCatalogRefresh),
  records: vi.mocked(api.modHubRecords),
  probe: vi.mocked(api.ingamePluginStatus),
  probeInstall: vi.mocked(api.ingamePluginInstall),
  probeUninstall: vi.mocked(api.ingamePluginUninstall),
  install: vi.mocked(api.modCatalogInstall),
  uninstall: vi.mocked(api.modCatalogUninstall),
  safeMode: vi.mocked(api.modHubSafeMode),
  listen: vi.mocked(api.listenDownloadProgress),
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocked.refresh.mockResolvedValue({ mods: [], fetchedAt: "", sourceVersion: "", gameVersion: "" } as never);
  mocked.records.mockResolvedValue([]);
  mocked.probe.mockResolvedValue({ installed: false, outdated: false, resMods: "", discussion: 0 } as never);
  mocked.probeInstall.mockResolvedValue("ok" as never);
  mocked.safeMode.mockResolvedValue(false as never);
  mocked.install.mockResolvedValue({} as never);
  const config = useConfigStore();
  config.activeInstall = { kind: "manual", path: GAME };
  config.installs = [{ kind: "manual", path: GAME }, { kind: "manual", path: OTHER }];
});

afterEach(() => {
  const toasts = useToast().toasts;
  for (const slot of [...toasts]) useToast().remove(slot.id);
});

describe("usePluginUpdatesStore.refresh", () => {
  it("aggregates stale ledger mods and probe hash into per-install info", async () => {
    mocked.refresh.mockResolvedValue({
      mods: [entry("a", "2"), entry("b", "1"), entry("gone", "9")],
      fetchedAt: "",
      sourceVersion: "",
      gameVersion: "",
    } as never);
    mocked.records.mockResolvedValue([
      record("a", "1", GAME), // stale → update
      record("b", "1", GAME), // current → skip
      record("ghost", "1", GAME), // not in catalog → skip
    ] as never);
    mocked.probe.mockResolvedValue({ installed: true, outdated: true, resMods: "", discussion: 0 } as never);

    const updates = usePluginUpdatesStore();
    await updates.refresh();

    const info = updates.infoFor(GAME);
    expect(info?.mods.map((m) => m.id)).toEqual(["a"]);
    expect(info?.probeOutdated).toBe(true);
    // GAME: one stale mod + the outdated probe; OTHER: the same probe
    // mock reports its probe outdated too — totalCount spans every
    // install now, unlike the old active-install-only count.
    expect(updates.totalCount).toBe(3);
  });

  it("pairs folded-family legacy records onto the folded entry, once per family", async () => {
    // A folded style family: pre-fold records sit under legacy ids with
    // no preset; the update pass must resolve them onto the folded
    // entry (its id installs, its mapped scheme carries over), and two
    // legacy records of ONE family collapse into a single step.
    mocked.refresh.mockResolvedValue({
      mods: [
        entry("battle.panel", "2", {
          "battle.panel.ttaro": "ttaro",
          "battle.panel.autospy": "classic",
        }),
      ],
      fetchedAt: "",
      sourceVersion: "",
      gameVersion: "",
    } as never);
    mocked.records.mockResolvedValue([
      record("battle.panel.ttaro", "1", GAME),
      record("battle.panel.autospy", "1", GAME), // same family → deduped
      record("battle.panel", "2", GAME), // post-fold record, current → skip
    ] as never);

    const updates = usePluginUpdatesStore();
    await updates.refresh();

    const mods = updates.infoFor(GAME)?.mods ?? [];
    expect(mods).toHaveLength(1);
    expect(mods[0].id).toBe("battle.panel");
    expect(mods[0].preset).toBe("ttaro"); // the first legacy record's folded scheme
  });

  it("keeps other installs' records out of this install's snapshot", async () => {
    mocked.refresh.mockResolvedValue({ mods: [entry("a", "2")], fetchedAt: "", sourceVersion: "", gameVersion: "" } as never);
    mocked.records.mockResolvedValue([record("a", "1", OTHER)] as never);

    const updates = usePluginUpdatesStore();
    await updates.refresh();

    expect(updates.infoFor(GAME)?.mods).toEqual([]);
    expect(updates.infoFor(OTHER)?.mods.map((m) => m.id)).toEqual(["a"]);
  });

  it("leaves the previous snapshot when the catalog is unreachable", async () => {
    mocked.refresh.mockRejectedValueOnce(new Error("offline") as never);
    const updates = usePluginUpdatesStore();
    updates.perInstall = { [GAME]: { mods: [{ id: "a", name: "mod-a", preset: null }], probeOutdated: false } };
    await updates.refresh();
    expect(updates.infoFor(GAME)?.mods.length).toBe(1);
  });
});

describe("usePluginUpdatesStore.updateAll", () => {
  it("updates the probe first, then stale mods, sequentially", async () => {
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: {
        mods: [
          { id: "a", name: "mod-a", preset: "lite" },
          { id: "b", name: "mod-b", preset: null },
        ],
        probeOutdated: true,
      },
    };

    await updates.updateAll();

    expect(mocked.probeInstall).toHaveBeenCalledWith(GAME);
    expect(mocked.install).toHaveBeenNthCalledWith(1, "a", GAME, "lite");
    expect(mocked.install).toHaveBeenNthCalledWith(2, "b", GAME, undefined);
    expect(updates.done).toBe(3);
    expect(updates.running).toBe(false);
    // Ends with a freshness re-assessment.
    expect(mocked.refresh).toHaveBeenCalled();
  });

  it("collects failures, keeps going, and reports one error toast", async () => {
    mocked.install
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error("mirror down") as never);
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: {
        mods: [
          { id: "a", name: "mod-a", preset: null },
          { id: "b", name: "mod-b", preset: null },
        ],
        probeOutdated: false,
      },
    };

    await updates.updateAll();

    // The test env's i18n has no catalogs, so the toast text falls back
    // to the raw key — assert on the collected failures instead (the
    // real app interpolates names into the message).
    expect(useToast().toasts.some((s) => s.type === "error")).toBe(true);
    // PARTIAL failure: work landed, the toast is a footnote — the 30 s
    // auto-dismiss default stays (a sticky slot is reserved for a pass
    // that was refused wholesale).
    expect(useToast().toasts.some((s) => s.type === "error" && s.duration !== 0)).toBe(true);
    expect(updates.failures.join("|")).toContain("mod-b");
    expect(updates.failures.join("|")).toContain("mirror down");
    expect(updates.done).toBe(2);
  });

  it("raises a STICKY error toast when the whole pass was refused", async () => {
    // The guard-refusal shape (a running client): the single probe task
    // rejects with the backend's raw sentence, the pass dies in ~100 ms
    // and the progress card never mounts — this toast is the ONLY
    // surface the rejection reaches, so it must not auto-dismiss
    // (duration 0 = sticky until closed, copyable).
    mocked.probeInstall.mockRejectedValueOnce(
      new Error("World of Warships is running from D:/Korabli (pid 7) — close that client before installing") as never,
    );
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: { mods: [], probeOutdated: true },
    };

    await updates.updateAll();

    const slot = useToast().toasts.find((s) => s.type === "error");
    expect(slot).toBeDefined();
    expect(slot?.duration).toBe(0);
    expect(slot?.copyable).toBe(true);
    expect(updates.failures.length).toBe(1);
    expect(updates.done).toBe(1);
  });

  it("retires a live 30 s error slot before raising the sticky verdict", async () => {
    // The real-world sequence: the plugin card's refusal already put a
    // 30 s error slot up, THEN the user hits the batch pass. hikari's
    // push() only takes duration when CREATING a slot, so the sticky
    // show must remove the old slot first or the whole verdict rides the
    // old timer and vanishes with it at 30 s.
    useToast().error("prior refusal");
    mocked.probeInstall.mockRejectedValueOnce(new Error("client running") as never);
    const updates = usePluginUpdatesStore();
    updates.perInstall = { [GAME]: { mods: [], probeOutdated: true } };

    await updates.updateAll();

    const errors = useToast().toasts.filter((s) => s.type === "error");
    expect(errors).toHaveLength(1); // the prior slot was retired, not reused
    expect(errors[0]?.duration).toBe(0);
  });

  it("toasts the light success when a fast pass beats the card grace", async () => {
    // Probe-only local write: resolves in ~0 ms, the progress card never
    // mounts, so the success toast is the pass's only visible trace.
    mocked.probeInstall.mockResolvedValueOnce("ok" as never);
    const updates = usePluginUpdatesStore();
    updates.perInstall = { [GAME]: { mods: [], probeOutdated: true } };

    await updates.updateAll();

    expect(useToast().toasts.some((s) => s.type === "success")).toBe(true);
    expect(updates.failures.length).toBe(0);
  });

  it("folds per-item progress events into overallPercent", async () => {
    let emit: ((p: { id: string; kind: string; phase: string; received: number; total: number }) => void) | undefined;
    mocked.listen.mockImplementationOnce((handler: unknown) => {
      emit = handler as typeof emit;
      return () => undefined;
    });
    // One mod after the probe: total 2 items. Hold the install open at
    // 50% download → overall (1 + 0.5) / 2 = 75% is observable, then
    // finish the item.
    let release!: (v?: unknown) => void;
    mocked.install.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({} as never);
          setTimeout(() => {
            emit?.({ id: "a", kind: "mod-package", phase: "download", received: 50, total: 100 });
          }, 0);
        }) as never,
    );
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: { mods: [{ id: "a", name: "mod-a", preset: null }], probeOutdated: true },
    };
    const run = updates.updateAll();
    await vi.waitFor(() => expect(updates.overallPercent).toBe(75));
    release({});
    await run;
    expect(updates.running).toBe(false);
  });

  it("captures the per-item download speed and drops it on a zero-rate tick", async () => {
    let emit:
      | ((p: {
          id: string;
          kind: string;
          phase: string;
          received: number;
          total: number;
          speedBps: number;
        }) => void)
      | undefined;
    mocked.listen.mockImplementationOnce((handler: unknown) => {
      emit = handler as typeof emit;
      return () => undefined;
    });
    let release!: () => void;
    mocked.install.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({} as never);
          setTimeout(() => {
            emit?.({
              id: "a",
              kind: "mod-package",
              phase: "download",
              received: 20,
              total: 100,
              speedBps: 2_097_152,
            });
          }, 0);
        }) as never,
    );
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: { mods: [{ id: "a", name: "mod-a", preset: null }], probeOutdated: false },
    };

    const run = updates.updateAll();
    await vi.waitFor(() => expect(updates.speedBps).toBe(2_097_152));

    // mod_catalog sends speedBps 0 on its own phase transitions — that must
    // read as "no sample", never stick to the last rate.
    emit?.({
      id: "a",
      kind: "mod-package",
      phase: "download",
      received: 25,
      total: 100,
      speedBps: 0,
    });
    await vi.waitFor(() => expect(updates.speedBps).toBeNull());

    release();
    await run;
    expect(updates.speedBps).toBeNull(); // the pass cleared it with phase/percent
    expect(updates.running).toBe(false);
  });

  it("resets the captured speed at every task start", async () => {
    let emit:
      | ((p: {
          id: string;
          kind: string;
          phase: string;
          received: number;
          total: number;
          speedBps: number;
        }) => void)
      | undefined;
    mocked.listen.mockImplementationOnce((handler: unknown) => {
      emit = handler as typeof emit;
      return () => undefined;
    });
    let releaseA!: () => void;
    let releaseB!: () => void;
    mocked.install
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseA = () => resolve({} as never))) as never,
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseB = () => resolve({} as never))) as never,
      );
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: {
        mods: [
          { id: "a", name: "mod-a", preset: null },
          { id: "b", name: "mod-b", preset: null },
        ],
        probeOutdated: false,
      },
    };

    const run = updates.updateAll();
    await vi.waitFor(() => expect(updates.currentName).toBe("mod-a"));
    emit?.({
      id: "a",
      kind: "mod-package",
      phase: "download",
      received: 20,
      total: 100,
      speedBps: 1_048_576,
    });
    await vi.waitFor(() => expect(updates.speedBps).toBe(1_048_576));

    releaseA();
    await vi.waitFor(() => expect(updates.currentName).toBe("mod-b"));
    // The next item starts clean — never the previous item's rate.
    expect(updates.speedBps).toBeNull();

    releaseB();
    await run;
    expect(updates.speedBps).toBeNull();
  });

  it("a throwing progress listener never strands the pass", async () => {
    // The shared bus registers handlers synchronously; a throwing
    // registration must not strand the pass either.
    mocked.listen.mockImplementationOnce(() => {
      throw new Error("listen boom");
    });
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: { mods: [{ id: "a", name: "mod-a", preset: null }], probeOutdated: false },
    };
    await updates.updateAll();
    expect(mocked.install).toHaveBeenCalled();
    expect(updates.running).toBe(false);
    expect(updates.done).toBe(1);
  });

  it("is re-entrant safe: a second call while running does nothing", async () => {
    let release!: () => void;
    mocked.install.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({} as never))) as never,
    );
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: { mods: [{ id: "a", name: "mod-a", preset: null }], probeOutdated: false },
    };
    const first = updates.updateAll();
    await vi.waitFor(() => expect(updates.running).toBe(true));
    await updates.updateAll(); // must return immediately
    expect(mocked.install).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(updates.running).toBe(false);
  });

  it("updateAll quietly skips an id grabbed mid-pass instead of failing it", async () => {
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: {
        mods: [
          { id: "a", name: "mod-a", preset: null },
          { id: "b", name: "mod-b", preset: null },
        ],
        probeOutdated: false,
      },
    };
    // "b" is grabbed between task build and its queue turn.
    const held = updates.runMod("b", GAME);
    await vi.waitFor(() => expect(updates.itemOp("b")).toBe("install"));

    await updates.updateAll();

    // The batch must not report the foreign-held item as a failure — it
    // is freshly updated by the op that holds it.
    expect(updates.failures).toEqual([]);
    await held;
  });

  it("is a no-op with nothing to update", async () => {
    const updates = usePluginUpdatesStore();
    updates.perInstall = { [GAME]: { mods: [], probeOutdated: false } };
    await updates.updateAll();
    expect(mocked.install).not.toHaveBeenCalled();
    expect(updates.running).toBe(false);
  });

  it("updateAll skips items another surface is already updating", async () => {
    let releaseB!: () => void;
    mocked.install.mockImplementation((id: unknown) =>
      id === "b"
        ? new Promise((resolve) => (releaseB = () => resolve({} as never))) as never
        : Promise.resolve({} as never) as never,
    );
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: {
        mods: [
          { id: "a", name: "mod-a", preset: null },
          { id: "b", name: "mod-b", preset: null },
        ],
        probeOutdated: false,
      },
    };
    // The mod hub's row for "b" is mid-install on the shared table.
    const held = updates.runMod("b", GAME);
    await vi.waitFor(() => expect(updates.itemOp("b")).toBe("install"));

    await updates.updateAll();

    // Each id installed exactly once: "b" only by the held op, never
    // re-run by the batch pass.
    expect(mocked.install.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b"]);
    releaseB();
    await held;
    expect(updates.itemOp("b")).toBeUndefined();
  });

  it("updateAll is a quiet sync when every item is busy elsewhere", async () => {
    let release!: () => void;
    mocked.install.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({} as never))) as never,
    );
    const updates = usePluginUpdatesStore();
    updates.perInstall = { [GAME]: { mods: [{ id: "a", name: "mod-a", preset: null }], probeOutdated: false } };
    const held = updates.runMod("a", GAME);
    await vi.waitFor(() => expect(updates.itemOp("a")).toBe("install"));

    await updates.updateAll();

    expect(updates.running).toBe(false); // no flash of an empty pass
    expect(mocked.install).toHaveBeenCalledTimes(1); // the held op only
    release();
    await held;
  });
});

describe("usePluginUpdatesStore all-installs batch", () => {
  it("aggregates pending installs, active install first, into totalCount", () => {
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [OTHER]: { mods: [], probeOutdated: true },
      [GAME]: { mods: [{ id: "a", name: "mod-a", preset: null }], probeOutdated: false },
    };

    expect(updates.pendingInstalls.map((g) => g.path)).toEqual([GAME, OTHER]);
    expect(updates.totalCount).toBe(2);
  });

  it("updateAll covers every pending install, active install first", async () => {
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [OTHER]: { mods: [], probeOutdated: true },
      [GAME]: { mods: [{ id: "a", name: "mod-a", preset: null }], probeOutdated: true },
    };

    await updates.updateAll();

    // Active install (GAME) first: its probe, its mod, then OTHER's probe.
    expect(mocked.probeInstall).toHaveBeenNthCalledWith(1, GAME);
    expect(mocked.install).toHaveBeenNthCalledWith(1, "a", GAME, undefined);
    expect(mocked.probeInstall).toHaveBeenNthCalledWith(2, OTHER);
    expect(updates.done).toBe(3);
  });

  it("updateAll skips the running client's install and warns instead", async () => {
    const gameStatus = useGameStatusStore();
    gameStatus.process = {
      running: true,
      pid: 7,
      kind: "manual",
      realm: null,
      exePath: `${OTHER}\\WorldOfWarships.exe`,
      matchedInstall: { kind: "manual", path: OTHER },
    };
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: { mods: [], probeOutdated: true },
      [OTHER]: { mods: [{ id: "b", name: "mod-b", preset: null }], probeOutdated: true },
    };

    await updates.updateAll();

    // Only the not-running install is touched; the running one becomes a
    // warning toast, never a failed item.
    expect(mocked.probeInstall).toHaveBeenCalledTimes(1);
    expect(mocked.probeInstall).toHaveBeenCalledWith(GAME);
    expect(mocked.install).not.toHaveBeenCalled();
    expect(updates.done).toBe(1);
    expect(updates.failures).toEqual([]);
    expect(useToast().toasts.some((s) => s.type === "warning")).toBe(true);
  });

  it("updateAll reports the skip even when the running client is the only one pending", async () => {
    const gameStatus = useGameStatusStore();
    gameStatus.process = {
      running: true,
      pid: 7,
      kind: "manual",
      realm: null,
      exePath: null,
      matchedInstall: { kind: "manual", path: GAME },
    };
    const updates = usePluginUpdatesStore();
    updates.perInstall = { [GAME]: { mods: [], probeOutdated: true } };

    await updates.updateAll();

    expect(mocked.probeInstall).not.toHaveBeenCalled();
    expect(updates.running).toBe(false);
    expect(useToast().toasts.some((s) => s.type === "warning")).toBe(true);
  });
});

describe("usePluginUpdatesStore per-client summary", () => {
  it("folds each landed item into the local snapshot, so the badge is clear the moment the pass ends", async () => {
    // Hold the post-pass freshness re-assessment open (it would only
    // confirm): the badge must clear through the LOCAL fold, not that
    // network round-trip — the exact user report this addresses.
    mocked.refresh.mockImplementation(() => new Promise(() => undefined) as never);
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: { mods: [{ id: "a", name: "mod-a", preset: null }], probeOutdated: true },
      [OTHER]: { mods: [], probeOutdated: true },
    };

    await updates.updateAll();

    expect(updates.totalCount).toBe(0);
    expect(updates.infoFor(GAME)).toEqual({ mods: [], probeOutdated: false });
    expect(updates.infoFor(OTHER)).toEqual({ mods: [], probeOutdated: false });
  });

  it("a multi-client full success toasts the client count, not the bare done line", async () => {
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: { mods: [], probeOutdated: true },
      [OTHER]: { mods: [], probeOutdated: true },
    };

    await updates.updateAll();

    // Raw keys: the test env's i18n has no catalogs, so t() echoes the
    // key — enough to pin which summary branch fired.
    const texts = useToast().toasts.flatMap((s) => s.messages.map((m) => m.text));
    expect(texts).toContain("resources.pluginUpdateDoneClients");
    expect(updates.failures).toEqual([]);
  });

  it("a mixed run warns with the failed clients instead of erroring the whole pass", async () => {
    mocked.probeInstall
      .mockResolvedValueOnce("ok" as never) // GAME's probe lands
      .mockRejectedValueOnce(new Error("other refused") as never); // OTHER's refused
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: { mods: [], probeOutdated: true },
      [OTHER]: { mods: [], probeOutdated: true },
    };

    await updates.updateAll();

    const texts = useToast().toasts.flatMap((s) => s.messages.map((m) => m.text));
    expect(texts).toContain("resources.pluginUpdatePartialClientsDetail");
    expect(useToast().toasts.some((s) => s.type === "error")).toBe(false);
    expect(updates.failures.join("|")).toContain("other refused");
  });

  it("a total multi-client refusal raises the sticky all-clients error", async () => {
    mocked.probeInstall.mockRejectedValue(new Error("safe mode") as never);
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: { mods: [], probeOutdated: true },
      [OTHER]: { mods: [], probeOutdated: true },
    };

    await updates.updateAll();

    const errors = useToast().toasts.filter((s) => s.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.duration).toBe(0);
    expect(errors[0]?.copyable).toBe(true);
    expect(errors[0]?.messages.some((m) => m.text.includes("resources.pluginUpdateAllFailedClientsDetail"))).toBe(true);
    expect(updates.failures.length).toBe(2);
  });

  it("a client whose every item is busy elsewhere stays out of the summary rollup", async () => {
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: { mods: [], probeOutdated: true },
      [OTHER]: { mods: [{ id: "b", name: "mod-b", preset: null }], probeOutdated: false },
    };
    // The mod hub holds OTHER's only item across the click (a resolving
    // mock would free the table and put "b" back into the queue).
    let releaseB!: () => void;
    mocked.install.mockImplementationOnce(
      () => new Promise((resolve) => (releaseB = () => resolve({} as never))) as never,
    );
    const held = updates.runMod("b", OTHER);
    await vi.waitFor(() => expect(updates.itemOp("b")).toBe("install"));

    await updates.updateAll();

    // GAME alone was attempted → the single-client success line; the
    // client-count line would over-claim OTHER as updated by THIS pass.
    const texts = useToast().toasts.flatMap((s) => s.messages.map((m) => m.text));
    expect(texts).toContain("resources.pluginUpdateDone");
    expect(texts).not.toContain("resources.pluginUpdateDoneClients");
    releaseB();
    await held;
  });
});

describe("usePluginUpdatesStore shared per-item orchestration", () => {
  it("runProbe fans the freshness sync out to the live probe store", async () => {
    // Everything stale before the op, everything current after: the
    // fan-out must re-assess BOTH signals — this is the fix for the
    // live card and the sidebar badge disagreeing after an update.
    mocked.probe.mockResolvedValue({ installed: true, outdated: true, resMods: "", discussion: 0 } as never);
    const updates = usePluginUpdatesStore();
    const plugin = useIngamePluginStore();
    await Promise.all([updates.refresh(), plugin.refresh()]);
    expect(updates.infoFor(GAME)?.probeOutdated).toBe(true);
    expect(plugin.outdated).toBe(true);

    mocked.probe.mockResolvedValue({ installed: true, outdated: false, resMods: "", discussion: 0 } as never);
    expect(await updates.runProbe(GAME, "update")).toBeNull();

    await vi.waitFor(() => expect(updates.infoFor(GAME)?.probeOutdated).toBe(false));
    expect(plugin.outdated).toBe(false);
    expect(mocked.probeInstall).toHaveBeenCalledWith(GAME);
  });

  it("runProbe refuses a safe-mode probe with the localized key and no install RPC", async () => {
    // The backend's guard sentence is English; the store pre-checks the
    // quarantine so every caller's tError render shows resources.safeModeBlock
    // instead of the raw sentence.
    mocked.safeMode.mockResolvedValue(true as never);
    const updates = usePluginUpdatesStore();

    expect(await updates.runProbe(GAME, "install")).toBe("resources.safeModeBlock");
    expect(mocked.probeInstall).not.toHaveBeenCalled();
    expect(mocked.probeUninstall).not.toHaveBeenCalled();
  });

  it("runProbe refuses the running client's install with the localized key and no RPC", async () => {
    const gameStatus = useGameStatusStore();
    gameStatus.process = {
      running: true,
      pid: 7,
      kind: "manual",
      realm: null,
      exePath: `${GAME}\\WorldOfWarships.exe`,
      matchedInstall: { kind: "manual", path: GAME },
    };
    const updates = usePluginUpdatesStore();

    expect(await updates.runProbe(GAME, "install")).toBe("resources.gameRunningBlock");
    expect(mocked.probeInstall).not.toHaveBeenCalled();
  });

  it("runProbe uninstall goes through the same shared table", async () => {
    // The localized guard pre-checks run before the busy table is taken,
    // so hold the RPC open to observe the registration (an instantly
    // resolving mock could complete the whole op between two polls).
    let release!: () => void;
    mocked.probeUninstall.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(null as never))) as never,
    );
    const updates = usePluginUpdatesStore();
    const done = updates.runProbe(GAME, "uninstall");
    await vi.waitFor(() => expect(updates.probeBusy).toBe("uninstall"));
    release();
    expect(await done).toBeNull();
    expect(mocked.probeUninstall).toHaveBeenCalledWith(GAME);
    expect(updates.probeBusy).toBeNull();
  });

  it("a second probe op while one is in flight is refused without an RPC", async () => {
    let release!: () => void;
    mocked.probeInstall.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve("ok" as never))) as never,
    );
    const updates = usePluginUpdatesStore();
    const first = updates.runProbe(GAME, "install");
    await vi.waitFor(() => expect(updates.probeBusy).toBe("install"));

    // The live card and a batch pass cannot double-drive the probe: the
    // loser gets the same offline-flavored refusal contract as before.
    expect(await updates.runProbe(GAME, "update")).toBe("common.game.offline");
    expect(mocked.probeInstall).toHaveBeenCalledTimes(1);

    release();
    expect(await first).toBeNull();
    await vi.waitFor(() => expect(updates.probeBusy).toBeNull());
  });

  it("keeps the probe busy guard atomic across the async pre-checks", async () => {
    // Both calls pass the early busy check while the safe-mode RPC is
    // pending; without a synchronous re-check the loser would reach
    // withItem's single-flight throw — a rejected promise callers never
    // catch — instead of the documented key contract.
    const gate = deferred<boolean>();
    mocked.safeMode.mockReturnValue(gate.promise as never);
    const updates = usePluginUpdatesStore();

    const first = updates.runProbe(GAME, "install");
    const second = updates.runProbe(GAME, "install");
    gate.resolve(false);

    await expect(second).resolves.toBe("common.game.offline");
    await expect(first).resolves.toBeNull();
    expect(mocked.probeInstall).toHaveBeenCalledTimes(1);
    expect(updates.probeBusy).toBeNull();
  });

  it("runProbe localizes the backend's raw safe-mode guard sentence", async () => {
    // Defensive fallback: the pre-check normally intercepts the quarantine,
    // but a stale game-status snapshot can let the real guard through and
    // the English sentence must not reach a toast raw.
    mocked.probeInstall.mockRejectedValueOnce(
      new Error(
        "safe mode is active — turn mods back on before installing, uninstalling or toggling them",
      ) as never,
    );
    const updates = usePluginUpdatesStore();

    expect(await updates.runProbe(GAME, "install")).toBe("resources.safeModeBlock");
  });

  it("runProbe localizes the backend's raw running-client guard sentence", async () => {
    mocked.probeInstall.mockRejectedValueOnce(
      new Error(
        "World of Warships is running from D:/Korabli (pid 7) — close that client before installing",
      ) as never,
    );
    const updates = usePluginUpdatesStore();

    expect(await updates.runProbe(GAME, "install")).toBe("resources.gameRunningBlock");
  });

  it("runMod is single-flight per mod id and clears its row after", async () => {
    let release!: () => void;
    mocked.install.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({} as never))) as never,
    );
    const updates = usePluginUpdatesStore();
    const first = updates.runMod("a", GAME);
    await vi.waitFor(() => expect(updates.itemOp("a")).toBe("install"));

    await expect(updates.runMod("a", GAME)).rejects.toThrow("busy");

    release();
    await first;
    expect(updates.itemOp("a")).toBeUndefined();
  });

  it("a failed runMod still clears its row", async () => {
    mocked.install.mockRejectedValueOnce(new Error("disk full") as never);
    const updates = usePluginUpdatesStore();
    await expect(updates.runMod("a", GAME)).rejects.toThrow("disk full");
    expect(updates.itemOp("a")).toBeUndefined();
  });

  it("runModUninstall shares the table and reports through the caller", async () => {
    mocked.uninstall.mockResolvedValue({ name: "mod-a", removedFiles: 3, restoredFiles: 0 } as never);
    const updates = usePluginUpdatesStore();
    const done = updates.runModUninstall("a", GAME);
    await vi.waitFor(() => expect(updates.itemOp("a")).toBe("uninstall"));
    expect(await done).toEqual({ name: "mod-a", removedFiles: 3, restoredFiles: 0 });
    expect(mocked.uninstall).toHaveBeenCalledWith("a", GAME);
    expect(updates.itemOp("a")).toBeUndefined();
  });

  it("a caller joining an in-flight assessment schedules one trailing run", async () => {
    // Hold the first assessment's catalog RPC open; the second caller
    // joins it (coalescing) and its interest rides the dirty flag into
    // exactly one trailing re-assessment after the held run resolves.
    let release!: () => void;
    mocked.refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ mods: [], fetchedAt: "", sourceVersion: "", gameVersion: "" } as never);
        }) as never,
    );
    const updates = usePluginUpdatesStore();
    const first = updates.refresh();
    const joined = updates.refresh();
    release();
    await Promise.all([first, joined]);
    await vi.waitFor(() => expect(mocked.refresh).toHaveBeenCalledTimes(2));
  });
});

describe("failureDetail", () => {
  it("joins the failed items verbatim under the cap", () => {
    expect(failureDetail([])).toBe("");
    expect(failureDetail(["a: boom"])).toBe("a: boom");
    expect(failureDetail(["a: boom", "b: boom", "c: boom"])).toBe("a: boom; b: boom; c: boom");
  });

  it("folds the overflow into a +N tail", () => {
    expect(failureDetail(["a: 1", "b: 2", "c: 3", "d: 4", "e: 5"])).toBe("a: 1; b: 2; c: 3; +2");
    expect(failureDetail(["a", "b", "c", "d"], 2)).toBe("a; b; +2");
  });
});

describe("usePluginUpdatesStore localized guard summaries", () => {
  // Load en-US so the assertions read the RENDERED copy: this pins that a
  // runProbe key travels through tError before it reaches a summary.
  beforeAll(async () => {
    await setLocale("en-US");
  });

  it("renders a safe-mode probe refusal as the localized line, not the key", async () => {
    // Seed the pending probe directly: a quarantined install's live status
    // reads "absent", so only a stale pre-quarantine snapshot puts the
    // probe into a batch pass — exactly when the refusal must read local.
    mocked.safeMode.mockResolvedValue(true as never);
    const updates = usePluginUpdatesStore();
    updates.perInstall = { [GAME]: { mods: [], probeOutdated: true } };

    await updates.updateAll();

    const summary = updates.failures.join("|");
    expect(summary).toContain("Safe mode is active");
    expect(summary).not.toContain("resources.safeModeBlock");
  });

  it("localizes a catalog mod item's backend safe-mode guard sentence", async () => {
    // Catalog-mod installs have no frontend guard pre-check, so the raw
    // backend sentence reaches updateAll's per-item catch — the summary
    // must render the localized line, never the English sentence.
    mocked.install.mockRejectedValueOnce(
      new Error(
        "safe mode is active — turn mods back on before installing, uninstalling or toggling them",
      ) as never,
    );
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: {
        mods: [{ id: "a", name: "mod-a", preset: null }],
        probeOutdated: false,
      },
    };

    await updates.updateAll();

    const summary = updates.failures.join("|");
    expect(summary).toContain("mod-a: Safe mode is active");
    expect(summary).not.toContain("installing, uninstalling or toggling");
  });
});

describe("usePluginUpdatesStore multi-client failure detail", () => {
  // Multi-client summaries used to name only the failed clients, dropping
  // the per-item errors — the reason plugins could sit stale with no clue
  // why (the backend bug's silent failures hid behind exactly this gap).
  // The en-US catalog is loaded here so t() interpolates and these
  // assertions read the RENDERED copy; the earlier suites keep the
  // missing-catalog raw-key behavior on purpose.
  beforeAll(async () => {
    await setLocale("en-US");
  });

  it("a mixed multi-client run carries the concrete failed items in its warning", async () => {
    mocked.probeInstall
      .mockResolvedValueOnce("ok" as never) // GAME's probe lands
      .mockRejectedValueOnce(new Error("other refused") as never); // OTHER's refused
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: { mods: [], probeOutdated: true },
      [OTHER]: { mods: [], probeOutdated: true },
    };

    await updates.updateAll();

    const warning = useToast().toasts.find((s) => s.type === "warning");
    const text = warning?.messages.at(-1)?.text ?? "";
    expect(text).toContain("Plugins updated on 1 client(s)");
    expect(text).toContain("Built-in probe plugin");
    expect(text).toContain("other refused");
    expect(useToast().toasts.some((s) => s.type === "error")).toBe(false);
  });

  it("a total multi-client refusal keeps the sticky error and carries the detail", async () => {
    mocked.probeInstall
      .mockRejectedValueOnce(new Error("game A refused") as never)
      .mockRejectedValueOnce(new Error("game B refused") as never);
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: { mods: [], probeOutdated: true },
      [OTHER]: { mods: [], probeOutdated: true },
    };

    await updates.updateAll();

    const errors = useToast().toasts.filter((s) => s.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.duration).toBe(0);
    expect(errors[0]?.copyable).toBe(true);
    const text = errors[0]?.messages.at(-1)?.text ?? "";
    expect(text).toContain("Plugin updates failed on all 2 client(s)");
    expect(text).toContain("game A refused");
    expect(text).toContain("game B refused");
  });

  it("caps a long failure list at three items plus a +N fold", async () => {
    mocked.probeInstall.mockResolvedValueOnce("ok" as never); // GAME lands
    mocked.install.mockImplementation((id: unknown) =>
      Promise.reject(new Error(`boom-${String(id)}`)) as never,
    );
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: { mods: [], probeOutdated: true },
      [OTHER]: {
        mods: [
          { id: "a", name: "mod-a", preset: null },
          { id: "b", name: "mod-b", preset: null },
          { id: "c", name: "mod-c", preset: null },
          { id: "d", name: "mod-d", preset: null },
        ],
        probeOutdated: false,
      },
    };

    await updates.updateAll();

    const warning = useToast().toasts.find((s) => s.type === "warning");
    const text = warning?.messages.at(-1)?.text ?? "";
    expect(text).toContain("boom-a");
    expect(text).toContain("boom-b");
    expect(text).toContain("boom-c");
    expect(text).toContain("+1");
    expect(text).not.toContain("boom-d");
    expect(updates.failures).toHaveLength(4);
  });
});
