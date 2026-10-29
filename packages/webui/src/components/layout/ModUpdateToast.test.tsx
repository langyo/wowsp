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
import { nextTick } from "vue";
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
  modHubSafeMode: vi.fn(),
  listenDownloadProgress: vi.fn((_handler: unknown) => () => undefined),
}));

vi.mock("@/api", () => ({ api: mocks }));

import { initLocaleMessages, t } from "@/i18n";
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
  mocks.modHubSafeMode.mockResolvedValue(false);
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

describe("ModUpdateToast live meta", () => {
  const LONG_NAME =
    "[Mod] Secondary Armament Status with a name long enough to fill the whole step line and then some more words";

  /** The download-phase pass state, long name included. */
  function primeDownload(): void {
    const updates = usePluginUpdatesStore();
    updates.running = true;
    updates.currentName = LONG_NAME;
    updates.done = 0;
    updates.total = 3;
    updates.phase = "download";
    updates.percent = 42;
    updates.speedBps = 1.5 * 1_048_576;
  }

  it("keeps the download percent and speed visible beside a long mod name", async () => {
    primeDownload();
    mount(ModUpdateToast);
    await vi.advanceTimersByTimeAsync(400); // grace elapsed → card mounted

    const message = document.body.querySelector<HTMLElement>(".mod-update-toast__message");
    const meta = document.body.querySelector<HTMLElement>(".mod-update-toast__meta");
    // The meta is a SIBLING of the ellipsized message line — the structure
    // that keeps it out of the name's overflow, so a long name cannot cut
    // the progress readout off the card.
    expect(message?.textContent).toContain(LONG_NAME);
    expect(message?.textContent).not.toContain("MB/s");
    expect(meta?.textContent).toBe(
      `${t("resources.pluginUpdateDownloading", { percent: 42 })} · 1.5 MB/s`,
    );
    // Download/preparing keeps the static package mark.
    const icon = document.body.querySelector<HTMLElement>(".mod-update-toast__icon");
    expect(icon?.querySelector("svg")).not.toBeNull();
    expect(icon?.querySelector(".hk-spinner")).toBeNull();
  });

  it("drops the speed suffix before the first sample instead of an em-dash", async () => {
    const updates = usePluginUpdatesStore();
    updates.running = true;
    updates.currentName = LONG_NAME;
    updates.done = 0;
    updates.total = 3;
    updates.phase = "download";
    updates.percent = 2;
    updates.speedBps = null; // no transfer sample has landed yet
    mount(ModUpdateToast);
    await vi.advanceTimersByTimeAsync(400);

    const meta = document.body.querySelector<HTMLElement>(".mod-update-toast__meta");
    expect(meta?.textContent).toBe(
      t("resources.pluginUpdateDownloading", { percent: 2 }),
    );
    expect(meta?.textContent).not.toContain("—");
    expect(meta?.textContent).not.toContain("MB/s");
  });

  it("swaps to the spinner and the dotless copy while installing", async () => {
    const updates = usePluginUpdatesStore();
    updates.running = true;
    updates.currentName = LONG_NAME;
    updates.done = 0;
    updates.total = 1;
    updates.phase = "install";
    updates.percent = 100;
    updates.speedBps = null;
    mount(ModUpdateToast);
    await vi.advanceTimersByTimeAsync(400);

    const icon = document.body.querySelector<HTMLElement>(".mod-update-toast__icon");
    const meta = document.body.querySelector<HTMLElement>(".mod-update-toast__meta");
    // The work-in-flight cue: hikari's spinner replaces the package mark.
    expect(icon?.querySelector(".hk-spinner")).not.toBeNull();
    expect(icon?.querySelector("svg")).toBeNull();
    // The install copy carries no trailing ellipsis — the spinner already
    // says "still working".
    expect(meta?.textContent).toBe(t("resources.pluginUpdateInstalling"));
    expect(meta?.textContent).not.toMatch(/(…|\.\.\.)$/);
  });

  it("freezes the live meta through the leave transition", async () => {
    primeDownload();
    mount(ModUpdateToast);
    await vi.advanceTimersByTimeAsync(400);
    expect(document.body.querySelector(".mod-update-toast__meta")?.textContent).toContain("1.5 MB/s");

    // The store drops running and clears phase/percent/speed in the same
    // sync block — the sync watcher must freeze the meta first.
    const updates = usePluginUpdatesStore();
    updates.running = false;
    updates.phase = null;
    updates.percent = null;
    updates.speedBps = null;
    updates.currentName = "";
    await nextTick();

    expect(card()).not.toBeNull();
    const frozen = document.body.querySelector<HTMLElement>(".mod-update-toast__meta");
    expect(frozen?.textContent).toContain("42%");
    expect(frozen?.textContent).toContain("1.5 MB/s");

    await vi.advanceTimersByTimeAsync(260);
    expect(card()).toBeNull();
  });

  it("freezes the spinner icon through the leave transition", async () => {
    const updates = usePluginUpdatesStore();
    updates.running = true;
    updates.currentName = LONG_NAME;
    updates.done = 0;
    updates.total = 1;
    updates.phase = "install";
    updates.percent = 100;
    updates.speedBps = null;
    mount(ModUpdateToast);
    await vi.advanceTimersByTimeAsync(400);
    expect(document.body.querySelector(".mod-update-toast__icon .hk-spinner")).not.toBeNull();

    // The store clears its fields in the same sync block that drops
    // running — the frozen snapshot must keep the install icon too.
    updates.running = false;
    updates.phase = null;
    updates.percent = null;
    updates.currentName = "";
    await nextTick();

    expect(card()).not.toBeNull();
    expect(document.body.querySelector(".mod-update-toast__icon .hk-spinner")).not.toBeNull();
    expect(document.body.querySelector(".mod-update-toast__meta")?.textContent).toBe(
      t("resources.pluginUpdateInstalling"),
    );

    await vi.advanceTimersByTimeAsync(260);
    expect(card()).toBeNull();
  });
});
