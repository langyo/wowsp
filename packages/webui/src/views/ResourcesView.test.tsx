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
  scan: vi.fn(), foreign: vi.fn(), stale: vi.fn(), loader: vi.fn(), loaderHealth: vi.fn(), safe: vi.fn(), reconcile: vi.fn(),
  bootInstaller: vi.fn(), disarm: vi.fn(),
  adopt: vi.fn(), uninstall: vi.fn(), error: vi.fn(),
  success: vi.fn(), warning: vi.fn(), info: vi.fn(),
  migrationPlan: vi.fn(),
  purgeBackups: vi.fn(),
  records: vi.fn(), catalog: vi.fn(), preview: vi.fn(),
  catalogInstall: vi.fn(), catalogUninstall: vi.fn(),
  syncOn: true,
}));
vi.mock("vue-router", () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/api", () => ({ api: {
  modHubScanInstalled: mocks.scan, modHubForeignUnits: mocks.foreign, modHubStaleVersions: mocks.stale,
  modHubPnfLoaderStatus: mocks.loader, modHubLoaderHealth: mocks.loaderHealth, modHubSafeMode: mocks.safe, modHubReconcile: mocks.reconcile,
  modHubBootInstaller: mocks.bootInstaller, modHubDisarmBootInstaller: mocks.disarm,
  modHubUninstallUnit: mocks.uninstall,
  modHubMigrationPlan: mocks.migrationPlan,
  modHubPurgeBackups: mocks.purgeBackups,
  modCatalogRefresh: mocks.catalog,
  modCatalogPreviewFiles: mocks.preview,
  modCatalogInstall: mocks.catalogInstall,
  modCatalogUninstall: mocks.catalogUninstall,
  modHubRecords: mocks.records, modTags: async () => ({ tags: [] }),
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
    runMod: (id: string, root: string, preset?: string) => mocks.catalogInstall(id, root, preset),
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
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
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
    useToast: () => ({ error: mocks.error, success: mocks.success, warning: mocks.warning, info: mocks.info }),
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
  mocks.syncOn = true;
  mocks.config = reactive({ activeInstall: { path: "C:/TestGameA" }, installs: [] });
  mocks.scan.mockResolvedValue([mod("Mod A")]);
  mocks.foreign.mockResolvedValue([]);
  mocks.stale.mockResolvedValue([]);
  mocks.loader.mockResolvedValue(null);
  mocks.loaderHealth.mockResolvedValue(null);
  mocks.bootInstaller.mockResolvedValue(null);
  mocks.disarm.mockResolvedValue({ removedFiles: 3, cutRows: 2 });
  mocks.safe.mockResolvedValue(false);
  mocks.reconcile.mockResolvedValue(null);
  mocks.records.mockResolvedValue([]);
  mocks.catalog.mockResolvedValue({ mods: [], sourceVersion: "test", fetchedAt: "" });
  mocks.purgeBackups.mockResolvedValue([]);
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
      global: { stubs: { HkScrollContainer: false } },
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
      global: { stubs: { HkScrollContainer: false } },
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
    expect(mocks.catalogInstall).toHaveBeenNthCalledWith(1, "mod-x", "C:/EU", undefined);
    expect(mocks.catalogInstall).toHaveBeenNthCalledWith(2, "mod-x", "C:/RU", undefined);
    expect(mocks.info).toHaveBeenCalledWith("resources.sync.skippedByRule");
    expect(mocks.success).toHaveBeenCalledWith("resources.sync.done");
  });

  it("stays single-root while unified sync is off", async () => {
    localStorage.setItem("wowsp-modhub-disclaimer-acked", "1");
    mocks.syncOn = false;
    multiInstallConfig();
    await mountWithEntry();
    // Only the ACTIVE client's root is touched; the per-op toast stays.
    expect(mocks.catalogInstall).toHaveBeenCalledTimes(1);
    expect(mocks.catalogInstall).toHaveBeenCalledWith("mod-x", "C:/EU", undefined);
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
        global: { stubs: { HkScrollContainer: false } },
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
      global: { stubs: { HkScrollContainer: false } },
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
    expect(mocks.catalogInstall).toHaveBeenCalledWith("mod-a", "C:/CN", undefined);
    expect(mocks.catalogInstall).toHaveBeenCalledWith("mod-cn", "C:/CN", undefined);
    expect(mocks.catalogUninstall).toHaveBeenCalledWith("mod-extra", "C:/CN");
    expect(mocks.success).toHaveBeenCalledWith("resources.sync.done");
  });


  it("exposes the sync-all tools entry disabled below two clients", async () => {
    mocks.catalog.mockResolvedValue({ mods: [catEntry("mod-x")], sourceVersion: "test", fetchedAt: "" });
    const view = await shallowMount(ResourcesView, {
      global: { stubs: { HkScrollContainer: false } },
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
    expect(rows[0].find(".loader-health__row-hint").text()).toBe(
      "resources.loaderHealth.hint.signatureRefused",
    );
    // The shared-framework verdict names the framework label, not a mod.
    expect(rows[1].find(".loader-health__row-name").text()).toBe(
      "resources.loaderHealth.framework",
    );
    expect(rows[2].find(".loader-health__row-hint").text()).toBe(
      "resources.loaderHealth.hint.disabledByDependency",
    );
    // The quiet "N loaded OK" line closes the strip.
    expect(view.find(".loader-health__ok").text()).toBe(
      "resources.loaderHealth.loadedOkSummary",
    );
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
    expect(view.find(".boot-installer__head").text()).toContain(
      "resources.bootInstaller.title",
    );
    expect(view.find(".boot-installer__rowname").exists()).toBe(false);
    // Expanding lists the descriptor rows under the unit path.
    await view.find(".boot-installer__head").trigger("click");
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
    const badges = view.findAll(".mod-row__badge--contested");
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
    const badges = view.findAll(".mod-row__badge--contested");
    expect(badges).toHaveLength(1);
    expect(badges[0].text()).toBe("resources.contestedTree");
  });
});

