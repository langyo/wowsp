/**
 * Tests for the batch-update progress card's MOUNT GRACE: a pass that
 * ends inside the grace window (a guard refusal answers in ~100 ms)
 * never mounts the card — its flash-in/flash-out read as "the click did
 * nothing" while the real verdict is the store's failure toast. A pass
 * that outlives the grace gets the card, and its ending still plays the
 * leave transition.
 *
 * The api module is mocked (the store under it is real); fake timers
 * drive the grace and leave windows.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  modCatalogRefresh: vi.fn(),
  modHubRecords: vi.fn(),
  ingamePluginStatus: vi.fn(),
  ingamePluginInstall: vi.fn(),
  ingamePluginUninstall: vi.fn(),
  modCatalogInstall: vi.fn(),
  modCatalogUninstall: vi.fn(),
  listenDownloadProgress: vi.fn((_handler: unknown) => () => undefined),
}));

vi.mock("@/api", () => ({ api: mocks }));

import { initLocaleMessages } from "@/i18n";
import { usePluginUpdatesStore } from "@/stores/pluginUpdates";
import ModUpdateToast from "./ModUpdateToast";

enableAutoUnmount(afterEach);

const CARD = ".mod-update-toast";

function card(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(CARD);
}

beforeAll(async () => {
  await initLocaleMessages();
});

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ModUpdateToast mount grace", () => {
  it("never mounts for a pass that dies inside the grace window", async () => {
    const updates = usePluginUpdatesStore();
    mount(ModUpdateToast);
    // The guard-refusal shape: one probe task, refused instantly.
    mocks.ingamePluginInstall.mockRejectedValueOnce(new Error("client running") as never);
    updates.perInstall = { "D:\\Game": { mods: [], probeOutdated: true } };

    const pass = updates.updateAll();
    await vi.advanceTimersByTimeAsync(100); // pass runs + fails inside the grace
    await pass;

    expect(updates.running).toBe(false);
    expect(card()).toBeNull();
    // And it stays gone — no delayed mount fires for a dead pass.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(card()).toBeNull();
  });

  it("mounts once the pass outlives the grace, and leaves cleanly", async () => {
    const updates = usePluginUpdatesStore();
    mount(ModUpdateToast);
    updates.perInstall = { "D:\\Game": { mods: [], probeOutdated: true } };

    // Hold the probe install open so the pass lives past the grace.
    let release!: (v?: unknown) => void;
    mocks.ingamePluginInstall.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );

    const pass = updates.updateAll();
    await vi.advanceTimersByTimeAsync(399);
    expect(card()).toBeNull(); // still inside the grace
    await vi.advanceTimersByTimeAsync(1);
    expect(card()).not.toBeNull(); // grace elapsed, pass alive → mounted

    release({});
    await pass;
    await vi.advanceTimersByTimeAsync(260); // leave transition length
    expect(card()).toBeNull();
  });

  it("re-arms the grace when a new pass starts inside the old one's grace", async () => {
    const updates = usePluginUpdatesStore();
    mount(ModUpdateToast);

    // Pass A dies inside the grace — its mount timer is cancelled.
    updates.running = true;
    await vi.advanceTimersByTimeAsync(100);
    updates.running = false;
    await vi.advanceTimersByTimeAsync(50);
    expect(card()).toBeNull();

    // Pass B starts and OUTLIVES a full grace of its own — the card must
    // mount on B's clock, never on A's cancelled timer.
    updates.running = true;
    await vi.advanceTimersByTimeAsync(400);
    expect(card()).not.toBeNull();

    updates.running = false;
    await vi.advanceTimersByTimeAsync(260);
    expect(card()).toBeNull();
  });

  it("picks up an already-running pass on mount (the immediate watcher)", async () => {
    const updates = usePluginUpdatesStore();
    updates.running = true;
    mount(ModUpdateToast);

    await vi.advanceTimersByTimeAsync(399);
    expect(card()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(card()).not.toBeNull();
  });
});
