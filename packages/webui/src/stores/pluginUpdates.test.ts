/** pluginUpdates store: freshness aggregation (catalog ledger records +
 *  probe hash status) per install, the sequential all-installs one-click
 *  batch pass with overall progress folding (the running client's install
 *  skipped with a warning), and the SHARED per-item orchestration (busy
 *  table + freshness fan-out) every update surface routes through.
 *  The api module is mocked; the config/gameStatus stores are real
 *  (their refs are set directly). */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useToast } from "@celestia-island/hikari";

import type { CatalogEntry, ModInstallRecord } from "@/api";
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
      listenDownloadProgress: vi.fn((_handler: unknown) => () => undefined),
    },
  };
});

import { api } from "@/api";
import { useGameStatusStore } from "./gameStatus";
import { useIngamePluginStore } from "./ingamePlugin";
import { usePluginUpdatesStore } from "./pluginUpdates";

const GAME = "D:\\Games\\World of Warships";
const OTHER = "E:\\OtherClient";

function entry(id: string, version: string): CatalogEntry {
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
    authorUrl: "",
    packages: [],
    i18n: {},
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

const mocked = {
  refresh: vi.mocked(api.modCatalogRefresh),
  records: vi.mocked(api.modHubRecords),
  probe: vi.mocked(api.ingamePluginStatus),
  probeInstall: vi.mocked(api.ingamePluginInstall),
  probeUninstall: vi.mocked(api.ingamePluginUninstall),
  install: vi.mocked(api.modCatalogInstall),
  uninstall: vi.mocked(api.modCatalogUninstall),
  listen: vi.mocked(api.listenDownloadProgress),
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocked.refresh.mockResolvedValue({ mods: [], fetchedAt: "", sourceVersion: "", gameVersion: "" } as never);
  mocked.records.mockResolvedValue([]);
  mocked.probe.mockResolvedValue({ installed: false, outdated: false, resMods: "", discussion: 0 } as never);
  mocked.probeInstall.mockResolvedValue("ok" as never);
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
    expect(updates.failures.join("|")).toContain("mod-b");
    expect(updates.failures.join("|")).toContain("mirror down");
    expect(updates.done).toBe(2);
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

  it("runProbe uninstall goes through the same shared table", async () => {
    const updates = usePluginUpdatesStore();
    const done = updates.runProbe(GAME, "uninstall");
    await vi.waitFor(() => expect(updates.probeBusy).toBe("uninstall"));
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
