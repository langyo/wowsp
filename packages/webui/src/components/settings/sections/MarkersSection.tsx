/** Player markers settings section (玩家标记): ONE list — add/remove local
 *  colored markers (red = 消极作战, yellow = 疑似作弊, purple = 隐藏高手)
 *  and review them. The add form collapses into a top-right "+" button
 *  opening a tabbed dialog — 精准搜索 (the classic form plus a realm
 *  select + lookup that resolves the account id, rename-proof) and
 *  从海猴雷达导入 (migrate ApeRadar's watch list into markers,
 *  desktop only — the phone build hides the tab and keeps the search
 *  face). The search box collapses into a search icon with a
 *  popover; a filter icon hosts the multi-select color group (all players
 *  + the three marks; nothing picked falls back to all). Rows carry the
 *  same configured stat columns as the live roster (the stats prefs own
 *  the column list) and sort by the first configured column, descending.
 *  Removal shows an undo toast. Strictly local data — no login, no sync,
 *  no upload. */
import { computed, defineComponent, ref, watch, type PropType } from "vue";
import type { VNode } from "vue";
import {
  HkButton,
  HkIconButton,
  HkInput,
  HkModal,
  HkPopover,
  HkScrollContainer,
  HkSelect,
  HkSettingsGroup,
  HkSettingsHint,
  HkSwitch,
  HkTabs,
  HkTag,
  useToast,
} from "@celestia-island/hikari";
import { Cloud, Filter, Plus, Search, X } from "@lucide/vue";

import { t } from "@/i18n";
import { MARKER_COLORS, useMarkersStore } from "@/stores/markers";
import { useAccountStore } from "@/stores/account";
import { useStatsStore } from "@/stores/stats";
import { prAlgoForRequest, useStatsPrefsStore, type OverlayColumnMetric } from "@/stores/statsPrefs";
import { api } from "@/api";
import type { ApeRadarWatchList, CloudBanMatch, MarkerColor, MarkerEntry } from "@/api";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";
import FilterCategoryChip from "@/components/ships/FilterCategoryChip";
import {
  rosterColumns,
  rosterStatCols,
  type RosterColumnSpec,
} from "@/features/replay/postBattleShare";
import { fetchRosterStatsByNames, type RosterStat } from "@/composables/useRosterStats";
import {
  overlayColumnDims,
  resolveRosterBattleScope,
  type RosterModeNumbers,
} from "@/utils/statView";
import { scopedRosterView } from "@/utils/shipStatsScope";
import { markerTintClass } from "@/features/markers/markerTint";
import { markerColorLabel } from "@/features/markers/playerContextMenu";
import { buildApeRadarPreview, rowsToImportItems } from "@/features/markers/aperadarImport";
import { cloudMatchHint, type CloudHintLabels } from "@/features/markers/cloudBan";
import { isAiName } from "@/utils/aiNames";
import { isMobileApp } from "@/utils/platform";
import "./MarkersSection.scss";

/** The color tabs, in the store's list order. */
const COLOR_TAB_LABEL_KEYS: Record<MarkerColor, string> = {
  red: "settings.markersColorRed",
  yellow: "settings.markersColorYellow",
  purple: "settings.markersColorPurple",
};

function colorLabel(color: MarkerColor): string {
  return t(COLOR_TAB_LABEL_KEYS[color]);
}

/** A settled "no stats" roster row: all numbers null, not hidden, not
 *  loading — the cells render their dash face instead of a spinner. */
const EMPTY_ROSTER_STAT: RosterStat = {
  winrate: null,
  pr: null,
  avgDamage: null,
  battles: null,
  kd: null,
  ranked: null,
  global: null,
  solo: null,
  accountId: null,
  clanId: null,
  clanTag: null,
  realm: null,
  karma: null,
  hidden: false,
  loading: false,
};

/** The sortable number a column reads off one view. */
function metricValue(
  view: RosterModeNumbers | undefined,
  metric: OverlayColumnMetric,
): number | null {
  if (!view) return null;
  switch (metric) {
    case "winrate":
      return view.winrate;
    case "pr":
      return view.pr;
    case "battles":
      return view.battles;
    case "damage":
      return view.avgDamage;
    case "kd":
      return view.kd;
  }
}

export default defineComponent({
  name: "SettingsMarkersSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup() {
    const store = useMarkersStore();
    void store.ensureLoaded();
    const prefs = useStatsPrefsStore();
    const account = useAccountStore();
    const stats = useStatsStore();
    const toast = useToast();

    // ── cloud ban-list (云端封禁名单) — toggle + tooltip details ──────
    // null = not loaded yet (the switch renders off and disabled until
    // the config answer lands, so it never flips under a click).
    const cloudEnabled = ref<boolean | null>(null);
    const cloudMatches = ref<Map<number, CloudBanMatch>>(new Map());

    async function loadCloudConfig(): Promise<void> {
      try {
        cloudEnabled.value = (await api.cloudBanGetConfig()).enabled;
      } catch {
        cloudEnabled.value = false;
      }
    }
    async function loadCloudMatches(): Promise<void> {
      try {
        const list = await api.cloudBanList();
        cloudMatches.value = new Map(list.map((m) => [m.accountId, m]));
      } catch {
        /* tooltip details are best-effort — rows still render */
      }
    }
    void loadCloudConfig();
    void loadCloudMatches();
    // The cloud side refreshes independently (a battle's check lands via
    // the markers-changed event) — reload the detail map whenever the
    // merged list's cloud population changes.
    watch(
      () =>
        store.entries
          .filter((e) => e.source === "cloud")
          .map((e) => e.accountId)
          .join(","),
      () => void loadCloudMatches(),
    );

    async function setCloudEnabled(next: boolean): Promise<void> {
      const prev = cloudEnabled.value;
      cloudEnabled.value = next; // optimistic; the backend answer rules
      try {
        cloudEnabled.value = (await api.cloudBanSetConfig(next)).enabled;
      } catch (e) {
        cloudEnabled.value = prev;
        toast.show((e as Error).message, { type: "error" });
      }
    }

    /** The tooltip line for a cloud row (detail map hit → full hint;
     *  miss → the generic sentence). */
    function cloudHintFor(entry: MarkerEntry): string {
      const labels: CloudHintLabels = {
        title: t("settings.markersCloudTooltip"),
        banTime: t("settings.markersCloudFieldBanTime"),
        banName: t("settings.markersCloudFieldBanName"),
        userName: t("settings.markersCloudFieldUserName"),
        namesake: t("settings.markersCloudFieldNamesake"),
      };
      const match =
        entry.accountId != null ? cloudMatches.value.get(entry.accountId) : undefined;
      return match ? cloudMatchHint(match, labels) : labels.title;
    }

    /** Dismiss a cloud row (a local false-positive verdict) with an undo
     *  toast — the row leaves the merged list via the change event. */
    async function dismissCloudEntry(entry: MarkerEntry): Promise<void> {
      if (entry.accountId == null) return;
      const accountId = entry.accountId;
      try {
        await api.cloudBanDismiss(accountId, true);
        toast.show(t("settings.markersCloudDismissed", { name: entry.nickname }), {
          type: "success",
          duration: 8000,
          action: {
            label: t("settings.markersCloudUndo"),
            onClick: () => {
              void api.cloudBanDismiss(accountId, false).catch((err: Error) => {
                // A failed restore must not pass silently — the row stays
                // dismissed and the user would believe otherwise.
                toast.show(err.message, { type: "error" });
              });
            },
          },
        });
      } catch (e) {
        toast.show((e as Error).message, { type: "error" });
      }
    }

    // The import wizard is desktop-only: 海猴雷达 is a Windows tool, and
    // the phone build has neither the default-location scan nor the
    // native file picker. On the phone the dialog renders the
    // exact-search body alone (no tab strip at all).
    const mobileApp = isMobileApp();

    // ── add dialog (tabbed: 精准搜索 / 从海猴雷达导入) ──────────────────
    const addOpen = ref(false);
    const addTab = ref<"search" | "import">("search");
    const nameInput = ref("");
    const noteInput = ref("");
    const color = ref<MarkerColor>("red");
    const adding = ref(false);

    function colorTabs() {
      return MARKER_COLORS.map((key) => ({ key, label: colorLabel(key) }));
    }

    /** The dialog's top tab group — desktop shows both faces, the phone
     *  hides the strip entirely (see mobileApp above). */
    function addTabs() {
      if (mobileApp) return [];
      return [
        { key: "search", label: t("settings.markersAddTabSearch") },
        { key: "import", label: t("settings.markersAddTabImport") },
      ];
    }

    // ── exact search (精准搜索): realm + lookup resolve the account id ──
    const SEARCH_REALMS = ["ru", "eu", "na", "asia", "cn"];
    const searchRealm = ref(account.activeRealm || "asia");
    const searching = ref(false);
    /** Player resolved by the lookup, staged for the add button (the
     *  preview row below the inputs shows exactly what it will store). */
    const staged = ref<{ nickname: string; accountId: number; realm: string } | null>(null);
    /** The last lookup found nothing — the add still works by typed name. */
    const searchMiss = ref(false);

    /** Bumped by every event that invalidates a lookup in flight: a new
     *  query, a realm switch, the dialog being reopened. doSearch stamps
     *  its attempt with the value it took at launch and drops the result
     *  when the counter has moved on (mirrors the account binder's
     *  seq-guard in AccountManagerContent). */
    let searchSeq = 0;

    function invalidateStaged(): void {
      searchSeq++;
      staged.value = null;
      searchMiss.value = false;
    }

    /** Floor under the search button's busy state (ms) — a lookup the
     *  stats cache answers in a couple of frames would flip the ring off
     *  in the same frame that painted it, reading as no reaction (see
     *  AccountManagerContent's SEARCH_BUSY_FLOOR_MS for the report). */
    const SEARCH_BUSY_FLOOR_MS = 400;

    /** Lookup-only step: resolve the nickname on the selected realm and
     *  stage it (the account binder's search without the bind). */
    async function doSearch(): Promise<void> {
      const name = nameInput.value.trim();
      if (!name || searching.value) return;
      const realm = searchRealm.value;
      const seq = ++searchSeq;
      const startedAt = Date.now();
      searching.value = true;
      searchMiss.value = false;
      // Any new query invalidates the previously staged preview (a failed
      // re-search must not leave the old player staged).
      staged.value = null;
      try {
        // force: an explicit query must re-pull from the WG API — the
        // documented rule for user-driven lookups (same as the binder).
        const result = await stats.lookup(name, realm, { force: true });
        if (seq !== searchSeq) return;
        staged.value = { nickname: result.name, accountId: result.accountId, realm };
      } catch {
        if (seq !== searchSeq) return;
        // Miss or lookup failure — markersSearchMiss covers both; the
        // add button still works by the typed nickname (accountId null).
        searchMiss.value = true;
      } finally {
        // Hold the ring to the floor before clearing the busy state (see
        // SEARCH_BUSY_FLOOR_MS). Clearing unconditionally is safe because
        // doSearch refuses to start while searching is set.
        const remaining = SEARCH_BUSY_FLOOR_MS - (Date.now() - startedAt);
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
        searching.value = false;
      }
    }

    async function addMarker(): Promise<void> {
      const typed = nameInput.value.trim();
      if (!typed || adding.value) return;
      adding.value = true;
      try {
        // Staged → the resolved canonical nickname + account id
        // (rename-proof); miss / no search → the typed nickname exactly
        // as before, accountId null.
        const stagedPlayer = staged.value;
        await store.add(
          stagedPlayer?.nickname ?? typed,
          color.value,
          noteInput.value.trim() || null,
          stagedPlayer?.accountId ?? null,
        );
        nameInput.value = "";
        noteInput.value = "";
        invalidateStaged();
        addOpen.value = false;
      } finally {
        adding.value = false;
      }
    }

    // ── import wizard (从海猴雷达导入) — desktop only ──────────────────
    type ImportState = "idle" | "scanning" | "notfound" | "found";
    const importState = ref<ImportState>("idle");
    const importList = ref<ApeRadarWatchList | null>(null);
    /** Inline read/scan failure — the raw anyhow message from the IPC. */
    const importError = ref<string | null>(null);
    const importNegtive = ref(true);
    const importCheater = ref(true);
    const importing = ref(false);

    /** The default-location scan fires on the FIRST activation of the
     *  import tab (a tab-switch watch, never the modal's open of the
     *  search tab); later visits reuse what it found. */
    watch(addTab, (tab) => {
      if (tab === "import" && importState.value === "idle") void scanImport();
    });

    async function scanImport(): Promise<void> {
      importState.value = "scanning";
      importError.value = null;
      try {
        const found = await api.aperadarScan();
        if (found == null) {
          importState.value = "notfound";
          return;
        }
        importList.value = found;
        importState.value = "found";
      } catch (e) {
        // The scan itself failed — surface the message on the read-error
        // line and offer the manual picker (the notfound face).
        importError.value = (e as Error).message;
        importState.value = "notfound";
      }
    }

    /** Manual browse: native picker → parse the picked file. A cancelled
     *  pick (null) leaves the wizard exactly where it was. */
    async function browseImport(): Promise<void> {
      try {
        const path = await api.aperadarPick();
        if (path == null) return;
        importError.value = null;
        importList.value = await api.aperadarRead(path);
        importState.value = "found";
      } catch (e) {
        importError.value = (e as Error).message;
      }
    }

    /** The wizard's preview, rebuilt whenever a category toggles or the
     *  markers store changes (a concurrent add flips the exists badge). */
    const importPreview = computed(() => {
      const list = importList.value;
      if (!list) return null;
      return buildApeRadarPreview(
        list,
        { negtive: importNegtive.value, cheater: importCheater.value },
        // "已标记，将更新" is about LOCAL rows — a cloud-only match must
        // not read as "already marked" and talk the user out of an import.
        store.entries
          .filter((entry) => entry.source !== "cloud")
          .map((entry) => entry.nickname),
      );
    });

    async function runImport(): Promise<void> {
      const preview = importPreview.value;
      if (!preview || preview.rows.length === 0 || importing.value) return;
      importing.value = true;
      try {
        const result = await store.importBatch(rowsToImportItems(preview.rows));
        toast.show(
          t("settings.markersImportDone", {
            added: result.added,
            updated: result.updated,
            skipped: result.skipped,
          }),
          { type: "success" },
        );
        addOpen.value = false;
      } catch (e) {
        toast.show((e as Error).message, { type: "error" });
      } finally {
        importing.value = false;
      }
    }

    /** Open the add dialog from the toolbar's "+" — start from the search
     *  face with a clean slate (no stale preview / miss from a previous
     *  visit; the wizard's scanned list survives across visits). */
    function openAdd(): void {
      invalidateStaged();
      addTab.value = "search";
      addOpen.value = true;
    }

    // ── search (icon + popover) ───────────────────────────────────────
    const search = ref("");
    const searchOpen = ref(false);
    const searchBtn = ref<HTMLElement | null>(null);

    // ── color filter (icon + multi-select group) ──────────────────────
    const filterOpen = ref(false);
    const filterColors = ref<Set<string>>(new Set());
    const colorOptions = computed(() =>
      MARKER_COLORS.map((key) => ({ value: key as string, label: colorLabel(key) })),
    );
    function toggleColor(value: string): void {
      const next = new Set(filterColors.value);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      filterColors.value = next;
    }
    /** The 全部玩家 pill: nothing picked shows every player (the default). */
    function resetColors(): void {
      filterColors.value = new Set();
    }

    // ── stats columns (shared with the live roster's prefs) ───────────
    const columns = computed<RosterColumnSpec[]>(() => rosterColumns());
    const battleScope = computed(() => resolveRosterBattleScope(prefs.prefs.overlayBattleScope, {}));
    const viewOf = (st: RosterStat, scope: RosterColumnSpec["scope"]): RosterModeNumbers =>
      scopedRosterView(
        st,
        null,
        overlayColumnDims(scope, prefs.prefs.overlayBattleScope),
        battleScope.value,
        prAlgoForRequest() ?? "winrate",
      );

    const statsMap = ref<Map<string, RosterStat>>(new Map());
    const statsLoading = ref(false);
    // activeRealm defaults to "asia" before an account is bound — the
    // list still shows numbers (other surfaces read the same realm).
    const realm = computed(() => account.activeRealm);
    let fetchSeq = 0;
    async function refreshStats(): Promise<void> {
      const seq = ++fetchSeq;
      const rl = realm.value;
      // Cloud rows are CN players by construction: fetch their stats on
      // "cn" rather than the active realm (a dual-realm user would
      // otherwise read wrong-realm — occasionally wrong-PLAYER — numbers
      // beside a "suspected cheater" row). Off the CN realm the cloud
      // rows skip fetching and settle to dashes below.
      const localNames = store.entries
        .filter((e) => e.source !== "cloud")
        .map((e) => e.nickname)
        .filter((n) => !isAiName(n));
      const cloudNames = store.entries
        .filter((e) => e.source === "cloud")
        .map((e) => e.nickname)
        .filter((n) => !isAiName(n));
      // Everything SETTLES, only some rows FETCH: a name missing from
      // statsMap renders a forever-spinner (rosterStatCols), so the
      // settled loops below dash whatever was not fetched — while the
      // fetch batch keeps cloud rows only on the CN realm.
      const settleNames = [...localNames, ...cloudNames];
      const fetchNames = rl === "cn" ? settleNames : localNames;
      if (!rl || settleNames.length === 0) {
        statsMap.value = new Map();
        statsLoading.value = false;
        return;
      }
      statsLoading.value = true;
      try {
        const map = await fetchRosterStatsByNames(fetchNames, rl, (name, entry) => {
          if (seq !== fetchSeq) return;
          const next = new Map(statsMap.value);
          next.set(name, entry);
          statsMap.value = next;
        });
        if (seq === fetchSeq) {
          // Names the batch could not resolve — and cloud rows off the
          // CN realm, which never fetched — get a settled all-null
          // entry: rosterStatCols renders a dash for a present-but-empty
          // stat and a forever-spinner for a missing one.
          const settled = new Map(map);
          for (const name of settleNames) {
            if (!settled.has(name)) settled.set(name, EMPTY_ROSTER_STAT);
          }
          statsMap.value = settled;
        }
      } catch {
        // A rejected batch must not leave rows spinning forever: settle
        // every name into its dash face.
        if (seq === fetchSeq) {
          const settled = new Map<string, RosterStat>();
          for (const name of settleNames) settled.set(name, EMPTY_ROSTER_STAT);
          statsMap.value = settled;
        }
      } finally {
        if (seq === fetchSeq) statsLoading.value = false;
      }
    }
    watch(
      () => [store.entries.map((e) => e.nickname).join("\n"), realm.value] as const,
      () => void refreshStats(),
      { immediate: true },
    );

    // ── rows: search + color filter, sorted by the first column ───────
    const filtered = computed<MarkerEntry[]>(() => {
      const q = search.value.trim().toLowerCase();
      return store.entries
        .filter(
          (entry) => filterColors.value.size === 0 || filterColors.value.has(entry.color),
        )
        .filter(
          (entry) =>
            !q ||
            entry.nickname.toLowerCase().includes(q) ||
            (entry.note ?? "").toLowerCase().includes(q) ||
            String(entry.accountId ?? "").includes(q),
        );
    });

    /** The first configured column's number for one entry (the list's sort). */
    function sortValue(entry: MarkerEntry, column: RosterColumnSpec): number | null {
      const st = statsMap.value.get(entry.nickname);
      if (!st) return null;
      return metricValue(viewOf(st, column.scope), column.metric);
    }
    const rows = computed<MarkerEntry[]>(() => {
      const list = [...filtered.value];
      const first = columns.value[0];
      if (first) {
        list.sort((a, b) => {
          const va = sortValue(a, first);
          const vb = sortValue(b, first);
          if (va == null && vb == null) return a.nickname.localeCompare(b.nickname);
          if (va == null) return 1; // unknown / hidden stats sink
          if (vb == null) return -1;
          // Equal numbers tie-break by nickname (stable, locale-aware).
          return vb - va || a.nickname.localeCompare(b.nickname);
        });
      }
      return list;
    });

    const countText = computed(() =>
      t("settings.markersCount", { n: store.entries.length }),
    );

    /** Remove + an undo toast (restoring the exact entry) so a misclick
     *  never loses a mark. */
    async function removeEntry(entry: MarkerEntry): Promise<void> {
      const { nickname, color: entryColor, note, accountId } = entry;
      await store.remove(nickname);
      toast.show(t("settings.markersRemoved", { name: nickname }), {
        type: "success",
        duration: 8000,
        action: {
          label: t("settings.markersUndo"),
          onClick: () => {
            void store.add(nickname, entryColor, note ?? null, accountId ?? null);
          },
        },
      });
    }

    const statCells = (entry: MarkerEntry): VNode =>
      rosterStatCols(
        entry.nickname,
        statsMap.value,
        statsLoading.value,
        (st, scope) => viewOf(st, scope),
      );

    /** The 精准搜索 face: realm select + name + lookup row over the
     *  classic note input, staged preview and color tabs. */
    function renderSearchTab(): VNode {
      const stagedPlayer = staged.value;
      return (
        <>
          <div class="markers-section__search-row">
            <HkSelect
              class="markers-section__search-realm"
              modelValue={searchRealm.value}
              onUpdate:modelValue={(v: string) => {
                searchRealm.value = v;
                // The staged preview belongs to the realm it was found
                // on — drop it (and any attempt in flight) rather than
                // pair one realm's id with another realm's label.
                invalidateStaged();
              }}
              options={SEARCH_REALMS.map((r) => ({ value: r, label: r.toUpperCase() }))}
            />
            <div class="markers-section__add-input">
              <HkInput
                modelValue={nameInput.value}
                onUpdate:modelValue={(v: string) => {
                  nameInput.value = v;
                  // Editing the name invalidates the staged preview.
                  invalidateStaged();
                }}
                placeholder={t("settings.markersNamePlaceholder")}
                submitOnEnter={() => void doSearch()}
              />
            </div>
            <HkButton
              class="markers-section__search-btn"
              size="sm"
              loading={searching.value}
              disabled={!nameInput.value.trim()}
              onClick={() => void doSearch()}
            >
              {t("settings.markersSearchBtn")}
            </HkButton>
          </div>
          <div class="markers-section__add-input">
            <HkInput
              modelValue={noteInput.value}
              onUpdate:modelValue={(v: string) => (noteInput.value = v)}
              placeholder={t("settings.markersNotePlaceholder")}
              submitOnEnter={() => void addMarker()}
            />
          </div>
          {stagedPlayer ? (
            /* The resolved player — exactly what the add button will
             *  store: canonical nickname + account id + realm tag. */
            <div class="markers-section__staged">
              <span class="markers-section__staged-label">{t("settings.markersSearchFound")}</span>
              <span class={["markers-section__staged-name", markerTintClass(color.value)]}>
                {stagedPlayer.nickname}
              </span>
              <span class="markers-section__staged-id">{stagedPlayer.accountId}</span>
              <HkTag variant="default" size="sm">
                {stagedPlayer.realm.toUpperCase()}
              </HkTag>
            </div>
          ) : searchMiss.value ? (
            <p class="markers-section__miss">{t("settings.markersSearchMiss")}</p>
          ) : (
            <p class="markers-section__hint">{t("settings.markersSearchHint")}</p>
          )}
          <HkTabs
            block
            variant="segmented"
            modelValue={color.value}
            onUpdate:modelValue={(v: string) => (color.value = v as MarkerColor)}
            tabs={colorTabs()}
          />
          <div class="markers-section__add-actions">
            <HkButton
              size="sm"
              disabled={!nameInput.value.trim() || adding.value}
              onClick={() => void addMarker()}
            >
              {t("settings.markersAdd")}
            </HkButton>
          </div>
        </>
      );
    }

    /** The 从海猴雷达导入 face: scan/browse → the parsed list, category
     *  switches (Positive always disabled) and the scrollable preview. */
    function renderImportTab(): VNode {
      const preview = importPreview.value;
      return (
        <div class="markers-section__wizard">
          <p class="markers-section__wizard-intro">{t("settings.markersImportIntro")}</p>
          {importState.value === "scanning" ? (
            <p class="markers-section__wizard-status">{t("settings.markersImportScanning")}</p>
          ) : null}
          {importState.value === "notfound" ? (
            <div class="markers-section__wizard-notfound">
              <p class="markers-section__wizard-status">{t("settings.markersImportNotFound")}</p>
              <HkButton
                class="markers-section__wizard-browse"
                size="sm"
                onClick={() => void browseImport()}
              >
                {t("settings.markersImportBrowse")}
              </HkButton>
            </div>
          ) : null}
          {importError.value ? (
            <p class="markers-section__wizard-error">
              {t("settings.markersImportReadError")}: {importError.value}
            </p>
          ) : null}
          {importList.value ? (
            <>
              <p class="markers-section__wizard-path" data-hint={importList.value.path}>
                {t("settings.markersImportFoundAt", { path: importList.value.path })}
              </p>
              <div class="markers-section__wizard-cats">
                <span class="markers-section__wizard-cats-title">
                  {t("settings.markersImportStatusTitle")}
                </span>
                <div class="markers-section__wizard-cat">
                  <span class="markers-section__dot markers-section__dot--red" />
                  <span class="markers-section__wizard-cat-name">
                    {t("settings.markersImportStatusNegtive")}
                  </span>
                  <HkSwitch
                    size="sm"
                    color="danger"
                    modelValue={importNegtive.value}
                    onUpdate:modelValue={(v: boolean) => (importNegtive.value = v)}
                  />
                </div>
                <div class="markers-section__wizard-cat">
                  <span class="markers-section__dot markers-section__dot--yellow" />
                  <span class="markers-section__wizard-cat-name">
                    {t("settings.markersImportStatusCheater")}
                  </span>
                  <HkSwitch
                    size="sm"
                    color="warning"
                    modelValue={importCheater.value}
                    onUpdate:modelValue={(v: boolean) => (importCheater.value = v)}
                  />
                </div>
                {/* Positive: WoWSP has no positive mark — the row shows
                 *  why and never switches on. */}
                <div class="markers-section__wizard-cat markers-section__wizard-cat--disabled">
                  <span class="markers-section__dot markers-section__dot--off" />
                  <span class="markers-section__wizard-cat-name">
                    {t("settings.markersImportStatusPositive")}
                  </span>
                  <span
                    class="markers-section__wizard-cat-hint"
                    data-hint={t("settings.markersImportPositiveHint")}
                  >
                    {t("settings.markersImportPositiveHint")}
                  </span>
                  <HkSwitch size="sm" disabled modelValue={false} onUpdate:modelValue={() => {}} />
                </div>
              </div>
              {preview && preview.rows.length > 0 ? (
                <>
                  <p class="markers-section__wizard-preview-title">
                    {t("settings.markersImportPreviewTitle", { n: preview.counts.total })}
                  </p>
                  <HkScrollContainer class="markers-section__wizard-list">
                    <div class="markers-section__wizard-list-inner">
                      {preview.rows.map((row) => (
                        <div
                          class="markers-section__wizard-row"
                          key={`${row.server}:${row.nickname}`}
                        >
                          <span class="markers-section__wizard-row-server">{row.server}</span>
                          <span
                            class={["markers-section__wizard-row-name", markerTintClass(row.color)]}
                          >
                            {row.nickname}
                          </span>
                          {row.exists ? (
                            <span class="markers-section__wizard-row-badge">
                              {t("settings.markersImportExists")}
                            </span>
                          ) : null}
                          <span class="markers-section__wizard-row-status">
                            {row.color === "red"
                              ? t("settings.markersImportStatusNegtive")
                              : t("settings.markersImportStatusCheater")}
                          </span>
                        </div>
                      ))}
                    </div>
                  </HkScrollContainer>
                </>
              ) : (
                <p class="markers-section__wizard-empty">{t("settings.markersImportEmpty")}</p>
              )}
              <div class="markers-section__add-actions">
                <HkButton
                  size="sm"
                  loading={importing.value}
                  disabled={!preview || preview.rows.length === 0 || importing.value}
                  onClick={() => void runImport()}
                >
                  {t("settings.markersImportBtn")}
                </HkButton>
              </div>
            </>
          ) : null}
        </div>
      );
    }

    return () => (
      <HkSettingsGroup title={t("settings.markersTitle")}>
        <HkSettingsHint>{t("settings.markersHint")}</HkSettingsHint>
        <div class="markers-section__toolbar">
          {/* Search collapses to an icon; the field lives in the popover. */}
          <button
            type="button"
            ref={searchBtn}
            class={[
              "markers-section__icon-btn",
              searchOpen.value || search.value.trim() ? "markers-section__icon-btn--on" : "",
            ]}
            aria-label={t("settings.markersSearchPlaceholder")}
            data-hint={t("settings.markersSearchPlaceholder")}
            onClick={() => {
              filterOpen.value = false;
              searchOpen.value = !searchOpen.value;
            }}
          >
            <Search size={14} />
          </button>
          <HkPopover
            modelValue={searchOpen.value}
            onUpdate:modelValue={(v: boolean) => {
              if (!v) searchOpen.value = false;
            }}
            anchorRef={searchBtn.value}
            placement="bottom-end"
            padding="lg"
            title={t("settings.markersSearchPlaceholder")}
          >
            <div class="markers-section__pop">
              <HkInput
                modelValue={search.value}
                onUpdate:modelValue={(v: string) => (search.value = v)}
                placeholder={t("settings.markersSearchPlaceholder")}
              />
            </div>
          </HkPopover>
          {/* Filter collapses to the funnel; the popover hosts the
              multi-select color pills (全部玩家 + the three marks). */}
          <FilterCategoryChip
            title={t("settings.markersFilterTitle")}
            allLabel={t("settings.markersFilterAll")}
            options={colorOptions.value}
            selected={filterColors.value}
            open={filterOpen.value}
            onUpdate:open={(v: boolean) => {
              if (v) searchOpen.value = false;
              filterOpen.value = v;
            }}
            onToggle={(value: string) => toggleColor(value)}
            onAll={() => resetColors()}
            icon={<Filter size={14} />}
            hint={t("settings.markersFilterHint")}
            engaged={filterColors.value.size > 0}
          />
          <span class="markers-section__muted">{countText.value}</span>
          <HkIconButton
            class="markers-section__add-btn"
            variant="ghost"
            aria-label={t("settings.markersAddTitle")}
            data-hint={t("settings.markersAddTitle")}
            onClick={openAdd}
          >
            <Plus size={15} />
          </HkIconButton>
        </div>
        <HkScrollContainer class="markers-section__list">
          <div class="markers-section__list-inner">
            {rows.value.length === 0 ? (
              <p class="markers-section__muted">{t("settings.markersEmpty")}</p>
            ) : (
              rows.value.map((entry) => (
                <div
                  class="markers-section__entry"
                  key={entry.nickname}
                  data-player-name={entry.nickname}
                  data-player-account={
                    entry.accountId != null ? String(entry.accountId) : undefined
                  }
                >
                  <span
                    class={["markers-section__dot", `markers-section__dot--${entry.color}`]}
                    data-hint={colorLabel(entry.color)}
                  />
                  <span
                    class={["markers-section__entry-name", markerTintClass(entry.color)]}
                    data-hint={
                      entry.source === "cloud"
                        ? cloudHintFor(entry)
                        : markerColorLabel(entry.color)
                    }
                  >
                    {entry.nickname}
                  </span>
                  {entry.source === "cloud" ? (
                    <span
                      class="markers-section__cloud-badge"
                      data-hint={t("settings.markersCloudTooltip")}
                    >
                      <Cloud size={11} />
                      {t("settings.markersCloudBadge")}
                    </span>
                  ) : entry.note ? (
                    <span class="markers-section__entry-note">{entry.note}</span>
                  ) : null}
                  <span class="markers-section__entry-id">
                    {entry.accountId ?? ""}
                  </span>
                  <span class="markers-section__stats">{statCells(entry)}</span>
                  {entry.source === "cloud" ? (
                    <HkIconButton
                      class="markers-section__remove-btn"
                      variant="ghost"
                      aria-label={t("settings.markersCloudDismiss")}
                      data-hint={t("settings.markersCloudDismiss")}
                      onClick={() => void dismissCloudEntry(entry)}
                    >
                      <X size={14} />
                    </HkIconButton>
                  ) : (
                    <HkIconButton
                      class="markers-section__remove-btn"
                      variant="ghost"
                      aria-label={t("settings.markersRemove")}
                      data-hint={t("settings.markersRemove")}
                      onClick={() => void removeEntry(entry)}
                    >
                      <X size={14} />
                    </HkIconButton>
                  )}
                </div>
              ))
            )}
          </div>
        </HkScrollContainer>
        <div class="markers-section__cloud-row">
          <HkSwitch
            size="sm"
            color="warning"
            modelValue={cloudEnabled.value ?? false}
            disabled={cloudEnabled.value == null}
            onUpdate:modelValue={(v: boolean) => {
              if (cloudEnabled.value != null) void setCloudEnabled(v);
            }}
          />
          <span class="markers-section__cloud-label">
            {t("settings.markersCloudToggle")}
          </span>
          <span
            class="markers-section__cloud-hint"
            data-hint={t("settings.markersCloudHint")}
          >
            {t("settings.markersCloudHintShort")}
          </span>
        </div>
        <HkModal
          modelValue={addOpen.value}
          onUpdate:modelValue={(v: boolean) => (addOpen.value = v)}
          title={t("settings.markersAddTitle")}
          width="30rem"
        >
          <div class="markers-section__add">
            {/* Desktop: the two faces behind a segmented tab strip; the
             *  phone hides the strip and keeps the search face alone. */}
            {mobileApp ? null : (
              <HkTabs
                block
                variant="segmented"
                modelValue={addTab.value}
                onUpdate:modelValue={(v: string) => (addTab.value = v as "search" | "import")}
                tabs={addTabs()}
              />
            )}
            {addTab.value === "import" && !mobileApp ? renderImportTab() : renderSearchTab()}
          </div>
        </HkModal>
      </HkSettingsGroup>
    );
  },
});
