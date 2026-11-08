/**
 * Resources settings section — the decisions-pack card's torpedo slot.
 *
 * The E26/P2 torpedo model lives inside the out-of-band decisions pack, and
 * the report side renders N/A when it is absent. The settings card therefore
 * has to report the slot's presence and on-disk size exactly like the fire /
 * move / advice models, and stay silent on older packs that predate it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";

import { initLocaleMessages, t } from "@/i18n";
import type { DecisionsPackStatus } from "@/api";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";
import { useSettingsResourcesState } from "@/components/settings/useSettingsResourcesState";
import { formatBytes } from "@/components/settings/useSettingsUpdatesState";
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

/** The pack status the card reads (only the decisions block is asserted
 *  here — the resource inventory stays empty). */
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
 *  and the (empty) inventory list, so plain refs stand in for the shared
 *  update store — the section under test never triggers a refresh. */
function updatesState() {
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
    resourceRows: ref(null),
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

function mountSection(pack: DecisionsPackStatus) {
  const resources = useSettingsResourcesState();
  resources.capabilities.loaded = true;
  resources.capabilities.aiInference = true;
  resources.decisions.value = pack;
  resources.decisionsChecked.value = true;
  return mount(ResourcesSection, {
    props: {
      ctx: { updates: updatesState(), resources } as unknown as SettingsBodyCtx,
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
