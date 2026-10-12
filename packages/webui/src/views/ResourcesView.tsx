import { defineComponent, watch } from "vue";
import {
  AlertTriangle,
  AudioLines,
  Ellipsis,
  FolderSearch,
  ImageIcon,
  Puzzle,
  RefreshCw,
  ShieldCheck,
  Undo2,
} from "@lucide/vue";

import {
  HkButton,
  HkConfirmDialog,
  HkIconButton,
  HkTabs,
  HMenu,
} from "@celestia-island/hikari";

import AsyncSearchCombo from "@/components/search/AsyncSearchCombo";
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
import { t } from "@/i18n";
import "./ResourcesView.scss";
import { useModHub } from "./resources/useModHub";
import { useMigrateWizard } from "./resources/useMigrateWizard";
import type { ResourcesCtx } from "./resources/context";
import { renderPane } from "./resources/DetailPane";
import { renderMigrateWizard } from "./resources/MigrateWizard";
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
    const wizard = useMigrateWizard(hub);
    hub.bindMigrateWizard(wizard.openMigrateWizard);
    const ctx: ResourcesCtx = { ...hub, ...wizard };

    // All installed rows, confirmations and migration plans belong to the
    // selected install. Invalidate synchronously so an old row can never
    // invoke an action against the newly selected root, even mid-scan.
    const gameRoot = hub.gameRoot;
    watch(gameRoot, (root) => {
      hub.invalidateRoot();
      wizard.beginRootChange();
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
          <span class="mod-row__tile mod-row__tile--cat mod-row__tile--sm">
            <Icon size={14} />
          </span>
          <span class="resources-view__combo-name">{text.name || entry.title || entry.nameEn}</span>
        </>
      );
    }

    /** Empty-state text node — the list is a flex column of rows, so a bare
     *  string would render flush and full-contrast instead of reading as a
     *  placeholder. */
    const emptyNote = (text: string) => <div class="resources-view__empty">{text}</div>;

    /** What an empty online list means depends on WHY it is empty: mid-fetch
     *  is not the same as "nothing matched", and a failed fetch is already
     *  talking through the error banner above the list. */
    const catalogEmptyNote = () => {
      if (hub.catalogLoading.value) return emptyNote(t("resources.refreshing"));
      if (hub.catalogError.value) return null;
      const listed = listedEntries(hub.catalog.value);
      return emptyNote(
        listed.length === 0 ? t("resources.catalogEmpty") : t("resources.empty"),
      );
    };

    const installedEmptyNote = () =>
      emptyNote(hub.scanning.value ? t("resources.scanning") : t("resources.empty"));

    return () => {
      const sourceTabs = [
        { key: "online", label: t("resources.source.online") },
        { key: "installed", label: t("resources.source.installed") },
      ];
      const bigCatTabs = [
        { key: "function", label: t("resources.big.function"), icon: <Puzzle size={14} /> },
        { key: "texture", label: t("resources.big.texture"), icon: <ImageIcon size={14} /> },
        { key: "voice", label: t("resources.big.voice"), icon: <AudioLines size={14} /> },
      ];
      const selKey = hub.selectedRowKey.value;
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
                          key: "migrate",
                          label: t("resources.staleMigrate"),
                          icon: RefreshCw,
                          disabled:
                            !hub.gameRoot.value || hub.staleBins.value.length === 0 || wizard.migrating.value,
                        },
                      ]}
                      onSelect={({ key }: { key: string | number }) => {
                        hub.toolsOpen.value = false;
                        if (key === "safe-enter") hub.safeModeAsk.value = "on";
                        else if (key === "safe-exit") hub.safeModeAsk.value = "off";
                        else if (key === "migrate") wizard.openMigrateWizard();
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

              {/* The count pill mirrors the replay list's count — scoped to
                  the ACTIVE source AND big category, i.e. exactly what the
                  "all" chip below counts; narrower chip/filter states show
                  in the list itself. */}
              <span class="resources-view__count">
                {t("resources.countLine", {
                  count:
                    hub.source.value === "online"
                      ? hub.catalogInCat.value.length
                      : hub.installedInCat.value.length,
                })}
              </span>

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
                  <RefreshCw size={15} class={hub.refreshSpinning.value ? "spin" : undefined} />
                </HkIconButton>
                <HkIconButton
                  size={24}
                  variant="ghost"
                  data-hint={t("resources.installSection")}
                  aria-label={t("resources.installSection")}
                  onClick={hub.openLocal}
                >
                  <FolderSearch size={15} />
                </HkIconButton>
              </div>

              {hub.source.value === "online" && hub.catalogError.value && (
                <div class="resources-banner resources-banner--error">
                  {t("resources.catalogError", { error: hub.catalogError.value })}
                </div>
              )}

              {/* Sub-division chips, scoped to the active big category.
                  Multi-select toggles: no chips picked = show everything,
                  each clicked chip narrows to its bucket (union). */}
              <div class="resources-chips">
                {hub.source.value === "online"
                  ? CATALOG_CATS.filter(
                      (c) =>
                        catBig(c) === hub.bigCat.value && (hub.catCounts.value.get(c) ?? 0) > 0,
                    ).map((c) => (
                      <button
                        key={c}
                        class={["chip", hub.catalogCats.value.has(c) && "chip--on"]}
                        aria-pressed={hub.catalogCats.value.has(c)}
                        title={t("resources.chipsHint")}
                        onClick={() => hub.toggleCatalogCat(c)}
                      >
                        {t(`resources.cat.${c}`)} · {hub.catCounts.value.get(c)}
                      </button>
                    ))
                  : KIND_ORDER.filter(
                      (k) => KIND_BIG[k] === hub.bigCat.value && (hub.kindCounts.value.get(k) ?? 0) > 0,
                    ).map((k) => (
                      <button
                        key={k}
                        class={["chip", hub.kindFilters.value.has(k) && "chip--on"]}
                        aria-pressed={hub.kindFilters.value.has(k)}
                        title={t("resources.chipsHint")}
                        onClick={() => hub.toggleKindFilter(k)}
                      >
                        {kindLabel(k)} · {hub.kindCounts.value.get(k)}
                      </button>
                    ))}
              </div>
            </div>

            {/* ── The compact list (the master half): the sidebar's
                scroller — the filter stack above stays put ── */}
            <div class="resources-view__side-scroll">
              {hub.source.value === "online"
                ? hub.catalogShown.value.length === 0
                  ? catalogEmptyNote()
                  : hub.catalogShown.value.map((entry) => renderCatalogRow(ctx, entry, selKey))
                : hub.bigCat.value === "texture" && hub.textureComponents.value.length === 0
                  ? installedEmptyNote()
                  : hub.bigCat.value === "texture"
                    ? hub.textureComponents.value.map((comp) => renderComponentRow(ctx, comp))
                    : hub.shown.value.length === 0
                      ? installedEmptyNote()
                      : hub.shown.value.map((m) => renderInstalledRow(ctx, m, selKey))}
            </div>

            {renderModstationStrip(ctx)}

            {/* Catalog metadata rides a quiet footer (the count itself moved
                into the pill above); the installed list has none — its count
                IS the pill. */}
            {hub.source.value === "online" && (
              <div class="resources-view__side-foot">
                {t("resources.catalogMeta", {
                  source: hub.catalogSource.value,
                  time: hub.catalogFetched.value.slice(0, 10),
                })}
              </div>
            )}
          </aside>

          {/* ── The detail half: what the selected row is, and every
              action for it, with the actions pinned bottom-right ── */}
          <section class="resources-view__main">{renderPane(ctx)}</section>

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

          {/* Stale-bin migration wizard: plan → review → executing → done. */}
          {renderMigrateWizard(ctx)}

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

          {/* One-time disclaimer gate — raised by the first mutating
              operation (see requestModOpDisclaimer), never again after. */}
          <ModOpDisclaimer />
        </div>
      );
    };
  },
});
