import { computed, defineComponent, onMounted, onUnmounted, ref, watch } from "vue";
import {
  AlertTriangle,
  AudioLines,
  ExternalLink,
  FileCode,
  FolderSearch,
  Globe,
  Hash,
  ImageIcon,
  PackageCheck,
  Palette,
  Puzzle,
  RefreshCw,
  ScrollText,
  Trash2,
} from "@lucide/vue";

import {
  HButton,
  HConfirmDialog,
  HSearchInput,
  HSwitch,
  HTabs,
  useToast,
} from "@celestia-island/hikari";

import {
  api,
  type CatalogEntry,
  type CatalogProgress,
  type InstalledMod,
  type ModInstallRecord,
  type ModKind,
  type PackagePlan,
} from "@/api";
import { openExternal } from "@/utils/openExternal";
import { useConfigStore } from "@/stores/config";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import "./ResourcesView.scss";

const KIND_ORDER: ModKind[] = ["voice", "skin", "script", "gui", "patch", "textures"];

/** lucide glyph + accent hue per plugin category. */
const KIND_META: Record<ModKind, { icon: typeof Puzzle; class: string }> = {
  voice: { icon: AudioLines, class: "voice" },
  skin: { icon: Palette, class: "skin" },
  script: { icon: FileCode, class: "script" },
  gui: { icon: ImageIcon, class: "gui" },
  patch: { icon: ScrollText, class: "patch" },
  textures: { icon: PackageCheck, class: "textures" },
};

type CatalogCat = "battle" | "minimap" | "port" | "text" | "patch";
const CATALOG_CATS: CatalogCat[] = ["battle", "minimap", "port", "text", "patch"];

/** Top-level tabs (VSCode-marketplace style): the three former stacked
 *  sections become switchable views, the online catalog first. */
type HubTab = "catalog" | "installed" | "local";

const REPO = "langyo/wowsp";

/**
 * Mod Hub (Resources page).
 *
 * Top-level tabs pick the surface first, VSCode-marketplace style:
 * - Online catalog: curated tool-type plugins from `mod-index.json` (built
 *   from GitHub Discussions by scripts/mod_hub_publish.py). Install downloads
 *   the release asset, verifies SHA-256 and unpacks through the same pipeline
 *   as local installs.
 * - Installed: scan what is already under the latest `bin/<version>/res_mods/`.
 * - From folder: unpacked-package classifier flow (local zips still manual).
 */
export default defineComponent({
  name: "ResourcesView",
  setup() {
    const config = useConfigStore();
    const toast = useToast();
    const { uiLocale, dataLanguage } = useLanguage();

    const activeTab = ref<HubTab>("catalog");
    const installed = ref<InstalledMod[]>([]);
    const scanning = ref(false);
    const filter = ref<"all" | ModKind>("all");

    const sourcePath = ref("");
    const analyzing = ref(false);
    const plan = ref<PackagePlan | null>(null);
    const planError = ref("");
    const installing = ref(false);
    const report = ref<{ name: string; count: number; version: string } | null>(null);

    // ── Online catalog state ──
    const catalog = ref<CatalogEntry[]>([]);
    const catalogSource = ref("");
    const catalogFetched = ref("");
    const catalogLoading = ref(false);
    const catalogError = ref("");
    const catalogFilter = ref<"all" | CatalogCat>("all");
    const catalogSearch = ref("");
    const records = ref<ModInstallRecord[]>([]);
    // Per-plugin busy/progress maps (Vue instruments collection mutations,
    // so `.set`/`.delete` re-render). Only the plugins currently being
    // processed appear here — every other card stays fully clickable while
    // one download runs, and parallel installs each track their own state.
    const busy = ref(new Map<string, "install" | "uninstall">());
    const progresses = ref(new Map<string, CatalogProgress>());
    const confirmTarget = ref<CatalogEntry | null>(null);

    // Installed-tab unit actions: relPath → "toggle" | "uninstall".
    const unitBusy = ref(new Map<string, "toggle" | "uninstall">());
    const unitTarget = ref<InstalledMod | null>(null);

    const gameRoot = computed(() => config.activeInstall?.path ?? "");

    let unlisten: (() => void) | undefined;
    onMounted(() => {
      api
        .listenCatalogProgress?.((p) => {
          if (p.phase === "done") {
            progresses.value.delete(p.id);
          } else {
            progresses.value.set(p.id, p);
          }
        })
        ?.then((un) => (unlisten = un));
    });
    onUnmounted(() => unlisten?.());

    async function loadCatalog(force: boolean) {
      if (catalogLoading.value) return;
      catalogLoading.value = true;
      catalogError.value = "";
      try {
        const index = await api.modCatalogRefresh(force);
        catalog.value = index.mods;
        catalogSource.value = index.sourceVersion;
        catalogFetched.value = index.fetchedAt;
      } catch (e) {
        catalogError.value = e instanceof Error ? e.message : String(e);
      } finally {
        catalogLoading.value = false;
      }
    }

    async function loadRecords() {
      try {
        records.value = await api.modHubRecords();
      } catch {
        records.value = [];
      }
    }

    const recordOf = (id: string) => records.value.find((r) => r.id === id);

    /** Installed units are keyed by their primary path (unique per unit). */
    const unitKey = (m: InstalledMod) => m.relPath;

    async function installMod(entry: CatalogEntry) {
      if (!gameRoot.value || busy.value.has(entry.id)) return;
      busy.value.set(entry.id, "install");
      try {
        const r = await api.modCatalogInstall(entry.id, gameRoot.value);
        toast.success(t("resources.installedDone", { name: r.name, version: entry.version }));
        await Promise.all([scan(), loadRecords()]);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        busy.value.delete(entry.id);
        progresses.value.delete(entry.id);
      }
    }

    async function uninstallMod() {
      const entry = confirmTarget.value;
      if (!entry || !gameRoot.value || busy.value.has(entry.id)) return;
      confirmTarget.value = null;
      busy.value.set(entry.id, "uninstall");
      try {
        const r = await api.modCatalogUninstall(entry.id, gameRoot.value);
        toast.success(
          t("resources.uninstalledDone", {
            name: r.name,
            removed: r.removedFiles,
            restored: r.restoredFiles > 0 ? t("resources.restoredPart", { count: r.restoredFiles }) : "",
          }),
        );
        await Promise.all([scan(), loadRecords()]);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        busy.value.delete(entry.id);
      }
    }

    // ── Installed-unit actions (temporary disable via `.bak`, uninstall) ──

    async function toggleUnit(mod: InstalledMod, enabled: boolean) {
      if (!gameRoot.value || unitBusy.value.has(unitKey(mod))) return;
      unitBusy.value.set(unitKey(mod), "toggle");
      try {
        await api.modHubSetUnitEnabled(mod.relPath, gameRoot.value, enabled);
        toast.success(
          enabled
            ? t("resources.unitEnabled", { name: mod.name })
            : t("resources.unitDisabled", { name: mod.name }),
        );
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        unitBusy.value.delete(unitKey(mod));
        await scan();
      }
    }

    async function uninstallUnit() {
      const mod = unitTarget.value;
      if (!mod || !gameRoot.value || unitBusy.value.has(unitKey(mod))) return;
      unitTarget.value = null;
      unitBusy.value.set(unitKey(mod), "uninstall");
      try {
        const r = await api.modHubUninstallUnit(mod.relPath, gameRoot.value);
        toast.success(
          t("resources.uninstalledDone", {
            name: r.name,
            removed: r.removedFiles,
            restored: r.restoredFiles > 0 ? t("resources.restoredPart", { count: r.restoredFiles }) : "",
          }),
        );
        await Promise.all([scan(), loadRecords()]);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        unitBusy.value.delete(unitKey(mod));
      }
    }

    async function scan() {
      if (!gameRoot.value || scanning.value) return;
      scanning.value = true;
      try {
        installed.value = await api.modHubScanInstalled(gameRoot.value);
      } finally {
        scanning.value = false;
      }
    }

    async function analyze() {
      if (!sourcePath.value.trim() || analyzing.value) return;
      analyzing.value = true;
      plan.value = null;
      planError.value = "";
      report.value = null;
      try {
        plan.value = await api.modHubClassifyPath(sourcePath.value.trim());
      } catch (e) {
        planError.value = e instanceof Error ? e.message : String(e);
      } finally {
        analyzing.value = false;
      }
    }

    async function confirmInstall() {
      if (!plan.value || installing.value) return;
      installing.value = true;
      try {
        const r = await api.modHubInstall(sourcePath.value.trim(), gameRoot.value, plan.value);
        report.value = { name: r.name, count: r.wroteFiles, version: r.binVersion };
        plan.value = null;
        await scan();
      } catch (e) {
        planError.value = e instanceof Error ? e.message : String(e);
      } finally {
        installing.value = false;
      }
    }

    const byKind = computed(() => {
      const map = new Map<ModKind, number>();
      for (const m of installed.value) map.set(m.kind, (map.get(m.kind) ?? 0) + 1);
      return map;
    });

    const shown = computed(() =>
      filter.value === "all"
        ? installed.value
        : installed.value.filter((m) => m.kind === filter.value),
    );

    const catCounts = computed(() => {
      const map = new Map<string, number>();
      for (const m of catalog.value) map.set(m.category, (map.get(m.category) ?? 0) + 1);
      return map;
    });

    const catalogShown = computed(() => {
      const q = catalogSearch.value.trim().toLowerCase();
      return catalog.value.filter((m) => {
        if (catalogFilter.value !== "all" && m.category !== catalogFilter.value) return false;
        if (!q) return true;
        return (
          m.id.includes(q) ||
          m.nameEn.toLowerCase().includes(q) ||
          m.nameZh.toLowerCase().includes(q) ||
          m.title.toLowerCase().includes(q)
        );
      });
    });

    /** Localized name/description from the thread's wowsp:i18n block:
     *  UI locale first, then the game-data language, then en-US. Matching
     *  falls back to the language subtag so `zh-SG` still finds `zh-CN`. */
    function localized(entry: CatalogEntry): { name: string; desc: string } {
      const table = entry.i18n ?? {};
      const wanted = [uiLocale.value, dataLanguage.value, "en-US"];
      for (const lang of wanted) {
        const text = table[lang];
        if (text?.name || text?.description) {
          return { name: text.name, desc: text.description };
        }
      }
      for (const lang of wanted) {
        const base = lang.split("-")[0]?.toLowerCase();
        const key = base && Object.keys(table).find((k) => k.split("-")[0].toLowerCase() === base);
        const text = key ? table[key] : undefined;
        if (text?.name || text?.description) {
          return { name: text.name, desc: text.description };
        }
      }
      return { name: entry.nameZh || entry.nameEn, desc: entry.description };
    }

    const catalogKb = (entry: CatalogEntry) =>
      entry.packages.reduce((sum, p) => sum + p.size, 0) > 0
        ? Math.max(1, Math.round(entry.packages.reduce((s, p) => s + p.size, 0) / 1024))
        : 0;

    const discussionUrl = (n?: number | null) =>
      n ? `https://github.com/${REPO}/discussions/${n}` : "";

    function kindLabel(kind: ModKind): string {
      return t(`resources.kind.${kind}`);
    }

    // The config store hydrates the active install asynchronously — rescan
    // once the game root shows up (the mount-time scan is a no-op before it).
    watch(gameRoot, (root) => {
      if (root && installed.value.length === 0) scan();
    });

    onMounted(() => {
      scan();
      loadCatalog(false);
      loadRecords();
    });

    return () => (
      <div class="resources-view">
        <div class="resources-view__head">
          <h1 class="resources-view__title">{t("resources.title")}</h1>
        </div>
        <p class="resources-view__subtitle">{t("resources.subtitle")}</p>

        {!gameRoot.value && (
          <div class="resources-banner resources-banner--warn">
            <AlertTriangle size={16} />
            {t("resources.noGame")}
          </div>
        )}

        {/* ── Tab strip: pick the surface first, then work inside it ── */}
        <HTabs
          class="resources-view__tabs"
          modelValue={activeTab.value}
          onUpdate:modelValue={(v: string) => (activeTab.value = v as HubTab)}
          tabs={[
            { key: "catalog", label: t("resources.tab.catalog"), icon: <Globe size={14} /> },
            { key: "installed", label: t("resources.tab.installed"), icon: <Puzzle size={14} /> },
            { key: "local", label: t("resources.tab.local"), icon: <FolderSearch size={14} /> },
          ]}
          variant="pill"
          scrollable={false}
          renderPanels={false}
        />

        {/* Panels swap instantly (VSCode-style); the tab strip's sliding
            indicator already carries the motion feedback. */}
        <div key={activeTab.value}>
            {/* ── Online catalog: curated tool plugins from the mod-hub release ── */}
            {activeTab.value === "catalog" && (
              <section class="resources-section">
                <div class="resources-section__head">
                  <Globe size={18} />
                  <h2>{t("resources.catalogTitle")}</h2>
                  <button
                    class="resources-view__rescan resources-section__action"
                    disabled={catalogLoading.value}
                    onClick={() => loadCatalog(true)}
                  >
                    <RefreshCw size={14} class={catalogLoading.value ? "spin" : undefined} />
                    {catalogLoading.value ? t("resources.refreshing") : t("resources.refresh")}
                  </button>
                </div>
                <p class="resources-section__desc">{t("resources.catalogHint")}</p>

                {catalogError.value && (
                  <div class="resources-banner resources-banner--error">
                    {t("resources.catalogError", { error: catalogError.value })}
                  </div>
                )}

                {catalog.value.length > 0 && (
                  <>
                    <div class="resources-toolbar">
                      <HSearchInput
                        modelValue={catalogSearch.value}
                        onUpdate:modelValue={(v: string) => (catalogSearch.value = v)}
                        placeholder={t("resources.catalogSearch")}
                      />
                      <span class="resources-toolbar__meta">
                        {t("resources.catalogSource", {
                          count: catalog.value.length,
                          source: catalogSource.value,
                          time: catalogFetched.value.slice(0, 10),
                        })}
                      </span>
                    </div>

                    <div class="resources-chips">
                      <button
                        class={["chip", catalogFilter.value === "all" && "chip--on"]}
                        onClick={() => (catalogFilter.value = "all")}
                      >
                        {t("resources.cat.all")} · {catalog.value.length}
                      </button>
                      {CATALOG_CATS.filter((c) => (catCounts.value.get(c) ?? 0) > 0).map((c) => (
                        <button
                          key={c}
                          class={["chip", catalogFilter.value === c && "chip--on"]}
                          onClick={() => (catalogFilter.value = c)}
                        >
                          {t(`resources.cat.${c}`)} · {catCounts.value.get(c)}
                        </button>
                      ))}
                    </div>

                    {catalogShown.value.length === 0 ? (
                      <div class="resources-section__placeholder">{t("resources.empty")}</div>
                    ) : (
                      <div class="catalog-grid">
                        {catalogShown.value.map((entry) => {
                          const text = localized(entry);
                          const record = recordOf(entry.id);
                          const upToDate = record && record.version === entry.version;
                          const busyState = busy.value.get(entry.id);
                          const busyInstall = busyState === "install";
                          const busyUninstall = busyState === "uninstall";
                          const progressEntry = progresses.value.get(entry.id);
                          const url = discussionUrl(entry.discussion);
                          const kb = catalogKb(entry);
                          return (
                            <div key={entry.id} class="catalog-card">
                              <div class="catalog-card__head">
                                <span class="catalog-card__name">
                                  {text.name || entry.title || entry.nameEn}
                                </span>
                                {upToDate && (
                                  <span class="catalog-card__badge catalog-card__badge--ok">
                                    {t("resources.installedBadge")}
                                  </span>
                                )}
                              </div>
                              {text.name && text.name !== entry.nameEn && (
                                <div class="catalog-card__sub">{entry.nameEn}</div>
                              )}
                              {text.desc && (
                                <div class="catalog-card__desc" data-hint={text.desc}>
                                  {text.desc}
                                </div>
                              )}
                              <div class="catalog-card__meta">
                                <span class="catalog-card__ver">
                                  <Hash size={11} />
                                  {record && !upToDate
                                    ? `${record.version} → ${entry.version}`
                                    : entry.version}
                                </span>
                                {kb > 0 && (
                                  <span>
                                    {t("resources.pkgCount", {
                                      count: entry.packages.length,
                                      kb,
                                    })}
                                  </span>
                                )}
                                <span>{t("resources.gameRange", { game: entry.game })}</span>
                              </div>
                              <div class="catalog-card__actions">
                                {!upToDate && (
                                  <HButton
                                    size="sm"
                                    variant="primary"
                                    disabled={!!busyState || !gameRoot.value}
                                    loading={busyInstall}
                                    onClick={() => installMod(entry)}
                                  >
                                    {busyInstall
                                      ? t("resources.installingMod")
                                      : record
                                        ? t("resources.update")
                                        : t("resources.install")}
                                  </HButton>
                                )}
                                {record && (
                                  <button
                                    class="catalog-card__uninstall"
                                    data-hint={t("resources.uninstall")}
                                    aria-label={t("resources.uninstall")}
                                    disabled={!!busyState}
                                    onClick={() => (confirmTarget.value = entry)}
                                  >
                                    <Trash2 size={13} />
                                    {busyUninstall ? t("resources.uninstalling") : ""}
                                  </button>
                                )}
                                {url && (
                                  <button
                                    class="catalog-card__thread"
                                    data-hint={t("resources.openDiscussion")}
                                    onClick={() => openExternal(url)}
                                  >
                                    <ExternalLink size={13} />
                                    {t("resources.discuss")}
                                  </button>
                                )}
                              </div>
                              {busyInstall && progressEntry && (
                                <div class="catalog-card__progress">
                                  <div
                                    class="catalog-card__progress-bar"
                                    style={{
                                      width: `${Math.min(
                                        100,
                                        progressEntry.total > 0
                                          ? (progressEntry.received / progressEntry.total) * 100
                                          : 12,
                                      )}%`,
                                    }}
                                  />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}

                {!catalogLoading.value && catalog.value.length === 0 && !catalogError.value && (
                  <div class="resources-section__placeholder">{t("resources.catalogEmpty")}</div>
                )}
              </section>
            )}

            {/* ── Installed plugins, browsable by category ─────────────────── */}
            {activeTab.value === "installed" && (
              <section class="resources-section">
                <div class="resources-section__head">
                  <Puzzle size={18} />
                  <h2>{t("resources.installed")}</h2>
                  <button
                    class="resources-view__rescan resources-section__action"
                    disabled={!gameRoot.value || scanning.value}
                    onClick={scan}
                  >
                    <RefreshCw size={14} class={scanning.value ? "spin" : undefined} />
                    {scanning.value ? t("resources.scanning") : t("resources.scan")}
                  </button>
                </div>

                <div class="resources-chips">
                  <button
                    class={["chip", filter.value === "all" && "chip--on"]}
                    onClick={() => (filter.value = "all")}
                  >
                    {t("resources.filterAll")} · {installed.value.length}
                  </button>
                  {KIND_ORDER.filter((k) => (byKind.value.get(k) ?? 0) > 0).map((k) => (
                    <button
                      key={k}
                      class={["chip", filter.value === k && "chip--on"]}
                      onClick={() => (filter.value = k)}
                    >
                      {kindLabel(k)} · {byKind.value.get(k)}
                    </button>
                  ))}
                </div>

                {shown.value.length === 0 ? (
                  <div class="resources-section__placeholder">{t("resources.empty")}</div>
                ) : (
                  <div class="mod-grid">
                    {shown.value.map((m) => {
                      const meta = KIND_META[m.kind];
                      const Icon = meta.icon;
                      const state = unitBusy.value.get(m.relPath);
                      const busyToggle = state === "toggle";
                      return (
                        <div
                          key={m.relPath}
                          class={[
                            "mod-card",
                            `mod-card--${meta.class}`,
                            m.disabled && "mod-card--disabled",
                          ]}
                        >
                          <div class="mod-card__main">
                            <Icon size={20} />
                            <div class="mod-card__body">
                              <div class="mod-card__name">
                                {m.name}
                                {m.version && (
                                  <span class="mod-card__version">{m.version}</span>
                                )}
                              </div>
                              <div class="mod-card__kind">{kindLabel(m.kind)}</div>
                              {m.detail && <div class="mod-card__detail">{m.detail}</div>}
                              <div class="mod-card__path" title={m.paths.join("\n")}>
                                {m.relPath}
                                {m.paths.length > 1 && ` +${m.paths.length - 1}`}
                              </div>
                              {m.paths.length === 0 && (
                                <div class="mod-card__detail">{t("resources.manifestOnly")}</div>
                              )}
                            </div>
                            <button
                              class="mod-card__uninstall"
                              data-hint={t("resources.uninstall")}
                              aria-label={t("resources.uninstall")}
                              disabled={!!state}
                              onClick={() => (unitTarget.value = m)}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                          <div class="mod-card__foot">
                            {m.paths.length > 0 ? (
                              <HSwitch
                                size="sm"
                                modelValue={!m.disabled}
                                disabled={!!state}
                                onUpdate:modelValue={(v: boolean) => toggleUnit(m, v)}
                              >
                                {m.disabled
                                  ? t("resources.disabled")
                                  : t("resources.enabled")}
                              </HSwitch>
                            ) : (
                              <span class="mod-card__foot-note">
                                {t("resources.manifestOnlyShort")}
                              </span>
                            )}
                            {busyToggle && <span class="mod-card__spinner" />}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            )}

            {/* ── Install from an unpacked folder via the classifier ───────── */}
            {activeTab.value === "local" && (
              <section class="resources-section">
                <div class="resources-section__head">
                  <FolderSearch size={18} />
                  <h2>{t("resources.installSection")}</h2>
                </div>
                <p class="resources-section__desc">{t("resources.installHint")}</p>

                <div class="resources-installrow">
                  <input
                    type="text"
                    v-model={sourcePath.value}
                    placeholder={t("resources.pathPlaceholder")}
                    spellcheck={false}
                  />
                  <button
                    disabled={!sourcePath.value.trim() || analyzing.value || !gameRoot.value}
                    onClick={analyze}
                  >
                    {analyzing.value ? t("resources.analyzing") : t("resources.browse")}
                  </button>
                </div>

                {planError.value && (
                  <div class="resources-banner resources-banner--error">{planError.value}</div>
                )}
                {report.value && (
                  <div class="resources-banner resources-banner--ok">
                    {t("resources.installedOk", {
                      name: report.value.name,
                      count: report.value.count,
                      version: report.value.version,
                    })}
                  </div>
                )}

                {plan.value && (
                  <div class={`plan-card plan-card--${KIND_META[plan.value.kind].class}`}>
                    <div class="plan-card__head">
                      {(() => {
                        const Icon = KIND_META[plan.value!.kind].icon;
                        return <Icon size={18} />;
                      })()}
                      <strong>{plan.value.name}</strong>
                      <span class="plan-card__badge">{kindLabel(plan.value.kind)}</span>
                      {plan.value.detail && (
                        <span class="plan-card__detail">{plan.value.detail}</span>
                      )}
                    </div>
                    {plan.value.entries.length > 0 && (
                      <table class="plan-card__files">
                        <caption>{t("resources.planFiles")}</caption>
                        <tbody>
                          {plan.value.entries.map((e) => (
                            <tr key={e.fromRel + e.toRel}>
                              <td>{e.fromRel === "." ? "." : `${e.fromRel}/`}</td>
                              <td>→</td>
                              <td>{e.toRel}/</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {plan.value.warnings.length > 0 && (
                      <ul class="plan-card__warnings">
                        {plan.value.warnings.map((w) => (
                          <li key={w}>
                            <AlertTriangle size={12} /> {w}
                          </li>
                        ))}
                      </ul>
                    )}
                    <button
                      class="plan-card__go"
                      disabled={installing.value}
                      onClick={confirmInstall}
                    >
                      {installing.value ? t("resources.installing") : t("resources.confirmInstall")}
                    </button>
                  </div>
                )}
              </section>
            )}
          </div>

        <HConfirmDialog
          open={!!confirmTarget.value}
          title={t("resources.uninstall")}
          message={t("resources.confirmUninstall", { name: confirmTarget.value?.nameZh || confirmTarget.value?.nameEn || "" })}
          confirmLabel={t("resources.uninstall")}
          onConfirm={uninstallMod}
          onUpdate:open={(v: boolean) => {
            if (!v) confirmTarget.value = null;
          }}
        />

        <HConfirmDialog
          open={!!unitTarget.value}
          title={t("resources.uninstall")}
          message={t("resources.confirmUnitUninstall", {
            name: unitTarget.value?.name || "",
          })}
          confirmLabel={t("resources.uninstall")}
          onConfirm={uninstallUnit}
          onUpdate:open={(v: boolean) => {
            if (!v) unitTarget.value = null;
          }}
        />
      </div>
    );
  },
});
