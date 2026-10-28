import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, shallowMount } from "@vue/test-utils";
import { h, reactive } from "vue";
import type { VNode } from "vue";
import type { InstalledMod, MigrationPlan } from "@/api";

const mocks = vi.hoisted(() => ({
  config: {} as { activeInstall: { path: string } | null },
  scan: vi.fn(), foreign: vi.fn(), stale: vi.fn(), loader: vi.fn(), safe: vi.fn(), reconcile: vi.fn(),
  adopt: vi.fn(), uninstall: vi.fn(), error: vi.fn(),
  migrationPlan: vi.fn(),
  records: vi.fn(), catalog: vi.fn(), preview: vi.fn(),
}));
vi.mock("vue-router", () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/api", () => ({ api: {
  modHubScanInstalled: mocks.scan, modHubForeignUnits: mocks.foreign, modHubStaleVersions: mocks.stale,
  modHubPnfLoaderStatus: mocks.loader, modHubSafeMode: mocks.safe, modHubReconcile: mocks.reconcile,
  modHubUninstallUnit: mocks.uninstall,
  modHubMigrationPlan: mocks.migrationPlan,
  modCatalogRefresh: mocks.catalog,
  modCatalogPreviewFiles: mocks.preview,
  modHubRecords: mocks.records, modTags: async () => ({ tags: [] }),
} }));
vi.mock("@/stores/config", () => ({ useConfigStore: () => mocks.config }));
vi.mock("@/stores/gameStatus", () => ({
  useGameStatusStore: () => ({ process: { running: false }, processes: [] }),
}));
vi.mock("@/stores/pluginUpdates", () => ({ usePluginUpdatesStore: () => ({ itemBusy: new Map(), syncFreshness: vi.fn() }) }));
/* The crash-suspect pins ride the crash store; the inventory tests drive
 * scan flows, so the store answers empty (no suspects, nothing pinned). */
vi.mock("@/stores/crash", () => ({
  useCrashStore: () => ({
    history: [],
    quarantined: [],
    quarantineBusy: new Set(),
    analyze: vi.fn(async () => { throw new Error("no analysis in this suite"); }),
    loadQuarantined: vi.fn(async () => []),
    quarantine: vi.fn(),
    restore: vi.fn(),
  }),
}));
vi.mock("@/stores/staleBins", () => ({ useStaleBinsStore: () => ({ adopt: mocks.adopt }) }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/useLanguage", () => ({ useLanguage: () => ({ uiLocale: { value: "en" }, dataLanguage: { value: "en" } }) }));
vi.mock("@/features/modhub/AssetPreview", () => ({ default: { name: "AssetPreview", render: () => null } }));
vi.mock("@/components/search/AsyncSearchCombo", () => ({ default: { name: "AsyncSearchCombo", render: () => null } }));
vi.mock("@celestia-island/hikari", () => {
  const component = (name: string) => ({ name, props: ["modelValue", "open", "footerActions", "items", "tabs", "src"], render: () => null });
  return {
    HkTabs: component("HkTabs"), HkSpinner: component("HkSpinner"), HkButton: component("HkButton"),
    HkCheckbox: component("HkCheckbox"), HkConfirmDialog: component("HkConfirmDialog"),
    HkIconButton: component("HkIconButton"), HkModal: component("HkModal"), HkSwitch: component("HkSwitch"), HMenu: component("HMenu"),
    HkImagePreview: component("HkImagePreview"),
    /* The file-list window's additions (detail ⋯ menu + tree). */
    HkTree: component("HkTree"),
    // The view's scroll regions (sidebar list, pane bodies, wizard stacks)
    // are hikari scroll containers now — render the (mocked) host for real
    // as a pass-through div wrapping the slot (same shape as LookupView's
    // mock; mountInstalled also un-stubs it, or shallowMount hides slots).
    HkScrollContainer: {
      name: "HkScrollContainer",
      setup(_: unknown, { slots }: { slots: { default?: () => VNode[] } }) {
        return () => h("div", slots.default?.() ?? []);
      },
    },
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
  // The sidebar list and the pane bodies are hikari scroll containers now
  // — render the (mocked) host for real so its slot content (rows, empty
  // notes, detail cards) stays visible under shallowMount.
  const view = shallowMount(ResourcesView, {
    // LoadingNote renders too: the mid-scan empty note keeps its copy (the
    // ring is the stubbed HkSpinner), and the notes below assert on it.
    global: { stubs: { HkScrollContainer: false, LoadingNote: false } },
  });
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
    view.findComponent({ name: "HMenu" }).vm.$emit("select", "migrate");
    await flushPromises();
    const wizard = () => view.findComponent({ name: "HkModal" });
    wizard().props("footerActions")[1].onClick();
    await flushPromises();
    expect(mocks.migrationPlan).toHaveBeenCalledExactlyOnceWith("C:/TestGameA", "1");
    mocks.config.activeInstall = { path: "C:/TestGameB" };
    await flushPromises();
    expect(wizard().props("modelValue")).toBe(false);
    view.findComponent({ name: "HMenu" }).vm.$emit("select", "migrate");
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

describe("plugin file-list window", () => {
  it("opens from the catalog detail menu and starts the preview right away", async () => {
    mocks.catalog.mockResolvedValue({
      mods: [{
        id: "mod-a", version: "2", category: "text", nameEn: "Mod A",
        game: ">=15.7", title: "Mod A", nameZh: "", description: "",
        authors: [{ name: "TTaro", url: "" }],
        packages: [{ name: "a.zip", sha256: "ab", size: 2048 }],
        i18n: {}, aliases: [],
      }],
      sourceVersion: "test",
      fetchedAt: "",
    });
    mocks.preview.mockResolvedValue({ binVersion: "1", packages: [] });
    // Same un-stub as mountInstalled: the scroll containers wrapping the
    // sidebar rows must render their slots for .mod-row to exist.
    const view = await shallowMount(ResourcesView, {
      global: { stubs: { HkScrollContainer: false } },
    });
    await flushPromises();
    await view.findAll(".mod-row")[0].trigger("click");
    await flushPromises();
    const menus = view.findAllComponents({ name: "HMenu" });
    menus[menus.length - 1].vm.$emit("select", "files")
    await flushPromises();
    const open = view
      .findAllComponents({ name: "HkModal" })
      .find((m) => m.props("modelValue") === true);
    expect(open).toBeTruthy();
    expect(mocks.preview).toHaveBeenCalledExactlyOnceWith("mod-a", "C:/TestGameA", undefined);
  });
});

describe("catalog detail menu", () => {
  const mountCatalogDetail = async (records: unknown[]) => {
    mocks.catalog.mockResolvedValue({
      mods: [{
        id: "mod-a", version: "2", category: "text", nameEn: "Mod A",
        game: ">=15.7", title: "Mod A", nameZh: "", description: "",
        authors: [], packages: [{ name: "a.zip", sha256: "ab", size: 2048 }],
        i18n: {}, aliases: [],
      }],
      sourceVersion: "test",
      fetchedAt: "",
    });
    mocks.records.mockResolvedValue(records);
    const view = await shallowMount(ResourcesView, {
      global: { stubs: { HkScrollContainer: false } },
    });
    await flushPromises();
    await view.findAll(".mod-row")[0].trigger("click");
    await flushPromises();
    const menus = view.findAllComponents({ name: "HMenu" });
    return menus[menus.length - 1].props("items") as { key: string; disabled?: boolean }[];
  };

  it("keeps open-path grayed until the entry has an install record", async () => {
    const notInstalled = await mountCatalogDetail([]);
    expect(notInstalled.find((i) => i.key === "open-path")?.disabled).toBe(true);

    const installed = await mountCatalogDetail([
      { id: "mod-a", version: "1", gameRoot: "C:/TestGameA" },
    ]);
    expect(installed.find((i) => i.key === "open-path")?.disabled).toBeFalsy();
  });

  it("lands the preset tabs on the installed scheme and drifts on switch", async () => {
    mocks.catalog.mockResolvedValue({
      mods: [{
        id: "smi", version: "1", category: "battle", nameEn: "SMI",
        game: "*", title: "SMI", nameZh: "", description: "",
        authors: [], packages: [{ name: "a.zip", sha256: "ab", size: 2048 }],
        i18n: {}, aliases: [],
        presets: [
          { id: "classic", nameZh: "经典", nameEn: "Classic", packages: [] },
          { id: "sasagcy", nameZh: "Sasagcy", nameEn: "Sasagcy", packages: [] },
        ],
      }],
      sourceVersion: "test",
      fetchedAt: "",
    });
    mocks.records.mockResolvedValue([
      { id: "smi", version: "1", gameRoot: "C:/TestGameA", preset: "sasagcy" },
    ]);
    const view = await shallowMount(ResourcesView, {
      global: { stubs: { HkScrollContainer: false } },
    });
    await flushPromises();
    await view.findAll(".mod-row")[0].trigger("click");
    await flushPromises();

    // The pane's preset tabs — the HkTabs whose tab list carries the
    // scheme ids (the source switcher's tabs carry view keys instead).
    const presetTabs = () =>
      view
        .findAllComponents({ name: "HkTabs" })
        .find(
          (c) =>
            (c.props("tabs") as { key: string }[] | undefined)?.some(
              (tab) => tab.key === "sasagcy",
            ),
        )!;
    // First entry shows the INSTALLED scheme, not the default first one.
    expect(presetTabs().props("modelValue")).toBe("sasagcy");

    // Switching is still a user action away from the installed scheme.
    presetTabs().vm.$emit("update:modelValue", "classic");
    await flushPromises();
    expect(presetTabs().props("modelValue")).toBe("classic");
  });

  it("folds style families: legacy record lands its scheme and the preview swaps per button", async () => {
    // A folded family (scripts/mod_hub_families.py): one card, a scheme
    // button group, per-scheme preview + note, legacy ids in supersedes.
    // The ledger record was written under the legacy one-entry-per-
    // variant id and carries no preset.
    mocks.catalog.mockResolvedValue({
      mods: [{
        id: "battle.panel", version: "1", category: "battle", nameEn: "Team Panels",
        game: "*", title: "Team Panels", nameZh: "", description: "Family intro.",
        authors: [], packages: [{ name: "classic.zip", sha256: "ab", size: 2048 }],
        i18n: {}, aliases: [],
        preview: "https://github.com/user-attachments/assets/panel-classic.png",
        supersedes: {
          "battle.panel.autospy": "classic",
          "battle.panel.ttaro": "ttaro",
        },
        presets: [
          { id: "classic", nameZh: "经典", nameEn: "Classic", packages: [],
            preview: "https://github.com/user-attachments/assets/panel-classic.png" },
          { id: "ttaro", nameZh: "TTaro", nameEn: "TTaro", packages: [],
            preview: "https://github.com/user-attachments/assets/panel-ttaro.png",
            descZh: "与剪影图标类插件不兼容。", descEn: "Incompatible with silhouette icon mods." },
        ],
      }],
      sourceVersion: "test",
      fetchedAt: "",
    });
    mocks.records.mockResolvedValue([
      { id: "battle.panel.ttaro", version: "1", gameRoot: "C:/TestGameA", preset: null },
    ]);
    const view = await shallowMount(ResourcesView, {
      global: { stubs: { HkScrollContainer: false } },
    });
    await flushPromises();
    await view.findAll(".mod-row")[0].trigger("click");
    await flushPromises();

    const presetTabs = () =>
      view
        .findAllComponents({ name: "HkTabs" })
        .find(
          (c) =>
            (c.props("tabs") as { key: string }[] | undefined)?.some(
              (tab) => tab.key === "ttaro",
            ),
        )!;
    // The legacy record's folded scheme is the landed (and installed)
    // one — not the default first scheme, and not a drift.
    expect(presetTabs().props("modelValue")).toBe("ttaro");
    // The scheme's own preview + note are on the pane.
    const previewImg = () =>
      view.findAllComponents({ name: "HkImagePreview" })[0];
    expect(previewImg().props("src")).toBe(
      "https://github.com/user-attachments/assets/panel-ttaro.png",
    );
    expect(view.find(".mod-detail__preset-note").text()).toContain(
      "Incompatible with silhouette icon mods.",
    );
    // On the installed (folded) scheme the primary action is NOT the
    // save-and-reinstall wording — there is no drift.
    expect(view.text()).not.toContain("resources.presetApplyReinstall");

    // Flipping the button group swaps the preview image and the note;
    // away from the installed scheme the save-and-reinstall wording arms.
    presetTabs().vm.$emit("update:modelValue", "classic");
    await flushPromises();
    expect(previewImg().props("src")).toBe(
      "https://github.com/user-attachments/assets/panel-classic.png",
    );
    expect(view.find(".mod-detail__preset-note").exists()).toBe(false);
  });
});
