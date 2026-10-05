/** pluginUpdates store: freshness aggregation (catalog ledger records +
 *  probe hash status) per install, and the sequential one-click batch
 *  pass with overall progress folding. The api module is mocked; the
 *  config store is real (its refs are set directly). */
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
      modCatalogInstall: vi.fn(),
      listenCatalogProgress: vi.fn(async (_handler: unknown) => () => undefined),
    },
  };
});

import { api } from "@/api";
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
  install: vi.mocked(api.modCatalogInstall),
  listen: vi.mocked(api.listenCatalogProgress),
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
    expect(updates.activeCount).toBe(2); // one mod + the probe
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

    await updates.updateAll(GAME);

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

    await updates.updateAll(GAME);

    // The test env's i18n has no catalogs, so the toast text falls back
    // to the raw key — assert on the collected failures instead (the
    // real app interpolates names into the message).
    expect(useToast().toasts.some((s) => s.type === "error")).toBe(true);
    expect(updates.failures.join("|")).toContain("mod-b");
    expect(updates.failures.join("|")).toContain("mirror down");
    expect(updates.done).toBe(2);
  });

  it("folds per-item progress events into overallPercent", async () => {
    let emit: ((p: { id: string; phase: string; package: number; packages: number; received: number; total: number }) => void) | undefined;
    mocked.listen.mockImplementationOnce(async (handler: unknown) => {
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
            emit?.({ id: "a", phase: "downloading", package: 1, packages: 1, received: 50, total: 100 });
          }, 0);
        }) as never,
    );
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: { mods: [{ id: "a", name: "mod-a", preset: null }], probeOutdated: true },
    };
    const run = updates.updateAll(GAME);
    await vi.waitFor(() => expect(updates.overallPercent).toBe(75));
    release({});
    await run;
    expect(updates.running).toBe(false);
  });

  it("a rejected progress listener never strands the pass", async () => {
    mocked.listen.mockRejectedValueOnce(new Error("listen boom") as never);
    const updates = usePluginUpdatesStore();
    updates.perInstall = {
      [GAME]: { mods: [{ id: "a", name: "mod-a", preset: null }], probeOutdated: false },
    };
    await updates.updateAll(GAME);
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
    const first = updates.updateAll(GAME);
    await vi.waitFor(() => expect(updates.running).toBe(true));
    await updates.updateAll(GAME); // must return immediately
    expect(mocked.install).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(updates.running).toBe(false);
  });

  it("is a no-op with nothing to update", async () => {
    const updates = usePluginUpdatesStore();
    updates.perInstall = { [GAME]: { mods: [], probeOutdated: false } };
    await updates.updateAll(GAME);
    expect(mocked.install).not.toHaveBeenCalled();
    expect(updates.running).toBe(false);
  });
});
