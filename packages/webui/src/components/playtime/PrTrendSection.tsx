import {
  computed,
  defineComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type Ref,
  type VNode,
} from "vue";

import { HkCheckbox, HkDatePicker, HkPopover, HkTabs, useBreakpoint } from "@celestia-island/hikari";

import { api, type ExpectedPrEntry, type ShipStatsHistoryPoint } from "@/api";
import { shipIconUrl } from "@/features/holographic/shipIcons";
import { isoDayWindowSec } from "@/utils/shipAggregation";
import { useAccountStore } from "@/stores/account";
import { useShipStatsStore } from "@/stores/shipStats";
import { statsPrefsState } from "@/stores/statsPrefs";
import { useLanguage } from "@/i18n/useLanguage";
import { t } from "@/i18n";
import PrTrendChart from "./PrTrendChart";
import {
  expectedPrMap,
  filterIntervalsByRange,
  prOfInterval,
  prTrendIntervals,
  prTrendShipCatalog,
  prTrendShipName,
  prTrendTierMatches,
  PR_TREND_TIER_BRACKETS,
  type PrTrendPoint,
  type PrTrendRangeKey,
} from "./prTrend";
import "@/components/ships/ShipFilterBar.scss";
import "./PrTrendSection.scss";

/** Canonical ship-type reading order for the type row's options (BB→CV→CA→
 *  DD→SS, the dashboard filter bar's own order; only types present in the
 *  window get an option). */
const TYPE_ORDER = ["Battleship", "AirCarrier", "Cruiser", "Destroyer", "Submarine"];

/**
 * PR 趋势 — the playtime page's skill-trend section under the battle
 * heatmap: a line of per-interval wows-numbers PR derived entirely from
 * LOCALLY CACHED data (the per-ship history `lookup_player_ship_stats`
 * appends on every stats lookup, plus the 7-day expected-values table).
 * No new upstream traffic happens here beyond the (cached) expected-values
 * fetch — the points accrue as a side effect of normal water-meter use.
 *
 * Controls: a time-range segmented tabs row (7d / 30d / 90d / full career /
 * custom — the custom segment opens the LookupView's date-pair popover
 * pattern) and ONE ship-filter chip. The chip's popup stacks, top to
 * bottom: the water-meter's type and tier button groups (pinned), the
 * range-scoped ship list with per-row checkboxes and battles / winrate /
 * avg-damage columns (scrollable, capped), and a pinned select-all row
 * whose checkbox goes indeterminate on a partial selection. The three
 * constraints AND together; every empty selection means "no constraint".
 * The PR math aggregates any subset the way the account PR does
 * (battle-weighted expected sums — see prTrend.ts).
 *
 * Bound to the ACTIVE account (the same identity the dashboard charts):
 * no active account or PR display disabled → nothing renders at all.
 */
export default defineComponent({
  name: "PrTrendSection",
  setup() {
    const account = useAccountStore();
    const shipStats = useShipStatsStore();
    const { uiLocale } = useLanguage();
    const { isMobile } = useBreakpoint();

    // The expected-values table is account-independent — load once.
    const expected = ref<ExpectedPrEntry[] | null>(null);
    onMounted(async () => {
      try {
        expected.value = await api.getExpectedPrTable();
      } catch {
        expected.value = [];
      }
    });

    // ── Selection state (declared ahead of the account watch: its
    // immediate run and the reset below both touch these). Type / tier /
    // ship AND together; each empty list = that constraint off. ──
    const typeSel = ref<string[]>([]);
    const tierSel = ref<string[]>([]);
    const shipSel = ref<string[]>([]);

    // The two popovers' open flags live above the account watch: its body
    // force-closes them on a switch (the section renders null mid-switch;
    // closed popups cannot leave their outside-close listeners hanging).
    const customOpen = ref(false);
    const shipPopOpen = ref(false);

    const activeAccount = computed(() => account.activeAccount);
    // Whether the (local-file) history read has settled for the CURRENT
    // account — a read that fails or finds no file must fall through to the
    // empty note instead of hiding the whole section forever.
    const historySettled = ref(false);
    watch(
      activeAccount,
      (acc, prev) => {
        historySettled.value = false;
        // A different account's ship ids mean nothing here — stale picks
        // would silently filter the new history down to nothing.
        if (prev) {
          typeSel.value = [];
          tierSel.value = [];
          shipSel.value = [];
          // The section renders null mid-switch; closed popovers cannot
          // leave their outside-close listeners hanging.
          customOpen.value = false;
          shipPopOpen.value = false;
        }
        if (!acc) return;
        const key = `${acc.realm}_${acc.accountId}`;
        void shipStats
          .loadHistory(acc.accountId, acc.realm)
          .catch(() => undefined)
          .finally(() => {
            const now = activeAccount.value;
            if (now && `${now.realm}_${now.accountId}` === key) historySettled.value = true;
          });
      },
      { immediate: true },
    );

    // Per-account history points, read LIVE out of the ship-stats store:
    // the store's `load()` refreshes the history after every water-meter
    // lookup, so PR points land here without a remount.
    const historyPts = computed<ShipStatsHistoryPoint[] | null>(() => {
      const acc = activeAccount.value;
      return acc ? (shipStats.history.get(`${acc.realm}_${acc.accountId}`) ?? null) : null;
    });

    const intervals = computed(() =>
      historyPts.value ? prTrendIntervals(historyPts.value) : [],
    );
    const expectedMap = computed(() =>
      expected.value ? expectedPrMap(expected.value) : null,
    );

    // ── Time range (7d / 30d / 90d / full career / custom) ──────────────
    const rangeKey = ref<PrTrendRangeKey>("30d");
    const customFrom = ref<string | null>(null);
    const customTo = ref<string | null>(null);
    const customWindow = computed(() =>
      customFrom.value && customTo.value
        ? isoDayWindowSec(customFrom.value, customTo.value)
        : null,
    );
    const rangeOptions = [
      { key: "7d", label: t("playtime.prTrendRange7d") },
      { key: "30d", label: t("playtime.prTrendRange30d") },
      { key: "90d", label: t("playtime.prTrendRange90d") },
      { key: "all", label: t("playtime.prTrendRangeAll") },
      { key: "custom", label: t("dashboard.rangeCustom") },
    ];

    // The custom segment's popover — the LookupView pattern: HkTabs
    // suppresses the emit for the already-active segment, so the reopen
    // gesture rides a wrapper click on the checked radio; outside-close
    // lets the pickers' body-level calendar panels through.
    const rangeTabsRef = ref<HTMLElement | null>(null);
    const rangePanelRef = ref<HTMLElement | null>(null);

    function onRangeTabUpdate(v: string | number) {
      rangeKey.value = v as PrTrendRangeKey;
      customOpen.value = v === "custom";
    }

    function onRangeTabsClick(e: MouseEvent) {
      if (rangeKey.value !== "custom") return;
      const seg = (e.target as HTMLElement).closest?.("[role='radio']");
      if (seg instanceof HTMLElement && seg.getAttribute("aria-checked") === "true") {
        customOpen.value = true;
      }
    }

    function onRangeDocPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (rangeTabsRef.value?.contains(target)) return;
      if (rangePanelRef.value?.contains(target)) return;
      for (const panel of document.querySelectorAll<HTMLElement>(".hk-popover-panel")) {
        if (panel.contains(target)) return;
      }
      customOpen.value = false;
    }

    watch(customOpen, (open) => {
      if (open) {
        document.addEventListener("pointerdown", onRangeDocPointerDown, true);
      } else {
        document.removeEventListener("pointerdown", onRangeDocPointerDown, true);
      }
    });
    onBeforeUnmount(() => {
      document.removeEventListener("pointerdown", onRangeDocPointerDown, true);
    });

    // ── The window-scoped data: intervals inside the range drive the line,
    //    the popup catalog AND the PR aggregation alike. ──
    const rangedIntervals = computed(() => {
      const w = customWindow.value;
      return filterIntervalsByRange(
        intervals.value,
        rangeKey.value === "custom"
          ? { key: "custom", fromSec: w?.fromSec ?? null, toSec: w?.toSec ?? null }
          : { key: rangeKey.value },
        Math.floor(Date.now() / 1000),
      );
    });

    // ── Ship-filter popup (one chip; see the module docs) ────────────────
    const shipBtnRef = ref<HTMLButtonElement | null>(null);
    const shipPanelRef = ref<HTMLElement | null>(null);

    function onShipDocPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (shipBtnRef.value?.contains(target)) return;
      if (shipPanelRef.value?.contains(target)) return;
      for (const panel of document.querySelectorAll<HTMLElement>(".hk-popover-panel")) {
        if (panel.contains(target)) return;
      }
      shipPopOpen.value = false;
    }

    watch(shipPopOpen, (open) => {
      if (open) {
        document.addEventListener("pointerdown", onShipDocPointerDown, true);
      } else {
        document.removeEventListener("pointerdown", onShipDocPointerDown, true);
      }
    });
    onBeforeUnmount(() => {
      document.removeEventListener("pointerdown", onShipDocPointerDown, true);
    });

    /** t() returns the key when a message is missing — keep the raw key (or
     *  the caller's fallback) instead of leaking it into the UI (same guard
     *  as PlaytimeView). */
    function i18nOr(key: string, fallback: string): string {
      const lbl = t(key);
      return lbl === key ? fallback : lbl;
    }

    function typeLabel(key: string): string {
      return i18nOr(`dashboard.shipType.${key}`, key);
    }

    const catalog = computed(() => prTrendShipCatalog(rangedIntervals.value));
    const typeOfShip = computed(() => {
      const m = new Map<number, string>();
      for (const s of catalog.value) m.set(s.shipId, s.type);
      return m;
    });
    const tierOfShip = computed(() => {
      const m = new Map<number, number | null>();
      for (const s of catalog.value) m.set(s.shipId, s.tier);
      return m;
    });

    /** The list narrows to the type/tier match; only ships played in the
     *  window (the catalog) ever appear. */
    const listedShips = computed(() =>
      catalog.value.filter(
        (s) =>
          (typeSel.value.length === 0 || typeSel.value.includes(s.type)) &&
          (tierSel.value.length === 0 ||
            tierSel.value.some((b) => prTrendTierMatches(s.tier, b))),
      ),
    );

    const typeOptions = computed(() => {
      const present = new Set(catalog.value.map((s) => s.type));
      return TYPE_ORDER.filter((ty) => present.has(ty)).map((ty) => ({
        value: ty,
        label: typeLabel(ty),
      }));
    });

    function toggle(list: Ref<string[]>, value: string) {
      list.value = list.value.includes(value)
        ? list.value.filter((v) => v !== value)
        : [...list.value, value];
    }

    function toggleShip(shipId: number) {
      const k = String(shipId);
      shipSel.value = shipSel.value.includes(k)
        ? shipSel.value.filter((v) => v !== k)
        : [...shipSel.value, k];
    }

    /** Select-all over the LISTED ships: checked when every listed ship is
     *  picked, indeterminate (hikari's null) on a partial pick, unchecked
     *  when none. Clicking checks all listed / clears the lot (a cleared
     *  lot = the ship constraint off, the chip's 全部 semantics). */
    const allChecked = computed<boolean | null>(() => {
      const rows = listedShips.value;
      const picked = rows.filter((s) => shipSel.value.includes(String(s.shipId)));
      if (picked.length === 0) return false;
      return picked.length === rows.length ? true : null;
    });

    function onAllChecked() {
      if (allChecked.value === true) {
        shipSel.value = [];
      } else {
        shipSel.value = listedShips.value.map((s) => String(s.shipId));
      }
    }

    function include(shipId: number): boolean {
      if (typeSel.value.length > 0) {
        const ty = typeOfShip.value.get(shipId);
        if (!ty || !typeSel.value.includes(ty)) return false;
      }
      if (
        tierSel.value.length > 0 &&
        !tierSel.value.some((b) => prTrendTierMatches(tierOfShip.value.get(shipId) ?? null, b))
      ) {
        return false;
      }
      if (shipSel.value.length > 0 && !shipSel.value.includes(String(shipId))) return false;
      return true;
    }

    const series = computed<PrTrendPoint[]>(() => {
      const table = expectedMap.value;
      if (!table) return [];
      const out: PrTrendPoint[] = [];
      for (const iv of rangedIntervals.value) {
        const p = prOfInterval(iv, table, include);
        if (p) out.push(p);
      }
      return out;
    });

    const totalBattles = computed(() => series.value.reduce((a, p) => a + p.battles, 0));

    /** The chip's label: 全部舰船 while nothing constrains, else the active
     *  constraints in chip order (types · tiers · n ships). */
    const shipChipLabel = computed(() => {
      const parts: string[] = [];
      if (typeSel.value.length > 0) {
        parts.push(typeOptions.value
          .filter((o) => typeSel.value.includes(o.value))
          .map((o) => o.label)
          .join("·"));
      }
      if (tierSel.value.length > 0) {
        parts.push(
          PR_TREND_TIER_BRACKETS
            .filter((b) => tierSel.value.includes(b.key))
            .map((b) => b.label)
            .join("·"),
        );
      }
      if (shipSel.value.length > 0) {
        parts.push(t("playtime.prTrendShipCount", { n: shipSel.value.length }));
      }
      return parts.length > 0
        ? parts.join(" · ")
        : t("playtime.prTrendShipAll");
    });

    /** The white battle-HUD silhouette (right-facing via CSS flip), shared
     *  with the water-meter's type popup. Null-safe: an unknown type never
     *  reaches an option row. */
    function typeIcon(typeKey: string): VNode {
      return (
        <img
          class="ship-filter-bar__type-icon"
          src={shipIconUrl(typeKey, "white") ?? undefined}
          alt=""
          draggable={false}
        />
      );
    }

    /** `M/D` x labels — locale calendar rules without the year (the section
     *  sits under a heatmap that already carries the year context). */
    function fmtTick(ts: number): string {
      const d = new Date(ts * 1000);
      return d.toLocaleDateString(uiLocale.value, { month: "short", day: "numeric" });
    }

    function hintOf(p: PrTrendPoint): string {
      return t("playtime.prTrendPoint", {
        date: new Date(p.t * 1000).toLocaleDateString(uiLocale.value),
        pr: p.pr,
        battles: p.battles,
        wr: p.winrate.toFixed(1),
      });
    }

    return () => {
      // No bound account (or PR display off) → not this section's business.
      const acc = activeAccount.value;
      if (!acc || !statsPrefsState.value.prEnabled) return null;

      // The frame (title + controls) renders as soon as the account is
      // known; the body fills in as the cached reads settle. Gating the
      // WHOLE section on those reads made "still fetching" (the
      // expected-values refresh can take seconds on a cold or stale table)
      // read as "the section does not exist".
      const pts = historyPts.value;
      const historyLoaded = pts !== null || historySettled.value;
      let body: VNode | null = null;
      if (historyLoaded && (pts?.length ?? 0) === 0) {
        // No cached history at all — the point-accrual note is the most
        // actionable face and needs no attempt at the expected table.
        body = <p class="playtime-view__note">{t("playtime.prTrendEmpty")}</p>;
      } else if (expected.value === null || !historyLoaded) {
        body = null; // still reading — the frame is already on screen
      } else if (expected.value.length === 0) {
        body = <p class="playtime-view__note">{t("playtime.prTrendNoExpected")}</p>;
      } else if (rangeKey.value === "custom" && !customWindow.value) {
        // An unfinished custom pick: name the cause instead of pretending
        // the selection has no data.
        body = <p class="playtime-view__note">{t("playtime.prTrendRangeIncomplete")}</p>;
      } else if (series.value.length === 0) {
        body = <p class="playtime-view__note">{t("playtime.prTrendNoData")}</p>;
      } else {
        body = (
          <>
            <PrTrendChart points={series.value} fmtTick={fmtTick} hintOf={hintOf} />
            <p class="playtime-view__note">{t("playtime.prTrendHint")}</p>
          </>
        );
      }

      return (
        <section class="play-section pr-trend-section">
          <div class="play-section__head">
            <h3>{t("playtime.prTrendTitle")}</h3>
            <div class="play-section__controls">
              {/* Time range — the wrapper anchors the custom popover and
                  carries the reopen click test (the LookupView pattern). */}
              <div class="pr-trend-range" ref={rangeTabsRef} onClick={onRangeTabsClick}>
                <HkTabs
                  variant="segmented"
                  modelValue={rangeKey.value}
                  onUpdate:modelValue={onRangeTabUpdate}
                  tabs={rangeOptions.map((o) => ({ key: o.key, label: o.label }))}
                />
              </div>
              <HkPopover
                modelValue={customOpen.value}
                onUpdate:modelValue={(v: boolean) => {
                  if (!v) customOpen.value = false;
                }}
                anchorRef={rangeTabsRef.value}
                placement="bottom-end"
                closeOnBackdrop={isMobile.value}
                sheetOnMobile
                title={t("dashboard.rangeCustom")}
              >
                <div ref={rangePanelRef} class="pr-trend-rangepop">
                  <div class="pr-trend-rangepop__head">
                    <span>{t("dashboard.rangeCustom")}</span>
                  </div>
                  <div class="pr-trend-rangepop__dates">
                    <HkDatePicker
                      size="sm"
                      modelValue={customFrom.value}
                      onUpdate:modelValue={(v: string | null) => (customFrom.value = v)}
                      placeholder={t("dashboard.rangeFrom")}
                      max={customTo.value ?? undefined}
                    />
                    <HkDatePicker
                      size="sm"
                      modelValue={customTo.value}
                      onUpdate:modelValue={(v: string | null) => (customTo.value = v)}
                      placeholder={t("dashboard.rangeTo")}
                      min={customFrom.value ?? undefined}
                    />
                  </div>
                  <div class="pr-trend-rangepop__hint">{t("playtime.prTrendRangeHint")}</div>
                </div>
              </HkPopover>
              {/* The ONE ship-filter chip (types + tiers + ship list). */}
              <button
                type="button"
                ref={shipBtnRef}
                class={[
                  "ship-filter-bar__chip",
                  typeSel.value.length + tierSel.value.length + shipSel.value.length > 0
                    ? "ship-filter-bar__chip--on"
                    : "ship-filter-bar__chip--all",
                ]}
                aria-haspopup="menu"
                aria-expanded={shipPopOpen.value}
                onClick={() => (shipPopOpen.value = !shipPopOpen.value)}
              >
                <span>{shipChipLabel.value}</span>
              </button>
              <HkPopover
                modelValue={shipPopOpen.value}
                onUpdate:modelValue={(v: boolean) => {
                  if (!v) shipPopOpen.value = false;
                }}
                anchorRef={shipBtnRef.value}
                placement="bottom-end"
                closeOnBackdrop={isMobile.value}
                sheetOnMobile
                title={t("playtime.prTrendShipFilterTitle")}
              >
                <div ref={shipPanelRef} class="ship-filter-bar__pop pr-trend-pop">
                  <div class="ship-filter-bar__pop-head">
                    <span>{t("playtime.prTrendShipFilterTitle")}</span>
                  </div>
                  {/* The two water-meter button groups — pinned above the
                      scrolling list (the panel is a flex column; only the
                      list scrolls). */}
                  <div class="pr-trend-pop__groups">
                    <div class="ship-filter-bar__opts">
                      <button
                        type="button"
                        class="ship-filter-bar__opt"
                        data-active={typeSel.value.length === 0 || undefined}
                        onClick={() => (typeSel.value = [])}
                      >
                        <span>{t("ships.filter.typeAll")}</span>
                      </button>
                      {typeOptions.value.map((o) => (
                        <button
                          key={o.value}
                          type="button"
                          class="ship-filter-bar__opt"
                          data-active={typeSel.value.includes(o.value) || undefined}
                          onClick={() => toggle(typeSel, o.value)}
                        >
                          {typeIcon(o.value)}
                          <span>{o.label}</span>
                        </button>
                      ))}
                    </div>
                    <div class="ship-filter-bar__opts">
                      <button
                        type="button"
                        class="ship-filter-bar__opt"
                        data-active={tierSel.value.length === 0 || undefined}
                        onClick={() => (tierSel.value = [])}
                      >
                        <span>{t("ships.filter.tierAll")}</span>
                      </button>
                      {PR_TREND_TIER_BRACKETS.map((b) => (
                        <button
                          key={b.key}
                          type="button"
                          class="ship-filter-bar__opt"
                          data-active={tierSel.value.includes(b.key) || undefined}
                          onClick={() => toggle(tierSel, b.key)}
                        >
                          <span>{b.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* The scrollable checkbox list (max-height in SCSS) —
                      rows show the range-scoped battles / winrate / average
                      damage on the right. */}
                  <div class="pr-trend-pop__cols" aria-hidden="true">
                    <span />
                    <span>{t("playtime.prTrendColShip")}</span>
                    <span>{t("playtime.prTrendColBattles")}</span>
                    <span>{t("playtime.prTrendColWr")}</span>
                    <span>{t("playtime.prTrendColAvg")}</span>
                  </div>
                  <div class="pr-trend-pop__list" role="listbox" aria-multiselectable="true">
                    {listedShips.value.length === 0 ? (
                      <p class="pr-trend-pop__empty">
                        {rangeKey.value === "custom" && !customWindow.value
                          ? t("playtime.prTrendRangeIncomplete")
                          : t("playtime.prTrendNoData")}
                      </p>
                    ) : (
                      listedShips.value.map((s) => {
                        const checked = shipSel.value.includes(String(s.shipId));
                        return (
                          <div
                            key={s.shipId}
                            class="pr-trend-pop__row"
                            role="option"
                            aria-selected={checked}
                            onClick={(e) => {
                              // The checkbox toggles via its own emit; the
                              // row handler skips it (ShipPickerModal's
                              // split).
                              if ((e.target as HTMLElement).closest(".hk-checkbox")) return;
                              toggleShip(s.shipId);
                            }}
                          >
                            <HkCheckbox
                              size="sm"
                              modelValue={checked}
                              onUpdate:modelValue={() => toggleShip(s.shipId)}
                            />
                            <span class="pr-trend-pop__name">
                              {s.tier != null ? `T${s.tier} · ` : ""}
                              {prTrendShipName(s.shipId, uiLocale.value)}
                            </span>
                            <span class="pr-trend-pop__num">{s.battles}</span>
                            <span class="pr-trend-pop__num">
                              {s.battles > 0 ? ((s.wins / s.battles) * 100).toFixed(1) : "—"}%
                            </span>
                            <span class="pr-trend-pop__num">
                              {Math.round(s.damage / s.battles).toLocaleString(uiLocale.value)}
                            </span>
                          </div>
                        );
                      })
                    )}
                  </div>
                  {/* Pinned select-all — sits below the list, never scrolls
                      with it (the panel is one flex column). */}
                  <div
                    class="pr-trend-pop__all"
                    onClick={(e) => {
                      // The checkbox toggles via its own emit (its root is
                      // .hk-checkbox, same guard the rows use); a press on
                      // the text is the row's toggle.
                      if ((e.target as HTMLElement).closest(".hk-checkbox")) return;
                      onAllChecked();
                    }}
                  >
                    <HkCheckbox
                      size="sm"
                      // hikari's runtime maps a null modelValue to the
                      // indeterminate dash (pinned by its own tests) — its
                      // prop TYPE just never declared the null.
                      modelValue={allChecked.value as unknown as boolean}
                      onUpdate:modelValue={() => onAllChecked()}
                    />
                    <span>{t("playtime.prTrendSelectAll")}</span>
                  </div>
                </div>
              </HkPopover>
              {series.value.length > 0 ? (
                <span class="play-section__total">
                  {t("playtime.prTrendTotal", { n: totalBattles.value })}
                </span>
              ) : null}
            </div>
          </div>
          {body}
        </section>
      );
    };
  },
});

