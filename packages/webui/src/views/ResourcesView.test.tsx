import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, shallowMount } from "@vue/test-utils";
import { h, reactive } from "vue";
import type { VNode } from "vue";
import type { InstalledMod, MigrationPlan } from "@/api";

const mocks = vi.hoisted(() => ({
  config: {} as {
    activeInstall: { path: string; kind?: string; realm?: string | null } | null;
    installs?: { path: string; kind?: string; realm?: string | null }[];
  },
  scan: vi.fn(), foreign: vi.fn(), stale: vi.fn(), treeVersion: vi.fn(), loader: vi.fn(), loaderHealth: vi.fn(), safe: vi.fn(), reconcile: vi.fn(),
  bootInstaller: vi.fn(), disarm: vi.fn(),
  adopt: vi.fn(), uninstall: vi.fn(), cleanJunk: vi.fn(), error: vi.fn(),
  success: vi.fn(), warning: vi.fn(), info: vi.fn(),
  migrationPlan: vi.fn(),
  purgeBackups: vi.fn(),
  records: vi.fn(), catalog: vi.fn(), preview: vi.fn(),
  clientUsage: vi.fn(),
  layerStack: vi.fn(), layerSetOrder: vi.fn(), layerSetEnabled: vi.fn(),
  layerRender: vi.fn(), layerPaths: vi.fn(),
  catalogInstall: vi.fn(), catalogUninstall: vi.fn(),
  syncOn: true,
}));
vi.mock("vue-router", () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/api", () => ({ api: {
  modHubScanInstalled: mocks.scan, modHubForeignUnits: mocks.foreign, modHubStaleVersions: mocks.stale,
  modHubTreeVersion: mocks.treeVersion,
  modHubPnfLoaderStatus: mocks.loader, modHubLoaderHealth: mocks.loaderHealth, modHubSafeMode: mocks.safe, modHubReconcile: mocks.reconcile,
  modHubBootInstaller: mocks.bootInstaller, modHubDisarmBootInstaller: mocks.disarm,
  modHubUninstallUnit: mocks.uninstall,
  modHubCleanUnitJunk: mocks.cleanJunk,
  modHubMigrationPlan: mocks.migrationPlan,
  modHubPurgeBackups: mocks.purgeBackups,
  modCatalogRefresh: mocks.catalog,
  modCatalogPreviewFiles: mocks.preview,
  modCatalogInstall: mocks.catalogInstall,
  modCatalogUninstall: mocks.catalogUninstall,
  modHubRecords: mocks.records, modTags: async () => ({ tags: [] }),
  modHubClientUsage: mocks.clientUsage,
  modHubLayerStack: mocks.layerStack,
  modHubLayerSetOrder: mocks.layerSetOrder,
  modHubLayerSetEnabled: mocks.layerSetEnabled,
  modHubLayerRender: mocks.layerRender,
  modHubLayerPaths: mocks.layerPaths,
} }));
vi.mock("@/stores/config", () => ({ useConfigStore: () => mocks.config }));
vi.mock("@/stores/gameStatus", () => ({
  useGameStatusStore: () => ({ process: { running: false }, processes: [] }),
}));
/* The pluginUpdates mock routes the shared run entry points onto the
 * mocked api commands, so fan-out assertions observe the per-root RPCs
 * exactly like production does. */
vi.mock("@/stores/pluginUpdates", () => ({
  usePluginUpdatesStore: () => ({
    itemBusy: new Map(),
    syncFreshness: vi.fn(),
    runMod: (id: string, root: string, preset?: string, _op?: string, skip?: boolean) =>
      mocks.catalogInstall(id, root, preset, skip),
    runModUninstall: (id: string, root: string) => mocks.catalogUninstall(id, root),
  }),
}));
/* The mod-sync preference: a plain getter box (not a vue ref) seeded per
 * test BEFORE mount — the computeds read it lazily, which is all the
 * assertions need. */
vi.mock("@/stores/modSync", () => ({
  modSyncState: { get value() { return mocks.syncOn; } },
  useModSyncStore: () => ({
    syncEnabled: { get value() { return mocks.syncOn; } },
    setSyncEnabled: (v: boolean) => { mocks.syncOn = v; },
    toggleSync: () => { mocks.syncOn = !mocks.syncOn; },
  }),
}));
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
/* Keys pass through, but as a SPY so parameterized calls (the server tag's
 * {servers} interpolation) are assertable — the pane's label contract
 * lives in the ARGUMENTS, not in the rendered key echo. */
vi.mock("@/i18n", () => ({ t: vi.fn((key: string) => key) }));
vi.mock("@/i18n/useLanguage", () => ({ useLanguage: () => ({ uiLocale: { value: "en" }, dataLanguage: { value: "en" } }) }));
vi.mock("@/features/modhub/AssetPreview", () => ({ default: { name: "AssetPreview", render: () => null } }));
vi.mock("@/components/search/AsyncSearchCombo", () => ({ default: { name: "AsyncSearchCombo", render: () => null } }));
vi.mock("@celestia-island/hikari", () => {
  const component = (name: string) => ({
    name,
    props: ["modelValue", "open", "footerActions", "items", "tabs", "src", "message", "title", "confirmLabel", "loading"],
    render: () => null,
  });
  return {
    HkTabs: component("HkTabs"), HkSpinner: component("HkSpinner"), HkButton: component("HkButton"),
    HkCheckbox: component("HkCheckbox"), HkConfirmDialog: component("HkConfirmDialog"),
    HkIconButton: component("HkIconButton"), HkModal: component("HkModal"), HkSwitch: component("HkSwitch"), HMenu: component("HMenu"),
    HkImagePreview: component("HkImagePreview"), HkMediaPlayer: component("HkMediaPlayer"),
    /* The layered swimlane's primitive: render its item slot for real so
       the layer rows are inspectable under shallowMount. */
    HkDraggableList: {
      name: "HkDraggableList",
      props: ["items", "lockedKeys", "label"],
      setup(
        props: { items?: { key: string }[] },
        { slots }: { slots: { item?: (scope: { item: { key: string } }) => VNode } },
      ) {
        return () =>
          h(
            "div",
            { class: "hk-draggable-list" },
            (props.items ?? []).map((item) => slots.item?.({ item })),
          );
      },
    },
    /* AppTag's hikari base — a class-merging span passthrough so the
       migrated tags render for the DOM-contract assertions. */
    HkTag: {
      name: "HkTag",
      inheritAttrs: false,
      setup(_: unknown, { slots, attrs }: { slots: { icon?: () => VNode[]; default?: () => VNode[] }; attrs: Record<string, unknown> }) {
        return () => h("span", { ...attrs, class: ["hk-tag", attrs.class] }, [slots.icon?.(), slots.default?.()]);
      },
    },
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
    /* The boot strip's collapsible: a header button that toggles through
     * update:modelValue and gates its body (the row list) on modelValue —
     * the shape the boot-installer assertions drive. */
    HkExpansionPanel: {
      name: "HkExpansionPanel",
      props: ["modelValue", "disabled"],
      emits: ["update:modelValue"],
      setup(
        props: { modelValue?: boolean },
        { slots, emit }: { slots: Record<string, (() => VNode[]) | undefined>; emit: (event: string, ...args: unknown[]) => void },
      ) {
        return () =>
          h("div", { class: "hk-expansion-panel" }, [
            h(
              "button",
              {
                type: "button",
                class: "hk-expansion-panel-header",
                "aria-expanded": props.modelValue ? "true" : "false",
                onClick: () => emit("update:modelValue", !props.modelValue),
              },
              [slots.title?.(), h("span", { class: "hk-expansion-panel-chevron" }), slots.action?.()],
            ),
            props.modelValue ? h("div", { class: "hk-expansion-panel-body" }, slots.default?.()) : null,
          ]);
      },
    },
    useToast: () => ({ error: mocks.error, success: mocks.success, warning: mocks.warning, info: mocks.info }),
  };
});

/* The mocked t, imported so parameterized calls are assertable. */
import { t } from "@/i18n";
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
    global: { stubs: { HkScrollContainer: false, HkExpansionPanel: false, LoadingNote: false, AppTag: false, HkTag: false } },
  });
  view.findAllComponents({ name: "HkTabs" }).find((tabs) => tabs.props("modelValue") === "online")!
    .vm.$emit("update:modelValue", "installed");
  await flushPromises();
  return view;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.syncOn = true;
  mocks.config = reactive({ activeInstall: { path: "C:/TestGameA" }, installs: [] });
  mocks.scan.mockResolvedValue([mod("Mod A")]);
  mocks.foreign.mockResolvedValue([]);
  mocks.stale.mockResolvedValue([]);
  mocks.treeVersion.mockResolvedValue({
    treeGameVersion: "15.10.0",
    gameVersion: "15.10.0",
    stale: false,
    riskyPaths: [],
  });
  mocks.loader.mockResolvedValue(null);
  mocks.loaderHealth.mockResolvedValue(null);
  mocks.bootInstaller.mockResolvedValue(null);
  mocks.disarm.mockResolvedValue({ removedFiles: 3, cutRows: 2 });
  mocks.safe.mockResolvedValue(false);
  mocks.reconcile.mockResolvedValue(null);
  mocks.records.mockResolvedValue([]);
  mocks.cleanJunk.mockResolvedValue({ relPath: "PnFMods/test", removedFiles: 2 });
  mocks.clientUsage.mockResolvedValue({ totalBytes: 4096, files: 4, units: 2 });
  mocks.catalog.mockResolvedValue({ mods: [], sourceVersion: "test", fetchedAt: "" });
  mocks.purgeBackups.mockResolvedValue([]);
  mocks.layerStack.mockResolvedValue({
    layers: [], rendered: true, generation: 0, slotConflicts: [], gameVersion: null,
  });
  mocks.layerRender.mockResolvedValue({
    written: 0, removed: 0, unchanged: 0, blockedForeign: 0, warnings: [], generation: 1,
  });
  mocks.layerPaths.mockResolvedValue([]);
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


  it("warns when the mod tree was stamped by an older client", async () => {
    // The field report's shape: mods installed for 15.9, the client now on
    // 15.10, loose gui/ overrides on disk. The banner names both versions
    // and the override count — and it is ADVISORY (nothing is disabled).
    mocks.treeVersion.mockResolvedValue({
      treeGameVersion: "15.9.0",
      gameVersion: "15.10.0",
      stale: true,
      riskyPaths: ["gui/uss_settings.xml", "gui/fontconfig_scaleform.xml"],
    });
    const view = await mountInstalled();
    await flushPromises();
    const banners = view.findAll(".resources-banner--warn");
    expect(
      banners.some((b) => b.text().includes("resources.treeStale")),
      banners.map((b) => b.text()).join(" | "),
    ).toBe(true);
    expect(mocks.treeVersion).toHaveBeenCalled();
  });

  it("stays quiet when the tree matches the running client", async () => {
    const view = await mountInstalled();
    await flushPromises();
    const banners = view.findAll(".resources-banner--warn");
    expect(
      banners.some((b) => b.text().includes("resources.treeStale")),
      banners.map((b) => b.text()).join(" | "),
    ).toBe(false);
  });

  it("names the count and stays keyboard-reachable when overrides remain", async () => {
    // The count must actually reach t(), not just the key: the dead-param
    // bug this test replaces passed a {count} the locale never used.
    mocks.treeVersion.mockResolvedValue({
      treeGameVersion: "15.9.0",
      gameVersion: "15.10.0",
      stale: true,
      riskyPaths: ["gui/uss_settings.xml", "gui/fontconfig_scaleform.xml"],
    });
    const view = await mountInstalled();
    await flushPromises();
    const banner = view
      .findAll(".resources-banner--warn")
      .find((b) => b.attributes("role") === "alert");
    expect(banner, "the stale banner is an alert region").toBeTruthy();
    // The params ride the mocked t() as its second argument object.
    const calls = (t as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const call = calls.find((c) => c[0] === "resources.treeStale");
    expect(call, "treeStale must be rendered with params").toBeTruthy();
    expect(call![1]).toMatchObject({ count: 2, tree: "15.9.0", current: "15.10.0" });
    // The hint has to be focusable: its whole explanation lives in data-hint.
    const hintHolder = banner!.find("[data-hint]");
    expect(hintHolder.attributes("tabindex")).toBe("0");
  });

  it("says there is nothing to disable when no overrides remain", async () => {
    // A tree whose only override is .bak-disabled is still stale, but with
    // an empty risk list — the banner must not claim "0 files to disable".
    mocks.treeVersion.mockResolvedValue({
      treeGameVersion: "15.9.0",
      gameVersion: "15.10.0",
      stale: true,
      riskyPaths: [],
    });
    await mountInstalled();
    await flushPromises();
    const calls = (t as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(
      calls.some((c) => c[0] === "resources.treeStaleNoOverrides"),
      calls.map((c) => String(c[0])).join(", "),
    ).toBe(true);
    expect(
      calls.some((c) => c[0] === "resources.treeStale"),
      "the count-bearing variant must not render with an empty list",
    ).toBe(false);
  });
  it("cannot reuse a delayed migration plan in another root's wizard", async () => {
    mocks.stale.mockResolvedValue([{ binVersion: "1", mods: ["Test mod"], fileCount: 1 }]);
    const pending = deferred<MigrationPlan>();
    mocks.migrationPlan.mockReturnValueOnce(pending.promise);
    const view = await mountInstalled();
    view.findComponent({ name: "HMenu" }).vm.$emit("select", "migrate");
    await flushPromises();
    // Multiple modals share the view now (safe mode / purge / migration):
    // the wizard is the one whose footer carries the migrate actions.
    const wizard = () =>
      view
        .findAllComponents({ name: "HkModal" })
        .find((m) => {
          const actions = m.props("footerActions") as
            | { label?: string }[]
            | undefined;
          return (
            !!actions &&
            actions.length > 0 &&
            String(actions[0]?.label ?? "").startsWith("resources.migrate")
          );
        })!;
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
    const chips = view.findAll(".resources-chips .app-tag");
    expect(chips).toHaveLength(2);
    await chips[0].trigger("click");
    expect(rows()).toBe(1);
    expect(view.findAll(".resources-chips .app-tag--primary")).toHaveLength(1);
    await chips[1].trigger("click");
    expect(rows()).toBe(2);
    expect(view.findAll(".resources-chips .app-tag--primary")).toHaveLength(2);
    await chips[0].trigger("click");
    expect(rows()).toBe(1);
    await chips[1].trigger("click");
    expect(rows()).toBe(2);
    expect(view.findAll(".resources-chips .app-tag--primary")).toHaveLength(0);
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
      global: { stubs: { HkScrollContainer: false, AppTag: false, HkTag: false } },
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
      global: { stubs: { HkScrollContainer: false, AppTag: false, HkTag: false } },
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
      global: { stubs: { HkScrollContainer: false, AppTag: false, HkTag: false } },
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
      global: { stubs: { HkScrollContainer: false, AppTag: false, HkTag: false } },
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

describe("detail pane server tag + author tags", () => {
  const catEntry = (servers: string[] | undefined, author = "Ren_Zotto_prpr") => ({
    id: "text.font.east-asia", version: "1", category: "battle",
    nameEn: "East Asia Font Pack", game: ">=15.9 <15.10",
    title: "East Asia Font Pack", nameZh: "", description: "CJK filler.",
    authors: [{ name: author, url: "" }],
    packages: [{ name: "a.zip", sha256: "ab", size: 2048 }],
    i18n: {}, aliases: [], servers,
  });
  const mountEntry = async (servers?: string[]) => {
    mocks.catalog.mockResolvedValue({
      mods: [catEntry(servers)],
      sourceVersion: "test",
      fetchedAt: "",
    });
    const view = await shallowMount(ResourcesView, {
      global: { stubs: { HkScrollContainer: false, AppTag: false, HkTag: false } },
    });
    await flushPromises();
    await view.findAll(".mod-row")[0].trigger("click");
    await flushPromises();
    return view;
  };

  it("folds all-server applicability into ONE universal tag at the top", async () => {
    const view = await mountEntry(undefined);
    const tag = view.find(".mod-detail__badges [data-scope]");
    expect(tag.exists()).toBe(true);
    expect(tag.text()).toContain("resources.servers.universal");
    // The old metadata-row scatter is gone: no per-realm tags anywhere.
    expect(view.find(".mod-detail__meta-servers").exists()).toBe(false);
    expect(view.find(".mod-detail__meta-server").exists()).toBe(false);
  });

  it("keeps a server SUBSET inside the same one tag instead of scattering", async () => {
    const view = await mountEntry(["na", "asia"]);
    const tag = view.find(".mod-detail__badges [data-scope]");
    expect(tag.text()).toContain("resources.servers.list");
    expect(tag.attributes("data-scope")).toBe("exclusive");
    // The realm names are interpolated into the same tag, dot-joined (the
    // i18n mock echoes keys, so the ARGUMENTS are the assertion).
    // realmLabel falls back to the uppercased code when the echoed mock
    // has no translation, so the interpolation reads "NA·ASIA".
    expect(vi.mocked(t)).toHaveBeenCalledWith("resources.servers.list", {
      servers: "NA·ASIA",
    });
    // Still exactly one applicability tag, and no meta scatter.
    expect(view.findAll(".mod-detail__badges [data-scope]").length).toBe(1);
    expect(view.find(".mod-detail__meta-server").exists()).toBe(false);
  });

  it("renders author names in a never-wrap text span", async () => {
    const view = await mountEntry(undefined);
    // Tag texts (server label + author) all live in the never-wrap span;
    // the AUTHOR pill is the one carrying the name.
    const texts = view.findAll(".mod-detail__badges .app-tag").map((w) => w.text());
    expect(texts).toContain("Ren_Zotto_prpr");
  });

  it("keeps the span between the icons on the linked author pill", async () => {
    mocks.catalog.mockResolvedValue({
      mods: [{
        ...catEntry(undefined),
        authors: [{ name: "Linked_Author", url: "https://example.com/a" }],
      }],
      sourceVersion: "test",
      fetchedAt: "",
    });
    const view = await shallowMount(ResourcesView, {
      global: { stubs: { HkScrollContainer: false, AppTag: false, HkTag: false } },
    });
    await flushPromises();
    await view.findAll(".mod-row")[0].trigger("click");
    await flushPromises();
    const link = view
      .findAll("button.app-tag-btn")
      .find((w) => w.text().includes("Linked_Author"));
    expect(link).toBeDefined();
    expect(link!.find(".app-tag").text()).toBe("Linked_Author");
  });
});

describe("server-applicability filtering (left-sidebar client realm)", () => {
  const catEntry = (id: string, servers?: string[]) => ({
    id, version: "1", category: "battle", nameEn: id, game: "*",
    title: id, nameZh: "", description: "",
    authors: [], packages: [{ name: "a.zip", sha256: "ab", size: 2048 }],
    i18n: {}, aliases: [], servers,
  });
  const mountOnline = async (mods: unknown[], active: Record<string, unknown>) => {
    mocks.catalog.mockResolvedValue({ mods, sourceVersion: "test", fetchedAt: "" });
    mocks.config.activeInstall = active as typeof mocks.config.activeInstall;
    const view = await shallowMount(ResourcesView, {
      global: { stubs: { HkScrollContainer: false, AppTag: false, HkTag: false } },
    });
    await flushPromises();
    return view;
  };

  it("hides entries inapplicable to the active install's realm", async () => {
    const view = await mountOnline(
      [catEntry("mod-any"), catEntry("mod-eu", ["eu"])],
      { kind: "cn360", realm: "cn", path: "C:/TestGameA" },
    );
    const rows = view.findAll(".mod-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toContain("mod-any");
  });

  it("falls back through the kind when the install carries no realm field", async () => {
    const view = await mountOnline(
      [catEntry("mod-any"), catEntry("mod-eu", ["eu"])],
      { kind: "cn360", path: "C:/TestGameA" },
    );
    expect(view.findAll(".mod-row")).toHaveLength(1);
  });

  it("an unknown realm hides nothing (no over-filtering ambiguous clients)", async () => {
    const view = await mountOnline(
      [catEntry("mod-any"), catEntry("mod-eu", ["eu"])],
      { kind: "steam", path: "C:/TestGameA" },
    );
    expect(view.findAll(".mod-row")).toHaveLength(2);
  });

  it("keeps search scoped to the applicable catalog", async () => {
    const view = await mountOnline(
      [catEntry("mod-any"), catEntry("mod-eu", ["eu"])],
      { kind: "cn360", realm: "cn", path: "C:/TestGameA" },
    );
    // comboSearch reaches the view as the AsyncSearchCombo mock's search
    // attr: the eu-only entry must never surface as a cn candidate.
    const combo = view.getComponent({ name: "AsyncSearchCombo" });
    const search = (combo.vm.$attrs as { search: (q: string) => Promise<unknown[]> }).search;
    const hits = (await search("mod")) as { id: string }[];
    expect(hits.map((h) => h.id)).toEqual(["mod-any"]);
  });
});

describe("multi-client sync", () => {
  const catEntry = (id: string, servers?: string[]) => ({
    id, version: "1", category: "battle", nameEn: id, game: "*",
    title: id, nameZh: "", description: "",
    authors: [], packages: [{ name: "a.zip", sha256: "ab", size: 2048 }],
    i18n: {}, aliases: [], servers,
  });
  const multiInstallConfig = () => {
    // Active = the EU steam client (it can SEE an eu/ru-exclusive entry);
    // the CN client is skipped by rule, the Lesta build (kind fallback →
    // ru) receives the install too.
    mocks.config.activeInstall = { kind: "steam", realm: "eu", path: "C:/EU" };
    mocks.config.installs = [
      { kind: "steam", realm: "eu", path: "C:/EU" },
      { kind: "cn360", realm: "cn", path: "C:/CN" },
      { kind: "lesta", path: "C:/RU" },
    ];
  };
  const mountWithEntry = async (servers?: string[]) => {
    mocks.catalog.mockResolvedValue({
      mods: [catEntry("mod-x", servers)],
      sourceVersion: "test",
      fetchedAt: "",
    });
    mocks.catalogInstall.mockResolvedValue({
      name: "Mod X", binVersion: "1", wroteFiles: 1, warnings: [],
    });
    const view = await shallowMount(ResourcesView, {
      global: { stubs: { HkScrollContainer: false, AppTag: false, HkTag: false } },
    });
    await flushPromises();
    await view.findAll(".mod-row")[0].trigger("click");
    await flushPromises();
    // The pane's install action is the mocked HkButton carrying onClick
    // in attrs (the mock renders no DOM).
    const installBtn = view
      .findAllComponents({ name: "HkButton" })
      .find((b) => "onClick" in (b.vm.$attrs as Record<string, unknown>))!;
    (installBtn.vm.$attrs as { onClick: () => void }).onClick();
    await flushPromises();
    return view;
  };

  it("fans an install out to every applicable root and skips rule-inapplicable clients", async () => {
    localStorage.setItem("wowsp-modhub-disclaimer-acked", "1");
    multiInstallConfig();
    await mountWithEntry(["eu", "ru"]);
    // Active EU client first, the Lesta build (kind fallback → ru) next;
    // the CN client is skipped by rule (cn ∉ [eu, ru]).
    expect(mocks.catalogInstall).toHaveBeenCalledTimes(2);
    expect(mocks.catalogInstall).toHaveBeenNthCalledWith(1, "mod-x", "C:/EU", undefined, false);
    expect(mocks.catalogInstall).toHaveBeenNthCalledWith(2, "mod-x", "C:/RU", undefined, true);
    expect(mocks.info).toHaveBeenCalledWith("resources.sync.skippedByRule");
    expect(mocks.success).toHaveBeenCalledWith("resources.sync.done");
  });

  it("skips version-incompatible targets quietly instead of failing them", async () => {
    localStorage.setItem("wowsp-modhub-disclaimer-acked", "1");
    multiInstallConfig();
    mocks.catalog.mockResolvedValue({
      mods: [catEntry("mod-x")],
      sourceVersion: "test",
      fetchedAt: "",
    });
    // The Lesta client (kind fallback -> ru) reports a foreign version
    // lineage: the backend's version gate answers report.skipped and the
    // fan-out treats it as a RULE skip — quiet per-client note, no
    // failure, no outcome. (Inline mount: the shared helper re-seeds the
    // install mock wholesale.)
    mocks.catalogInstall.mockImplementation(async (_id: string, root: string) =>
      root === "C:/RU"
        ? { name: "Mod X", binVersion: "", wroteFiles: 0, warnings: [], skipped: "mismatch" }
        : { name: "Mod X", binVersion: "1", wroteFiles: 1, warnings: [] },
    );
    const view = await shallowMount(ResourcesView, {
      global: { stubs: { HkScrollContainer: false, AppTag: false, HkTag: false } },
    });
    await flushPromises();
    await view.findAll(".mod-row")[0].trigger("click");
    await flushPromises();
    const installBtn = view
      .findAllComponents({ name: "HkButton" })
      .find((b) => "onClick" in (b.vm.$attrs as Record<string, unknown>))!;
    (installBtn.vm.$attrs as { onClick: () => void }).onClick();
    await flushPromises();
    // Universal entry: EU + CN land, RU skips by version — three attempts.
    expect(mocks.catalogInstall).toHaveBeenCalledTimes(3);
    // The gate skips every FAN-OUT target; the ACTIVE root (EU) keeps
    // warn-and-proceed.
    expect(mocks.catalogInstall).toHaveBeenNthCalledWith(1, "mod-x", "C:/EU", undefined, false);
    expect(mocks.catalogInstall).toHaveBeenNthCalledWith(3, "mod-x", "C:/RU", undefined, true);
    expect(mocks.info.mock.calls.map((c) => c[0])).toContain(
      "resources.sync.skippedByVersion",
    );
    // Only the landed clients count — the skip is not a partial failure.
    expect(mocks.success).toHaveBeenCalledWith("resources.sync.done");
    expect(mocks.warning).not.toHaveBeenCalledWith(expect.stringContaining("resources.sync.partial"));
  });

  it("stays single-root while unified sync is off", async () => {
    localStorage.setItem("wowsp-modhub-disclaimer-acked", "1");
    mocks.syncOn = false;
    multiInstallConfig();
    await mountWithEntry();
    // Only the ACTIVE client's root is touched; the per-op toast stays.
    expect(mocks.catalogInstall).toHaveBeenCalledTimes(1);
    expect(mocks.catalogInstall).toHaveBeenCalledWith("mod-x", "C:/EU", undefined, undefined);
    expect(mocks.success).toHaveBeenCalledWith("resources.installedDone");
  });

  it("shows the managing-individually banner only with several clients and sync off", async () => {
    const mountBanner = async () => {
      mocks.catalog.mockResolvedValue({
        mods: [catEntry("mod-x")],
        sourceVersion: "test",
        fetchedAt: "",
      });
      const view = await shallowMount(ResourcesView, {
        global: { stubs: { HkScrollContainer: false, AppTag: false, HkTag: false } },
      });
      await flushPromises();
      return view;
    };
    // The modSync mock's state box is read lazily at render time, so each
    // scenario mounts its own view (no post-mount toggling).
    mocks.syncOn = false;
    multiInstallConfig();
    const individual = await mountBanner();
    expect(individual.find(".resources-banner--sync").exists()).toBe(true);
    expect(individual.find(".resources-banner--sync").text()).toContain("resources.sync.banner");

    mocks.syncOn = true;
    const unified = await mountBanner();
    expect(unified.find(".resources-banner--sync").exists()).toBe(false);

    mocks.syncOn = false;
    mocks.config.installs = [mocks.config.installs![0]];
    const singleClient = await mountBanner();
    expect(singleClient.find(".resources-banner--sync").exists()).toBe(false);
  });

  it("reconciles every other client to the active one's ledger set", async () => {
    localStorage.setItem("wowsp-modhub-disclaimer-acked", "1");
    mocks.config.activeInstall = { kind: "steam", realm: "eu", path: "C:/EU" };
    mocks.config.installs = [
      { kind: "steam", realm: "eu", path: "C:/EU" },
      { kind: "cn360", realm: "cn", path: "C:/CN" },
    ];
    mocks.catalog.mockResolvedValue({
      mods: [catEntry("mod-a"), catEntry("mod-cn", ["cn"]), catEntry("mod-extra")],
      sourceVersion: "test",
      fetchedAt: "",
    });
    // Active EU client owns mod-a (universal) + mod-cn (CN-exclusive);
    // the CN client carries only the extra mod.
    mocks.records.mockResolvedValue([
      { id: "mod-a", name: "Mod A", version: "1", source: "mod-hub", gameRoot: "C:/EU" },
      { id: "mod-cn", name: "Mod CN", version: "1", source: "mod-hub", gameRoot: "C:/EU" },
      { id: "mod-extra", name: "Mod Extra", version: "1", source: "mod-hub", gameRoot: "C:/CN" },
    ]);
    mocks.catalogInstall.mockResolvedValue({
      name: "X", binVersion: "1", wroteFiles: 1, warnings: [],
    });
    mocks.catalogUninstall.mockResolvedValue({
      id: "mod-extra", name: "Mod Extra", removedFiles: 1, restoredFiles: 0,
    });
    const view = await shallowMount(ResourcesView, {
      global: { stubs: { HkScrollContainer: false, AppTag: false, HkTag: false } },
    });
    await flushPromises();
    view.findComponent({ name: "HMenu" }).vm.$emit("select", "sync-all");
    await flushPromises();
    // The confirm dialog opens with the reconcile summary before any RPC.
    const dialog = view
      .findAllComponents({ name: "HkConfirmDialog" })
      .find((d) => d.props("open") === true)!;
    expect(dialog.props("message")).toBe("resources.sync.confirmBody");
    dialog.vm.$emit("confirm");
    await flushPromises();
    // CN receives the two missing mods (mod-cn by its realm rule);
    // its extra mod leaves (removal is realm-agnostic).
    expect(mocks.catalogInstall).toHaveBeenCalledTimes(2);
    expect(mocks.catalogInstall).toHaveBeenCalledWith("mod-a", "C:/CN", undefined, undefined);
    expect(mocks.catalogInstall).toHaveBeenCalledWith("mod-cn", "C:/CN", undefined, undefined);
    expect(mocks.catalogUninstall).toHaveBeenCalledWith("mod-extra", "C:/CN");
    expect(mocks.success).toHaveBeenCalledWith("resources.sync.done");
  });


  it("exposes the sync-all tools entry disabled below two clients", async () => {
    mocks.catalog.mockResolvedValue({ mods: [catEntry("mod-x")], sourceVersion: "test", fetchedAt: "" });
    const view = await shallowMount(ResourcesView, {
      global: { stubs: { HkScrollContainer: false, AppTag: false, HkTag: false } },
    });
    await flushPromises();
    const tools = view.findComponent({ name: "HMenu" });
    const items = tools.props("items") as { key: string; disabled?: boolean }[];
    expect(items.find((i) => i.key === "sync-all")?.disabled).toBe(true);

    multiInstallConfig();
    await flushPromises();
    const itemsAfter = tools.props("items") as { key: string; disabled?: boolean }[];
    expect(itemsAfter.find((i) => i.key === "sync-all")?.disabled).toBeFalsy();
  });
});

describe("last session plugin health strip", () => {
  const verdict = (mod: string | null, kind: string, at = "2026-10-31 15:45:34.761") => ({
    modName: mod, kind, detail: "detail", at,
  });

  it("stays hidden without error verdicts", async () => {
    mocks.loaderHealth.mockResolvedValue({
      logPath: "C:/TestGameA/profile/python.log",
      linesScanned: 4,
      lastSessionAt: "2026-10-31 15:45:34.764",
      verdicts: [verdict("ConsumablesMonitor2", "loadedOk", "2026-10-31 15:45:34.764")],
    });
    const view = await mountInstalled();
    expect(view.find(".loader-health").exists()).toBe(false);
  });

  it("renders each error verdict row with its suggestion plus the quiet summary", async () => {
    mocks.loaderHealth.mockResolvedValue({
      logPath: "C:/TestGameA/profile/python.log",
      linesScanned: 8,
      lastSessionAt: "2026-10-31 15:45:34.766",
      verdicts: [
        verdict("BattleFrame_Torpedoes", "signatureRefused"),
        verdict(null, "frameworkDataMissing", "2026-10-31 15:45:22.465"),
        verdict("ThreeDimentionalRadar", "disabledByDependency", "2026-10-31 15:45:34.766"),
        verdict("ConsumablesMonitor2", "loadedOk", "2026-10-31 15:45:34.764"),
      ],
    });
    const view = await mountInstalled();
    expect(view.find(".loader-health").exists()).toBe(true);
    // Collapsed by default: the head counts the errors, no rows yet.
    expect(view.find(".loader-health__head").text()).toContain("resources.loaderHealth.title");
    expect(view.find(".loader-health__head").text()).toContain("3");
    expect(view.find(".loader-health__row").exists()).toBe(false);
    await view.find(".loader-health__head").trigger("click");
    // One row per ERROR verdict (the loaded-OK row is the summary line).
    const rows = view.findAll(".loader-health__row");
    expect(rows).toHaveLength(3);
    expect(rows[0].text()).toContain("BattleFrame_Torpedoes");
    expect(rows[0].text()).toContain("resources.loaderHealth.kind.signatureRefused");
    expect(rows[0].text()).toContain("2026-10-31 15:45:34.761");
    // The hint line now carries the locate action, so its text is the
    // suggestion plus the action label.
    expect(rows[0].find(".loader-health__row-hint").text()).toContain(
      "resources.loaderHealth.hint.signatureRefused",
    );
    expect(rows[0].find(".loader-health__row-locate").text()).toBe(
      "resources.loaderHealth.locate",
    );
    // The shared-framework verdict names the framework label, not a mod.
    expect(rows[1].find(".loader-health__row-name").text()).toBe(
      "resources.loaderHealth.framework",
    );
    expect(rows[2].find(".loader-health__row-hint").text()).toContain(
      "resources.loaderHealth.hint.disabledByDependency",
    );
    // The quiet "N loaded OK" line closes the strip.
    expect(view.find(".loader-health__ok").text()).toBe(
      "resources.loaderHealth.loadedOkSummary",
    );
  });

  it("locates the affected unit from a row's action", async () => {
    mocks.scan.mockResolvedValue([
      mod("TTaroModUtils"),
      mod("BattleFrame_Torpedoes"),
      mod("Mod A"),
    ]);
    mocks.loaderHealth.mockResolvedValue({
      logPath: "C:/TestGameA/profile/python.log",
      linesScanned: 8,
      lastSessionAt: "2026-10-31 15:45:34.766",
      verdicts: [
        verdict("BattleFrame_Torpedoes", "signatureRefused"),
        verdict(null, "frameworkDataMissing"),
      ],
    });
    const view = await mountInstalled();
    await view.find(".loader-health__head").trigger("click");
    const rows = view.findAll(".loader-health__row");
    expect(rows).toHaveLength(2);
    expect(rows[0].find(".loader-health__row-locate").exists()).toBe(true);
    // The named verdict locates its own unit straight into the pane.
    await rows[0].find(".loader-health__row-locate").trigger("click");
    await flushPromises();
    expect(view.find(".mod-detail__name").text()).toContain(
      "BattleFrame_Torpedoes",
    );
    // The shared-framework verdict lands on the framework unit itself —
    // the probe by the name family the log carries.
    await rows[1].find(".loader-health__row-locate").trigger("click");
    await flushPromises();
    expect(view.find(".mod-detail__name").text()).toContain("TTaroModUtils");
  });
});

describe("boot re-installer strip", () => {
  it("stays hidden without a boot installer in the tree", async () => {
    mocks.bootInstaller.mockResolvedValue(null);
    const view = await mountInstalled();
    expect(view.find(".boot-installer").exists()).toBe(false);
  });

  it("stays hidden while safe mode is on (mutations refused)", async () => {
    mocks.bootInstaller.mockResolvedValue({
      unitRelPath: "PnFMods/ModsInstaller_4_3_1",
      version: "4_3_1",
      descriptors: ["Shot Timer"],
      manifestRows: ["Shot Timer"],
    });
    mocks.safe.mockResolvedValue(true);
    const view = await mountInstalled();
    expect(view.find(".boot-installer").exists()).toBe(false);
  });

  it("lists the rows collapsed, then confirm runs the disarm and rescans", async () => {
    mocks.bootInstaller.mockResolvedValue({
      unitRelPath: "PnFMods/ModsInstaller_4_3_1",
      version: "4_3_1",
      descriptors: ["Shot Timer", "TeamHP"],
      manifestRows: ["Shot Timer"],
    });
    localStorage.setItem("wowsp-modhub-disclaimer-acked", "1");
    const view = await mountInstalled();
    expect(view.find(".boot-installer").exists()).toBe(true);
    // Collapsed by default: the head names the strip, no rows yet.
    expect(view.find(".boot-installer .hk-expansion-panel-header").text()).toContain(
      "resources.bootInstaller.title",
    );
    expect(view.find(".boot-installer__rowname").exists()).toBe(false);
    // Expanding lists the descriptor rows under the unit path.
    await view.find(".boot-installer .hk-expansion-panel-header").trigger("click");
    const rows = view.findAll(".boot-installer__rowname");
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toBe("Shot Timer");
    expect(view.find(".boot-installer__unit").text()).toContain(
      "PnFMods/ModsInstaller_4_3_1",
    );

    // DISARM opens the confirm dialog naming the unit and the row list.
    const disarmBtn = view
      .findAllComponents({ name: "HkButton" })
      .find((b) => "onClick" in (b.vm.$attrs as Record<string, unknown>))!;
    (disarmBtn.vm.$attrs as { onClick: () => void }).onClick();
    await flushPromises();
    const dialog = view
      .findAllComponents({ name: "HkConfirmDialog" })
      .find((d) => d.props("open") === true)!;
    expect(dialog.props("title")).toBe("resources.bootInstaller.confirmTitle");
    expect(dialog.props("message")).toBe("resources.bootInstaller.confirmBody");

    // Confirming runs the command, toasts the report and rescans.
    dialog.vm.$emit("confirm");
    await flushPromises();
    expect(mocks.disarm).toHaveBeenCalledExactlyOnceWith("C:/TestGameA");
    expect(mocks.success).toHaveBeenCalledWith("resources.bootInstaller.done");
    // Mount's first scan + the disarm's refresh pass both hit the scan.
    expect(mocks.scan.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mocks.records.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("contested tree badge", () => {
  it("badges installed units the scan marks contested", async () => {
    mocks.scan.mockResolvedValue([
      { ...mod("Mod A"), relPath: "PnFMods/a", contested: true },
      { ...mod("Mod B"), relPath: "PnFMods/b" },
    ]);
    const view = await mountInstalled();
    const badges = view.findAll('.mod-row__tail [data-hint="resources.contestedTreeHint"]');
    expect(badges).toHaveLength(1);
    expect(badges[0].text()).toBe("resources.contestedTree");
    expect(badges[0].attributes("data-hint")).toBe("resources.contestedTreeHint");
  });

  it("badges contested foreign (ModStation) strip rows", async () => {
    mocks.foreign.mockResolvedValue([
      { installer: "modstation", key: "k1", name: "Station Mod", contested: true },
      { installer: "modstation", key: "k2", name: "Station Plain" },
    ]);
    const view = await mountInstalled();
    const badges = view.findAll('.mod-row__tail [data-hint="resources.contestedTreeHint"]');
    expect(badges).toHaveLength(1);
    expect(badges[0].text()).toBe("resources.contestedTree");
  });
});

describe("entry clients window", () => {
  const catEntry = () => ({
    id: "mod-x", version: "1", category: "battle", nameEn: "mod-x", game: "*",
    title: "mod-x", nameZh: "", description: "",
    authors: [], packages: [{ name: "a.zip", sha256: "ab", size: 2048 }],
    i18n: {}, aliases: [],
  });
  const recordFixture = {
    id: "mod-x", name: "Mod X", version: "1", category: "battle", source: "mod-hub",
    discussion: null, binVersion: "1", installedAt: "2026-11-02T00:00:00Z",
    files: [], gameRoot: "C:/EU",
  };
  async function mountPane() {
    mocks.catalog.mockResolvedValue({
      mods: [catEntry()], sourceVersion: "test", fetchedAt: "",
    });
    const view = shallowMount(ResourcesView, {
      // The window is a real child component with its own fetch watch —
      // keep it live under shallowMount.
      global: {
        stubs: { HkScrollContainer: false, LoadingNote: false, EntryClientsWindow: false, AppTag: false, HkTag: false },
      },
    });
    await flushPromises();
    await view.findAll(".mod-row")[0].trigger("click");
    await flushPromises();
    return view;
  }

  it("merges the installed state into the scope tag with the installed clients", async () => {
    mocks.config.activeInstall = { kind: "steam", realm: "eu", path: "C:/EU" };
    mocks.config.installs = [
      { kind: "steam", realm: "eu", path: "C:/EU" },
      { kind: "lesta", path: "C:/RU" },
    ];
    mocks.records.mockResolvedValue([recordFixture]);
    const view = await mountPane();
    const tag = view.find(".mod-detail__badges [data-scope]");
    expect(tag.exists()).toBe(true);
    // Installed: the tag reads 已安装 · <installed clients>, NOT the plain
    // scope text — and the scope tag no longer appears separately.
    expect(tag.text()).toContain("resources.installedBadge");
    expect(tag.text()).toContain("EU");
    expect(tag.text()).not.toContain("resources.servers.universal");
    // The merged tag opens the window in the INSTALLED state too — the
    // usage probe runs for every configured client root.
    await tag.trigger("click");
    await flushPromises();
    expect(mocks.clientUsage).toHaveBeenCalledWith("C:/EU");
    expect(mocks.clientUsage).toHaveBeenCalledWith("C:/RU");
    const modal = view
      .findAllComponents({ name: "HkModal" })
      .find((m) => m.props("title") === "resources.entryClients.title");
    expect(modal?.props("modelValue")).toBe(true);
  });

  it("falls back to the scope text and still opens the window when nothing is installed", async () => {
    mocks.config.activeInstall = { kind: "steam", realm: "eu", path: "C:/EU" };
    mocks.config.installs = [{ kind: "steam", realm: "eu", path: "C:/EU" }];
    const view = await mountPane();
    const tag = view.find(".mod-detail__badges [data-scope]");
    expect(tag.text()).toContain("resources.servers.universal");
    await tag.trigger("click");
    await flushPromises();
    // The click-through lists every configured client: the usage probe
    // runs per client root, and the entry-clients modal is the one that
    // opened (title names the entry).
    expect(mocks.clientUsage).toHaveBeenCalledWith("C:/EU");
    const modal = view
      .findAllComponents({ name: "HkModal" })
      .find((m) => m.props("title") === "resources.entryClients.title");
    expect(modal?.props("modelValue")).toBe(true);
  });
});

describe("installed-unit known-mod relations", () => {
  const relatedRecord = (init: { id: string; name: string; files: string[] }) => ({
    id: init.id,
    name: init.name,
    version: "1",
    category: "battle",
    source: "mod-hub",
    binVersion: "1",
    installedAt: "2026-11-01T00:00:00Z",
    files: init.files,
    gameRoot: "C:/TestGameA",
  });
  /** One installed unit whose tree two ledger records claim: its own
   *  record (identity match) and a catch-all extra pack. */
  async function mountRelated() {
    mocks.scan.mockResolvedValue([
      {
        ...mod("Mod A"),
        relPath: "PnFMods/a",
        paths: ["PnFMods/a"],
        identity: "mod-a",
      } as InstalledMod,
    ]);
    mocks.records.mockResolvedValue([
      relatedRecord({
        id: "mod-a",
        name: "Mod A",
        files: ["PnFMods/a/main.py", "PnFMods/a/tex.dds"],
      }),
      relatedRecord({ id: "pack.extra", name: "Extra Pack", files: ["PnFMods/a/extra.txt"] }),
    ]);
    const view = await mountInstalled();
    await view.find(".mod-row").trigger("click");
    await flushPromises();
    return view;
  }

  it("tags installed rows with the known-mod association count", async () => {
    const view = await mountRelated();
    const tags = view.findAll('.mod-row__tail [data-hint="resources.relatedTitle"]');
    expect(tags).toHaveLength(1);
    expect(tags[0].text()).toBe("resources.relatedCount");
    expect(t).toHaveBeenCalledWith("resources.relatedCount", { count: 2 });
  });

  it("keeps the association section in the pane body flow, under the head", async () => {
    const view = await mountRelated();
    // The section is part of the body scroller's own flow: a sparse unit's
    // list starts right under the pane head instead of after an empty
    // flex-grown body, and it is not a separate row pinned above the actions.
    expect(view.find(".mod-detail__scroll .mod-detail__related").exists()).toBe(true);
    // It is a direct child of the body column (not a sibling of the
    // scroller), so nothing flex-grown can open a gap above it.
    expect(view.find(".mod-detail__inner > .mod-detail__related").exists()).toBe(true);
    expect(view.find(".mod-detail__foot .mod-detail__related").exists()).toBe(false);
  });

  it("opens with the association list expanded and lists each known mod", async () => {
    const view = await mountRelated();
    expect(view.find(".mod-detail__related").exists()).toBe(true);
    // Expanded by default: the rows ride the pane body's own scroll flow.
    expect(view.find(".mod-detail__related-head").attributes("aria-expanded")).toBe("true");
    const rows = view.findAll(".mod-detail__related-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].find(".mod-detail__related-name").text()).toContain("Mod A");
    expect(rows[0].text()).toContain("resources.relatedOwn");
    expect(rows[0].text()).toContain("resources.relatedSource.managed");
    expect(rows[0].text()).toContain("resources.relatedFilesHere");
    expect(rows[1].find(".mod-detail__related-name").text()).toContain("Extra Pack");
    // Managed ledger rows are removable from here; both carry the action.
    expect(view.findAll(".mod-detail__related-remove")).toHaveLength(2);

    // The header still collapses the list on request.
    await view.find(".mod-detail__related-head").trigger("click");
    expect(view.findAll(".mod-detail__related-row")).toHaveLength(0);
    expect(view.find(".mod-detail__related-head").attributes("aria-expanded")).toBe("false");
  });

  it("re-expands the list on the next selection and drops the old body", async () => {
    mocks.scan.mockResolvedValue([
      {
        ...mod("Mod A"),
        relPath: "PnFMods/a",
        paths: ["PnFMods/a"],
        identity: "mod-a",
      } as InstalledMod,
      {
        ...mod("Mod B"),
        relPath: "PnFMods/b",
        paths: ["PnFMods/b"],
        identity: "mod-b",
      } as InstalledMod,
    ]);
    mocks.records.mockResolvedValue([
      relatedRecord({ id: "mod-a", name: "Mod A", files: ["PnFMods/a/main.py"] }),
      relatedRecord({ id: "mod-b", name: "Mod B", files: ["PnFMods/b/main.py"] }),
    ]);
    const view = await mountInstalled();
    const rowOf = (name: string) =>
      view.findAll(".mod-row").find((row) => row.text().includes(name))!;
    await rowOf("Mod A").trigger("click");
    await flushPromises();
    const firstBody = view.find(".mod-detail__scroll").element;
    await view.find(".mod-detail__related-head").trigger("click");
    expect(view.findAll(".mod-detail__related-row")).toHaveLength(0);
    // A new selection starts expanded again (collapse is per-pane), and the
    // re-keyed pane is a fresh body — so the previous unit's scroll offset
    // cannot carry over.
    await rowOf("Mod B").trigger("click");
    await flushPromises();
    expect(view.find(".mod-detail__related-head").attributes("aria-expanded")).toBe("true");
    const rows = view.findAll(".mod-detail__related-row");
    expect(rows).toHaveLength(1);
    // Mod B's own relation — not a stale row left over from the old pane.
    expect(rows[0].find(".mod-detail__related-name").text()).toContain("Mod B");
    expect(view.find(".mod-detail__scroll").element).not.toBe(firstBody);
    // The old body is really detached, not merely unshadowed.
    expect(firstBody.isConnected).toBe(false);
  });

  it("removes a managed relation through the catalog uninstall and rescans", async () => {
    localStorage.setItem("wowsp-modhub-disclaimer-acked", "1");
    mocks.catalogUninstall.mockResolvedValue({
      id: "mod-a",
      name: "Mod A",
      removedFiles: 3,
      restoredFiles: 1,
    });
    const view = await mountRelated();
    // The list is expanded by default, so the remove action is already there.
    await view.findAll(".mod-detail__related-remove")[0].trigger("click");
    await flushPromises();
    const dialog = view
      .findAllComponents({ name: "HkConfirmDialog" })
      .find(
        (d) =>
          d.props("open") === true &&
          d.props("message") === "resources.relatedConfirmRemove",
      );
    expect(dialog).toBeTruthy();
    // Nothing happens before the confirm.
    expect(mocks.catalogUninstall).not.toHaveBeenCalled();
    dialog!.vm.$emit("confirm");
    await flushPromises();
    expect(mocks.catalogUninstall).toHaveBeenCalledExactlyOnceWith("mod-a", "C:/TestGameA");
    expect(mocks.success).toHaveBeenCalledWith("resources.uninstalledDone");
    expect(mocks.scan.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mocks.records.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("shows a shared runtime row without a remove action", async () => {
    mocks.scan.mockResolvedValue([
      {
        ...mod("TTaroModUtils"),
        relPath: "PnFMods/TTaroModUtils",
        paths: ["PnFMods/TTaroModUtils"],
      } as InstalledMod,
    ]);
    mocks.records.mockResolvedValue([
      relatedRecord({
        id: "shared.pnfmods.ttaromodutils",
        name: "Shared TTaro runtime",
        files: ["PnFMods/TTaroModUtils/lib.lua"],
      }),
    ]);
    const view = await mountInstalled();
    await view.find(".mod-row").trigger("click");
    await flushPromises();
    expect(view.findAll(".mod-detail__related-row")).toHaveLength(1);
    // The component record is not removable on its own; the hint explains
    // that it leaves with its last consumer.
    expect(view.findAll(".mod-detail__related-remove")).toHaveLength(0);
    expect(view.find(".mod-detail__related-hint").text()).toBe("resources.relatedSharedHint");
    expect(view.find(".mod-detail__related-name").text()).toContain("Shared TTaro runtime");
  });

  it("routes a foreign relation's remove through the owning unit's uninstall", async () => {
    localStorage.setItem("wowsp-modhub-disclaimer-acked", "1");
    mocks.scan.mockResolvedValue([
      {
        ...mod("Aslain One"),
        relPath: "PnFMods/AslainOne",
        paths: ["PnFMods/AslainOne"],
      } as InstalledMod,
    ]);
    mocks.records.mockResolvedValue([]);
    mocks.foreign.mockResolvedValue([
      { installer: "aslain", key: "aslain-one", name: "Aslain One", version: "2" },
    ]);
    mocks.uninstall.mockResolvedValue({
      name: "Aslain One",
      removedFiles: 1,
      restoredFiles: 0,
    });
    const view = await mountInstalled();
    await view.find(".mod-row").trigger("click");
    await flushPromises();
    const remove = view.findAll(".mod-detail__related-remove");
    expect(remove).toHaveLength(1);
    await remove[0].trigger("click");
    await flushPromises();
    // Foreign rows have no ledger id: the remove opens the unit-uninstall
    // confirm, which also cuts the Aslain manifest row.
    const dialog = view
      .findAllComponents({ name: "HkConfirmDialog" })
      .find(
        (d) =>
          d.props("open") === true &&
          d.props("message") === "resources.confirmUnitUninstall",
      );
    expect(dialog).toBeTruthy();
    dialog!.vm.$emit("confirm");
    await flushPromises();
    expect(mocks.uninstall).toHaveBeenCalledExactlyOnceWith("PnFMods/AslainOne", "C:/TestGameA");
  });
});

describe("installed-unit junk hygiene", () => {
  it("warns about preview/screenshot junk and cleans it on demand", async () => {
    localStorage.setItem("wowsp-modhub-disclaimer-acked", "1");
    mocks.scan.mockResolvedValue([
      {
        ...mod("Junk Mod"),
        relPath: "PnFMods/junk",
        paths: ["PnFMods/junk"],
        junkCount: 3,
        junkFiles: ["screenshot.png", "preview.jpg"],
      } as InstalledMod,
    ]);
    mocks.cleanJunk.mockResolvedValue({ relPath: "PnFMods/junk", removedFiles: 3 });
    const view = await mountInstalled();
    await view.find(".mod-row").trigger("click");
    await flushPromises();
    const strip = view.find(".mod-detail__junk");
    expect(strip.exists()).toBe(true);
    expect(strip.text()).toContain("resources.junkNotice");
    expect(strip.find(".mod-detail__junk-text").attributes("data-hint")).toContain(
      "screenshot.png",
    );
    // The strip's clean action rides HkButton (stubbed under shallowMount):
    // invoke the handler its attrs carry.
    const clean = view
      .findAllComponents({ name: "HkButton" })
      .find((b) => "onClick" in (b.vm.$attrs as Record<string, unknown>));
    expect(clean).toBeTruthy();
    (clean!.vm.$attrs as { onClick: () => void }).onClick();
    await flushPromises();
    expect(mocks.cleanJunk).toHaveBeenCalledExactlyOnceWith("C:/TestGameA", "PnFMods/junk");
    expect(mocks.success).toHaveBeenCalledWith("resources.junkCleaned");
    expect(mocks.scan.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

