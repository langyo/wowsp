import { defineComponent, ref, watch } from "vue";
import {
  AlertTriangle,
  ChevronDown,
  Ellipsis,
  FolderOpen,
  FolderSync,
  ListTree,
  Palette,
  Puzzle,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Undo2,
} from "@lucide/vue";

import {
  HkButton,
  HkConfirmDialog,
  HkExpansionPanel,
  HkIconButton,
  HkModal,
  HkScrollContainer,
  HkSpinner,
  HkSwitch,
  HkTabs,
  HMenu,
} from "@celestia-island/hikari";

import AsyncSearchCombo from "@/components/search/AsyncSearchCombo";
import AppTag from "@/components/base/AppTag";
import ErrorCard from "@/components/base/ErrorCard";
import LoadingNote from "@/components/base/LoadingNote";
import type { CatalogEntry, InstalledMod } from "@/api";
import {
  CATALOG_CATS,
  KIND_BIG,
  KIND_META,
  KIND_ORDER,
  catBig,
  catIcon,
  type BigCat,
} from "@/features/modhub/taxonomy";
import { listedEntries } from "@/features/modhub/catalogListed";
import ModOpDisclaimer from "@/features/modhub/ModOpDisclaimer";
import { usePreviewPrefetch } from "@/features/modhub/previewPrefetch";
import { t } from "@/i18n";
import { formatLocalStamp } from "@/utils/format";
import { installLabelOf } from "@/utils/installLabel";
import { mediaImageUrl } from "@/utils/media";
import "./ResourcesView.scss";
import { useModHub } from "./resources/useModHub";
import { renderCrashPins, renderCrashPinsWindow, useCrashPins } from "./resources/CrashPins";
import { renderEntryClientsWindow } from "./resources/EntryClientsWindow";
import {
  renderPurgeBackups,
  renderPurgeBackupsWindow,
  usePurgeBackups,
} from "./resources/PurgeBackups";
import { useMigrateWizard } from "./resources/useMigrateWizard";
import { useImportWizard } from "./resources/useImportWizard";
import { useFileListWindow } from "./resources/useFileListWindow";
import type { ResourcesCtx } from "./resources/context";
import { renderPane } from "./resources/DetailPane";
import LayerStack, { renderLayerReport } from "./resources/LayerStack";
import { renderMigrateWizard } from "./resources/MigrateWizard";
import { renderImportWizard } from "./resources/ImportWizard";
import { renderFileListWindow } from "./resources/FileListWindow";
import {
  renderCatalogRow,
  renderComponentRow,
  renderInstalledRow,
  renderModstationStrip,
} from "./resources/SidebarRows";
import { kindLabel, localized } from "./resources/display";

/**
 * Mod Hub (Resources page) — master/detail in the replay page's
 * secondary-sidebar shape.
 *
 * The flush left sidebar owns the title row (with the ⋯ tool menu), the
 * condition strips, the count pill and the whole filter stack (big category,
 * source + tool row, chips) above the scrolling row list; the right pane
 * shows what the selected row is and carries every action for it — nothing is
 * hidden behind a modal, and the pane keeps a placeholder until something is
 * picked.
 *
 * Online catalog: curated tool-type mods from `mod-index.json` (built from
 * GitHub Discussions by scripts/mod_hub_publish.py); install downloads the
 * release asset, verifies SHA-256 and unpacks through the same pipeline as
 * local installs. Installed: scan of the latest `bin/<version>/res_mods/`.
 *
 * The state machines live in views/resources/ (useModHub, useMigrateWizard,
 * the display helpers); the pane/row/wizard markup lives in the sibling
 * render modules as plain functions over the shared context, so every vnode
 * below still renders in this component's own tree.
 */
export default defineComponent({
  name: "ResourcesView",
  setup() {
    const hub = useModHub();
  // Crash-suspect pinning (崩溃嫌疑置顶): rides the crash store quietly.
  const crashPins = useCrashPins(hub.gameRoot);
  // The collapsed launcher row's secondary window (the suspect rows used
  // to inline above the installed list and squeeze the normal entries).
  const crashPinsOpen = ref(false);
  // Purge-backup snapshots: the launcher row + secondary window for the
  // res_mods.wowsp-purge-* trees. An unfinished marker means an
  // interrupted purge (resume or mark it done); a resume/restore-merge
  // rebuilds the live tree, so the installed rows rescan afterwards.
  const purgeBackups = usePurgeBackups(hub.gameRoot, () => void hub.scan());
  const purgeBackupsOpen = ref(false);
  // Last-session plugin health (loader verdicts from python.log): the
  // collapsible strip's open state — collapsed by default, one line.
  const loaderHealthOpen = ref(false);
  // The beautify view's "按资源面查看" section — the old texture-component
  // grouping stays reachable below the swimlane (collapsed by default).
  const componentsOpen = ref(false);
  // Boot re-installer strip (PnFMods/ModsInstaller_*): same collapsible
  // shape — collapsed by default, the DISARM action sits on the head row
  // and its confirm dialog opens separately.
  const bootInstallerOpen = ref(false);
  const disarmAsk = ref(false);
    const wizard = useMigrateWizard(hub);
    hub.bindMigrateWizard(wizard.openMigrateWizard);
    // Custom import wizard (自定义导入安装): its own state machine; the entry
    // button below opens it.
    const importWizard = useImportWizard(hub);
    const fileWindow = useFileListWindow(hub);
    // Dynamic catalog previews: rows warm their screenshot as they approach
    // the viewport, and the selected entry warms its preview-video metadata
    // + poster — never the full clip (the pane only streams after play).
    const previewPrefetch = usePreviewPrefetch({
      selectedEntry: () => {
        const sel = hub.selection.value;
        return sel?.mode === "catalog" ? sel.entry : null;
      },
    });
    const ctx: ResourcesCtx = {
      ...hub,
      ...wizard,
      ...importWizard,
      fileWindow,
      previewPrefetch,
    };

    // All installed rows, confirmations and migration plans belong to the
    // selected install. Invalidate synchronously so an old row can never
    // invoke an action against the newly selected root, even mid-scan.
    const gameRoot = hub.gameRoot;
    watch(gameRoot, (root) => {
      hub.invalidateRoot();
      wizard.beginRootChange();
      importWizard.beginImportRootChange();
      if (root) void hub.scan();
    }, { flush: "sync" });

    function comboRenderItem(raw: unknown) {
      if (hub.source.value === "installed") {
        const mod = raw as InstalledMod;
        const meta = KIND_META[mod.kind];
        const Icon = meta.icon;
        return (
          <>
            <span class={["mod-row__tile", `mod-row__tile--${meta.class}`, "mod-row__tile--sm"]}>
              <Icon size={14} />
            </span>
            <span class="resources-view__combo-name">{hub.unitDisplayName(mod)}</span>
            {mod.version && <span class="resources-view__combo-ver">{mod.version}</span>}
          </>
        );
      }
      const entry = raw as CatalogEntry;
      const Icon = catIcon(entry.category);
      const text = localized(entry);
      return (
        <>
          <span
            class={[
              "mod-row__tile",
              "mod-row__tile--cat",
              "mod-row__tile--sm",
              entry.preview && "mod-row__tile--preview",
            ]}
          >
            {/* Same layering as the sidebar rows: glyph under the thumbnail
                as placeholder and offline fallback. */}
            <Icon size={14} />
            {entry.preview && (
              <img
                class="mod-row__thumb"
                src={mediaImageUrl(entry.preview)}
                alt=""
                loading="lazy"
                draggable={false}
              />
            )}
          </span>
          <span class="resources-view__combo-name">{text.name || entry.title || entry.nameEn}</span>
        </>
      );
    }

    /** Empty-state text node — the list is a flex column of rows, so a bare
     *  string would render flush and full-contrast instead of reading as a
     *  placeholder. */
    const emptyNote = (text: string) => <div class="resources-view__empty">{text}</div>;

    /** Loading twin of emptyNote (mid-fetch / mid-scan): hikari's ring above
     *  the status copy — motion carries the "in progress" cue, so the line
     *  itself drops the trailing ellipsis (LoadingNote contract). */
    const loadingNote = (text: string) => (
      <div class="resources-view__empty">
        <LoadingNote text={text} />
      </div>
    );

    /** What an empty online list means depends on WHY it is empty: mid-fetch
     *  is not the same as "nothing matched", and a failed fetch is already
     *  talking through the error banner above the list. */
    const catalogEmptyNote = () => {
      if (hub.catalogLoading.value) return loadingNote(t("resources.refreshing"));
      if (hub.catalogError.value) return null;
      // Applicability-filtered like every list pipeline: a catalog whose
      // entries are all inapplicable to the active client reads as
      // "nothing matched", not as a missing catalog.
      const listed = listedEntries(hub.applicableCatalog.value);
      return emptyNote(
        listed.length === 0 ? t("resources.catalogEmpty") : t("resources.empty"),
      );
    };

    const installedEmptyNote = () =>
      hub.scanning.value
        ? loadingNote(t("resources.scanning"))
        : emptyNote(t("resources.empty"));

    return () => {
      const sourceTabs = [
        { key: "online", label: t("resources.source.online") },
        { key: "installed", label: t("resources.source.installed") },
      ];
      const bigCatTabs = [
        { key: "function", label: t("resources.big.function"), icon: <Puzzle size={14} /> },
        { key: "beautify", label: t("resources.big.beautify"), icon: <Palette size={14} /> },
      ];
      const selKey = hub.selectedRowKey.value;
      // The pane is re-keyed per selection so a freshly picked row always
      // opens at the top of its own body: the body's HkScrollContainer
      // instance otherwise survives the patch-in-place selection change, and
      // now that the association list starts expanded almost every pane body
      // is taller than its viewport — a carried-over scroll offset would drop
      // the next unit into the middle of its previews or its related list.
      // (Same intent as the PostBattlePanel drill-down reset.)
      const paneKey = (() => {
        const sel = hub.selection.value;
        if (!sel) return "none";
        switch (sel.mode) {
          case "catalog":
            return `catalog:${sel.entry.id}`;
          case "installed":
            return `installed:${sel.mod.relPath}`;
          case "foreign":
            return `foreign:${sel.unit.installer}:${sel.unit.key}`;
          case "component":
            return `component:${sel.comp.key}`;
          case "layer":
            return `layer:${sel.packId}`;
          case "local":
            return "local";
          default: {
            // A new Selection mode must extend this key: its rows would
            // otherwise keep the previous selection's pane body (and scroll
            // offset). The assignment makes a missed mode a type error.
            const unreachable: never = sel;
            return String(unreachable);
          }
        }
      })();
      return (
        <div class="resources-view">
          {/* ── Master/detail in the replay page's secondary-sidebar shape:
              the sidebar owns the title row, the condition strips, the count
              pill and the whole filter stack above the scrolling list; the
              pane shows what the selected row is. ── */}
          <aside class="resources-view__side">
            <div class="resources-view__side-head">
              <div class="resources-view__side-head-row">
                <h2 class="resources-view__side-title">{t("resources.title")}</h2>
                <span class="resources-view__side-actions">
                  {/* Tool menu: safe mode + the migration wizard — the ⋯
                      button rides the title row like the replay list's head
                      actions; refresh / folder-install ride the source row
                      below as its trailing ghost pair. */}
                  <span class="resources-view__tools" ref={hub.toolsAnchor}>
                    <HkIconButton
                      size={24}
                      variant="ghost"
                      data-hint={t("resources.toolsMenu")}
                      onClick={() => (hub.toolsOpen.value = !hub.toolsOpen.value)}
                    >
                      <Ellipsis size={15} />
                    </HkIconButton>
                    <HMenu
                      variant="popup"
                      title={t("resources.toolsMenu")}
                      open={hub.toolsOpen.value}
                      anchorRef={hub.toolsAnchor.value}
                      placement="bottom-end"
                      items={[
                        {
                          key: "safe-enter",
                          label: t("resources.safeModeEnter"),
                          icon: ShieldCheck,
                          disabled: !hub.gameRoot.value || hub.safeMode.value || hub.safeModeBusy.value,
                        },
                        {
                          key: "safe-exit",
                          label: t("resources.safeModeExit"),
                          icon: Undo2,
                          disabled: !hub.safeMode.value || hub.safeModeBusy.value,
                        },
                        {
                          key: "purge-reinstall",
                          label: t("resources.purgeReinstall"),
                          icon: Trash2,
                          disabled:
                            !hub.gameRoot.value ||
                            hub.safeMode.value ||
                            hub.purgeBusy.value,
                        },
                        {
                          key: "migrate",
                          label: t("resources.staleMigrate"),
                          icon: RefreshCw,
                          disabled:
                            !hub.gameRoot.value || hub.staleBins.value.length === 0 || wizard.migrating.value,
                        },
                        {
                          key: "sync-all",
                          label: t("resources.sync.action"),
                          icon: FolderSync,
                          disabled:
                            !hub.gameRoot.value ||
                            hub.clientCount.value < 2 ||
                            hub.catalogLoading.value ||
                            hub.recordsLoading.value ||
                            hub.syncAllBusy.value,
                        },
                      ]}
                      // HMenu select emits the item key itself as the first argument.
                      onSelect={(key: string | number) => {
                        hub.toolsOpen.value = false;
                        if (key === "safe-enter") hub.safeModeAsk.value = "on";
                        else if (key === "safe-exit") hub.safeModeAsk.value = "off";
                        else if (key === "purge-reinstall") hub.purgeAsk.value = hub.foreignUnits.value.length > 0 ? "choice" : "simple";
                        else if (key === "migrate") wizard.openMigrateWizard();
                        else if (key === "sync-all") void hub.openSyncAll();
                      }}
                      onUpdate:open={(v: boolean) => (hub.toolsOpen.value = v)}
                    />
                  </span>
                </span>
              </div>

              {/* Compact condition strip: only what NEEDS attention stays a
                  banner — a missing install speaks the replay list's quiet
                  no-client note, while safe mode / stale bins keep the
                  banner chrome (both carry an action). Tooling lives in the
                  ⋯ menu. */}
              {!hub.gameRoot.value && (
                <p class="resources-view__side-note">{t("resources.noGame")}</p>
              )}

              {hub.safeMode.value && hub.gameRoot.value && (
                <div class="resources-banner resources-banner--warn">
                  <AlertTriangle size={16} />
                  <span class="resources-banner__text">{t("resources.safeModeOn")}</span>
                  <HkButton
                    size="sm"
                    disabled={hub.safeModeBusy.value}
                    loading={hub.safeModeBusy.value}
                    onClick={() => (hub.safeModeAsk.value = "off")}
                  >
                    {t("resources.safeModeExit")}
                  </HkButton>
                </div>
              )}

              {/* A tree stamped by an older client. Advisory: the banner
                  names the drift and the override count, and the hint is
                  reachable by keyboard (the sibling banners carry an
                  action button; this one's fix lives in the installed
                  list, so the hint has to be focusable to be read at
                  all). Suppressed under safe mode, where nothing is
                  loaded anyway. */}
              {hub.treeVersion.value?.stale &&
                hub.gameRoot.value &&
                !hub.safeMode.value && (
                  <div class="resources-banner resources-banner--warn" role="alert">
                    <AlertTriangle size={16} />
                    <span
                      class="resources-banner__text"
                      tabindex="0"
                      data-hint={t("resources.treeStaleHint")}
                    >
                      {hub.treeVersion.value.riskyPaths.length > 0
                        ? t("resources.treeStale", {
                            tree: hub.treeVersion.value.treeGameVersion ?? "?",
                            current: hub.treeVersion.value.gameVersion ?? "?",
                            count: hub.treeVersion.value.riskyPaths.length,
                          })
                        : t("resources.treeStaleNoOverrides", {
                            tree: hub.treeVersion.value.treeGameVersion ?? "?",
                            current: hub.treeVersion.value.gameVersion ?? "?",
                          })}
                    </span>
                  </div>
                )}

              {hub.loaderStatus.value?.pnfModsPresent &&
                !hub.loaderStatus.value.markerPresent &&
                hub.gameRoot.value &&
                !hub.safeMode.value && (
                  <div class="resources-banner resources-banner--warn">
                    <AlertTriangle size={16} />
                    <span class="resources-banner__text">
                      {t("resources.pnfLoaderMissing")}
                    </span>
                    <HkButton
                      size="sm"
                      variant="primary"
                      disabled={hub.restoringLoader.value}
                      loading={hub.restoringLoader.value}
                      onClick={hub.restoreLoaderMarker}
                    >
                      {t("resources.pnfLoaderRestore")}
                    </HkButton>
                  </div>
                )}

              {hub.source.value === "installed" &&
                hub.loaderHealthErrors.value.length > 0 &&
                hub.gameRoot.value &&
                !hub.safeMode.value && (
                  <div class="loader-health">
                    <button
                      type="button"
                      class="loader-health__head"
                      aria-expanded={loaderHealthOpen.value}
                      data-hint={t("resources.loaderHealth.title")}
                      onClick={() => (loaderHealthOpen.value = !loaderHealthOpen.value)}
                    >
                      <AlertTriangle size={14} />
                      <span class="loader-health__title">
                        {t("resources.loaderHealth.title")}
                      </span>
                      <AppTag class="loader-health__badge" tone="warning">
                        {hub.loaderHealthErrors.value.length}
                      </AppTag>
                      <ChevronDown
                        size={14}
                        class={{ "is-open": loaderHealthOpen.value }}
                      />
                    </button>
                    {loaderHealthOpen.value && (
                      <div class="loader-health__body">
                        {hub.loaderHealthErrors.value.map((v, i) => (
                          <div
                            class="loader-health__row"
                            key={`${v.modName ?? "framework"}-${v.kind}-${i}`}
                          >
                            <span class="loader-health__row-main">
                              <span class="loader-health__row-name">
                                {v.modName ?? t("resources.loaderHealth.framework")}
                              </span>
                              <span class="loader-health__row-kind">
                                {t(`resources.loaderHealth.kind.${v.kind}`)}
                              </span>
                              <span class="loader-health__row-at">{v.at}</span>
                            </span>
                            <span class="loader-health__row-hint">
                              {t(`resources.loaderHealth.hint.${v.kind}`)}
                              <button
                                type="button"
                                class="loader-health__row-locate"
                                onClick={() =>
                                  hub.locateLoaderHealth(v.modName)
                                }
                              >
                                {t("resources.loaderHealth.locate")}
                              </button>
                            </span>
                          </div>
                        ))}
                        {hub.loaderHealthOkCount.value > 0 && (
                          <div class="loader-health__ok">
                            {t("resources.loaderHealth.loadedOkSummary", {
                              count: hub.loaderHealthOkCount.value,
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

              {(() => {
                const boot = hub.bootInstaller.value;
                return hub.source.value === "installed" &&
                  boot &&
                  hub.gameRoot.value &&
                  !hub.safeMode.value ? (
                  /* The warning strip's chrome (HkAlert's warning token
                      recipe) rides the wrapper; the collapsible is hikari's
                      HkExpansionPanel — the DISARM action sits in its action
                      slot, always reachable without expanding the row list
                      (issue #1736's views batch). */
                  <div class="boot-installer" data-hint={t("resources.bootInstaller.hint")}>
                    <HkExpansionPanel
                      modelValue={bootInstallerOpen.value}
                      onUpdate:modelValue={(v: boolean) => (bootInstallerOpen.value = v)}
                    >
                      {{
                        title: () => (
                          <>
                            <AlertTriangle size={14} class="boot-installer__icon" />
                            <span class="boot-installer__title">
                              {t("resources.bootInstaller.title", {
                                count: boot.descriptors.length,
                              })}
                            </span>
                          </>
                        ),
                        action: () => (
                          <HkButton
                            size="sm"
                            variant="primary"
                            disabled={hub.disarmBusy.value}
                            loading={hub.disarmBusy.value}
                            onClick={() => (disarmAsk.value = true)}
                          >
                            {t("resources.bootInstaller.disarm")}
                          </HkButton>
                        ),
                        default: () => (
                          <div class="boot-installer__body">
                            <div class="boot-installer__unit">
                              {boot.unitRelPath}
                              {boot.version &&
                                ` · v${boot.version}`}
                            </div>
                            {boot.descriptors.slice(0, 8).map((row) => (
                              <div class="boot-installer__rowname" key={row}>
                                {row}
                              </div>
                            ))}
                            {boot.descriptors.length > 8 && (
                              <div class="boot-installer__more">
                                {t("resources.bootInstaller.more", {
                                  count: boot.descriptors.length - 8,
                                })}
                              </div>
                            )}
                          </div>
                        ),
                      }}
                    </HkExpansionPanel>
                  </div>
                ) : null;
              })()}

              {hub.staleBins.value.length > 0 && hub.gameRoot.value && !hub.safeMode.value && (
                <div class="resources-banner resources-banner--warn">
                  <AlertTriangle size={16} />
                  <span class="resources-banner__text">
                    {t("resources.staleBinBanner", {
                      version: hub.staleBins.value.map((b) => b.binVersion).join(", "),
                      count: hub.staleBins.value.reduce((n, b) => n + b.fileCount, 0),
                    })}
                  </span>
                  <HkButton
                    size="sm"
                    variant="primary"
                    disabled={wizard.migrating.value}
                    loading={wizard.migrating.value}
                    onClick={wizard.openMigrateWizard}
                  >
                    {t("resources.staleMigrate")}
                  </HkButton>
                </div>
              )}

              {/* Individual-management notice: multi-client machine, unified
                  sync OFF — installs and removals hit ONLY the selected
                  client while the mode stays off. Quiet strip (no action):
                  the switch on the source row below IS the way out. */}
              {hub.syncIndividual.value && hub.activeInstall.value && (
                <div class="resources-banner resources-banner--sync">
                  <span class="resources-banner__text">
                    {t("resources.sync.banner", {
                      client: installLabelOf(hub.activeInstall.value),
                    })}
                  </span>
                </div>
              )}

              {/* The count pill mirrors the replay list's count — scoped to
                  the ACTIVE source AND big category, i.e. exactly what the
                  "all" chip below counts; narrower chip/filter states show
                  in the list itself. */}
              <AppTag class="resources-view__count" tone="primary">
                {t("resources.countLine", {
                  count:
                    hub.source.value === "online"
                      ? hub.catalogInCat.value.length
                      : hub.bigCat.value === "beautify"
                        ? hub.layerStack.layers.value.length
                        : hub.installedInCat.value.length,
                })}
              </AppTag>

              {/* Big category — the row-filling segmented strip. */}
              <HkTabs
                variant="segmented"
                block
                modelValue={hub.bigCat.value}
                onUpdate:modelValue={(v: string) => (hub.bigCat.value = v as BigCat)}
                tabs={bigCatTabs}
                renderPanels={false}
              />

              {/* Source switch + the three tool triggers (search popup,
                  refresh/rescan, folder install) ride one row — all ghost
                  icon-button sized, the segmented group carries the height. */}
              <div class="resources-view__row">
                <div class="resources-view__rowmain">
                  <HkTabs
                    variant="segmented"
                    modelValue={hub.source.value}
                    onUpdate:modelValue={(v: string) => hub.pickSource(v as "online" | "installed")}
                    tabs={sourceTabs}
                    renderPanels={false}
                  />
                  {/* Unified multi-client sync (only meaningful with several
                      installs): ON fans catalog installs/uninstalls out to
                      every client realm-filtered; OFF manages the selected
                      client alone and raises the banner above. Bare switch —
                      the data-hint tooltip carries the explanation, the ⋯
                      menu's "Sync all clients" does the one-shot reconcile. */}
                  {hub.clientCount.value > 1 && (
                    <span
                      class="resources-view__sync-toggle"
                      data-hint={t("resources.sync.toggleHint")}
                    >
                      <HkSwitch
                        size="sm"
                        modelValue={hub.syncEnabled.value}
                        aria-label={t("resources.sync.toggleLabel")}
                        onUpdate:modelValue={() => hub.toggleSync()}
                      />
                    </span>
                  )}
                </div>
                <AsyncSearchCombo
                  key={hub.source.value}
                  ghost
                  search={hub.comboSearch}
                  itemKey={(raw: unknown) =>
                    hub.source.value === "installed"
                      ? (raw as InstalledMod).relPath
                      : (raw as CatalogEntry).id
                  }
                  renderItem={comboRenderItem}
                  onSelect={hub.comboSelect}
                  title={t("resources.searchMod")}
                  placeholder={t("resources.listFilter")}
                  searchingText={t("resources.searching")}
                  minChars={1}
                  align="right"
                  noResultsText={t("resources.empty")}
                />
                <HkIconButton
                  size={24}
                  variant="ghost"
                  disabled={hub.refreshDisabled.value}
                  data-hint={hub.source.value === "online" ? t("resources.refresh") : t("resources.scan")}
                  aria-label={
                    hub.source.value === "online" ? t("resources.refresh") : t("resources.scan")
                  }
                  onClick={hub.refresh}
                >
                  {hub.refreshSpinning.value ? (
                    <HkSpinner size="xs" tone="current" />
                  ) : (
                    <RefreshCw size={15} />
                  )}
                </HkIconButton>
                {/* 自定义导入安装: the custom-import wizard (three steps). The
                    plain whole-package folder install stays reachable from
                    the wizard's first step. */}
                <HkIconButton
                  size={24}
                  variant="ghost"
                  data-hint={t("resources.importWizard.title")}
                  aria-label={t("resources.importWizard.title")}
                  onClick={importWizard.openImportWizard}
                >
                  <FolderOpen size={15} />
                </HkIconButton>
              </div>

              {hub.source.value === "online" && hub.catalogError.value && (
                <ErrorCard
                  error={hub.catalogError.value}
                  description={t("resources.catalogError", { error: hub.catalogError.value })}
                />
              )}

              {/* Sub-division chips, scoped to the active big category.
                  Multi-select toggles: no chips picked = show everything,
                  each clicked chip narrows to its bucket (union). The
                  layered beautify view owns its own row badges, so the
                  kind chips step aside there (they cannot narrow a stack). */}
              {(hub.source.value === "online" || hub.bigCat.value === "function") && (
              <div class="resources-chips">
                {hub.source.value === "online"
                  ? CATALOG_CATS.filter(
                      (c) =>
                        catBig(c) === hub.bigCat.value && (hub.catCounts.value.get(c) ?? 0) > 0,
                    ).map((c) => (
                      <AppTag
                        key={c}
                        interactive
                        tone={hub.catalogCats.value.has(c) ? "primary" : "default"}
                        face="outline"
                        aria-pressed={hub.catalogCats.value.has(c)}
                        data-hint={t("resources.chipsHint")}
                        onClick={() => hub.toggleCatalogCat(c)}
                      >
                        {t(`resources.cat.${c}`)} · {hub.catCounts.value.get(c)}
                      </AppTag>
                    ))
                  : KIND_ORDER.filter(
                      (k) => KIND_BIG[k] === hub.bigCat.value && (hub.kindCounts.value.get(k) ?? 0) > 0,
                    ).map((k) => (
                      <AppTag
                        key={k}
                        interactive
                        tone={hub.kindFilters.value.has(k) ? "primary" : "default"}
                        face="outline"
                        aria-pressed={hub.kindFilters.value.has(k)}
                        data-hint={t("resources.chipsHint")}
                        onClick={() => hub.toggleKindFilter(k)}
                      >
                        {kindLabel(k)} · {hub.kindCounts.value.get(k)}
                      </AppTag>
                    ))}
              </div>
              )}
            </div>

            {/* ── The compact list (the master half): the sidebar's
                scroller — the filter stack above stays put; the hikari
                scroll container owns the scrollbar (overlay track) and
                the rows scroll inside its viewport ── */}
            <HkScrollContainer class="resources-view__side-scroll">
              <div class="resources-view__side-inner">
                {hub.source.value !== "online"
                  ? renderCrashPins(crashPins, () => {
                      crashPinsOpen.value = true;
                    })
                  : null}
                {hub.source.value !== "online"
                  ? renderPurgeBackups(purgeBackups, () => {
                      purgeBackupsOpen.value = true;
                    })
                  : null}
                {hub.source.value === "online"
                  ? hub.catalogShown.value.length === 0
                    ? catalogEmptyNote()
                    : hub.catalogShown.value.map((entry) => renderCatalogRow(ctx, entry, selKey))
                  : hub.bigCat.value === "beautify"
                    ? (
                      <>
                        <LayerStack
                          layers={hub.layerStack.layers.value}
                          rendered={hub.layerStack.rendered.value}
                          slotConflicts={hub.layerStack.conflicts.value}
                          selectedPackId={
                            hub.selection.value?.mode === "layer"
                              ? hub.selection.value.packId
                              : ""
                          }
                          busy={hub.layerStack.busy.value}
                          loading={hub.layerStack.loading.value}
                          error={hub.layerStack.error.value}
                          reportBusy={hub.layerStack.reportBusy.value}
                          onSelect={hub.selectLayer}
                          onReorder={(from: number, to: number) =>
                            void hub.layerStack.setOrder(from, to)
                          }
                          onApply={() => void hub.layerStack.applyNow()}
                          onOpenReport={() => void hub.layerStack.openReport()}
                          onRetry={() => void hub.layerStack.refresh()}
                        />
                        {hub.textureComponents.value.length > 0 && (
                          <div class="layer-components">
                            <button
                              type="button"
                              class="layer-components__head"
                              aria-expanded={componentsOpen.value}
                              onClick={() => (componentsOpen.value = !componentsOpen.value)}
                            >
                              <ListTree size={14} />
                              <span class="layer-components__title">
                                {t("resources.layers.componentsToggle")}
                              </span>
                              <AppTag tone="default">
                                {hub.textureComponents.value.length}
                              </AppTag>
                              <ChevronDown
                                size={14}
                                class={{ "is-open": componentsOpen.value }}
                              />
                            </button>
                            {componentsOpen.value && (
                              <div class="layer-components__body">
                                {hub.textureComponents.value.map((comp) =>
                                  renderComponentRow(ctx, comp),
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )
                    : hub.shown.value.length === 0
                      ? installedEmptyNote()
                      : hub.shown.value.map((m) => renderInstalledRow(ctx, m, selKey))}
              </div>
            </HkScrollContainer>

            {renderModstationStrip(ctx)}

            {/* Catalog metadata rides a quiet footer (the count itself moved
                into the pill above); the installed list has none — its count
                IS the pill. */}
            {hub.source.value === "online" && (
              <div class="resources-view__side-foot">
                {t("resources.catalogMeta", {
                  source: hub.catalogSource.value,
                  time: formatLocalStamp(hub.catalogFetched.value, true),
                })}
              </div>
            )}
          </aside>

          {/* ── The detail half: what the selected row is, and every
              action for it, with the actions pinned bottom-right ── */}
          <section class="resources-view__main" key={paneKey}>{renderPane(ctx)}</section>

          <HkConfirmDialog
            open={!!hub.confirmTarget.value}
            title={t("resources.uninstall")}
            message={t("resources.confirmUninstall", { name: hub.confirmTarget.value?.nameZh || hub.confirmTarget.value?.nameEn || "" })}
            confirmLabel={t("resources.uninstall")}
            onConfirm={hub.uninstallMod}
            onUpdate:open={(v: boolean) => {
              if (!v) hub.confirmTarget.value = null;
            }}
          />

          <HkConfirmDialog
            open={hub.purgeAsk.value === "simple"}
            title={t("resources.purgeReinstall")}
            message={t("resources.confirmPurgeReinstall")}
            confirmLabel={t("resources.purgeReinstall")}
            onConfirm={() => void hub.doPurgeReinstall("wowsp-only")}
            onUpdate:open={(open: boolean) => {
              if (!open) hub.purgeAsk.value = null;
            }}
          />

          {/* Two-scope dialog: only offered when a third-party installer's
              units are actually on disk (the adopt scope is meaningless
              otherwise). */}
          <HkModal
            modelValue={hub.purgeAsk.value === "choice"}
            onUpdate:modelValue={(open: boolean) => {
              if (!open) hub.purgeAsk.value = null;
            }}
            title={t("resources.purgeReinstall")}
            width="34rem"
            footerActions={[
              {
                label: t("resources.purgeReinstallOurOnly"),
                variant: "secondary",
                loading: hub.purgeBusy.value,
                onClick: () => void hub.doPurgeReinstall("wowsp-only"),
              },
              {
                label: t("resources.purgeReinstallAdopt"),
                variant: "primary",
                loading: hub.purgeBusy.value,
                onClick: () => void hub.doPurgeReinstall("adopt-foreign"),
              },
            ]}
          >
            <p class="resources-view__purge-note">{t("resources.purgeReinstallChoiceIntro")}</p>
            <ul class="resources-view__purge-scopes">
              <li>{t("resources.purgeReinstallChoiceOur")}</li>
              <li>{t("resources.purgeReinstallChoiceAdopt")}</li>
            </ul>
            <p class="resources-view__purge-note">{t("resources.purgeReinstallBackupNote")}</p>
          </HkModal>

          {/* The collapsed crash-suspect launcher's secondary window — the
              suspect / quarantined management rows live here now. */}
          {renderCrashPinsWindow(
            crashPins,
            hub.installed.value,
            crashPinsOpen.value,
            (open: boolean) => {
              crashPinsOpen.value = open;
            },
          )}

          {/* The merged install tag's click-through — every configured
              client with this entry's install state + usage. */}
          {renderEntryClientsWindow(hub)}

          {/* The purge-backup launcher's secondary window — snapshot rows
              with resume / dismiss / restore-merge / delete. */}
          {renderPurgeBackupsWindow(
            purgeBackups,
            purgeBackupsOpen.value,
            (open: boolean) => {
              purgeBackupsOpen.value = open;
            },
          )}

          <HkConfirmDialog
            open={!!hub.safeModeAsk.value}
            title={t(hub.safeModeAsk.value === "on" ? "resources.safeModeEnter" : "resources.safeModeExit")}
            message={t(
              hub.safeModeAsk.value === "on"
                ? "resources.confirmSafeModeEnter"
                : "resources.confirmSafeModeExit",
            )}
            confirmLabel={t(
              hub.safeModeAsk.value === "on" ? "resources.safeModeEnter" : "resources.safeModeExit",
            )}
            onConfirm={hub.doSafeMode}
            onUpdate:open={(v: boolean) => {
              if (!v) hub.safeModeAsk.value = null;
            }}
          />

          {/* Multi-client reconcile confirm: per-client install/uninstall
              totals before anything touches another client's res_mods. */}
          <HkConfirmDialog
            open={!!hub.syncAllAsk.value}
            title={t("resources.sync.confirmTitle")}
            message={t("resources.sync.confirmBody", {
              installs: hub.syncAllAsk.value?.totalInstalls ?? 0,
              uninstalls: hub.syncAllAsk.value?.totalUninstalls ?? 0,
            })}
            confirmLabel={t("resources.sync.action")}
            confirmVariant="primary"
            loading={hub.syncAllBusy.value}
            onConfirm={() => void hub.doSyncAll()}
            onUpdate:open={(v: boolean) => {
              if (!v) hub.syncAllAsk.value = null;
            }}
          />

          {/* Stale-bin migration wizard: plan → review → executing → done. */}
          {renderMigrateWizard(ctx)}
          {/* Custom import wizard: kind → source → compliance & register. */}
          {renderImportWizard(ctx)}
          {renderFileListWindow(ctx)}

          {/* Related-mod removal (the installed pane's association section): a
              ledger row leaves through the catalog uninstall, which deletes
              its files in EVERY directory and restores the originals the
              install overwrote — the confirm copy says exactly that. */}
          <HkConfirmDialog
            open={!!hub.relationTarget.value}
            title={t("resources.uninstall")}
            message={t("resources.relatedConfirmRemove", {
              name: hub.relationTarget.value?.name || "",
            })}
            confirmLabel={t("resources.uninstall")}
            loading={hub.relationBusy.value}
            onConfirm={hub.removeRelatedMod}
            onUpdate:open={(v: boolean) => {
              if (!v) hub.relationTarget.value = null;
            }}
          />

          <HkConfirmDialog
            open={!!hub.unitTarget.value}
            title={t("resources.uninstall")}
            message={t("resources.confirmUnitUninstall", {
              name: hub.unitTarget.value?.name || "",
            })}
            confirmLabel={t("resources.uninstall")}
            onConfirm={hub.uninstallUnit}
            onUpdate:open={(v: boolean) => {
              if (!v) hub.unitTarget.value = null;
            }}
          />

          {/* ModStation trees sit outside res_mods — their uninstall is a
              whole-directory removal under bin/<version>/mods/, so the
              confirm spells that out. */}
          <HkConfirmDialog
            open={!!hub.foreignTarget.value}
            title={t("resources.uninstall")}
            message={t("resources.modstationUninstallConfirm", {
              name: hub.foreignTarget.value?.name || "",
            })}
            confirmLabel={t("resources.uninstall")}
            onConfirm={() => void hub.uninstallModstation()}
            onUpdate:open={(v: boolean) => {
              if (!v) hub.foreignTarget.value = null;
            }}
          />

          {/* Boot re-installer disarm: the confirm names the unit, every row
              it would re-apply and what removal does (files + manifest
              rows), then runs with the strip button's spinner. */}
          <HkConfirmDialog
            open={disarmAsk.value}
            title={t("resources.bootInstaller.confirmTitle")}
            message={t("resources.bootInstaller.confirmBody", {
              unit: hub.bootInstaller.value?.unitRelPath || "",
              count: hub.bootInstallerCutRows.value.length,
              rows: hub.bootInstallerCutRows.value.join(", "),
            })}
            confirmLabel={t("resources.bootInstaller.disarm")}
            confirmVariant="primary"
            loading={hub.disarmBusy.value}
            onConfirm={() => {
              disarmAsk.value = false;
              void hub.doDisarmBootInstaller();
            }}
            onUpdate:open={(v: boolean) => {
              if (!v) disarmAsk.value = false;
            }}
          />

          {/* Layer render report: totals + warnings + the conflicting path
              list from mod_hub_layer_paths (winner / shadowed / foreign). */}
          {renderLayerReport(ctx)}

          {/* Layered pack uninstall — resolves through the ledger record or
              the matching installed unit on confirm. */}
          <HkConfirmDialog
            open={!!hub.layerUninstallTarget.value}
            title={t("resources.layers.uninstallConfirmTitle")}
            message={t("resources.layers.uninstallConfirmBody", {
              name: hub.layerUninstallTarget.value?.name || "",
            })}
            confirmLabel={t("resources.layers.uninstall")}
            loading={hub.layerUninstallBusy.value}
            onConfirm={() => void hub.doLayerUninstall()}
            onUpdate:open={(open: boolean) => {
              if (!open) hub.layerUninstallTarget.value = null;
            }}
          />

          {/* One-time disclaimer gate — raised by the first mutating
              operation (see requestModOpDisclaimer), never again after. */}
          <ModOpDisclaimer />
        </div>
      );
    };
  },
});
