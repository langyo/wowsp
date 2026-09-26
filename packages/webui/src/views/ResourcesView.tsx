import { computed, defineComponent, onMounted, onUnmounted, ref, watch } from "vue";
import {
  AlertTriangle,
  AudioLines,
  ExternalLink,
  FolderSearch,
  ImageIcon,
  MousePointerClick,
  Puzzle,
  RefreshCw,
  Trash2,
} from "@lucide/vue";

import {
  HkButton,
  HkConfirmDialog,
  HkIconButton,
  HkSearchInput,
  HkSwitch,
  HkTabs,
  useToast,
} from "@celestia-island/hikari";

import AsyncSearchCombo from "@/components/search/AsyncSearchCombo";
import {
  api,
  type CatalogEntry,
  type CatalogProgress,
  type InstalledMod,
  type ModInstallRecord,
  type ModKind,
  type PackagePlan,
  type TextureAnalysis,
} from "@/api";
import {
  CATALOG_CATS,
  KIND_BIG,
  KIND_META,
  KIND_ORDER,
  catBig,
  catIcon,
  isCatalogCat,
  type BigCat,
  type CatalogCat,
} from "@/features/modhub/taxonomy";
import { openExternal } from "@/utils/openExternal";
import { useConfigStore } from "@/stores/config";
import { useGameStatusStore } from "@/stores/gameStatus";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import "./ResourcesView.scss";

/** Right-hand pane content: the selected catalog entry, the selected
 *  installed unit, or the folder-install flow (which has no list row of its
 *  own — it is opened from the list's action row). */
type Selection =
  | { mode: "catalog"; entry: CatalogEntry }
  | { mode: "installed"; mod: InstalledMod }
  | { mode: "local" };

const REPO = "langyo/wowsp";

/**
 * Mod Hub (Resources page) — master/detail, the replay page's shape.
 *
 * The left column owns the whole filter stack (big category, source, list
 * filter, chips) above the scrolling row list; the right pane shows what the
 * selected row is and carries every action for it — nothing is hidden behind
 * a modal, and the pane keeps a placeholder until something is picked.
 *
 * Online catalog: curated tool-type mods from `mod-index.json` (built from
 * GitHub Discussions by scripts/mod_hub_publish.py); install downloads the
 * release asset, verifies SHA-256 and unpacks through the same pipeline as
 * local installs. Installed: scan of the latest `bin/<version>/res_mods/`.
 */
export default defineComponent({
  name: "ResourcesView",
  setup() {
    const config = useConfigStore();
    const toast = useToast();
    const { uiLocale, dataLanguage } = useLanguage();

    const source = ref<"online" | "installed">("online");
    const bigCat = ref<BigCat>("function");
    // Shared filter box — one query across both sources keeps the row (and
    // the muscle memory) stable while swapping lists.
    const listQuery = ref("");
    const catalogFilter = ref<"all" | CatalogCat>("all");
    const filter = ref<"all" | ModKind>("all");
    const selection = ref<Selection | null>(null);

    const installed = ref<InstalledMod[]>([]);
    const scanning = ref(false);

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
    const records = ref<ModInstallRecord[]>([]);
    // Per-mod busy/progress maps (Vue instruments collection mutations,
    // so `.set`/`.delete` re-render). Only the mods currently being
    // processed appear here — every other row stays fully clickable while
    // one download runs, and parallel installs each track their own state.
    const busy = ref(new Map<string, "install" | "uninstall">());
    const progresses = ref(new Map<string, CatalogProgress>());
    const confirmTarget = ref<CatalogEntry | null>(null);

    // Installed-unit actions: relPath → "toggle" | "uninstall".
    const unitBusy = ref(new Map<string, "toggle" | "uninstall">());
    const unitTarget = ref<InstalledMod | null>(null);

    const gameRoot = computed(() => config.activeInstall?.path ?? "");
    const gameStatus = useGameStatusStore();

    /** Mutating res_mods while the client is running tears half-loaded mods —
     *  the backend rejects it too; this pre-check gives the localized message
     *  (and skips the round trip). */
    function gameRunning(): boolean {
      if (gameStatus.process.running) {
        toast.error(t("resources.gameRunningBlock"));
        return true;
      }
      return false;
    }

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
      if (!gameRoot.value || busy.value.has(entry.id) || gameRunning()) return;
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
      if (gameRunning()) {
        confirmTarget.value = null;
        return;
      }
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
      if (!gameRoot.value || unitBusy.value.has(unitKey(mod)) || gameRunning()) return;
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
      if (gameRunning()) {
        unitTarget.value = null;
        return;
      }
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
      if (!plan.value || installing.value || gameRunning()) return;
      installing.value = true;
      try {
        const r = await api.modHubInstall(sourcePath.value.trim(), gameRoot.value, plan.value);
        report.value = { name: r.name, count: r.wroteFiles, version: r.binVersion };
        plan.value = null;
        await Promise.all([scan(), loadRecords()]);
      } catch (e) {
        planError.value = e instanceof Error ? e.message : String(e);
      } finally {
        installing.value = false;
      }
    }

    // ── Marketplace filtering: big category → chips → shared query ──

    const catalogInCat = computed(() =>
      catalog.value.filter((m) => catBig(m.category) === bigCat.value),
    );
    const installedInCat = computed(() =>
      installed.value.filter((m) => KIND_BIG[m.kind] === bigCat.value),
    );

    // A chip picked under one big category must not leak an empty list into
    // the next one — reset both sub-filters on the category switch.
    watch(bigCat, () => {
      catalogFilter.value = "all";
      filter.value = "all";
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

    /** Query match for online entries: identity, published names and every
     *  localized variant (a user types what their UI language shows). */
    function entryMatches(entry: CatalogEntry, q: string): boolean {
      if (
        entry.id.includes(q) ||
        entry.nameEn.toLowerCase().includes(q) ||
        entry.nameZh.toLowerCase().includes(q) ||
        entry.title.toLowerCase().includes(q)
      ) {
        return true;
      }
      const text = localized(entry);
      if (text.name.toLowerCase().includes(q) || text.desc.toLowerCase().includes(q)) return true;
      return Object.values(entry.i18n ?? {}).some(
        (v) =>
          v.name?.toLowerCase().includes(q) || v.description?.toLowerCase().includes(q) || false,
      );
    }

    const modMatches = (m: InstalledMod, q: string) =>
      m.name.toLowerCase().includes(q) || m.relPath.toLowerCase().includes(q);

    const kindCounts = computed(() => {
      const map = new Map<ModKind, number>();
      for (const m of installedInCat.value) map.set(m.kind, (map.get(m.kind) ?? 0) + 1);
      return map;
    });

    const catCounts = computed(() => {
      const map = new Map<string, number>();
      for (const m of catalogInCat.value) map.set(m.category, (map.get(m.category) ?? 0) + 1);
      return map;
    });

    const catalogShown = computed(() => {
      const q = listQuery.value.trim().toLowerCase();
      return catalogInCat.value.filter((m) => {
        if (catalogFilter.value !== "all" && m.category !== catalogFilter.value) return false;
        return !q || entryMatches(m, q);
      });
    });

    const shown = computed(() => {
      const q = listQuery.value.trim().toLowerCase();
      return installedInCat.value.filter((m) => {
        if (filter.value !== "all" && m.kind !== filter.value) return false;
        return !q || modMatches(m, q);
      });
    });

    // ── Row → pane selection (the master/detail pair) ──

    function selectCatalog(entry: CatalogEntry) {
      source.value = "online";
      selection.value = { mode: "catalog", entry };
    }

    function selectInstalled(mod: InstalledMod) {
      source.value = "installed";
      selection.value = { mode: "installed", mod };
    }

    function openLocal() {
      selection.value = { mode: "local" };
    }

    /** Source switch: the list underneath is about to be a different dataset,
     *  so a selection that belongs to the other one is dropped (picking a
     *  combo hit re-selects right after, in the same tick). The folder flow
     *  is source-independent and survives. */
    function pickSource(next: "online" | "installed") {
      if (next === source.value) return;
      source.value = next;
      const mode = selection.value?.mode;
      if (mode === "catalog" || mode === "installed") selection.value = null;
    }

    const selectedRowKey = computed(() => {
      const sel = selection.value;
      if (sel?.mode === "catalog") return sel.entry.id;
      if (sel?.mode === "installed") return sel.mod.relPath;
      return "";
    });

    // ── Trailing search combo: jump straight into a mod ──
    // Scoped to the ACTIVE source — a popup that kept returning catalog hits
    // while the installed list is on screen would be a different list than
    // the one behind it. The combo is re-keyed on source change (see the
    // render below) so a swap drops the previous source's candidates instead
    // of re-rendering them through the other branch's row renderer.

    async function comboSearch(query: string): Promise<unknown[]> {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      return source.value === "online"
        ? catalog.value.filter((m) => entryMatches(m, q)).slice(0, 12)
        : installed.value.filter((m) => modMatches(m, q)).slice(0, 12);
    }

    function comboRenderItem(raw: unknown) {
      if (source.value === "installed") {
        const mod = raw as InstalledMod;
        const meta = KIND_META[mod.kind];
        const Icon = meta.icon;
        return (
          <>
            <span class={["mod-row__tile", `mod-row__tile--${meta.class}`, "mod-row__tile--sm"]}>
              <Icon size={14} />
            </span>
            <span class="mod-hub__combo-name">{mod.name}</span>
            {mod.version && <span class="mod-hub__combo-ver">{mod.version}</span>}
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
          <span class="mod-hub__combo-name">{text.name || entry.title || entry.nameEn}</span>
          <span class="mod-hub__combo-ver">v{entry.version}</span>
        </>
      );
    }

    function comboSelect(raw: unknown) {
      if (source.value === "installed") selectInstalled(raw as InstalledMod);
      else selectCatalog(raw as CatalogEntry);
    }

    /** Empty-state text node — the list is a flex column of rows, so a bare
     *  string would render flush and full-contrast instead of reading as a
     *  placeholder. */
    const emptyNote = (text: string) => <div class="mod-side__empty">{text}</div>;

    /** What an empty online list means depends on WHY it is empty: mid-fetch
     *  is not the same as "nothing matched", and a failed fetch is already
     *  talking through the error banner above the list. */
    const catalogEmptyNote = () => {
      if (catalogLoading.value) return emptyNote(t("resources.refreshing"));
      if (catalogError.value) return null;
      return emptyNote(
        catalog.value.length === 0 ? t("resources.catalogEmpty") : t("resources.empty"),
      );
    };

    const installedEmptyNote = () =>
      emptyNote(scanning.value ? t("resources.scanning") : t("resources.empty"));

    // ── Row 3 refresh: source decides what "refresh" means ──

    function refresh() {
      if (source.value === "online") void loadCatalog(true);
      else void scan();
    }

    const refreshSpinning = computed(() =>
      source.value === "online" ? catalogLoading.value : scanning.value,
    );
    // The online catalog works without a game install; rescanning installed
    // mods needs the res_mods root, hence the asymmetric disable.
    const refreshDisabled = computed(() => source.value === "installed" && !gameRoot.value);

    const catalogKb = (entry: CatalogEntry) =>
      entry.packages.reduce((sum, p) => sum + p.size, 0) > 0
        ? Math.max(1, Math.round(entry.packages.reduce((s, p) => s + p.size, 0) / 1024))
        : 0;

    const pkgKb = (size: number) => Math.max(1, Math.round(size / 1024));

    const discussionUrl = (n?: number | null) =>
      n ? `https://github.com/${REPO}/discussions/${n}` : "";

    function kindLabel(kind: ModKind): string {
      return t(`resources.kind.${kind}`);
    }

    /** Localized label for a texture-analysis code; falls back to the raw
     *  code when the locale has no entry (unknown nations, exotic dirs). */
    function texLabel(group: "cat" | "nation" | "species", code: string): string {
      const key = `resources.tex.${group}.${code}`;
      const label = t(key);
      return label === key ? code : label;
    }

    /** Compact breakdown of a texture-override tree — category / nation /
     *  species tags, the covered ship units, file-kind counts. Shared by the
     *  installed pane and the install plan card. */
    function renderTexAnalysis(a: TextureAnalysis) {
      const tags = [
        ...a.categories.map((c) => ({
          key: `cat-${c}`,
          text: texLabel("cat", c),
          cls: "tex-tag--cat",
        })),
        ...a.nations.map((n) => ({ key: `nat-${n}`, text: texLabel("nation", n), cls: "" })),
        ...a.species.map((s) => ({ key: `spc-${s}`, text: texLabel("species", s), cls: "" })),
        ...a.spaceNames.slice(0, 2).map((s) => ({ key: `space-${s}`, text: s, cls: "" })),
      ];
      const shownShips = a.ships.slice(0, 4);
      const meta = [
        t(a.truncated ? "resources.tex.filesOver" : "resources.tex.files", {
          count: a.fileCount,
        }),
        ...a.fileKinds.slice(0, 4).map((k) => `${k.ext} ${k.count}`),
      ].join(" · ");
      return (
        <div class="tex-analysis">
          {tags.length > 0 && (
            <div class="tex-analysis__tags">
              {tags.map((tag) => (
                <span key={tag.key} class={["tex-tag", tag.cls]}>
                  {tag.text}
                </span>
              ))}
            </div>
          )}
          {shownShips.length > 0 && (
            <div class="tex-analysis__ships" title={a.ships.join("\n")}>
              {shownShips.map((s) => (
                <span key={s} class="tex-ship">
                  {s}
                </span>
              ))}
              {a.ships.length > shownShips.length && (
                <span class="tex-ship tex-ship--more">
                  {t("resources.tex.moreShips", { count: a.ships.length - shownShips.length })}
                </span>
              )}
            </div>
          )}
          <div class="tex-analysis__meta">{meta}</div>
        </div>
      );
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

    // ── Detail pane (one branch per mode; the switch narrows the union) ──
    // Every mode renders head / scrolling body / footer, so the action row
    // stays pinned to the pane's bottom-right while long content scrolls.

    function renderCatalogDetail(entry: CatalogEntry) {
      const text = localized(entry);
      const record = recordOf(entry.id);
      const upToDate = !!record && record.version === entry.version;
      const busyState = busy.value.get(entry.id);
      const busyInstall = busyState === "install";
      const busyUninstall = busyState === "uninstall";
      const progressEntry = progresses.value.get(entry.id);
      const url = discussionUrl(entry.discussion);
      const kb = catalogKb(entry);
      const CatIcon = catIcon(entry.category);
      return (
        <div class="mod-detail">
          <div class="mod-detail__head">
            <span class="mod-row__tile mod-row__tile--cat mod-row__tile--lg">
              <CatIcon size={24} />
            </span>
            <div class="mod-detail__id">
              <div class="mod-detail__name">{text.name || entry.title || entry.nameEn}</div>
              <div class="mod-detail__en">{entry.nameEn}</div>
            </div>
          </div>
          <div class="mod-detail__scroll">
            <div class="mod-detail__badges">
              {isCatalogCat(entry.category) && (
                <span class="mod-detail__badge">{t(`resources.cat.${entry.category}`)}</span>
              )}
              <span class="mod-detail__badge">v{entry.version}</span>
              {record && !upToDate && (
                <span class="mod-detail__badge mod-detail__badge--warn">
                  {t("resources.installedAt", { version: record.version })}
                </span>
              )}
              {upToDate && (
                <span class="mod-detail__badge mod-detail__badge--ok">
                  {t("resources.installedBadge")}
                </span>
              )}
            </div>
            {(text.desc || entry.description) && (
              <p class="mod-detail__desc">{text.desc || entry.description}</p>
            )}
            <div class="mod-detail__meta">
              <span>{t("resources.gameRange", { game: entry.game })}</span>
              {kb > 0 && (
                <span>{t("resources.pkgCount", { count: entry.packages.length, kb })}</span>
              )}
            </div>
            {entry.packages.length > 0 && (
              <ul class="mod-detail__pkgs">
                {entry.packages.map((p) => (
                  <li key={p.url}>
                    <span class="mod-detail__pkgname">{p.name}</span>
                    {p.size > 0 && <span class="mod-detail__pkgsize">{pkgKb(p.size)} KB</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div class="mod-detail__foot">
            {busyInstall && progressEntry && (
              <div class="mod-detail__progress">
                <div
                  class="mod-detail__progress-bar"
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
            <div class="mod-detail__foot-row">
              {url && (
                <button
                  class="mod-detail__link"
                  data-hint={t("resources.openDiscussion")}
                  onClick={() => openExternal(url)}
                >
                  <ExternalLink size={13} />
                  {t("resources.discuss")}
                </button>
              )}
              <div class="mod-detail__actions">
                {record && (
                  <button
                    class="mod-detail__danger"
                    disabled={!!busyState}
                    onClick={() => (confirmTarget.value = entry)}
                  >
                    <Trash2 size={13} />
                    {busyUninstall ? t("resources.uninstalling") : t("resources.uninstall")}
                  </button>
                )}
                {!upToDate && (
                  <HkButton
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
                  </HkButton>
                )}
              </div>
            </div>
          </div>
        </div>
      );
    }

    function renderInstalledDetail(mod: InstalledMod) {
      const meta = KIND_META[mod.kind];
      const Icon = meta.icon;
      const state = unitBusy.value.get(mod.relPath);
      return (
        <div class="mod-detail">
          <div class="mod-detail__head">
            <span class={["mod-row__tile", `mod-row__tile--${meta.class}`, "mod-row__tile--lg"]}>
              <Icon size={24} />
            </span>
            <div class="mod-detail__id">
              <div class="mod-detail__name">
                {mod.name}
                {mod.version && <span class="mod-row__ver">{mod.version}</span>}
              </div>
              <div class="mod-detail__en">{kindLabel(mod.kind)}</div>
            </div>
          </div>
          <div class="mod-detail__scroll">
            {mod.disabled && (
              <div class="mod-detail__badges">
                <span class="mod-detail__badge mod-detail__badge--warn">
                  {t("resources.disabled")}
                </span>
              </div>
            )}
            {mod.textureAnalysis && renderTexAnalysis(mod.textureAnalysis)}
            {mod.detail && <div class="mod-detail__desc">{mod.detail}</div>}
            {mod.paths.length > 0 ? (
              <ul class="mod-detail__paths">
                {mod.paths.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : (
              <p class="mod-detail__hint">{t("resources.manifestOnly")}</p>
            )}
          </div>
          <div class="mod-detail__foot">
            <div class="mod-detail__foot-row">
              {mod.paths.length > 0 ? (
                <HkSwitch
                  size="sm"
                  modelValue={!mod.disabled}
                  disabled={!!state}
                  onUpdate:modelValue={(v: boolean) => toggleUnit(mod, v)}
                >
                  {mod.disabled ? t("resources.disabled") : t("resources.enabled")}
                </HkSwitch>
              ) : (
                <span class="mod-detail__hint">{t("resources.manifestOnlyShort")}</span>
              )}
              <div class="mod-detail__actions">
                <button
                  class="mod-detail__danger"
                  disabled={!!state}
                  onClick={() => (unitTarget.value = mod)}
                >
                  <Trash2 size={13} />
                  {state === "uninstall" ? t("resources.uninstalling") : t("resources.uninstall")}
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    function renderLocalDetail() {
      return (
        <div class="mod-detail">
          <div class="mod-detail__head">
            <span class="mod-row__tile mod-row__tile--lg">
              <FolderSearch size={24} />
            </span>
            <div class="mod-detail__id">
              <div class="mod-detail__name">{t("resources.installSection")}</div>
              <div class="mod-detail__en">{t("resources.installHint")}</div>
            </div>
          </div>
          <div class="mod-detail__scroll">
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
                  {plan.value.detail && <span class="plan-card__detail">{plan.value.detail}</span>}
                </div>
                {plan.value.textureAnalysis && renderTexAnalysis(plan.value.textureAnalysis)}
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
              </div>
            )}
          </div>
          <div class="mod-detail__foot">
            <div class="mod-detail__foot-row">
              <div class="mod-detail__actions">
                <HkButton
                  size="sm"
                  variant="primary"
                  disabled={!plan.value || installing.value || !gameRoot.value}
                  loading={installing.value}
                  onClick={confirmInstall}
                >
                  {installing.value ? t("resources.installing") : t("resources.confirmInstall")}
                </HkButton>
              </div>
            </div>
          </div>
        </div>
      );
    }

    function renderPane() {
      const sel = selection.value;
      if (!sel) {
        return (
          <div class="mod-detail mod-detail--empty">
            <div class="mod-detail__placeholder">
              <MousePointerClick size={30} />
              <p>{t("resources.pickHint")}</p>
            </div>
          </div>
        );
      }
      switch (sel.mode) {
        case "catalog":
          return renderCatalogDetail(sel.entry);
        case "installed":
          return renderInstalledDetail(sel.mod);
        case "local":
          return renderLocalDetail();
      }
    }

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
      const selKey = selectedRowKey.value;
      return (
        <div class="resources-view">
          <header class="resources-view__head">
            <h1 class="resources-view__title">{t("resources.title")}</h1>
            <p class="resources-view__subtitle">{t("resources.subtitle")}</p>
          </header>

          <div class="resources-banner resources-banner--warn">
            <AlertTriangle size={16} />
            {t("resources.experimental")}
          </div>

          {!gameRoot.value && (
            <div class="resources-banner resources-banner--warn">
              <AlertTriangle size={16} />
              {t("resources.noGame")}
            </div>
          )}

          {/* ── Master/detail: the filter stack + list on the left, the
              selected mod's pane on the right ── */}
          <div class="mod-hub">
            <aside class="mod-side">
              {/* Big category — the row-filling segmented strip. */}
              <HkTabs
                variant="segmented"
                block
                modelValue={bigCat.value}
                onUpdate:modelValue={(v: string) => (bigCat.value = v as BigCat)}
                tabs={bigCatTabs}
                renderPanels={false}
              />

              {/* Source switch + search-combo button ride one row. */}
              <div class="mod-side__row mod-side__row--source">
                <div class="mod-side__rowmain">
                  <HkTabs
                    variant="segmented"
                    modelValue={source.value}
                    onUpdate:modelValue={(v: string) => pickSource(v as "online" | "installed")}
                    tabs={sourceTabs}
                    renderPanels={false}
                  />
                </div>
                <AsyncSearchCombo
                  key={source.value}
                  search={comboSearch}
                  itemKey={(raw: unknown) =>
                    source.value === "installed"
                      ? (raw as InstalledMod).relPath
                      : (raw as CatalogEntry).id
                  }
                  renderItem={comboRenderItem}
                  onSelect={comboSelect}
                  title={t("resources.searchMod")}
                  placeholder={t("resources.listFilter")}
                  searchingText={t("resources.searching")}
                  minChars={1}
                  align="right"
                  noResultsText={t("resources.empty")}
                />
              </div>

              {/* List filter + refresh + folder-install entry. */}
              <div class="mod-side__row">
                <HkSearchInput
                  class="mod-side__filter"
                  modelValue={listQuery.value}
                  onUpdate:modelValue={(v: string) => (listQuery.value = v)}
                  placeholder={t("resources.listFilter")}
                />
                <HkIconButton
                  size={36}
                  disabled={refreshDisabled.value}
                  data-hint={source.value === "online" ? t("resources.refresh") : t("resources.scan")}
                  aria-label={
                    source.value === "online" ? t("resources.refresh") : t("resources.scan")
                  }
                  onClick={refresh}
                >
                  <RefreshCw size={16} class={refreshSpinning.value ? "spin" : undefined} />
                </HkIconButton>
                <HkIconButton
                  size={36}
                  data-hint={t("resources.installSection")}
                  aria-label={t("resources.installSection")}
                  onClick={openLocal}
                >
                  <FolderSearch size={16} />
                </HkIconButton>
              </div>

              {source.value === "online" && catalogError.value && (
                <div class="resources-banner resources-banner--error">
                  {t("resources.catalogError", { error: catalogError.value })}
                </div>
              )}

              {/* Sub-division chips, scoped to the active big category. */}
              <div class="resources-chips">
                {source.value === "online" ? (
                  <>
                    <button
                      class={["chip", catalogFilter.value === "all" && "chip--on"]}
                      onClick={() => (catalogFilter.value = "all")}
                    >
                      {t("resources.cat.all")} · {catalogInCat.value.length}
                    </button>
                    {CATALOG_CATS.filter(
                      (c) =>
                        catBig(c) === bigCat.value && (catCounts.value.get(c) ?? 0) > 0,
                    ).map((c) => (
                      <button
                        key={c}
                        class={["chip", catalogFilter.value === c && "chip--on"]}
                        onClick={() => (catalogFilter.value = c)}
                      >
                        {t(`resources.cat.${c}`)} · {catCounts.value.get(c)}
                      </button>
                    ))}
                  </>
                ) : (
                  <>
                    <button
                      class={["chip", filter.value === "all" && "chip--on"]}
                      onClick={() => (filter.value = "all")}
                    >
                      {t("resources.filterAll")} · {installedInCat.value.length}
                    </button>
                    {KIND_ORDER.filter(
                      (k) => KIND_BIG[k] === bigCat.value && (kindCounts.value.get(k) ?? 0) > 0,
                    ).map((k) => (
                      <button
                        key={k}
                        class={["chip", filter.value === k && "chip--on"]}
                        onClick={() => (filter.value = k)}
                      >
                        {kindLabel(k)} · {kindCounts.value.get(k)}
                      </button>
                    ))}
                  </>
                )}
              </div>

              {/* ── The compact list (the master half) ── */}
              <div class="mod-side__list">
                {source.value === "online"
                  ? catalogShown.value.length === 0
                    ? catalogEmptyNote()
                    : catalogShown.value.map((entry) => {
                        const text = localized(entry);
                        const record = recordOf(entry.id);
                        const upToDate = !!record && record.version === entry.version;
                        const busyInstall = busy.value.get(entry.id) === "install";
                        const RowIcon = catIcon(entry.category);
                        return (
                          <button
                            key={entry.id}
                            class={["mod-row", selKey === entry.id && "mod-row--active"]}
                            onClick={() => selectCatalog(entry)}
                          >
                            <span class="mod-row__tile mod-row__tile--cat">
                              <RowIcon size={20} />
                            </span>
                            <span class="mod-row__body">
                              <span class="mod-row__name">
                                {text.name || entry.title || entry.nameEn}
                                <span class="mod-row__ver">v{entry.version}</span>
                              </span>
                              <span class="mod-row__sub">{text.desc || entry.nameEn}</span>
                            </span>
                            <span class="mod-row__tail">
                              {busyInstall ? (
                                <span class="mod-row__spinner" />
                              ) : upToDate ? (
                                <span class="mod-row__badge mod-row__badge--ok">
                                  {t("resources.installedBadge")}
                                </span>
                              ) : record ? (
                                <span class="mod-row__badge mod-row__badge--up">
                                  {t("resources.update")}
                                </span>
                              ) : null}
                            </span>
                          </button>
                        );
                      })
                  : shown.value.length === 0
                    ? installedEmptyNote()
                    : shown.value.map((m) => {
                        const meta = KIND_META[m.kind];
                        const Icon = meta.icon;
                        const state = unitBusy.value.get(m.relPath);
                        return (
                          <button
                            key={m.relPath}
                            class={[
                              "mod-row",
                              m.disabled && "mod-row--disabled",
                              selKey === m.relPath && "mod-row--active",
                            ]}
                            onClick={() => selectInstalled(m)}
                          >
                            <span class={["mod-row__tile", `mod-row__tile--${meta.class}`]}>
                              <Icon size={20} />
                            </span>
                            <span class="mod-row__body">
                              <span class="mod-row__name">
                                {m.name}
                                {m.version && <span class="mod-row__ver">{m.version}</span>}
                              </span>
                              <span class="mod-row__sub">
                                {kindLabel(m.kind)} · {m.relPath}
                              </span>
                            </span>
                            <span class="mod-row__tail">
                              {state ? (
                                <span class="mod-row__spinner" />
                              ) : m.disabled ? (
                                <span class="mod-row__badge mod-row__badge--off">
                                  {t("resources.disabled")}
                                </span>
                              ) : null}
                            </span>
                          </button>
                        );
                      })}
              </div>

              <div class="mod-side__foot">
                {source.value === "online"
                  ? t("resources.catalogSource", {
                      count: catalog.value.length,
                      source: catalogSource.value,
                      time: catalogFetched.value.slice(0, 10),
                    })
                  : t("resources.countLine", { count: installed.value.length })}
              </div>
            </aside>

            {/* ── The detail half: what the selected row is, and every
                action for it, with the actions pinned bottom-right ── */}
            <section class="mod-detail-pane">{renderPane()}</section>
          </div>

          <HkConfirmDialog
            open={!!confirmTarget.value}
            title={t("resources.uninstall")}
            message={t("resources.confirmUninstall", { name: confirmTarget.value?.nameZh || confirmTarget.value?.nameEn || "" })}
            confirmLabel={t("resources.uninstall")}
            onConfirm={uninstallMod}
            onUpdate:open={(v: boolean) => {
              if (!v) confirmTarget.value = null;
            }}
          />

          <HkConfirmDialog
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
    };
  },
});
