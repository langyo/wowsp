import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, shallowMount } from "@vue/test-utils";
import { reactive } from "vue";
import type { InstalledMod, MigrationPlan } from "@/api";

const mocks = vi.hoisted(() => ({
  config: {} as { activeInstall: { path: string } | null },
  scan: vi.fn(), foreign: vi.fn(), stale: vi.fn(), loader: vi.fn(), safe: vi.fn(), reconcile: vi.fn(),
  adopt: vi.fn(), uninstall: vi.fn(), error: vi.fn(),
  migrationPlan: vi.fn(),
  records: vi.fn(), catalog: vi.fn(),
}));
vi.mock("vue-router", () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/api", () => ({ api: {
  modHubScanInstalled: mocks.scan, modHubForeignUnits: mocks.foreign, modHubStaleVersions: mocks.stale,
  modHubPnfLoaderStatus: mocks.loader, modHubSafeMode: mocks.safe, modHubReconcile: mocks.reconcile,
  modHubUninstallUnit: mocks.uninstall,
  modHubMigrationPlan: mocks.migrationPlan,
  modCatalogRefresh: mocks.catalog,
  modHubRecords: mocks.records, modTags: async () => ({ tags: [] }),
} }));
vi.mock("@/stores/config", () => ({ useConfigStore: () => mocks.config }));
vi.mock("@/stores/gameStatus", () => ({ useGameStatusStore: () => ({ process: { running: false } }) }));
vi.mock("@/stores/pluginUpdates", () => ({ usePluginUpdatesStore: () => ({ itemBusy: new Map(), syncFreshness: vi.fn() }) }));
vi.mock("@/stores/staleBins", () => ({ useStaleBinsStore: () => ({ adopt: mocks.adopt }) }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/useLanguage", () => ({ useLanguage: () => ({ uiLocale: { value: "en" }, dataLanguage: { value: "en" } }) }));
vi.mock("@/features/modhub/AssetPreview", () => ({ default: { name: "AssetPreview", render: () => null } }));
vi.mock("@/components/search/AsyncSearchCombo", () => ({ default: { name: "AsyncSearchCombo", render: () => null } }));
vi.mock("@celestia-island/hikari", () => {
  const component = (name: string) => ({ name, props: ["modelValue", "open", "footerActions"], render: () => null });
  return {
    HkTabs: component("HkTabs"), HkSpinner: component("HkSpinner"), HkButton: component("HkButton"),
    HkCheckbox: component("HkCheckbox"), HkConfirmDialog: component("HkConfirmDialog"),
    HkIconButton: component("HkIconButton"), HkModal: component("HkModal"), HkSwitch: component("HkSwitch"), HMenu: component("HMenu"),
    HkImagePreview: component("HkImagePreview"),
    useToast: () => ({ error: mocks.error, success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  };
});

import ResourcesView from "./ResourcesView";

enableAutoUnmount(afterEach);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const mod = (name: string): InstalledMod => ({
  name, relPath: "PnFMods/test", kind: "script", disabled: false,
  version: "1", fileCount: 1, totalBytes: 1, paths: ["test.xml"],
}) as InstalledMod;
async function mountInstalled() {
  const view = shallowMount(ResourcesView);
  view.findAllComponents({ name: "HkTabs" }).find((tabs) => tabs.props("modelValue") === "online")!
    .vm.$emit("update:modelValue", "installed");
  await flushPromises();
  return view;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.config = reactive({ activeInstall: { path: "C:/TestGameA" } });
  mocks.scan.mockResolvedValue([mod("Mod A")]);
  mocks.foreign.mockResolvedValue([]);
  mocks.stale.mockResolvedValue([]);
  mocks.loader.mockResolvedValue(null);
  mocks.safe.mockResolvedValue(false);
  mocks.reconcile.mockResolvedValue(null);
  mocks.records.mockResolvedValue([]);
  mocks.catalog.mockResolvedValue({ mods: [], sourceVersion: "test", fetchedAt: "" });
});

describe("mod inventory root ownership", () => {
  it("rescans after switching installs and clears old selections and confirmations", async () => {
    const view = await mountInstalled();
    await view.find(".mod-row").trigger("click");
    await view.find(".mod-detail__danger").trigger("click");
    await flushPromises();
    expect(view.findAllComponents({ name: "HkConfirmDialog" }).some((dialog) => dialog.props("open"))).toBe(true);
    const next = deferred<InstalledMod[]>();
    mocks.scan.mockReturnValueOnce(next.promise);
    mocks.config.activeInstall = { path: "C:/TestGameB" };
    await flushPromises();
    expect(mocks.scan).toHaveBeenLastCalledWith("C:/TestGameB");
    expect(view.find(".mod-row").exists()).toBe(false);
    expect(view.findAllComponents({ name: "HkConfirmDialog" }).every((dialog) => !dialog.props("open"))).toBe(true);
    next.resolve([mod("Mod B")]);
    await flushPromises();
    expect(view.find(".mod-row__name").text()).toBe("Mod B1");
    expect(mocks.uninstall).not.toHaveBeenCalled();
  });

  it("starts the new root while the previous scan is pending and discards its late result", async () => {
    const old = deferred<InstalledMod[]>();
    const latest = deferred<InstalledMod[]>();
    mocks.scan.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const view = await mountInstalled();
    mocks.config.activeInstall = { path: "C:/TestGameB" };
    await flushPromises();
    expect(mocks.scan).toHaveBeenLastCalledWith("C:/TestGameB");
    latest.resolve([mod("Mod B")]);
    await flushPromises();
    old.resolve([mod("Mod A")]);
    await flushPromises();
    expect(view.find(".mod-row__name").text()).toBe("Mod B1");
    expect(mocks.adopt).toHaveBeenCalledExactlyOnceWith("C:/TestGameB", []);
    expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith("C:/TestGameB");
  });

  it("clears the inventory when no install remains selected", async () => {
    const view = await mountInstalled();
    expect(view.find(".mod-row").exists()).toBe(true);
    mocks.config.activeInstall = null;
    await flushPromises();
    expect(view.find(".mod-row").exists()).toBe(false);
  });

  it("does not stop the new root's spinner or show an older scan error", async () => {
    const old = deferred<InstalledMod[]>();
    const latest = deferred<InstalledMod[]>();
    mocks.scan.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const view = await mountInstalled();
    mocks.config.activeInstall = { path: "C:/TestGameB" };
    await flushPromises();
    old.reject("old root is unavailable");
    await flushPromises();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(view.find(".resources-view__empty").text()).toBe("resources.scanning");
    latest.reject("new root is unavailable");
    await flushPromises();
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith("new root is unavailable");
    expect(view.find(".resources-view__empty").text()).toBe("resources.empty");
  });

  it("distinguishes the first scan from returning to the same root", async () => {
    const old = deferred<InstalledMod[]>();
    const middle = deferred<InstalledMod[]>();
    const latest = deferred<InstalledMod[]>();
    mocks.scan.mockReturnValueOnce(old.promise).mockReturnValueOnce(middle.promise).mockReturnValueOnce(latest.promise);
    const view = await mountInstalled();
    mocks.config.activeInstall = { path: "C:/TestGameB" };
    mocks.config.activeInstall = { path: "C:/TestGameA" };
    old.resolve([mod("Stale A")]);
    middle.resolve([mod("Mod B")]);
    await flushPromises();
    expect(view.find(".mod-row").exists()).toBe(false);
    expect(view.find(".resources-view__empty").text()).toBe("resources.scanning");
    latest.resolve([mod("Fresh A")]);
    await flushPromises();
    expect(view.find(".mod-row__name").text()).toBe("Fresh A1");
    expect(mocks.adopt).toHaveBeenCalledExactlyOnceWith("C:/TestGameA", []);
  });

  it("stops a pending scan's follow-up work when the view is unmounted", async () => {
    const pending = deferred<InstalledMod[]>();
    mocks.scan.mockReturnValueOnce(pending.promise);
    const view = await mountInstalled();
    view.unmount();
    pending.resolve([mod("Mod A")]);
    await flushPromises();
    expect(mocks.foreign).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.adopt).not.toHaveBeenCalled();
  });

  it("cannot reuse a delayed migration plan in another root's wizard", async () => {
    mocks.stale.mockResolvedValue([{ binVersion: "1", mods: ["Test mod"], fileCount: 1 }]);
    const pending = deferred<MigrationPlan>();
    mocks.migrationPlan.mockReturnValueOnce(pending.promise);
    const view = await mountInstalled();
    view.findComponent({ name: "HMenu" }).vm.$emit("select", { key: "migrate" });
    await flushPromises();
    const wizard = () => view.findComponent({ name: "HkModal" });
    wizard().props("footerActions")[1].onClick();
    await flushPromises();
    expect(mocks.migrationPlan).toHaveBeenCalledExactlyOnceWith("C:/TestGameA", "1");
    mocks.config.activeInstall = { path: "C:/TestGameB" };
    await flushPromises();
    expect(wizard().props("modelValue")).toBe(false);
    view.findComponent({ name: "HMenu" }).vm.$emit("select", { key: "migrate" });
    await flushPromises();
    pending.resolve({ fromVersion: "1", toVersion: "2", duplicate: [], superseded: [], decide: [{ path: "old.xml", size: 1 }] });
    await flushPromises();
    expect(wizard().props("footerActions")[1].label).toBe("resources.migrateScanStart");
  });
});

describe("list filter chips & install lights", () => {
  it("multi-selects chips with union semantics; the empty selection shows all", async () => {
    mocks.scan.mockResolvedValue([
      { ...mod("Mod A"), relPath: "PnFMods/a" },
      { ...mod("Mod P"), relPath: "PnFMods/p", kind: "patch" },
    ]);
    const view = await mountInstalled();
    const rows = () => view.findAll(".mod-row").length;
    expect(rows()).toBe(2);
    const chips = view.findAll(".resources-chips .chip");
    expect(chips).toHaveLength(2);
    await chips[0].trigger("click");
    expect(rows()).toBe(1);
    expect(view.findAll(".chip--on")).toHaveLength(1);
    await chips[1].trigger("click");
    expect(rows()).toBe(2);
    expect(view.findAll(".chip--on")).toHaveLength(2);
    await chips[0].trigger("click");
    expect(rows()).toBe(1);
    await chips[1].trigger("click");
    expect(rows()).toBe(2);
    expect(view.findAll(".chip--on")).toHaveLength(0);
  });

  it("marks rows with corner lights: yellow stale, blue aslain, green otherwise", async () => {
    mocks.catalog.mockResolvedValue({
      mods: [{ id: "mod-a", version: "2", category: "text", nameEn: "Mod A" }],
      sourceVersion: "test",
      fetchedAt: "",
    });
    mocks.records.mockResolvedValue([{ id: "mod-a", version: "1", gameRoot: "C:/TestGameA" }]);
    mocks.scan.mockResolvedValue([
      { ...mod("Mod A"), relPath: "PnFMods/a", identity: "mod-a" },
      { ...mod("Aslain One"), relPath: "PnFMods/b" },
      { ...mod("Plain"), relPath: "PnFMods/c" },
    ]);
    mocks.foreign.mockResolvedValue([
      { installer: "aslain", key: "k1", name: "Aslain One", identity: "mod-b" },
    ]);
    const view = await mountInstalled();
    expect(view.findAll(".mod-row__dot--yellow")).toHaveLength(1);
    expect(view.findAll(".mod-row__dot--blue")).toHaveLength(1);
    expect(view.findAll(".mod-row__dot--green")).toHaveLength(1);
  });
});
