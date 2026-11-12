/**
 * Resources settings section — the decisions-pack card's torpedo slot and
 * the resource-inventory column layout.
 *
 * The E26/P2 torpedo model lives inside the out-of-band decisions pack, and
 * the report side renders N/A when it is absent. The settings card therefore
 * has to report the slot's presence and on-disk size exactly like the fire /
 * move / advice models, and stay silent on older packs that predate it.
 *
 * The inventory is the section's one cross-resource surface: every row
 * renders SIX fixed cells (name | size | version | updated | channel | kind)
 * so the stylesheet's shared subgrid keeps the columns aligned across rows,
 * and the always-present kind chip closes every row in the far-right column.
 * The channel column shows the registry code's localized label (the raw code
 * stays the tooltip), and a fact with no content renders the grey N/A
 * placeholder instead of a blank cell.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";

import { initLocaleMessages, t } from "@/i18n";
import type { DecisionsPackStatus } from "@/api";
import type { ResourceStatusRow } from "@/api/modules/respack";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";
import { useSettingsResourcesState } from "@/components/settings/useSettingsResourcesState";
import { formatBytes } from "@/components/settings/useSettingsUpdatesState";
import { formatLocalStamp } from "@/utils/format";
import ResourcesSection from "./ResourcesSection";

enableAutoUnmount(afterEach);

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

/** The updates half of SettingsBodyCtx: this render only reads the pack card
 *  and the inventory walk (pass `rows` to render it), so plain refs stand in
 *  for the shared update store — the section under test never triggers a
 *  refresh. */
function updatesState(rows: ResourceStatusRow[] | null = null) {
  return {
    cacheStore: {
      status: null,
      update: null,
      progress: null,
      speedBps: 0,
      auxCaches: [],
      anyUpdateAvailable: false,
      updatesLoading: false,
      integrityChecking: false,
      checkUpdates: vi.fn(),
      download: vi.fn(),
      cancel: vi.fn(),
      clearRes: vi.fn(),
      verifyIntegrity: vi.fn(),
      clearAuxCache: vi.fn(),
      refreshStatus: vi.fn(),
      refreshUpdates: vi.fn(),
    },
    resourceRows: ref<ResourceStatusRow[] | null>(rows),
    inventoryBusy: ref(false),
    refreshInventoryRow: vi.fn(),
    dataPackVersion: ref(null),
    dataPackBusy: ref(false),
    refreshDataPackRow: vi.fn(),
    modCatalogStamp: ref(null),
    modCatalogBusy: ref(false),
    refreshModCatalogRow: vi.fn(),
    appUpdatePending: ref(false),
    clearArmed: ref(null),
    auxArmed: ref(null),
  };
}

function mountSection(pack: DecisionsPackStatus, rows: ResourceStatusRow[] | null = null) {
  const resources = useSettingsResourcesState();
  resources.capabilities.loaded = true;
  resources.capabilities.aiInference = true;
  resources.decisions.value = pack;
  resources.decisionsChecked.value = true;
  return mount(ResourcesSection, {
    props: {
      ctx: { updates: updatesState(rows), resources } as unknown as SettingsBodyCtx,
    },
  });
}

describe("Settings → Resources decisions pack torpedo slot", () => {
  it("falls back to the legacy torpedo slot when no torp4 model is installed", () => {
    const wrapper = mountSection(
      packStatus({
        adviceModelPresent: true,
        adviceModelBytes: 2048,
        torpedoModelPresent: true,
        torpedoModelBytes: 4096,
      }),
    );
    const text = wrapper.text();
    // The existing slots stay untouched...
    expect(text).toContain(
      t("settings.resourcesDecisionsAdviceInstalled", {
        size: formatBytes(2048),
      }),
    );
    // ...and the E26/P2 torpedo slot reports its own file + size.
    expect(text).toContain(
      t("settings.resourcesDecisionsTorpedoInstalled", {
        size: formatBytes(4096),
      }),
    );
  });

  it("prefers the torp4 slot when both torpedo models are installed", () => {
    const wrapper = mountSection(
      packStatus({
        torpedoModelPresent: true,
        torpedoModelBytes: 4096,
        torpedo4ModelPresent: true,
        torpedo4ModelBytes: 8192,
      }),
    );
    const text = wrapper.text();
    // T4 wins the ONE line: the three-head model is the preferred slot.
    expect(text).toContain(
      t("settings.resourcesDecisionsTorpedo4Installed", {
        size: formatBytes(8192),
      }),
    );
    expect(text).not.toContain(
      t("settings.resourcesDecisionsTorpedoInstalled", {
        size: formatBytes(4096),
      }),
    );
  });

  it("reports the torp4 slot when the legacy slot is absent", () => {
    const wrapper = mountSection(
      packStatus({ torpedo4ModelPresent: true, torpedo4ModelBytes: 8192 }),
    );
    expect(wrapper.text()).toContain(
      t("settings.resourcesDecisionsTorpedo4Installed", {
        size: formatBytes(8192),
      }),
    );
  });

  it("stays silent on an older pack without the torpedo slot", () => {
    const wrapper = mountSection(packStatus({ torpedoModelPresent: false }));
    expect(wrapper.text()).not.toContain(
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

/** The subtitles of ONE group (in DOM order), selected by its heading. */
function groupSubtitles(
  wrapper: ReturnType<typeof mountSection>,
  title: string,
): string[] {
  const groups = wrapper.findAll(".hk-settings-group");
  const group = groups.find((node) => node.find(".hk-settings-group-title").text() === title);
  return group ? group.findAll(".settings-modal__pack-name").map((node) => node.text()) : [];
}

describe("Settings → Resources card anatomy", () => {
  it("lists the three groups in the documented order", () => {
    const wrapper = mountSection(packStatus());
    // 资源 inventory → game-client data → resource pack → AI runtime. The
    // decision-model pack is NOT its own group: the models belong to the
    // runtime that consumes them.
    expect(groupTitles(wrapper)).toEqual([
      t("settings.resInvTitle"),
      t("settings.resourcesGameTitle"),
      t("settings.resourcesBakedTitle"),
      t("settings.resourcesAiTitle"),
    ]);
  });

  it("groups the decision-model pack with the AI runtime, not with the models", () => {
    const wrapper = mountSection(packStatus());
    // The pack is what the runtime loads — it reads as one story.
    expect(groupSubtitles(wrapper, t("settings.resourcesAiTitle"))).toContain(
      t("settings.resourcesDecisionsName"),
    );
    // ...and it is no longer a row of the baked-model-assets group, which now
    // holds only the shared resource pack.
    expect(groupSubtitles(wrapper, t("settings.resourcesBakedTitle"))).not.toContain(
      t("settings.resourcesDecisionsName"),
    );
  });

  it("renders no download progress inside the pane", () => {
    // Progress is the shared top-right card's job (stores/downloads). Any
    // inline progress bar here would be the exact drift this refactor removed.
    const wrapper = mountSection(packStatus());
    expect(wrapper.find(".settings-modal__pack-progress").exists()).toBe(false);
  });
});

describe("Settings → Resources inventory columns", () => {
  it("renders exactly six cells per row in the documented column order", () => {
    const wrapper = mountSection(packStatus(), inventoryRows());
    const rows = wrapper.findAll(".settings-modal__res-inv-row");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const cells = row.findAll(".settings-modal__res-inv-cell");
      expect(cells).toHaveLength(6);
      expect(
        cells.map(
          (cell) =>
            CELL_ORDER.find((col) => cell.classes(`settings-modal__res-inv-cell--${col}`)) ?? null,
        ),
      ).toEqual([...CELL_ORDER]);
    }
  });

  it("keeps the kind chip in the far-right column of every row", () => {
    const wrapper = mountSection(packStatus(), inventoryRows());
    const rows = wrapper.findAll(".settings-modal__res-inv-row");
    for (const row of rows) {
      expect(row.element.lastElementChild?.className).toBe(
        "settings-modal__res-inv-cell settings-modal__res-inv-cell--kind",
      );
    }
    // The blue info chip is the one fact EVERY row carries.
    expect(
      rows.map((row) => row.find(".settings-modal__res-inv-cell--kind .hk-tag-info").text()),
    ).toEqual([t("settings.resKindPack"), t("settings.resKindCache"), t("settings.resKindDataset")]);
  });

  it("localizes a timestamp version but keeps the raw ISO in the cell hint", () => {
    const wrapper = mountSection(packStatus(), inventoryRows());
    const versionCell = wrapper
      .findAll(".settings-modal__res-inv-row")[0]
      .find(".settings-modal__res-inv-cell--version");
    const iso = "2026-11-06T14:34:10Z";
    expect(versionCell.text()).toBe(formatLocalStamp(iso));
    expect(versionCell.text()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    // The raw source stays on the tooltip channel...
    expect(versionCell.attributes("data-hint")).toBe(iso);
    // ...and the localized stamp keeps the updated column's NORMAL face (the
    // mono face is reserved for verbatim IDs — see the next test).
    expect(versionCell.find(".hk-tag").classes()).not.toContain(
      "settings-modal__res-inv-tag-mono",
    );
  });

  it("keeps the mono face for verbatim version IDs", () => {
    // Semver / build ids are IDs, not stamps: mono marks them as such so a
    // build number never reads as a second timestamp vocabulary.
    const rows: ResourceStatusRow[] = [{ ...inventoryRows()[1], version: "13533378" }];
    const wrapper = mountSection(packStatus(), rows);
    // Scope to the data row: the header carries the same cell modifier.
    const versionCell = wrapper
      .find(".settings-modal__res-inv-row")
      .find(".settings-modal__res-inv-cell--version");
    expect(versionCell.text()).toBe("13533378");
    expect(versionCell.find(".hk-tag").classes()).toContain("settings-modal__res-inv-tag-mono");
  });

  it("falls back to hash6 for a content-addressed row without a version", () => {
    // A row with no version vocabulary still renders its abbreviated content
    // hash, and that ID keeps the mono face like every other verbatim ID.
    const sha256 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const rows: ResourceStatusRow[] = [{ ...inventoryRows()[1], version: null, sha256 }];
    const wrapper = mountSection(packStatus(), rows);
    const versionCell = wrapper
      .find(".settings-modal__res-inv-row")
      .find(".settings-modal__res-inv-cell--version");
    expect(versionCell.text()).toBe("F00A08");
    expect(versionCell.find(".hk-tag").classes()).toContain("settings-modal__res-inv-tag-mono");
    // The raw content hash stays the tooltip payload.
    expect(versionCell.attributes("data-hint")).toBe(sha256);
  });

  it("renders install stamps as bare local times with the raw ISO in the hint", () => {
    const wrapper = mountSection(packStatus(), inventoryRows());
    const installedCell = wrapper
      .findAll(".settings-modal__res-inv-row")[0]
      .find(".settings-modal__res-inv-cell--installed");
    const iso = "2026-11-05T08:00:00Z";
    // The column header says "updated" — the chip itself is only the stamp.
    expect(installedCell.text()).toBe(formatLocalStamp(iso));
    expect(installedCell.attributes("data-hint")).toBe(iso);
  });

  it("warns in the size column for an absent resource and marks absent facts N/A", () => {
    const wrapper = mountSection(packStatus(), inventoryRows());
    const absentRow = wrapper.findAll(".settings-modal__res-inv-row")[2];
    const sizeCell = absentRow.find(".settings-modal__res-inv-cell--size");
    // Nothing on disk is the row's headline fact: the size cell warns, it is
    // NOT an N/A placeholder.
    expect(sizeCell.find(".hk-tag-warning").text()).toBe(t("settings.cacheStatusMissing"));
    expect(sizeCell.classes()).not.toContain("settings-modal__res-inv-cell--na");
    // Every other fact is genuinely absent: the grey N/A chip, the --na cell
    // modifier (the phone layout hides those cells) and the localized hint.
    for (const col of ["version", "installed", "channel"]) {
      const cell = absentRow.find(`.settings-modal__res-inv-cell--${col}`);
      expect(cell.text()).toBe(t("settings.resInvNa"));
      expect(cell.find(".settings-modal__res-inv-tag-na").exists()).toBe(true);
      expect(cell.classes()).toContain("settings-modal__res-inv-cell--na");
      expect(cell.attributes("data-hint")).toBe(t("settings.resInvNaHint"));
    }
  });

  it("reports a present row's size and localized channel", () => {
    const wrapper = mountSection(packStatus(), inventoryRows());
    const rows = wrapper.findAll(".settings-modal__res-inv-row");
    expect(rows[1].find(".settings-modal__res-inv-cell--size").text()).toBe(formatBytes(2048));
    const channelCell = rows[0].find(".settings-modal__res-inv-cell--channel");
    expect(channelCell.text()).toBe(t("settings.resChanRes"));
    // The protocol code the registry stores stays the tooltip payload.
    expect(channelCell.attributes("data-hint")).toBe("res");
  });

  it("localizes every registry channel code and keeps the raw code in the hint", () => {
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
    const wrapper = mountSection(packStatus(), rows);
    const cells = wrapper
      .findAll(".settings-modal__res-inv-row")
      .map((row) => row.find(".settings-modal__res-inv-cell--channel"));
    expect(cells.map((cell) => cell.text())).toEqual(channels.map(([, key]) => t(key)));
    // The protocol code stays the tooltip payload, never part of the chip.
    expect(cells.map((cell) => cell.attributes("data-hint"))).toEqual(
      channels.map(([channel]) => channel),
    );
    // A real channel keeps the blue primary chip and is never marked N/A.
    expect(cells.every((cell) => cell.find(".hk-tag-primary").exists())).toBe(true);
    expect(
      cells.some((cell) => cell.classes().includes("settings-modal__res-inv-cell--na")),
    ).toBe(false);
  });

  it("falls back to the raw code for a channel the registry does not define", () => {
    // Defensive fallback: an unknown code must still render something, not a
    // blank cell and not the N/A placeholder.
    const rows: ResourceStatusRow[] = [{ ...inventoryRows()[1], channel: "stable" }];
    const wrapper = mountSection(packStatus(), rows);
    const cell = wrapper
      .find(".settings-modal__res-inv-row")
      .find(".settings-modal__res-inv-cell--channel");
    expect(cell.text()).toBe("stable");
    expect(cell.attributes("data-hint")).toBe("stable");
    expect(cell.classes()).not.toContain("settings-modal__res-inv-cell--na");
  });

  it("renders N/A in the size column for a present row with no bytes", () => {
    // The app-update row is present but carries no payload of its own: its
    // size is genuinely not applicable, unlike an absent row's warning.
    const rows: ResourceStatusRow[] = [
      { ...inventoryRows()[1], id: "app-update", kind: "update", channel: "app", sizeBytes: 0 },
    ];
    const wrapper = mountSection(packStatus(), rows);
    const row = wrapper.find(".settings-modal__res-inv-row");
    const sizeCell = row.find(".settings-modal__res-inv-cell--size");
    expect(sizeCell.text()).toBe(t("settings.resInvNa"));
    expect(sizeCell.find(".settings-modal__res-inv-tag-na").exists()).toBe(true);
    expect(sizeCell.classes()).toContain("settings-modal__res-inv-cell--na");
    expect(sizeCell.attributes("data-hint")).toBe(t("settings.resInvNaHint"));
    // The kind chip still closes the row in the far-right column.
    expect(row.element.lastElementChild?.className).toBe(
      "settings-modal__res-inv-cell settings-modal__res-inv-cell--kind",
    );
    expect(row.find(".settings-modal__res-inv-cell--kind").text()).toBe(t("settings.resKindUpdate"));
  });

  it("renders the six column labels above the rows", () => {
    const wrapper = mountSection(packStatus(), inventoryRows());
    const head = wrapper.find(".settings-modal__res-inv-head");
    expect(head.attributes("aria-hidden")).toBe("true");
    expect(head.findAll(".settings-modal__res-inv-cell").map((cell) => cell.text())).toEqual([
      t("settings.resInvColName"),
      t("settings.resInvColSize"),
      t("settings.resInvColVersion"),
      t("settings.resInvColInstalled"),
      t("settings.resInvColChannel"),
      t("settings.resInvColType"),
    ]);
  });

  it("hints the localized last-check stamp on the row", () => {
    const wrapper = mountSection(packStatus(), inventoryRows());
    const rows = wrapper.findAll(".settings-modal__res-inv-row");
    expect(rows[0].attributes("data-hint")).toBe(
      t("settings.resInvChecked", { time: formatLocalStamp("2026-11-07T09:30:00Z") }),
    );
    // A row the walk never checked carries no hint attribute at all.
    expect(rows[1].attributes("data-hint")).toBeUndefined();
  });
});
