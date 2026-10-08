import {
  computed,
  defineComponent,
  onBeforeUnmount,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from "vue";
import {
  HkButton,
  HkConfirmDialog,
  HkIconButton,
  HkPopover,
  HkTabs,
  useBreakpoint,
  useToast,
} from "@celestia-island/hikari";
import { Check, ChevronDown, FolderOpen, FolderPlus, RefreshCw, X } from "@lucide/vue";

import PlaytimeBreakdownPie from "@/components/playtime/PlaytimeBreakdownPie";
import PlaytimeTrendChart from "@/components/playtime/PlaytimeTrendChart";
import PlaytimeHeatmap from "@/components/playtime/PlaytimeHeatmap";
import {
  bucketDaily,
  fmtDuration,
  parseDayKey,
  type TrendRange,
} from "@/components/playtime/playtimeAgg";
import {
  battlesDaily,
  breakdownByMode,
  breakdownByNation,
  breakdownByTier,
  breakdownByType,
  BREAKDOWN_UNKNOWN_COLOR,
  breakdownColor,
  distinctShipCount,
  filterBattlesByScope,
  SCOPE_ALL,
  type BattleScope,
} from "@/components/playtime/battleBreakdown";
import { api, type PlaytimeOverview } from "@/api";
import { usePlaytimeStore } from "@/stores/playtime";
import { shipTypeChartColor, shipTypeCssColor } from "@/theme/shipTypeColors";
import { useConfigStore } from "@/stores/config";
import { clientMenuOptions } from "@/utils/installLabel";
import { sameGamePath } from "@/utils/gamePath";
import { useLanguage } from "@/i18n/useLanguage";
import { t } from "@/i18n";
import "./PlaytimeView.scss";

/** The cards strip's zero-valued stand-in for a battles-only veteran — a
 *  player whose replays exist but whose ledger overview holds nothing (game
 *  never tracked locally). The time cards then read 0 / — while the battles
 *  card counts real replay rows. */
const ZERO_OVERVIEW: PlaytimeOverview = {
  source: "local",
  importedTotalSeconds: 0,
  importedAt: null,
  localTotalSeconds: 0,
  totalSeconds: 0,
  launchCount: 0,
  daysPlayed: 0,
  firstTrackedDay: null,
  longestStreakDays: 0,
  longestStreakStart: null,
  longestStreakEnd: null,
  longestSessionSeconds: 0,
  longestSessionDate: null,
  longestDaySeconds: 0,
  longestDayDate: null,
  lastLaunch: null,
  daily: [],
};

/**
 * 游玩时间 — WoWSP's own playtime statistics (the water-meter page's
 * sibling view, switched from the title-bar center group). Layout mirrors
 * the reference sheet: a six-card record strip (career total, battle
 * count, longest streak / session / day, last launch — always one row),
 * the battle breakdown donuts (ship type / nation / tier / mode over the
 * replay-derived rows, four blocks on one row in the water-meter charts'
 * style), then the trend bars over 15 days / 12 weeks / 12 months, then
 * the GitHub-style battle heatmap — battles per local day from the same
 * replay rows, NOT the time ledger's `daily` (the tracker only records
 * client-run seconds, so a battle history spanning many untracked days
 * would collapse to one cell). The grid spans every week back to the
 * earliest replay (capped at three years), so a veteran's history predating
 * the last 52 weeks still lights up instead of falling off the window.
 *
 * Data comes from the Rust-side ledger (commands/playtime.rs) via the
 * playtime store: the tracker observes the game client in the background,
 * so this view only reads — on mount, then on a slow poll while mounted.
 * A Steam-imported career total is footnoted, never charted (it is
 * undated). The battle rows are scanned from every detected install's
 * replays folder; a top-right scope menu narrows the battle-derived content
 * (the battles card + the breakdown + the battle heatmap) to ONE of those
 * clients — it lists the whole detected install list, not just the active
 * one, so a client that is not currently selected app-wide is still one
 * pick away. The time ledger itself is client-agnostic and always global.
 */
export default defineComponent({
  name: "PlaytimeView",
  setup() {
    const store = usePlaytimeStore();
    const config = useConfigStore();
    const { uiLocale } = useLanguage();
    const { isMobile } = useBreakpoint();
    const range = ref<TrendRange>("15d");
    // The clock the charts bucket against — refreshed alongside each
    // overview fetch so "today" moves with the data.
    const now = ref(new Date());
    watch(
      () => store.overview,
      () => {
        now.value = new Date();
      },
    );

    onMounted(() => store.start());
    onUnmounted(() => store.stop());

    const rangeOptions = [
      { key: "15d", label: t("playtime.range15d") },
      { key: "12w", label: t("playtime.range12w") },
      { key: "12m", label: t("playtime.range12m") },
    ];

    const overview = computed(() => store.overview);
    const daily = computed(() => overview.value?.daily ?? []);
    const buckets = computed(() =>
      bucketDaily(daily.value, range.value, now.value, uiLocale.value),
    );
    const rangeTotal = computed(() =>
      buckets.value.reduce((acc, b) => acc + b.seconds, 0),
    );

    // ── Replay-derived battles (scope-aware) ───────────────────────────
    // Not persisted — every mount starts global. The scope is one install's
    // root path or SCOPE_ALL; it does NOT ride the app-wide active install
    // (that pick belongs to the settings/sidebar surface) — this menu is
    // how a client that is not active gets inspected.
    const scope = ref<BattleScope>(SCOPE_ALL);
    // Rows of installs the user removed from the settings list leave with
    // their list row: the scan is Rust-side and keeps finding the folder, so
    // the ignore is applied here — an unpickable client must not show data
    // the client menu cannot scope.
    const allBattles = computed(() =>
      (store.battles?.battles ?? []).filter((b) => !config.isIgnoredPath(b.installPath)),
    );
    const totalBattles = computed(() => allBattles.value.length);
    const scopedBattles = computed(() =>
      filterBattlesByScope(allBattles.value, scope.value),
    );
    /** The heatmap's points: battles per local day over the scoped rows.
     *  The time ledger's `daily` would under-draw battle history (it only
     *  covers days the tracker saw a client running). */
    const battleHeat = computed(() => battlesDaily(scopedBattles.value));

    const hasAnyData = computed(() => {
      const o = overview.value;
      return (
        (!!o && (o.localTotalSeconds > 0 || o.importedTotalSeconds > 0)) ||
        totalBattles.value > 0
      );
    });
    const importNote = computed(() => {
      const o = overview.value;
      if (!o || o.source !== "steam" || o.importedTotalSeconds <= 0) return null;
      return t("playtime.importNote", {
        hours: (o.importedTotalSeconds / 3600).toFixed(1),
        date: fmtStamp(o.importedAt ?? 0, true),
      });
    });

    function fmtDay(key: string | null): string {
      if (!key) return "—";
      const d = parseDayKey(key);
      return d ? d.toLocaleDateString(uiLocale.value) : key;
    }

    /** Compact month/day for the streak card's range — a full
     *  `2026/8/26 ~ 2026/10/4` does not fit a record card without
     *  ellipsizing. */
    function fmtDayShort(key: string | null): string {
      if (!key) return "—";
      const d = parseDayKey(key);
      return d ? `${d.getMonth() + 1}/${d.getDate()}` : key;
    }

    /** `YYYY-MM-DD HH:mm` for launch stamps; date-only when `dateOnly`. */
    function fmtStamp(unixSec: number, dateOnly = false): string {
      const d = new Date(unixSec * 1000);
      const p = (n: number) => String(n).padStart(2, "0");
      const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      return dateOnly ? day : `${day} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    // ── Scope menu (battle-derived content only — see module docs) ─────
    const scopeOpen = ref(false);
    const scopeBtn = ref<HTMLButtonElement | null>(null);
    const scopePanel = ref<HTMLElement | null>(null);

    function closeScope() {
      scopeOpen.value = false;
    }

    // ── Replay-sources manager (录像来源) ───────────────────────────────
    // Extra replay folders the user pins into the scan; persisted by the
    // typed backend commands and merged into the very same roots the
    // clients' own replays folders come from.
    const sourcesOpen = ref(false);
    const sourcesBtn = ref<HTMLButtonElement | null>(null);
    const sourcesPanel = ref<HTMLElement | null>(null);
    const addingSource = ref(false);
    const rebuilding = ref(false);
    const rebuildArmed = ref(false);
    const toast = useToast();

    function closeSources() {
      sourcesOpen.value = false;
    }

    function toastError(e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    }

    // One shared outside-close for both menus: a click inside a menu's own
    // trigger/panel is that menu's business; anything else closes whichever
    // of the two is open. (Same contract the scope menu had alone.)
    function onDocPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      const inScope = scopeBtn.value?.contains(target) || scopePanel.value?.contains(target);
      const inSources =
        sourcesBtn.value?.contains(target) || sourcesPanel.value?.contains(target);
      if (!inScope) closeScope();
      if (!inSources) closeSources();
    }

    // The outside-close listener lives exactly while a menu is open
    // (FilterCategoryChip's pattern); Escape close is HkPopover's own.
    watch([scopeOpen, sourcesOpen], ([a, b]) => {
      if (a || b) {
        document.addEventListener("pointerdown", onDocPointerDown, true);
      } else {
        document.removeEventListener("pointerdown", onDocPointerDown, true);
      }
    });
    onBeforeUnmount(() => {
      document.removeEventListener("pointerdown", onDocPointerDown, true);
    });

    /** Pin a freshly picked replay folder and rescan right away — a new
     *  source's battles reach the cards/heatmap immediately, not at the
     *  next game session. Null pick (cancel) is not an error. */
    async function onAddSource() {
      if (addingSource.value) return;
      addingSource.value = true;
      try {
        const picked = await api.pickReplayDir();
        if (picked) {
          await config.addReplayDir(picked);
          await store.refreshAll();
        }
      } catch (e) {
        toastError(e);
      } finally {
        addingSource.value = false;
      }
    }

    async function onRemoveSource(path: string) {
      try {
        await config.removeReplayDir(path);
        await store.refreshAll();
      } catch (e) {
        toastError(e);
      }
    }

    /** Rebuild the ledger from disk (confirm-dialog armed): drops the
     *  backend's parse + history cache, so battles whose replays are
     *  already gone leave with it. The full re-parse can run for seconds —
     *  the button stays disabled (and spins) until the fresh rows land. */
    async function onRebuild() {
      rebuildArmed.value = false;
      rebuilding.value = true;
      try {
        await store.resetBattles();
      } catch (e) {
        toastError(e);
      } finally {
        rebuilding.value = false;
      }
    }

    // Losing the picked install (row removed in settings) must not leave
    // the menu wearing a label whose rows filterBattlesByScope no longer
    // answers — fall back to the all-clients scope it already widened to.
    // A pinned replay folder leaving the sources list takes its scope
    // option with it the same way.
    watch(
      [() => config.installs, () => config.replayDirs],
      ([installs, replayDirs]) => {
        if (!scope.value) return;
        const stillThere =
          installs.some((i) => sameGamePath(i.path, scope.value)) ||
          replayDirs.some((d) => sameGamePath(d, scope.value));
        if (!stillThere) scope.value = SCOPE_ALL;
      },
    );

    /** Scope options: one per DETECTED client — the whole recognized
     *  install list, not just the active one, so any client's battles are
     *  reachable without switching the app-wide active install first; the
     *  label is the install's own name ("Steam · ASIA", "国服 · CN"), which
     *  is what the client row in the sidebar footer shows too. Then one
     *  option per pinned replay folder, labeled by the folder's own
     *  name — its rows carry the folder path as their install identity,
     *  which is exactly the key this menu matches on. Folders sharing a
     *  leaf name disambiguate with their parent segment. */
    const scopeOptions = computed(() => [
      { key: SCOPE_ALL, label: t("playtime.scopeAll") },
      ...clientMenuOptions(config.installs).map((o) => ({ key: o.value, label: o.label })),
      ...disambiguatedDirNames(config.replayDirs).map((d) => ({
        key: d.path,
        label: d.label,
      })),
    ]);

    /** The folders' own names (last path segment, both separators tolerated
     *  — backend paths are Windows-shaped; the browser-dev mock may hand
     *  over forward slashes); a leaf name used by more than one pinned
     *  folder carries its parent segment ("archive · wows录像"). */
    function disambiguatedDirNames(paths: string[]): { path: string; label: string }[] {
      const counts = new Map<string, number>();
      const segments = paths.map((p) => p.split(/[\\/]/).filter(Boolean));
      for (const segs of segments) {
        const leaf = segs[segs.length - 1] ?? "";
        counts.set(leaf, (counts.get(leaf) ?? 0) + 1);
      }
      return paths.map((p, i) => {
        const segs = segments[i];
        const leaf = segs[segs.length - 1] ?? p;
        const dup = (counts.get(leaf) ?? 0) > 1 && segs.length >= 2;
        return { path: p, label: dup ? `${segs[segs.length - 2]} · ${leaf}` : leaf };
      });
    }

    /** Whether a menu option is the picked one. The all-clients sentinel is
     *  compared exactly (an empty scope has no path spelling to normalize);
     *  a client option goes through path identity, so the row the settings
     *  list holds and the row the scan reported count as the same client
     *  even when their spelling differs. */
    function isPickedScope(key: BattleScope): boolean {
      return key === SCOPE_ALL ? scope.value === SCOPE_ALL : sameGamePath(scope.value, key);
    }

    const scopeLabel = computed(
      () =>
        scopeOptions.value.find((o) => isPickedScope(o.key))?.label ??
        t("playtime.scopeAll"),
    );

    function pickScope(key: BattleScope) {
      scope.value = key;
      closeScope();
    }

    // ── Breakdown groups ────────────────────────────────────────────────
    /** t() returns the key when a message is missing — keep the raw key (or
     *  the caller's fallback) instead of leaking it into the UI. */
    function i18nOr(key: string, fallback: string): string {
      const lbl = t(key);
      return lbl === key ? fallback : lbl;
    }

    function unknownLabel(): string {
      return t("playtime.breakdown.unknown");
    }

    /** Ship-type slice color — the app's canonical WG class palette
     *  (theme/shipTypeColors, the one the lookup donuts and the scheme
     *  editor share), so a user retint reaches this view too. Resolved at
     *  render time: shipTypeChartColor reads the store ref, keeping the
     *  donuts live under dark/light switches and palette edits. */
    function typeColorOf(key: string): string {
      return key === "unknown"
        ? BREAKDOWN_UNKNOWN_COLOR
        : shipTypeCssColor(shipTypeChartColor(key));
    }

    /** Ship type — the dashboard's existing localized type map. */
    function typeLabel(key: string): string {
      return key === "unknown" ? unknownLabel() : i18nOr(`dashboard.shipType.${key}`, key);
    }

    /** Nation — the ships feature's existing localized nation map. */
    function nationLabel(key: string): string {
      return key === "unknown" ? unknownLabel() : i18nOr(`ships.nation.${key}`, key);
    }

    /** Tier — "T1".."T11", locale-agnostic. */
    function tierLabel(key: string): string {
      return key === "unknown" ? unknownLabel() : `T${key}`;
    }

    /** Battle mode — the replay list's existing mode labels (generic battle
     *  label when the key has no entry, mirroring modeLabelOfKey). */
    function modeLabel(key: string): string {
      return key === "unknown"
        ? unknownLabel()
        : i18nOr(`replay.mode.${key}`, t("replay.mode._fallback"));
    }

    const breakdownGroups = computed(
      () =>
        scopedBattles.value.length === 0
          ? []
          : [
              {
                title: t("playtime.breakdown.byType"),
                entries: breakdownByType(scopedBattles.value),
                labelOf: typeLabel,
                colorOf: typeColorOf,
              },
              {
                title: t("playtime.breakdown.byNation"),
                entries: breakdownByNation(scopedBattles.value),
                labelOf: nationLabel,
                colorOf: (key: string) => breakdownColor("nation", key),
              },
              {
                title: t("playtime.breakdown.byTier"),
                entries: breakdownByTier(scopedBattles.value),
                labelOf: tierLabel,
                colorOf: (key: string) => breakdownColor("tier", key),
              },
              {
                title: t("playtime.breakdown.byMode"),
                entries: breakdownByMode(scopedBattles.value),
                labelOf: modeLabel,
                colorOf: (key: string) => breakdownColor("mode", key),
              },
            ],
    );

    /** Heatmap hover hint — the day's battle count. */
    function heatHint(n: number): string {
      return t("playtime.heatDay", { n });
    }

    const cards = computed(() => {
      const o = overview.value ?? (totalBattles.value > 0 ? ZERO_OVERVIEW : null);
      if (!o) return [];
      return [
        {
          label: t("playtime.cards.total"),
          value: fmtDuration(o.totalSeconds),
          sub: t("playtime.cards.launched", { n: o.launchCount }),
          running: false,
        },
        {
          label: t("playtime.cards.battles"),
          value: String(scopedBattles.value.length),
          sub: t("playtime.cards.battlesShips", {
            n: distinctShipCount(scopedBattles.value),
          }),
          running: false,
        },
        {
          label: t("playtime.cards.streak"),
          value: t("playtime.cards.days", { n: o.longestStreakDays }),
          sub:
            o.longestStreakStart && o.longestStreakEnd
              ? `${fmtDayShort(o.longestStreakStart)} ~ ${fmtDayShort(o.longestStreakEnd)}`
              : "—",
          running: false,
        },
        {
          label: t("playtime.cards.longestSession"),
          value: fmtDuration(o.longestSessionSeconds),
          sub: fmtDay(o.longestSessionDate),
          running: false,
        },
        {
          label: t("playtime.cards.longestDay"),
          value: fmtDuration(o.longestDaySeconds),
          sub: fmtDay(o.longestDayDate),
          running: false,
        },
        {
          label: t("playtime.cards.lastLaunch"),
          value: o.lastLaunch ? fmtDuration(o.lastLaunch.durationSeconds) : "—",
          sub: o.lastLaunch ? fmtStamp(o.lastLaunch.start) : "—",
          running: o.lastLaunch?.running ?? false,
        },
      ];
    });

    return () => (
      <div class="playtime-view">
        <div class="playtime-view__content">
          {/* ── Toolbar — ALWAYS rendered, empty state included: a fresh
              install's first playtime data can come from a pinned replay
              archive, and "rescan now" must never depend on data existing.
              The scope pill narrows ONLY the battle-derived content
              (battles card + breakdown + battle heatmap) — the ledger
              itself is global. */}
          <div class="playtime-view__toolbar">
            <button
              type="button"
              ref={scopeBtn}
              class="playtime-view__scope"
              aria-haspopup="menu"
              aria-expanded={scopeOpen.value}
              onClick={() => (scopeOpen.value = !scopeOpen.value)}
            >
              <span class="playtime-view__scope-label">{scopeLabel.value}</span>
              <ChevronDown
                size={13}
                class="playtime-view__scope-chevron"
                data-open={scopeOpen.value || undefined}
              />
            </button>
            {/* Desktop keeps closeOnBackdrop off: HkPopover's own
                document listener would close on the re-click of the
                open button before that click re-toggles it; the
                pointerdown listener above is the outside-close and
                Escape rides closeOnEscape. Phones dock the menu as a
                bottom sheet (sheetOnMobile, same convention as the
                filter chips). Both menus below share that contract. */}
            <HkPopover
              modelValue={scopeOpen.value}
              onUpdate:modelValue={(v: boolean) => {
                if (!v) closeScope();
              }}
              anchorRef={scopeBtn.value}
              placement="bottom-end"
              closeOnBackdrop={isMobile.value}
              sheetOnMobile
              title={t("playtime.battlesTitle")}
            >
              <div ref={scopePanel} class="playtime-view__scope-menu" role="menu">
                {scopeOptions.value.map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    role="menuitem"
                    class="playtime-view__scope-opt"
                    data-active={isPickedScope(o.key) || undefined}
                    onClick={() => pickScope(o.key)}
                  >
                    <span class="playtime-view__scope-opt-label">{o.label}</span>
                    {isPickedScope(o.key) ? (
                      <Check size={13} class="playtime-view__scope-opt-check" />
                    ) : null}
                  </button>
                ))}
                {/* No detected install = nothing but the all-clients
                    option to pick; the hint points at where clients are
                    chosen (same wording the old single-option menu
                    used). */}
                {config.installs.length === 0 ? (
                  <div class="playtime-view__scope-hint">
                    {t("playtime.scopeUnavailable")}
                  </div>
                ) : null}
              </div>
            </HkPopover>
            {/* ── Replay sources (录像来源): pins extra replay folders into
                the same scan that feeds the battles card + heatmap + replay
                rail. Removal keeps already-counted battles (history); the
                rebuild action at the bottom drops that history on purpose
                and requires the confirm dialog. */}
            <button
              type="button"
              ref={sourcesBtn}
              class="playtime-view__scope"
              aria-haspopup="menu"
              aria-expanded={sourcesOpen.value}
              onClick={() => (sourcesOpen.value = !sourcesOpen.value)}
            >
              <FolderOpen size={13} class="playtime-view__scope-lead" />
              <span class="playtime-view__scope-label">{t("playtime.sourcesTitle")}</span>
              <ChevronDown
                size={13}
                class="playtime-view__scope-chevron"
                data-open={sourcesOpen.value || undefined}
              />
            </button>
            <HkPopover
              modelValue={sourcesOpen.value}
              onUpdate:modelValue={(v: boolean) => {
                if (!v) closeSources();
              }}
              anchorRef={sourcesBtn.value}
              placement="bottom-end"
              closeOnBackdrop={isMobile.value}
              sheetOnMobile
              title={t("playtime.sourcesTitle")}
            >
              <div ref={sourcesPanel} class="playtime-view__sources-menu">
                {config.replayDirs.length === 0 ? (
                  <div class="playtime-view__sources-empty">
                    {t("playtime.sourcesEmpty")}
                  </div>
                ) : (
                  config.replayDirs.map((d) => (
                    <div key={d} class="playtime-view__sources-row">
                      <span class="playtime-view__sources-path" title={d}>
                        {d}
                      </span>
                      <button
                        type="button"
                        class="playtime-view__sources-remove"
                        aria-label={t("playtime.sourcesRemove", { path: d })}
                        onClick={() => void onRemoveSource(d)}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))
                )}
                {/* Phones have no native folder picker (rfd has no Android
                    backend) — the add row is desktop-only; pinned folders
                    still list and remove everywhere. */}
                {!isMobile.value ? (
                  <HkButton
                    size="sm"
                    variant="ghost"
                    disabled={addingSource.value}
                    loading={addingSource.value}
                    onClick={() => void onAddSource()}
                  >
                    <FolderPlus size={14} />
                    <span>{t("playtime.sourcesAdd")}</span>
                  </HkButton>
                ) : null}
                <div class="playtime-view__sources-hint">{t("playtime.sourcesHint")}</div>
                <div class="playtime-view__sources-footer">
                  <button
                    type="button"
                    class="playtime-view__sources-rebuild"
                    disabled={rebuilding.value}
                    onClick={() => (rebuildArmed.value = true)}
                  >
                    <RefreshCw
                      size={12}
                      class={rebuilding.value ? "playtime-view__spin" : undefined}
                    />
                    <span>{t("playtime.rebuild")}</span>
                  </button>
                </div>
              </div>
            </HkPopover>
            {/* Manual rescan: re-pulls overview + battles now. The 30 s poll
                re-pulls battles only around game sessions (activity key),
                so files that changed on disk while idle — a hand-copied
                replay, a pinned folder — otherwise wait for a launch. */}
            <HkIconButton
              size={24}
              variant="ghost"
              disabled={store.refreshing}
              aria-label={t("playtime.refresh")}
              onClick={() => void store.refreshAll()}
            >
              <RefreshCw
                size={15}
                class={store.refreshing ? "playtime-view__spin" : undefined}
              />
            </HkIconButton>
          </div>
          <HkConfirmDialog
            open={rebuildArmed.value}
            title={t("playtime.rebuild")}
            message={t("playtime.rebuildConfirm")}
            confirmLabel={t("playtime.rebuild")}
            onConfirm={() => void onRebuild()}
            onUpdate:open={(v: boolean) => {
              if (!v) rebuildArmed.value = false;
            }}
          />
          {!hasAnyData.value ? (
            <div class="playtime-view__empty">
              <h2 class="playtime-view__title">{t("playtime.emptyTitle")}</h2>
              <p class="playtime-view__hint">{t("playtime.emptyHint")}</p>
            </div>
          ) : (
            <>
              {/* ── Record cards ─────────────────────────────────────── */}
              <div class="playtime-cards">
                {cards.value.map((card) => (
                  <div class="playtime-card" key={card.label}>
                    <span class="playtime-card__label">{card.label}</span>
                    <span class="playtime-card__value">
                      {card.value}
                      {card.running ? (
                        <span
                          class="playtime-card__pulse"
                          title={t("playtime.cards.running")}
                        />
                      ) : null}
                    </span>
                    <span class="playtime-card__sub">{card.sub}</span>
                  </div>
                ))}
              </div>

              {importNote.value ? (
                <p class="playtime-view__note">{importNote.value}</p>
              ) : null}

              {/* ── Battle breakdown (replay-derived, scope-aware) ────── */}
              {store.battles ? (
                <section class="play-section">
                  <div class="play-section__head">
                    <h3>{t("playtime.battlesTitle")}</h3>
                  </div>
                  {scopedBattles.value.length === 0 ? (
                    <p class="playtime-breakdown__empty">
                      {totalBattles.value === 0
                        ? t("playtime.battlesEmpty")
                        : t("playtime.battlesNoneSelected")}
                    </p>
                  ) : (
                    <div class="playtime-breakdown">
                      {breakdownGroups.value.map((g) => (
                        <PlaytimeBreakdownPie
                          key={g.title}
                          title={g.title}
                          entries={g.entries}
                          labelOf={g.labelOf}
                          colorOf={g.colorOf}
                          unitLabel={t("playtime.breakdown.battles")}
                        />
                      ))}
                    </div>
                  )}
                </section>
              ) : null}

              {/* ── Trend bars ───────────────────────────────────────── */}
              <section class="play-section">
                <div class="play-section__head">
                  <h3>{t("playtime.trendTitle")}</h3>
                </div>
                <div class="play-section__controls">
                  <HkTabs
                    variant="segmented"
                    modelValue={range.value}
                    onUpdate:modelValue={(v: string) => (range.value = v as TrendRange)}
                    tabs={rangeOptions.map((o) => ({ key: o.key, label: o.label }))}
                  />
                  <span class="play-section__total">
                    {t("playtime.rangeTotal", { v: fmtDuration(rangeTotal.value) })}
                  </span>
                </div>
                <PlaytimeTrendChart buckets={buckets.value} />
              </section>

              {/* ── Battle heatmap (battles per local day, scope-aware;
                  hidden entirely when no replay was ever scanned) ──────── */}
              {store.battles && totalBattles.value > 0 ? (
                <section class="play-section">
                  <div class="play-section__head">
                    <h3>{t("playtime.heatTitle")}</h3>
                    <div class="play-heat-legend">
                      <span>{t("playtime.heatLess")}</span>
                      {[1, 2, 3, 4].map((level) => (
                        <span key={level} class={`play-heat-legend__swatch is-${level}`} />
                      ))}
                      <span>{t("playtime.heatMore")}</span>
                    </div>
                  </div>
                  <PlaytimeHeatmap
                    points={battleHeat.value}
                    hintOf={heatHint}
                    now={now.value}
                    locale={uiLocale.value}
                  />
                  <p class="playtime-view__note">{t("playtime.heatHint")}</p>
                </section>
              ) : null}
            </>
          )}
        </div>
      </div>
    );
  },
});
