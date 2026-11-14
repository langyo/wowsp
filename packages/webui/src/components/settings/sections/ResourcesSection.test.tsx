/**
 * Resources settings section — the status card, the four family rows, the
 * details child window, and the window's payload (the registry inventory's
 * column layout plus the decisions pack's technical facts).
 *
 * The 2026-11-14 hierarchy rework moved the pane from "audit shelf" to
 * "status first": ONE status card answers whether anything needs doing, ONE
 * family card carries at most one verb per family, and the maintainer's
 * audit lives in a CHILD WINDOW. These tests therefore pin four contracts:
 *
 * 1. The status card never claims "ready" for a set that was not checked, and
 *    it never duplicates an apply verb (the apply buttons belong to the rows).
 * 2. Every family row carries at most ONE verb, and same-family items share
 *    it (the four caches clear behind one two-step confirm).
 * 3. The details window is the gate: it opens from the entry row through the
 *    shared popup context and starts closed, which is what keeps the
 *    inventory's six fixed columns (name | size | version | updated |
 *    channel | kind) testable AND the destructive verbs out of a new
 *    player's way. The window teleports to the overlay root on
 *    document.body, so its assertions query the document, not the wrapper.
 * 4. The details payload keeps its facts: the E26/P2 torpedo slot, the
 *    channel/kind localizations and the N/A placeholders all still render.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { computed, nextTick, ref } from "vue";

import { initLocaleMessages, t } from "@/i18n";
import type {
  AiPackCheck,
  AiPackStatus,
  AuxCacheStatus,
  DecisionsPackStatus,
  ResStatus,
  ResUpdate,
} from "@/api";
import type { ResourceStatusRow } from "@/api/modules/respack";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";
import { useSettingsResourcesState } from "@/components/settings/useSettingsResourcesState";
import { formatBytes } from "@/components/settings/useSettingsUpdatesState";
import { formatLocalStamp } from "@/utils/format";
import ResourcesSection from "./ResourcesSection";


enableAutoUnmount(afterEach);

// The details window teleports OUTSIDE the mounted wrapper — sweep any
// window a finished test left behind so a leaked sheet can never bleed its
// DOM into the next test's document queries.
afterEach(() => {
  document.querySelectorAll('[class*="hk-modal"]').forEach((node) => node.remove());
});

// Load the real message tables: the assertions compare against the SAME
// localized strings the card renders.
beforeAll(async () => {
  await initLocaleMessages();
});

beforeEach(() => {
  setActivePinia(createPinia());
});

/** The pack status the card reads (only the decisions block is driven here —
 *  the inventory describe below supplies its own registry rows). */
function packStatus(over: Partial<DecisionsPackStatus> = {}): DecisionsPackStatus {
  return {
    present: true,
    dir: "/tmp/decisions",
    sizeBytes: 8192,
    modelPresent: true,
    modelBytes: 4096,
    moveModelPresent: false,
    moveModelBytes: 0,
    adviceModelPresent: false,
    adviceModelBytes: 0,
    torpedoModelPresent: false,
    torpedoModelBytes: 0,
    torpedo4ModelPresent: false,
    torpedo4ModelBytes: 0,
    losMaps: [],
    ...over,
  };
}

/** The resource pack's local state (only the facts the rows read are
 *  driven here). */
function resStatus(over: Partial<ResStatus> = {}): ResStatus {
  return {
    present: true,
    treeSha256: null,
    version: null,
    legacyStamp: false,
    sizeBytes: 1024,
    downloading: false,
    bundled: false,
    ...over,
  };
}

/** The AI channel's local install state (only the facts the pane reads). */
function aiPackStatus(over: Partial<AiPackStatus> = {}): AiPackStatus {
  return {
    installed: true,
    seq: 7,
    version: "2026-11-01T00:00:00Z",
    treeSha256: "abcdef",
    revision: "rev",
    installedAt: "2026-11-01T00:00:00Z",
    sizeBytes: 8192,
    losMaps: 0,
    losSkipped: false,
    models: [],
    ...over,
  };
}

/** One authenticated manifest answer (only the fields the pane reads). */
function aiCheck(over: Partial<AiPackCheck> = {}): AiPackCheck {
  return {
    current: aiPackStatus(),
    latestSeq: 8,
    latestVersion: "2026-11-02T00:00:00Z",
    latestTreeSha256: "fedcba",
    latestRevision: "rev2",
    totalBytes: 1024 * 1024,
    losIncluded: false,
    losMismatch: false,
    files: [],
    endpoint: "https://huggingface.co",
    manifestSha256: "sha",
    checkedAt: "2026-11-02T00:00:00Z",
    updateAvailable: false,
    ...over,
  };
}

/** The cache store's shape as this render reads it. Every verb is a stub:
 *  the section under test never starts a pass by itself. */
function cacheStoreStub() {
  return {
    status: null as ResStatus | null,
    update: null as ResUpdate | null,
    auxCaches: [] as AuxCacheStatus[],
    anyUpdateAvailable: false,
    updatesCheckedAt: 0,
    updatesLoading: false,
    integrityChecking: false,
    auxClearing: false,
    checkUpdates: vi.fn(),
    download: vi.fn(),
    clearRes: vi.fn(),
    verifyIntegrity: vi.fn(),
    clearAuxCache: vi.fn(),
    clearAllAuxCaches: vi.fn(),
    refreshStatus: vi.fn(),
    refreshUpdates: vi.fn(),
  };
}

/** The updates half of SettingsBodyCtx: the status card, the family rows and
 *  the details panel read the walk + the cache store, so plain refs stand in
 *  for the shared update store. The walk aggregates are derived here with the
 *  same rules the real hook applies (present rows only, bundled snapshot
 *  excluded) — a divergence would show up as a footprint assertion failure. */
function updatesState(
  rows: ResourceStatusRow[] | null = null,
  cache: Partial<ReturnType<typeof cacheStoreStub>> = {},
) {
  const resourceRows = ref<ResourceStatusRow[] | null>(rows);
  const loadResourceRows = vi.fn(async () => {});
  const walkTotalBytes = computed(() =>
    (resourceRows.value ?? []).reduce(
      (sum, row) =>
        row.present && row.sizeBytes > 0 && row.root !== "bundled"
          ? sum + row.sizeBytes
          : sum,
      0,
    ),
  );
  const walkCheckedAt = computed(() => {
    let newest: string | null = null;
    for (const row of resourceRows.value ?? []) {
      if (row.checkedAt && (newest == null || row.checkedAt > newest)) newest = row.checkedAt;
    }
    return newest;
  });
  return {
    cacheStore: { ...cacheStoreStub(), ...cache },
    resourceRows,
    walkTotalBytes,
    walkCheckedAt,
    familyBytes: (ids: readonly string[]) =>
      (resourceRows.value ?? []).reduce(
        (sum, row) => (row.present && ids.includes(row.id) ? sum + row.sizeBytes : sum),
        0,
      ),
    loadResourceRows,
    // Mirrors the hook's contract (verb, then re-walk) so the suite keeps
    // pinning the re-walk, not just the verb.
    runVerb: vi.fn(async (verb: () => Promise<unknown>) => {
      await verb();
      await loadResourceRows();
    }),
    packHashHint: ref(""),
    checkAll: vi.fn(async () => true),
    dataPackVersion: ref<string | null>(null),
    dataPackBusy: ref(false),
    refreshDataPackRow: vi.fn(),
    modCatalogStamp: ref<string | null>(null),
    modCatalogBusy: ref(false),
    refreshModCatalogRow: vi.fn(),
    appUpdatePending: ref(false),
    clearArmed: ref<string | null>(null),
    auxArmed: ref<string | null>(null),
    cleanArmed: ref(false),
  };
}

type UpdatesState = ReturnType<typeof updatesState>;

function mountSectionWith(
  updates: UpdatesState,
  pack: DecisionsPackStatus,
  out?: { resources?: ReturnType<typeof useSettingsResourcesState> },
) {
  const resources = useSettingsResourcesState();
  if (out) out.resources = resources;
  resources.capabilities.loaded = true;
  resources.capabilities.aiInference = true;
  resources.decisions.value = pack;
  resources.decisionsChecked.value = true;
  return mount(ResourcesSection, {
    props: {
      ctx: { updates, resources } as unknown as SettingsBodyCtx,
    },
  });
}

function mountSection(
  pack: DecisionsPackStatus,
  rows: ResourceStatusRow[] | null = null,
  cache: Partial<ReturnType<typeof cacheStoreStub>> = {},
) {
  return mountSectionWith(updatesState(rows, cache), pack);
}

describe("Settings → Resources decisions pack torpedo slot", () => {
  it("falls back to the legacy torpedo slot when no torp4 model is installed", async () => {
    const { host } = await mountDetails(
      packStatus({
        adviceModelPresent: true,
        adviceModelBytes: 2048,
        torpedoModelPresent: true,
        torpedoModelBytes: 4096,
      }),
    );
    const body = host.textContent ?? "";
    // The existing slots stay untouched...
    expect(body).toContain(
      t("settings.resourcesDecisionsAdviceInstalled", {
        size: formatBytes(2048),
      }),
    );
    // ...and the E26/P2 torpedo slot reports its own file + size.
    expect(body).toContain(
      t("settings.resourcesDecisionsTorpedoInstalled", {
        size: formatBytes(4096),
      }),
    );
  });

  it("prefers the torp4 slot when both torpedo models are installed", async () => {
    const { host } = await mountDetails(
      packStatus({
        torpedoModelPresent: true,
        torpedoModelBytes: 4096,
        torpedo4ModelPresent: true,
        torpedo4ModelBytes: 8192,
      }),
    );
    // T4 wins the ONE line: the three-head model is the preferred slot.
    expect(host.textContent ?? "").toContain(
      t("settings.resourcesDecisionsTorpedo4Installed", {
        size: formatBytes(8192),
      }),
    );
    expect(host.textContent ?? "").not.toContain(
      t("settings.resourcesDecisionsTorpedoInstalled", {
        size: formatBytes(4096),
      }),
    );
  });

  it("reports the torp4 slot when the legacy slot is absent", async () => {
    const { host } = await mountDetails(
      packStatus({ torpedo4ModelPresent: true, torpedo4ModelBytes: 8192 }),
    );
    expect(host.textContent ?? "").toContain(
      t("settings.resourcesDecisionsTorpedo4Installed", {
        size: formatBytes(8192),
      }),
    );
  });

  it("stays silent on an older pack without the torpedo slot", async () => {
    const { host } = await mountDetails(packStatus({ torpedoModelPresent: false }));
    expect(host.textContent ?? "").not.toContain(
      t("settings.resourcesDecisionsTorpedoInstalled", {
        size: formatBytes(4096),
      }),
    );
  });
});

/** The registry walk the inventory renders: one present pack with a
 *  timestamp version, install stamp, channel and last-check time; one
 *  present cache carrying only a size; one absent dataset (the warning
 *  shape). Three rows are enough to prove the columns align row to row. */
function inventoryRows(): ResourceStatusRow[] {
  return [
    {
      id: "res-pack",
      kind: "pack",
      channel: "res",
      trigger: "",
      progress: "",
      present: true,
      version: "2026-11-06T14:34:10Z",
      sha256: "0123456789abcdef".repeat(4),
      sizeBytes: 350 * 1024 ** 2,
      root: "cache",
      installedAt: "2026-11-05T08:00:00Z",
      checkedAt: "2026-11-07T09:30:00Z",
    },
    {
      id: "cache-image-cache",
      kind: "cache",
      channel: "",
      trigger: "",
      progress: "",
      present: true,
      version: null,
      sha256: null,
      sizeBytes: 2048,
      root: "cache",
    },
    {
      id: "data-ship-gameparams",
      kind: "dataset",
      channel: "",
      trigger: "",
      progress: "",
      present: false,
      version: null,
      sha256: null,
      sizeBytes: 0,
      root: "data",
    },
  ];
}

/** The six cell classes in DOM order — the exact sequence the stylesheet's
 *  shared subgrid maps onto the list's six tracks. */
const CELL_ORDER = ["name", "size", "version", "installed", "channel", "kind"] as const;

/** The group titles in DOM order — the section's card anatomy. */
function groupTitles(wrapper: ReturnType<typeof mountSection>): string[] {
  return wrapper.findAll(".hk-settings-group-title").map((node) => node.text());
}

/** The family card's rows in DOM order (the group titled resSpaceTitle). */
function familyRows(wrapper: ReturnType<typeof mountSection>) {
  const group = wrapper
    .findAll(".hk-settings-group")
    .find((node) => node.find(".hk-settings-group-title").text() === t("settings.resSpaceTitle"));
  return group ? group.findAll(".settings-modal__pack") : [];
}

/** The row of ONE family, selected by its name. */
function familyRow(wrapper: ReturnType<typeof mountSection>, name: string) {
  const row = familyRows(wrapper).find(
    (node) => node.find(".settings-modal__pack-name").text() === name,
  );
  if (!row) throw new Error(`family row not found: ${name}`);
  return row;
}

/** The always-visible verb labels of the family card. */
function familyVerbs(wrapper: ReturnType<typeof mountSection>): string[] {
  return familyRows(wrapper).flatMap((row) =>
    row.findAll(".settings-modal__pack-actions button").map((button) => button.text()),
  );
}

/** The details window teleports to hikari's overlay root on document.body —
 *  OUTSIDE the mounted wrapper — so every details assertion queries the
 *  document, not the wrapper. */
async function openDetails(wrapper: ReturnType<typeof mountSection>) {
  await wrapper.find(".settings-modal__res-details-entry").trigger("click");
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const host = document.querySelector('[class*="hk-modal"]');
  expect(host).toBeTruthy();
  return host!;
}

/** Mount AND open the details window in one step: the body only mounts
 *  while the window is open. */
async function mountDetails(
  pack: DecisionsPackStatus,
  rows: ResourceStatusRow[] | null = inventoryRows(),
  cache: Partial<ReturnType<typeof cacheStoreStub>> = {},
) {
  const wrapper = mountSection(pack, rows, cache);
  const host = await openDetails(wrapper);
  return { wrapper, host };
}

const cell = (row: Element, col: string): Element =>
  row.querySelector(`.settings-modal__res-inv-cell--${col}`)!;
const text = (el: Element | null | undefined): string => el?.textContent ?? "";

describe("Settings → Resources card anatomy", () => {
  it("keeps exactly two always-visible cards: the status readout and the rows", () => {
    const wrapper = mountSection(packStatus());
    expect(groupTitles(wrapper)).toEqual([
      t("settings.resStatusTitle"),
      t("settings.resSpaceTitle"),
    ]);
    // The registry audit is a child window, not a third card — only its
    // quiet entry row lives in the pane.
    expect(wrapper.find(".settings-modal__res-details-entry").exists()).toBe(true);
    expect(wrapper.find(".settings-modal__res-inv").exists()).toBe(false);
  });

  it("renders no download progress inside the pane", () => {
    // Progress is the shared top-right card's job (stores/downloads). Any
    // inline progress bar here would be the exact drift this refactor removed.
    const wrapper = mountSection(packStatus());
    expect(wrapper.find(".settings-modal__pack-progress").exists()).toBe(false);
  });
});

describe("Settings → Resources status card", () => {
  const card = (wrapper: ReturnType<typeof mountSection>) =>
    wrapper.find(".settings-modal__res-summary");

  it("claims readiness for a checked set and shows its footprint", () => {
    const wrapper = mountSection(packStatus(), inventoryRows(), {
      status: resStatus({ present: true, sizeBytes: 1024 }),
      updatesCheckedAt: 1,
    });
    const node = card(wrapper);
    expect(node.classes()).toContain("settings-modal__res-summary--success");
    expect(node.text()).toContain(t("settings.resStatusReady"));
    // The footprint is the walk's own sum (present, non-bundled rows) with the
    // NOVEL check stamp — never the cache overview added on top.
    expect(node.text()).toContain(
      t("settings.resStatusMeta", {
        size: formatBytes(350 * 1024 ** 2 + 2048),
        time: formatLocalStamp("2026-11-07T09:30:00Z"),
      }),
    );
    // ONE verb, and it is the pane's check — the apply verbs live on the rows.
    const buttons = node.findAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].text()).toBe(t("settings.cacheCheckUpdates"));
  });

  it("never dresses an unchecked set up as ready", () => {
    // No row carries a check stamp and no manifest snapshot exists yet: the
    // honest state is "not checked", not "ready".
    const rows = inventoryRows().map((row) => ({ ...row, checkedAt: null }));
    const wrapper = mountSection(packStatus(), rows, {
      status: resStatus({ present: true, sizeBytes: 1024 }),
    });
    const node = card(wrapper);
    expect(node.text()).toContain(t("settings.resStatusUnchecked"));
    expect(node.classes()).not.toContain("settings-modal__res-summary--success");
    expect(node.findAll("button")[0].text()).toBe(t("settings.cacheCheckUpdates"));
  });

  it("offers the download verb when the resource pack is missing", () => {
    const wrapper = mountSection(packStatus(), inventoryRows(), {
      status: resStatus({ present: false, sizeBytes: 0 }),
    });
    const node = card(wrapper);
    expect(node.classes()).toContain("settings-modal__res-summary--warning");
    expect(node.text()).toContain(t("settings.resStatusMissingPack"));
    expect(node.text()).toContain(t("settings.resStatusMissingPackHint"));
    expect(node.findAll("button")[0].text()).toBe(t("settings.cacheDownload"));
  });

  it("grows the ONE apply verb into update-all when updates are known", async () => {
    const updates = updatesState(inventoryRows(), {
      status: resStatus({ present: true, sizeBytes: 1024 }),
      anyUpdateAvailable: true,
      updatesCheckedAt: 1,
    });
    const state: { resources?: ReturnType<typeof useSettingsResourcesState> } = {};
    const wrapper = mountSectionWith(updates, packStatus(), state);
    // BOTH halves pending: the pack's manifest answer plus the AI channel's.
    state.resources!.aiCheck.value = aiCheck({ updateAvailable: true });
    await nextTick();
    const aiSpy = vi.spyOn(state.resources!, "downloadAi");
    const node = card(wrapper);
    expect(node.classes()).toContain("settings-modal__res-summary--info");
    expect(node.text()).toContain(t("settings.resStatusUpdates"));
    const button = node.findAll("button")[0];
    expect(button.text()).toBe(t("settings.resStatusUpdateAll"));
    await button.trigger("click");
    // Both pending passes queue through the hub's one FIFO; neither is
    // awaited on the button (the shared top-right card owns the progress).
    expect(updates.cacheStore.download).toHaveBeenCalledTimes(1);
    expect(aiSpy).toHaveBeenCalledTimes(1);
    // ...and each settled pass re-walks the registry.
    expect(updates.loadResourceRows).toHaveBeenCalled();
  });

  it("keeps the pack half of update-all behind the app-first gate", async () => {
    // The race the guard exists for: the card already rendered update-all
    // when the app update lands. Flipping the ref WITHOUT awaiting a tick
    // keeps the stale button on screen, so the click exercises the handler's
    // own gate — not the re-render that would remove the button.
    const updates = updatesState(inventoryRows(), {
      status: resStatus({ present: true, sizeBytes: 1024 }),
      anyUpdateAvailable: true,
      updatesCheckedAt: 1,
    });
    const state: { resources?: ReturnType<typeof useSettingsResourcesState> } = {};
    const wrapper = mountSectionWith(updates, packStatus(), state);
    state.resources!.aiCheck.value = aiCheck({ updateAvailable: true });
    await nextTick();
    const aiSpy = vi.spyOn(state.resources!, "downloadAi");
    const button = card(wrapper).findAll("button")[0];
    expect(button.text()).toBe(t("settings.resStatusUpdateAll"));
    updates.appUpdatePending.value = true;
    await button.trigger("click");
    // The AI channel is not held back by the app update; the pack is.
    expect(aiSpy).toHaveBeenCalledTimes(1);
    expect(updates.cacheStore.download).not.toHaveBeenCalled();
  });



  it("explains a pending app update instead of offering a verb", () => {
    const updates = updatesState(inventoryRows(), {
      status: resStatus({ present: true, sizeBytes: 1024 }),
      anyUpdateAvailable: true,
      updatesCheckedAt: 1,
    });
    updates.appUpdatePending.value = true;
    const wrapper = mountSectionWith(updates, packStatus());
    const node = card(wrapper);
    expect(node.text()).toContain(t("settings.resStatusAppFirst"));
    expect(node.text()).toContain(t("settings.resAfterApp"));
    // The app update comes first: no pack verb here, and the row's verb is
    // gated separately (the disabled prop), so the card must not add one.
    expect(node.findAll("button")).toHaveLength(0);
  });

  it("walks every refreshable lane from the ONE check verb", async () => {
    const updates = updatesState(inventoryRows(), {
      status: resStatus({ present: true, sizeBytes: 1024 }),
      updatesCheckedAt: 1,
    });
    const state: { resources?: ReturnType<typeof useSettingsResourcesState> } = {};
    const wrapper = mountSectionWith(updates, packStatus(), state);
    const aiSpy = vi.spyOn(state.resources!, "checkAiUpdate");
    await card(wrapper).findAll("button")[0].trigger("click");
    // The shell's refresh entry (data lanes + both manifests)...
    expect(updates.checkAll).toHaveBeenCalledTimes(1);
    // ...the ANNOUNCING res-manifest verb (a silent refresh drops the
    // delta-count / full-download toast a user-initiated check must give)...
    expect(updates.cacheStore.checkUpdates).toHaveBeenCalledTimes(1);
    expect(updates.cacheStore.refreshUpdates).not.toHaveBeenCalled();
    // ...the on-demand mod-hub index the shell's plan does not cover...
    expect(updates.refreshModCatalogRow).toHaveBeenCalledWith(true);
    // ...and the AI manifest snapshot on top of the shell-side check.
    expect(aiSpy).toHaveBeenCalled();
  });

  it("gates only the RESOURCE PACK behind an app update", async () => {
    const updates = updatesState(inventoryRows(), {
      status: resStatus({ present: true, sizeBytes: 1024 }),
      updatesCheckedAt: 1,
    });
    updates.appUpdatePending.value = true;
    const state: { resources?: ReturnType<typeof useSettingsResourcesState> } = {};
    const wrapper = mountSectionWith(updates, packStatus(), state);
    // An AI-only update rides its own signed channel — it must not be dressed
    // up as "update the application first".
    state.resources!.aiCheck.value = aiCheck({ updateAvailable: true });
    await nextTick();
    expect(card(wrapper).text()).toContain(t("settings.resStatusUpdates"));
    expect(card(wrapper).text()).not.toContain(t("settings.resStatusAppFirst"));
  });

  it("holds the resource pack back while an app update is pending", () => {
    const updates = updatesState(inventoryRows(), {
      status: resStatus({ present: true, sizeBytes: 1024 }),
      updatesCheckedAt: 1,
      anyUpdateAvailable: true,
    });
    updates.appUpdatePending.value = true;
    const wrapper = mountSectionWith(updates, packStatus());
    expect(card(wrapper).text()).toContain(t("settings.resStatusAppFirst"));
    expect(card(wrapper).text()).toContain(t("settings.resAfterApp"));
  });
});

describe("Settings → Resources family rows", () => {
  it("renders the four families in the documented order", () => {
    const wrapper = mountSection(packStatus(), inventoryRows(), {
      status: resStatus({ present: true, sizeBytes: 1024 }),
      auxCaches: [{ scope: "image-cache", sizeBytes: 2048 }],
    });
    expect(familyRows(wrapper).map((row) => row.find(".settings-modal__pack-name").text())).toEqual(
      [
        t("settings.resFamilyGameData"),
        t("settings.resPackTitle"),
        t("settings.resFamilyModels"),
        t("settings.resFamilyCaches"),
      ],
    );
  });

  it("never stacks two verbs on one family row", () => {
    const wrapper = mountSection(packStatus(), inventoryRows(), {
      status: resStatus({ present: true, sizeBytes: 1024 }),
      auxCaches: [{ scope: "image-cache", sizeBytes: 2048 }],
    });
    for (const row of familyRows(wrapper)) {
      expect(row.findAll(".settings-modal__pack-actions button").length).toBeLessThanOrEqual(1);
    }
  });

  it("leaves the auto-fetched game data without a verb of its own", () => {
    // The small datasets are the boot-time lane the status card's ONE check
    // spans — a second refresh button would be the same verb twice.
    const wrapper = mountSection(packStatus(), inventoryRows(), {
      status: resStatus({ present: true, sizeBytes: 1024 }),
    });
    expect(familyRow(wrapper, t("settings.resFamilyGameData")).findAll("button")).toHaveLength(0);
    // ...while it still reports where its data came from.
    expect(familyRow(wrapper, t("settings.resFamilyGameData")).text()).toContain(
      t("settings.dataSourceBundled"),
    );
  });

  it("clears every cache behind ONE two-step confirm", async () => {
    const updates = updatesState(inventoryRows(), {
      status: resStatus({ present: true, sizeBytes: 1024 }),
      auxCaches: [
        { scope: "image-cache", sizeBytes: 2048 },
        { scope: "gameparams", sizeBytes: 4096 },
      ],
    });
    const wrapper = mountSectionWith(updates, packStatus());
    const cleanButton = () =>
      familyRow(wrapper, t("settings.resFamilyCaches")).find(".settings-modal__pack-actions button");
    expect(cleanButton().text()).toBe(t("settings.resCleanAll"));
    await cleanButton().trigger("click");
    // The first click only arms the confirm — nothing is cleared yet.
    expect(cleanButton().text()).toBe(t("settings.cacheDeleteConfirm"));
    expect(updates.cacheStore.clearAllAuxCaches).not.toHaveBeenCalled();
    await cleanButton().trigger("click");
    expect(updates.cacheStore.clearAllAuxCaches).toHaveBeenCalledTimes(1);
    // ...and the walk is re-read afterwards, so the status card's footprint
    // stops advertising the bytes the cleanup just freed.
    expect(updates.loadResourceRows).toHaveBeenCalled();
  });

  it("switches the pack slot with the state instead of stacking verbs", () => {
    // No manifest snapshot: no dead "update" control — the summary's check is
    // the only way to learn whether an update exists.
    const noManifest = mountSection(packStatus(), inventoryRows(), {
      status: resStatus({ present: true, sizeBytes: 1024 }),
    });
    expect(familyRow(noManifest, t("settings.resPackTitle")).findAll("button")).toHaveLength(0);

    // Current pack + a fetched manifest: the slot becomes the integrity check.
    const current = mountSection(packStatus(), inventoryRows(), {
      status: resStatus({ present: true, sizeBytes: 1024 }),
      update: { updateAvailable: false, latestTreeSha256: "abcdef", deltaSteps: [] },
    });
    expect(familyRow(current, t("settings.resPackTitle")).find("button").text()).toBe(
      t("settings.resCheckIntegrity"),
    );

    // Missing pack: the slot is the download verb.
    const missing = mountSection(packStatus(), inventoryRows(), {
      status: resStatus({ present: false, sizeBytes: 0 }),
    });
    expect(familyRow(missing, t("settings.resPackTitle")).find("button").text()).toBe(
      t("settings.cacheDownload"),
    );
  });

  it("never claims the models are current without a manifest", () => {
    // Installed models + no authenticated manifest answer: the row reports the
    // bytes and offers the check — it does not paint a green "up to date".
    const wrapper = mountSectionWith(
      updatesState(inventoryRows(), { status: resStatus({ present: true, sizeBytes: 1024 }) }),
      packStatus(),
    );
    const row = familyRow(wrapper, t("settings.resFamilyModels"));
    expect(row.text()).not.toContain(t("settings.resUpToDate"));
    expect(row.find("button").text()).toBe(t("settings.resourcesAiChannelCheck"));
  });
});

describe("Settings → Resources details window", () => {
  it("opens the audit surface as a child window from the entry row", async () => {
    const wrapper = mountSection(packStatus(), inventoryRows(), {
      status: resStatus({ present: true, sizeBytes: 1024 }),
    });
    // The pane itself never inlines the audit table...
    expect(wrapper.find(".settings-modal__res-inv").exists()).toBe(false);
    const entry = wrapper.find(".settings-modal__res-details-entry");
    expect(entry.attributes("aria-haspopup")).toBe("dialog");
    expect(entry.attributes("aria-expanded")).toBe("false");
    // ...the entry opens it as a child window stacked on the shared popup
    // context (focus, ESC, the overlay and the phone back gesture close it).
    const host = await openDetails(wrapper);
    expect(wrapper.find(".settings-modal__res-details-entry").attributes("aria-expanded")).toBe(
      "true",
    );
    expect(host.textContent ?? "").toContain(t("settings.resDetailsTitle"));
    expect(host.querySelectorAll(".settings-modal__res-inv-row").length).toBeGreaterThan(0);
  });

  it("keeps the destructive verbs out of the always-visible rows", async () => {
    const { wrapper, host } = await mountDetails(packStatus(), inventoryRows(), {
      status: resStatus({ present: true, sizeBytes: 1024 }),
    });
    const packDelete = t("settings.resDeletePack", { size: formatBytes(1024) });
    const modelsDelete = t("settings.resDeleteModels", { size: formatBytes(8192) });
    const visible = familyVerbs(wrapper);
    expect(visible).not.toContain(packDelete);
    expect(visible).not.toContain(modelsDelete);
    // ...and they sit behind the details window's danger zone.
    expect(host.textContent ?? "").toContain(t("settings.resDangerTitle"));
    const dangerVerbs = [...host.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(dangerVerbs).toContain(packDelete);
    expect(dangerVerbs).toContain(modelsDelete);
  });

  it("keeps the restart note after the models are deleted", async () => {
    // The cleared models stay loaded until the next boot — exactly the moment
    // the note has to be visible, so it rides modelPresent OR the cleared flag.
    const updates = updatesState(inventoryRows(), {
      status: resStatus({ present: true, sizeBytes: 1024 }),
    });
    const state: { resources?: ReturnType<typeof useSettingsResourcesState> } = {};
    const wrapper = mountSectionWith(updates, packStatus(), state);
    state.resources!.decisions.value = packStatus({ present: false, modelPresent: false });
    state.resources!.decisionsCleared.value = true;
    const host = await openDetails(wrapper);
    expect(host.textContent ?? "").toContain(t("settings.resourcesDecisionsRestart"));
  });
});

describe("Settings → Resources inventory columns", () => {
  it("renders exactly six cells per row in the documented column order", async () => {
    const { host } = await mountDetails(packStatus(), inventoryRows());
    const rows = [...host.querySelectorAll(".settings-modal__res-inv-row")];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const cells = [...row.querySelectorAll(".settings-modal__res-inv-cell")];
      expect(cells).toHaveLength(6);
      expect(
        cells.map(
          (c) =>
            CELL_ORDER.find((col) =>
              c.className.includes(`settings-modal__res-inv-cell--${col}`),
            ) ?? null,
        ),
      ).toEqual([...CELL_ORDER]);
    }
  });

  it("keeps the kind chip in the far-right column of every row", async () => {
    const { host } = await mountDetails(packStatus(), inventoryRows());
    const rows = [...host.querySelectorAll(".settings-modal__res-inv-row")];
    for (const row of rows) {
      expect(row.lastElementChild?.className).toBe(
        "settings-modal__res-inv-cell settings-modal__res-inv-cell--kind",
      );
    }
    // The blue info chip is the one fact EVERY row carries.
    expect(
      rows.map((row) =>
        text(row.querySelector(".settings-modal__res-inv-cell--kind .hk-tag-info")),
      ),
    ).toEqual([t("settings.resKindPack"), t("settings.resKindCache"), t("settings.resKindDataset")]);
  });

  it("localizes a timestamp version but keeps the raw ISO in the cell hint", async () => {
    const { host } = await mountDetails(packStatus(), inventoryRows());
    const versionCell = cell(host.querySelectorAll(".settings-modal__res-inv-row")[0], "version");
    const iso = "2026-11-06T14:34:10Z";
    expect(text(versionCell)).toBe(formatLocalStamp(iso));
    expect(text(versionCell)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    // The raw source stays on the tooltip channel...
    expect(versionCell.getAttribute("data-hint")).toBe(iso);
    // ...and the localized stamp keeps the updated column's NORMAL face (the
    // mono face is reserved for verbatim IDs — see the next test).
    expect(versionCell.querySelector(".hk-tag")?.className).not.toContain(
      "settings-modal__res-inv-tag-mono",
    );
  });

  it("keeps the mono face for verbatim version IDs", async () => {
    // Semver / build ids are IDs, not stamps: mono marks them as such so a
    // build number never reads as a second timestamp vocabulary.
    const rows: ResourceStatusRow[] = [{ ...inventoryRows()[1], version: "13533378" }];
    const { host } = await mountDetails(packStatus(), rows);
    const versionCell = cell(host.querySelector(".settings-modal__res-inv-row")!, "version");
    expect(text(versionCell)).toBe("13533378");
    expect(versionCell.querySelector(".hk-tag")?.className).toContain(
      "settings-modal__res-inv-tag-mono",
    );
  });

  it("falls back to hash6 for a content-addressed row without a version", async () => {
    // A row with no version vocabulary still renders its abbreviated content
    // hash, and that ID keeps the mono face like every other verbatim ID.
    const sha256 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const rows: ResourceStatusRow[] = [{ ...inventoryRows()[1], version: null, sha256 }];
    const { host } = await mountDetails(packStatus(), rows);
    const versionCell = cell(host.querySelector(".settings-modal__res-inv-row")!, "version");
    expect(text(versionCell)).toBe("F00A08");
    expect(versionCell.querySelector(".hk-tag")?.className).toContain(
      "settings-modal__res-inv-tag-mono",
    );
    // The raw content hash stays the tooltip payload.
    expect(versionCell.getAttribute("data-hint")).toBe(sha256);
  });

  it("renders install stamps as bare local times with the raw ISO in the hint", async () => {
    const { host } = await mountDetails(packStatus(), inventoryRows());
    const installedCell = cell(host.querySelectorAll(".settings-modal__res-inv-row")[0], "installed");
    const iso = "2026-11-05T08:00:00Z";
    // The column header says "updated" — the chip itself is only the stamp.
    expect(text(installedCell)).toBe(formatLocalStamp(iso));
    expect(installedCell.getAttribute("data-hint")).toBe(iso);
  });

  it("warns in the size column for an absent resource and marks absent facts N/A", async () => {
    const { host } = await mountDetails(packStatus(), inventoryRows());
    const absentRow = host.querySelectorAll(".settings-modal__res-inv-row")[2];
    const sizeCell = cell(absentRow, "size");
    // Nothing on disk is the row's headline fact: the size cell warns, it is
    // NOT an N/A placeholder.
    expect(sizeCell.querySelector(".hk-tag-warning")?.textContent).toBe(
      t("settings.cacheStatusMissing"),
    );
    expect(sizeCell.className).not.toContain("settings-modal__res-inv-cell--na");
    // Every other fact is genuinely absent: the grey N/A chip, the --na cell
    // modifier (the phone layout hides those cells) and the localized hint.
    for (const col of ["version", "installed", "channel"]) {
      const c = cell(absentRow, col);
      expect(text(c)).toBe(t("settings.resInvNa"));
      expect(c.querySelector(".settings-modal__res-inv-tag-na")).toBeTruthy();
      expect(c.className).toContain("settings-modal__res-inv-cell--na");
      expect(c.getAttribute("data-hint")).toBe(t("settings.resInvNaHint"));
    }
  });

  it("reports a present row's size and localized channel", async () => {
    const { host } = await mountDetails(packStatus(), inventoryRows());
    const rows = [...host.querySelectorAll(".settings-modal__res-inv-row")];
    expect(text(cell(rows[1], "size"))).toBe(formatBytes(2048));
    const channelCell = cell(rows[0], "channel");
    expect(text(channelCell)).toBe(t("settings.resChanRes"));
    // The protocol code the registry stores stays the tooltip payload.
    expect(channelCell.getAttribute("data-hint")).toBe("res");
  });

  it("localizes every registry channel code and keeps the raw code in the hint", async () => {
    const channels = [
      ["app", "settings.resChanApp"],
      ["res", "settings.resChanRes"],
      ["data", "settings.resChanData"],
      ["mod-hub", "settings.resChanModHub"],
      ["ai", "settings.resChanAi"],
    ] as const;
    // One cache row per code: only the channel column differs, so the five
    // chips read side by side without another fact getting in the way.
    const rows: ResourceStatusRow[] = channels.map(([channel], i) => ({
      ...inventoryRows()[1],
      id: `cache-channel-${i}`,
      channel,
    }));
    const { host } = await mountDetails(packStatus(), rows);
    const cells = [...host.querySelectorAll(".settings-modal__res-inv-row")].map((row) =>
      cell(row, "channel"),
    );
    expect(cells.map((c) => text(c))).toEqual(channels.map(([, key]) => t(key)));
    // The protocol code stays the tooltip payload, never part of the chip.
    expect(cells.map((c) => c.getAttribute("data-hint"))).toEqual(
      channels.map(([channel]) => channel),
    );
    // A real channel keeps the blue primary chip and is never marked N/A.
    expect(cells.every((c) => c.querySelector(".hk-tag-primary") !== null)).toBe(true);
    expect(cells.some((c) => c.className.includes("settings-modal__res-inv-cell--na"))).toBe(
      false,
    );
  });

  it("falls back to the raw code for a channel the registry does not define", async () => {
    // Defensive fallback: an unknown code must still render something, not a
    // blank cell and not the N/A placeholder.
    const rows: ResourceStatusRow[] = [{ ...inventoryRows()[1], channel: "stable" }];
    const { host } = await mountDetails(packStatus(), rows);
    const channelCell = cell(host.querySelector(".settings-modal__res-inv-row")!, "channel");
    expect(text(channelCell)).toBe("stable");
    expect(channelCell.getAttribute("data-hint")).toBe("stable");
    expect(channelCell.className).not.toContain("settings-modal__res-inv-cell--na");
  });

  it("renders N/A in the size column for a present row with no bytes", async () => {
    // The app-update row is present but carries no payload of its own: its
    // size is genuinely not applicable, unlike an absent row's warning.
    const rows: ResourceStatusRow[] = [
      { ...inventoryRows()[1], id: "app-update", kind: "update", channel: "app", sizeBytes: 0 },
    ];
    const { host } = await mountDetails(packStatus(), rows);
    const row = host.querySelector(".settings-modal__res-inv-row")!;
    const sizeCell = cell(row, "size");
    expect(text(sizeCell)).toBe(t("settings.resInvNa"));
    expect(sizeCell.querySelector(".settings-modal__res-inv-tag-na")).toBeTruthy();
    expect(sizeCell.className).toContain("settings-modal__res-inv-cell--na");
    expect(sizeCell.getAttribute("data-hint")).toBe(t("settings.resInvNaHint"));
    // The kind chip still closes the row in the far-right column.
    expect(row.lastElementChild?.className).toBe(
      "settings-modal__res-inv-cell settings-modal__res-inv-cell--kind",
    );
    expect(text(cell(row, "kind"))).toBe(t("settings.resKindUpdate"));
  });

  it("renders the six column labels above the rows", async () => {
    const { host } = await mountDetails(packStatus(), inventoryRows());
    const head = host.querySelector(".settings-modal__res-inv-head")!;
    expect(head.getAttribute("aria-hidden")).toBe("true");
    const labels = [...head.querySelectorAll(".settings-modal__res-inv-cell")].map((c) => text(c));
    expect(labels).toEqual([
      t("settings.resInvColName"),
      t("settings.resInvColSize"),
      t("settings.resInvColVersion"),
      t("settings.resInvColInstalled"),
      t("settings.resInvColChannel"),
      t("settings.resInvColType"),
    ]);
  });

  it("hints the localized last-check stamp on the row", async () => {
    const { host } = await mountDetails(packStatus(), inventoryRows());
    const rows = [...host.querySelectorAll(".settings-modal__res-inv-row")];
    expect(rows[0].getAttribute("data-hint")).toBe(
      t("settings.resInvChecked", { time: formatLocalStamp("2026-11-07T09:30:00Z") }),
    );
    // A row the walk never checked carries no hint attribute at all.
    expect(rows[1].getAttribute("data-hint")).toBeNull();
  });
});
