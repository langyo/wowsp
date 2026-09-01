import { computed, defineComponent, onMounted, onUnmounted, ref, watch } from "vue";
import {
  AlertTriangle,
  AudioLines,
  ExternalLink,
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
import { useConfigStore } from "@/stores/config";
import { t } from "@/i18n";
import "./ResourcesView.scss";

const KIND_ORDER: ModKind[] = ["voice", "skin", "gui", "patch", "textures"];

/** lucide glyph + accent hue per plugin category. */
const KIND_META: Record<ModKind, { icon: typeof Puzzle; class: string }> = {
  voice: { icon: AudioLines, class: "voice" },
  skin: { icon: Palette, class: "skin" },
  gui: { icon: ImageIcon, class: "gui" },
  patch: { icon: ScrollText, class: "patch" },
  textures: { icon: PackageCheck, class: "textures" },
};

type CatalogCat = "battle" | "minimap" | "port" | "texts";
const CATALOG_CATS: CatalogCat[] = ["battle", "minimap", "port", "texts"];

const REPO = "langyo/wowsp";

/**
 * Mod Hub (Resources page).
 *
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
    const busyId = ref("");
    const busyKind = ref<"install" | "uninstall" | "">("");
    const progress = ref<CatalogProgress | null>(null);
    const confirmTarget = ref<CatalogEntry | null>(null);

    const gameRoot = computed(() => config.activeInstall?.path ?? "");

    let unlisten: (() => void) | undefined;
    onMounted(() => {
      api
        .listenCatalogProgress?.((p) => (progress.value = p.phase === "done" ? null : p))
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

    async function installMod(entry: CatalogEntry) {
      if (!gameRoot.value || busyId.value) return;
      busyId.value = entry.id;
      busyKind.value = "install";
      try {
        const r = await api.modCatalogInstall(entry.id, gameRoot.value);
        toast.success(t("resources.installedDone", { name: r.name, version: entry.version }));
        await Promise.all([scan(), loadRecords()]);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        busyId.value = "";
        busyKind.value = "";
        progress.value = null;
      }
    }

    async function uninstallMod() {
      const entry = confirmTarget.value;
      if (!entry || !gameRoot.value || busyId.value) return;
      confirmTarget.value = null;
      busyId.value = entry.id;
      busyKind.value = "uninstall";
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
        busyId.value = "";
        busyKind.value = "";
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
          <button
            class="resources-view__rescan"
            disabled={!gameRoot.value || scanning.value}
            onClick={scan}
          >
            <RefreshCw size={14} class={scanning.value ? "spin" : undefined} />
            {scanning.value ? t("resources.scanning") : t("resources.scan")}
          </button>
        </div>
        <p class="resources-view__subtitle">{t("resources.subtitle")}</p>

        {!gameRoot.value && (
          <div class="resources-banner resources-banner--warn">
            <AlertTriangle size={16} />
            {t("resources.noGame")}
          </div>
        )}

        {/* ── Online catalog: curated tool plugins from the mod-hub release ── */}
        <section class="resources-section">
          <div class="resources-section__head">
            <Globe size={18} />
            <h2>{t("resources.catalogTitle")}</h2>
            <button
              class="resources-view__rescan"
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
                    const record = recordOf(entry.id);
                    const upToDate = record && record.version === entry.version;
                    const busyInstall =
                      busyId.value === entry.id && busyKind.value === "install";
                    const busyUninstall =
                      busyId.value === entry.id && busyKind.value === "uninstall";
                    const url = discussionUrl(entry.discussion);
                    const kb = catalogKb(entry);
                    return (
                      <div key={entry.id} class="catalog-card">
                        <div class="catalog-card__head">
                          <span class="catalog-card__name">
                            {entry.nameZh || entry.title || entry.nameEn}
                          </span>
                          {upToDate && (
                            <span class="catalog-card__badge catalog-card__badge--ok">
                              {t("resources.installedBadge")}
                            </span>
                          )}
                        </div>
                        <div class="catalog-card__sub">
                          {entry.nameZh ? entry.nameEn : ""}
                        </div>
                        {entry.description && (
                          <div class="catalog-card__desc" title={entry.description}>
                            {entry.description}
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
                              disabled={!!busyId.value || !gameRoot.value}
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
                              title={t("resources.uninstall")}
                              disabled={!!busyId.value}
                              onClick={() => (confirmTarget.value = entry)}
                            >
                              <Trash2 size={13} />
                              {busyUninstall ? t("resources.uninstalling") : ""}
                            </button>
                          )}
                          {url && (
                            <a
                              class="catalog-card__thread"
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              title={t("resources.openDiscussion")}
                            >
                              <ExternalLink size={13} />
                              {t("resources.discuss")}
                            </a>
                          )}
                        </div>
                        {busyInstall && progress.value && (
                          <div class="catalog-card__progress">
                            <div
                              class="catalog-card__progress-bar"
                              style={{
                                width: `${Math.min(
                                  100,
                                  progress.value.total > 0
                                    ? (progress.value.received / progress.value.total) * 100
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

        {/* ── Installed plugins, browsable by category ─────────────────── */}
        <section class="resources-section">
          <div class="resources-section__head">
            <Puzzle size={18} />
            <h2>{t("resources.installed")}</h2>
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
                return (
                  <div key={m.relPath + m.name} class={`mod-card mod-card--${meta.class}`}>
                    <Icon size={20} />
                    <div class="mod-card__body">
                      <div class="mod-card__name">{m.name}</div>
                      <div class="mod-card__kind">{kindLabel(m.kind)}</div>
                      {m.detail && <div class="mod-card__detail">{m.detail}</div>}
                      <div class="mod-card__path">{m.relPath}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Install from an unpacked folder via the classifier ───────── */}
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
      </div>
    );
  },
});
