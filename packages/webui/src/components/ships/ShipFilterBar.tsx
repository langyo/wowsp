/**
 * ShipFilterBar — business component that packages ALL ship-table filtering
 * into one strip sharing the view's controls row with the date range tabs:
 * internally two fixed rows — the meta row (summary + search) pinned to the
 * tabs row's right end, the category chips claiming a full row below.
 * Emits `change` with the filtered + sorted flat list whenever any control
 * moves.
 *
 * Interaction model:
 *   - Five filter categories — type / nation / tier / winrate / battles —
 *     render as collapsed chips styled after the segmented button-group
 *     triggers.
 *   - Clicking a chip opens a popup hosting the category's option group.
 *     Type, nation and tier are MULTI-SELECT: the chosen options OR together
 *     inside the category (categories still AND). Winrate and battles are
 *     SINGLE-SELECT — their brackets sit on one numeric axis, so OR-ing
 *     thresholds that subsume each other (≥30 ∪ ≥100 = ≥30) only confuses;
 *     picking a bracket replaces the previous pick. The 正序/倒序 flag is
 *     SHARED by the whole category — re-clicking the picked option flips
 *     every arrow in it at once. Ship types and nations are further
 *     special: pure filters with no direction at all, so re-clicking a
 *     type/nation simply deselects it.
 *   - The nation popup hosts its options as ONE capped horizontal strip
 *     (it never wraps or outruns the viewport): panned by wheel (deltaY →
 *     scrollLeft) or mouse drag (5px click/pan threshold, the pan's
 *     trailing click swallowed), touch pans natively; a hint line names
 *     the gesture. The phone sheet still wraps the track.
 *   - The 全部… option always shows the direction arrow too: with a concrete
 *     selection it resets the category to the gray state; without one it
 *     engages the "sort while unfiltered" mode (first click sorts in the
 *     displayed direction, further clicks flip it). A chip that only sorts —
 *     sitting at 全部… — wears the intermediate --sort style.
 *   - A category is a sort key while it has a concrete selection or an
 *     engaged 全部…-sort (types only via the latter, so a type pick filters
 *     without reordering). Chips drag left/right (pointer-based adjacent
 *     swap) to reorder sort priority: the leftmost sorting chip is the
 *     primary key, the next sorting chip breaks ties, and so on; battles
 *     desc is the final fallback so the untouched view matches the
 *     pre-chip behaviour.
 *   - Fuzzy search (multilingual + pinyin) bypasses the category filters but
 *     keeps the multi-key sort.
 *
 * Data source: the ship encyclopedia (full WG API ship list, loaded lazily
 * by realm) with the offline database as fallback — so new ships never
 * vanish from filters. Chip order + selections persist to localStorage.
 */
import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { PlayerShipStats } from "@/api";
import { ArrowDown, ArrowUp, GripHorizontal, Search, X } from "@lucide/vue";

import { HkPopover, HkSearchInput, useBreakpoint } from "@celestia-island/hikari";

import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { shipOfflineEntry, nationNameFromDb } from "@/features/holographic/modelLoader";
import { canonicalNation } from "@/utils/nationFlags";
import NationFlag from "@/components/base/NationFlag";
import { useLanguage } from "@/i18n/useLanguage";
import { matchShipNames } from "@/features/search/pinyinSearch";
import { t } from "@/i18n";
import { useOptionStrip } from "./optionStrip";
import "./ShipFilterBar.scss";

type CatKey = "type" | "nation" | "tier" | "winrate" | "battles";
type SortDir = "asc" | "desc";

const TYPE_ORDER = ["Battleship", "AirCarrier", "Cruiser", "Destroyer", "Submarine", ""];
/** Canonical nation display order (the port tech-tree reading order) —
 *  mirrors the encyclopedia store's NATION_ORDER as a LOCAL const: importing
 *  the Pinia store from this component would risk a store↔component cycle
 *  and drag store wiring into every surface hosting the bar. */
const NATION_FILTER_ORDER = [
  "japan", "usa", "ussr", "germany", "uk", "france",
  "pan_asia", "italy", "netherlands", "commonwealth",
  "pan_america", "spain", "europe",
];
const TIER_FILTERS: [string, string][] = [
  ["I–V", "I – V"],
  ["VI–VII", "VI – VII"],
  ["VIII–IX", "VIII – IX"],
  ["X–★", "X – ★"],
];
function bracketTiers(key: string): number[] {
  switch (key) {
    case "I–V":
      return [1, 2, 3, 4, 5];
    case "VI–VII":
      return [6, 7];
    case "VIII–IX":
      return [8, 9];
    case "X–★":
      return [10, 11];
  }
  return [];
}
/** [storage value, label, predicate over winrate (0–100)]. */
const WINRATE_BRACKETS: [string, string, (wr: number) => boolean][] = [
  ["lt40", "<40%", (wr) => wr < 40],
  ["40-50", "40–50%", (wr) => wr >= 40 && wr < 50],
  ["50-60", "50–60%", (wr) => wr >= 50 && wr < 60],
  ["gte60", "≥60%", (wr) => wr >= 60],
];
/** [min battles]. Labels come from `ships.filter.minBattles` at render time. */
const BATTLE_STEPS: number[] = [30, 60, 100];

/** Minimal metadata slice the category predicates/sorters need — both the
 *  encyclopedia entry and the offline-DB fallback satisfy it structurally. */
interface ShipMeta {
  shipId: number;
  tier: number;
  type: string;
  nation: string;
}

interface CatDef {
  /** i18n keys (resolved via t() at render time, never stored as text). */
  title: string;
  allLabel: string;
  /** Filter predicate for one concrete selection. */
  matches(row: PlayerShipStats, info: ShipMeta | null, value: string): boolean;
  /** Numeric sort key; direction comes from the category's shared flag. */
  sortValue(row: PlayerShipStats, info: ShipMeta | null): number;
}

/** Canonical type ordering index — unknown types sort last. */
function typeRank(type: string): number {
  const idx = TYPE_ORDER.findIndex((k) => k && type.startsWith(k));
  return idx >= 0 ? idx : TYPE_ORDER.length;
}

/** Canonical nation ordering index (tech-tree reading order) — ships with
 *  no canonical nation (event/rental curios) sort last. */
function nationRank(nation: string): number {
  const idx = NATION_FILTER_ORDER.indexOf(canonicalNation(nation));
  return idx >= 0 ? idx : NATION_FILTER_ORDER.length;
}

const CAT_DEFS: Record<CatKey, CatDef> = {
  type: {
    title: "ships.filter.typeTitle",
    allLabel: "ships.filter.typeAll",
    matches: (_row, info, value) => (info?.type ?? "").startsWith(value),
    sortValue: (_row, info) => typeRank(info?.type ?? ""),
  },
  nation: {
    title: "ships.filter.nationTitle",
    allLabel: "ships.filter.nationAll",
    // Ships with NO canonical nation (event/rental curios — offline DB
    // "events" and unknown codes) pass only while the selection is empty:
    // once concrete nations are picked they are deliberately excluded
    // rather than getting an "other" option of their own.
    matches: (_row, info, value) => canonicalNation(info?.nation ?? "") === value,
    sortValue: (_row, info) => nationRank(info?.nation ?? ""),
  },
  tier: {
    title: "ships.filter.tierTitle",
    allLabel: "ships.filter.tierAll",
    matches: (_row, info, value) => bracketTiers(value).includes(info?.tier ?? 0),
    sortValue: (_row, info) => info?.tier ?? 0,
  },
  winrate: {
    title: "ships.filter.wrTitle",
    allLabel: "ships.filter.wrAll",
    matches: (row, _info, value) =>
      WINRATE_BRACKETS.find(([v]) => v === value)?.[2](row.winrate) ?? true,
    sortValue: (row) => row.winrate,
  },
  battles: {
    title: "ships.filter.battlesTitle",
    allLabel: "ships.filter.battlesAll",
    matches: (row, _info, value) => row.battles >= (Number(value) || 0),
    sortValue: (row) => row.battles,
  },
};

const CAT_KEYS: CatKey[] = ["type", "nation", "tier", "winrate", "battles"];
const DEFAULT_ORDER: CatKey[] = [...CAT_KEYS];

/** Winrate and battles brackets carve up ONE numeric axis, so picking
 *  several at once ORs thresholds that subsume each other (≥30 ∪ ≥100 is
 *  just ≥30) — these two categories hold exactly one pick at a time;
 *  type/tier/nation stay multi-select. */
const SINGLE_CATS: readonly CatKey[] = ["winrate", "battles"];
const isSingleSel = (key: CatKey) => SINGLE_CATS.includes(key);

/** Pure-filter categories: multi-select picks with no sort direction — a
 *  re-click deselects, and only the 全部… option can engage a sort (by the
 *  category's canonical rank order). */
const PURE_CATS: readonly CatKey[] = ["type", "nation"];
const isPureCat = (key: CatKey) => PURE_CATS.includes(key);

/** Concrete option values of a category in canonical (display) order —
 *  used to clamp stale multi-select storage down to the single-select
 *  model (battles keeps its lowest threshold, which is what the old OR
 *  actually filtered by). */
function canonicalValues(key: CatKey): string[] {
  switch (key) {
    case "type":
      return TYPE_ORDER.filter((t) => t !== "");
    case "nation":
      return [...NATION_FILTER_ORDER];
    case "tier":
      return TIER_FILTERS.map(([v]) => v);
    case "winrate":
      return WINRATE_BRACKETS.map(([v]) => v);
    case "battles":
      return BATTLE_STEPS.map(String);
  }
}

// ── localStorage persistence (shared by every view hosting the bar) ──

const PERSIST_KEY = "wowsp.shipFilter.v4";
/** The pre-nation format (four categories, no "nation" key). */
const LEGACY_PERSIST_KEY = "wowsp.shipFilter.v3";

/** Per-category state: multi-select filter values + the SHARED sort
 *  direction + whether the category also sorts while sitting at 全部…
 *  (engaged by clicking the 全部… option). */
interface CatSel {
  values: string[];
  dir: SortDir;
  allSort: boolean;
}

interface Persisted {
  order: CatKey[];
  sel: Partial<Record<CatKey, CatSel>>;
}

function isValidTierValue(v: string): boolean {
  return bracketTiers(v).length > 0;
}
function isValidWinrateValue(v: string): boolean {
  return WINRATE_BRACKETS.some(([k]) => k === v);
}
function isValidBattleValue(v: string): boolean {
  return BATTLE_STEPS.some((n) => String(n) === v);
}
function isValidValue(key: CatKey, v: string): boolean {
  switch (key) {
    case "type":
      return TYPE_ORDER.some((t) => t && t === v);
    case "nation":
      return NATION_FILTER_ORDER.includes(v);
    case "tier":
      return isValidTierValue(v);
    case "winrate":
      return isValidWinrateValue(v);
    case "battles":
      return isValidBattleValue(v);
  }
}

/** `order` is exactly the given keys in some order (a permutation). */
function isPermutationOf(order: unknown, keys: readonly CatKey[]): order is CatKey[] {
  return (
    Array.isArray(order) &&
    order.length === keys.length &&
    keys.every((k) => (order as unknown[]).includes(k))
  );
}

const LEGACY_CAT_KEYS: readonly CatKey[] = ["type", "tier", "winrate", "battles"];

/** Insert the "nation" category right after "type" (its default slot). */
function withNationAfterType(order: CatKey[]): CatKey[] {
  const idx = order.indexOf("type");
  const next = [...order];
  next.splice(idx >= 0 ? idx + 1 : next.length, 0, "nation");
  return next;
}

function loadPersisted(): Persisted | null {
  try {
    const rawV4 = localStorage.getItem(PERSIST_KEY);
    if (rawV4) {
      const p = JSON.parse(rawV4) as Persisted;
      // Order must be a permutation of the five categories, else fall back.
      // Heal-write: the invalid blob is swept (absence = the canonical
      // defaults) so the stale value is corrected once, not every boot.
      if (!isPermutationOf(p.order, CAT_KEYS)) {
        localStorage.removeItem(PERSIST_KEY);
        return null;
      }
      return p;
    }
    // v3 → v4 migration: the legacy four-key order (any permutation) is
    // accepted with "nation" inserted after "type". The v4 blob is written
    // back IMMEDIATELY and the v3 key swept — the migrated state must
    // survive a session with no further interaction, not re-migrate from
    // defaults on the next boot.
    const rawV3 = localStorage.getItem(LEGACY_PERSIST_KEY);
    if (!rawV3) return null;
    const legacy = JSON.parse(rawV3) as Persisted;
    if (!isPermutationOf(legacy.order, LEGACY_CAT_KEYS)) {
      localStorage.removeItem(LEGACY_PERSIST_KEY);
      return null;
    }
    const migrated: Persisted = {
      order: withNationAfterType(legacy.order),
      sel: legacy.sel ?? {},
    };
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify(migrated));
    } catch {
      /* storage full — the migrated state still holds for the session */
    }
    localStorage.removeItem(LEGACY_PERSIST_KEY);
    return migrated;
  } catch {
    localStorage.removeItem(PERSIST_KEY);
    localStorage.removeItem(LEGACY_PERSIST_KEY);
    return null;
  }
}

export interface FilterState {
  ships: PlayerShipStats[];
  hits: Map<number, string>;
}

export default defineComponent({
  name: "ShipFilterBar",
  props: {
    ships: { type: Array as () => PlayerShipStats[], required: true },
    realm: { type: String, default: "" },
  },
  emits: {
    change: (_state: FilterState) => true,
  },
  setup(props, { emit }) {
    const encyclopedia = useEncyclopediaStore();
    const { dataLanguage } = useLanguage();
    // Phone widths (the same <768px cut hikari's sheets use) dock every
    // popup as a bottom sheet instead of an anchored floating panel.
    const { isMobile } = useBreakpoint();

    // ── Chip state: drag order (= sort priority) + per-category multi-select.
    //    Types start ascending (the canonical BB→CV→CA→DD→SS reading order),
    //    everything else descending (high tier / good winrate / most battles
    //    first) so the first engagement lands on the useful direction. ──
    const stored = loadPersisted();
    const order = ref<CatKey[]>(stored ? [...stored.order] : [...DEFAULT_ORDER]);
    const sel = ref<Record<CatKey, CatSel>>({
      type: { values: [], dir: "asc", allSort: false },
      nation: { values: [], dir: "asc", allSort: false },
      tier: { values: [], dir: "desc", allSort: false },
      winrate: { values: [], dir: "desc", allSort: false },
      battles: { values: [], dir: "desc", allSort: false },
    });
    if (stored?.sel) {
      for (const k of CAT_KEYS) {
        const s = stored.sel[k];
        if (!s || (s.dir !== "asc" && s.dir !== "desc") || !Array.isArray(s.values)) continue;
        // Storage written by the all-multi-select model may hold several
        // picks for a now-single-select category — clamp to one.
        const valid = s.values.filter((v) => typeof v === "string" && isValidValue(k, v));
        const values = isSingleSel(k)
          ? [...valid].sort((a, b) => canonicalValues(k).indexOf(a) - canonicalValues(k).indexOf(b)).slice(0, 1)
          : valid;
        sel.value[k] = {
          values,
          dir: s.dir,
          allSort: s.allSort === true,
        };
      }
    }
    watch(
      [order, sel],
      () => {
        try {
          localStorage.setItem(
            PERSIST_KEY,
            JSON.stringify({ order: order.value, sel: sel.value } satisfies Persisted),
          );
        } catch {
          /* storage full / unavailable — ignore */
        }
      },
      { deep: true },
    );

    const openPop = ref<CatKey | null>(null);
    const chipDragging = ref<CatKey | null>(null);

    // ── Search state (kept verbatim from v1) ──
    const shipQuery = ref("");
    const searchOpen = ref(false);
    const chipsRow = ref<HTMLDivElement | null>(null);
    // The search BUTTON anchors the teleported panel (the wrapper div only
    // carries spacing); the panel content elements below feed the outside-
    // close containment — they render at body level, outside the bar root.
    const searchBtnEl = ref<HTMLButtonElement | null>(null);
    const searchPanelEl = ref<HTMLElement | null>(null);
    const popPanelEls = new Map<CatKey, HTMLElement | null>();

    // ── Chip-row indent: the bar sits beside the view's date tabs, so its
    //    box (and the chips row's 100% wrap basis with it) starts one
    //    tabs-width in — the chip row then reads as centered in the leftover
    //    space. The bar's offset against the host row is measured into
    //    `--sfb-indent`; the SCSS turns that into a negative margin plus a
    //    matching basis so the chips start flush with the tabs' left edge.
    //    (The bar must stay a direct flex sibling of the tabs in the host
    //    row — an intermediate wrapper would measure 0.) When the host wraps
    //    the whole bar below the tabs the offset is 0 and the strip keeps
    //    its natural layout. ──
    const chipIndent = ref(0);
    let indentObserver: ResizeObserver | null = null;
    function measureChipIndent() {
      const bar = chipsRow.value;
      const row = bar?.parentElement;
      if (!bar || !row) {
        chipIndent.value = 0;
        return;
      }
      const rowStyle = getComputedStyle(row);
      const padLeft = parseFloat(rowStyle.paddingLeft) || 0;
      const borderLeft = parseFloat(rowStyle.borderLeftWidth) || 0;
      // Floor (not round): a fractional overshoot would poke the row's
      // right edge past the host content edge, while a shortfall just
      // leaves an invisible sub-pixel gap on the left.
      chipIndent.value = Math.max(
        0,
        Math.floor(bar.getBoundingClientRect().left - row.getBoundingClientRect().left - padLeft - borderLeft),
      );
    }

    /** One outside-close for the whole bar, attached exactly while a panel
     *  is open (capture so it precedes every inside handler). Presses inside
     *  the bar root are ignored here — the chip's own click then toggles or
     *  switches popups, keeping one-click switching. The open panel itself
     *  teleports to body (HkPopover), outside the bar root, so its element is
     *  containment-checked too: a press on an option must reach its click. */
    function onDocPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (chipsRow.value?.contains(target)) return;
      if (openPop.value != null && popPanelEls.get(openPop.value)?.contains(target)) return;
      if (searchOpen.value && searchPanelEl.value?.contains(target)) return;
      openPop.value = null;
      searchOpen.value = false;
    }
    watch(
      () => openPop.value !== null || searchOpen.value,
      (anyOpen) => {
        if (anyOpen) {
          document.addEventListener("pointerdown", onDocPointerDown, true);
        } else {
          document.removeEventListener("pointerdown", onDocPointerDown, true);
        }
      },
    );
    onBeforeUnmount(() => {
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      indentObserver?.disconnect();
      window.removeEventListener("pointermove", onChipPointerMove);
      window.removeEventListener("pointerup", onChipPointerUp);
      window.removeEventListener("pointercancel", onChipPointerCancel);
    });

    onMounted(() => {
      // Pinia setup-store refs are auto-unwrapped — no `.value` here.
      if (props.realm && !encyclopedia.loadedRealm && !encyclopedia.loading) {
        void encyclopedia.load(props.realm).catch(() => {});
      }
      // Keep the indent fresh across tab-width changes (language switch,
      // viewport wraps) — the bar's width changes whenever the tabs' does.
      if (typeof ResizeObserver !== "undefined") {
        indentObserver = new ResizeObserver(measureChipIndent);
        if (chipsRow.value) indentObserver.observe(chipsRow.value);
        if (chipsRow.value?.parentElement) indentObserver.observe(chipsRow.value.parentElement);
      }
      measureChipIndent();
    });

    /** Unified ship metadata: encyclopedia first (full API list), offline
     *  DB as fallback for brand-new ships. Display names follow the
     *  素材翻译 setting (the encyclopedia store overlays them already; the
     *  offline fallback resolves through the same data language). */
    const infoOf = (shipId: number) => {
      const enc = encyclopedia.byId.get(shipId);
      if (enc) return enc;
      const off = shipOfflineEntry(shipId);
      return off
        ? {
            shipId,
            tier: off.tier ?? 0,
            type: off.type ?? "",
            nation: off.nation ?? "",
            name:
              off.names?.[dataLanguage.value] ??
              off.names?.["en-US"] ??
              `#${shipId}`,
          }
        : null;
    };

    /** Option rows per category. Type/tier/winrate/battles lists are
     *  RESIDENT: the selectable range never shrinks with the queried data,
     *  so a pick that matches nothing in the current range stays visible
     *  and re-clickable and just yields an empty result (the hosting view
     *  shows the no-match empty state) instead of degrading the popup.
     *  Nations are the exception — data-derived: only nations PRESENT in
     *  the queried list get an option (a nation with no ships can never
     *  match anything), in the canonical tech-tree reading order. */
    const presentNations = computed(() => {
      const set = new Set<string>();
      for (const s of props.ships) {
        const c = canonicalNation(infoOf(s.shipId)?.nation ?? "");
        if (c) set.add(c);
      }
      return NATION_FILTER_ORDER.filter((n) => set.has(n));
    });

    /** Nation display name — the app-wide chain: 素材翻译 DB first, then
     *  ships.nation.<code> i18n, raw code last (same as ShipPickerModal). */
    function nationOptionLabel(code: string): string {
      return (
        nationNameFromDb(code, dataLanguage.value) ??
        (t(`ships.nation.${code}`, {}) || code)
      );
    }

    const catOptions = computed<Record<CatKey, { value: string; label: string }[]>>(() => ({
      type: [
        { value: "", label: t(CAT_DEFS.type.allLabel) },
        ...TYPE_ORDER.filter((k) => k !== "").map(
          (k) => ({ value: k, label: t(`dashboard.shipType.${k}`, {}) }),
        ),
      ],
      nation: [
        { value: "", label: t(CAT_DEFS.nation.allLabel) },
        ...presentNations.value.map((n) => ({ value: n, label: nationOptionLabel(n) })),
      ],
      tier: [
        { value: "", label: t(CAT_DEFS.tier.allLabel) },
        ...TIER_FILTERS.map(([v, label]) => ({ value: v, label })),
      ],
      winrate: [
        { value: "", label: t(CAT_DEFS.winrate.allLabel) },
        ...WINRATE_BRACKETS.map(([v, label]) => ({ value: v, label })),
      ],
      battles: [
        { value: "", label: t(CAT_DEFS.battles.allLabel) },
        ...BATTLE_STEPS.map((n) => ({
          value: String(n),
          label: t("ships.filter.minBattles", { n }),
        })),
      ],
    }));

    // ── Search hits (shipId → matched name) — fuzzy + multilingual ──
    const hitNames = computed(() => {
      const hits = new Map<number, string>();
      if (!shipQuery.value.trim()) return hits;
      for (const s of props.ships) {
        const info = infoOf(s.shipId);
        const names = info ? { [dataLanguage.value]: info.name } : undefined;
        const hit = matchShipNames(shipQuery.value, names, s.shipId);
        if (hit) hits.set(s.shipId, hit.matchedName);
      }
      return hits;
    });
    const searchCandidates = computed(() =>
      [...hitNames.value.entries()].map(([shipId, name]) => {
        const info = infoOf(shipId);
        return { value: name, label: name, sub: info?.tier ? `T${info.tier}` : "" };
      }),
    );

    /** A category contributes a sort key while it has a concrete selection
     *  or an engaged 全部…-sort. Types and nations only via the latter: a
     *  type/nation pick is a pure filter with no direction, so it must not
     *  reorder the list. */
    const isSortCat = (key: CatKey) =>
      sel.value[key].allSort || (sel.value[key].values.length > 0 && !isPureCat(key));

    const filteredShips = computed(() => {
      let rows = props.ships;
      const q = shipQuery.value.trim().toLowerCase();
      if (q) {
        rows = rows.filter((s) => hitNames.value.has(s.shipId));
      } else {
        // Within a category the picked options OR together; categories AND.
        for (const key of order.value) {
          const { values } = sel.value[key];
          if (!values.length) continue;
          const def = CAT_DEFS[key];
          rows = rows.filter((s) => {
            const info = infoOf(s.shipId);
            return values.some((v) => def.matches(s, info, v));
          });
        }
      }
      // Multi-key sort: sorting chips earlier in the drag order win; the
      // final battles-desc tiebreak keeps the untouched view stable.
      const sortCats = order.value.filter(isSortCat);
      return [...rows].sort((a, b) => {
        for (const key of sortCats) {
          const def = CAT_DEFS[key];
          const d = def.sortValue(b, infoOf(b.shipId)) - def.sortValue(a, infoOf(a.shipId));
          if (d !== 0) return sel.value[key].dir === "desc" ? d : -d;
        }
        return b.battles - a.battles;
      });
    });

    watch(filteredShips, () => {
      emit("change", {
        ships: filteredShips.value,
        hits: hitNames.value,
      });
    }, { immediate: true });

    const totalBattles = computed(() => filteredShips.value.reduce((a, s) => a + s.battles, 0));

    /** Click one option in a category popup. The 全部… option carries dual
     *  semantics: with a concrete selection it resets the whole category
     *  (filter AND all-state sort off); without one it toggles/flips the
     *  all-state sort — the first click engages in the displayed direction,
     *  later clicks flip it. Concrete options join the selection when
     *  unpicked (replacing it outright in the single-select categories);
     *  when picked they flip the category's shared direction — except the
     *  pure categories (types/nations), which carry no direction and
     *  simply drop out. */
    function clickOption(key: CatKey, value: string) {
      const s = sel.value[key];
      if (value === "") {
        if (s.values.length > 0) {
          s.values = [];
          s.allSort = false;
        } else if (s.allSort) {
          s.dir = s.dir === "desc" ? "asc" : "desc";
        } else {
          s.allSort = true;
        }
        return;
      }
      if (s.values.includes(value)) {
        if (isPureCat(key)) {
          s.values = s.values.filter((v) => v !== value);
        } else {
          s.dir = s.dir === "desc" ? "asc" : "desc";
        }
      } else {
        s.values = isSingleSel(key) ? [value] : [...s.values, value];
      }
    }

    // ── Chip dragging: pointer press → arm past a 5px threshold → live
    //    adjacent swaps as the pointer crosses a neighbour's midpoint.
    //    The click that follows a drag is swallowed so it never re-opens
    //    the popup that the drag just closed. ──
    const chipEls = new Map<CatKey, HTMLElement | null>();
    let pressKey: CatKey | null = null;
    let pressX = 0;
    let pressY = 0;
    let armed = false;
    let draggedKey: CatKey | null = null;

    function swapChips(i: number, j: number) {
      const arr = order.value;
      const tmp = arr[i]!;
      arr[i] = arr[j]!;
      arr[j] = tmp;
    }

    function onChipPointerDown(e: PointerEvent, key: CatKey) {
      if (e.button !== 0) return;
      // A drag released off-chip leaves no click behind; clear the stale
      // swallow flag so this press's own click always lands.
      draggedKey = null;
      pressKey = key;
      pressX = e.clientX;
      pressY = e.clientY;
      armed = false;
      window.addEventListener("pointermove", onChipPointerMove);
      window.addEventListener("pointerup", onChipPointerUp, { once: true });
      window.addEventListener("pointercancel", onChipPointerCancel, { once: true });
    }

    function onChipPointerMove(e: PointerEvent) {
      if (pressKey == null) return;
      if (!armed) {
        if (Math.abs(e.clientX - pressX) < 5 && Math.abs(e.clientY - pressY) < 5) return;
        armed = true;
        chipDragging.value = pressKey;
        openPop.value = null;
        searchOpen.value = false;
      }
      e.preventDefault();
      const from = order.value.indexOf(pressKey);
      if (from > 0) {
        const r = chipEls.get(order.value[from - 1]!)?.getBoundingClientRect();
        if (r && e.clientX < r.left + r.width / 2) {
          swapChips(from, from - 1);
          return;
        }
      }
      if (from >= 0 && from < order.value.length - 1) {
        const r = chipEls.get(order.value[from + 1]!)?.getBoundingClientRect();
        if (r && e.clientX > r.left + r.width / 2) swapChips(from, from + 1);
      }
    }

    function teardownPress() {
      pressKey = null;
      window.removeEventListener("pointermove", onChipPointerMove);
    }

    function onChipPointerUp() {
      // A completed drag suppresses the trailing click; a plain click falls
      // through to onClick (popup toggle) untouched.
      if (armed) draggedKey = pressKey;
      armed = false;
      chipDragging.value = null;
      teardownPress();
    }

    function onChipPointerCancel() {
      armed = false;
      chipDragging.value = null;
      teardownPress();
    }

    function onChipClick(key: CatKey) {
      if (draggedKey === key) {
        draggedKey = null;
        return;
      }
      searchOpen.value = false;
      openPop.value = openPop.value === key ? null : key;
    }

    // ── Nation option strip: a single pannable line ──
    //    Fourteen flags cannot fit any sane popup width, and the old wrap
    //    never engaged (HkPopover sizes its panel to max-content, so the
    //    track always measured as ONE long line that ran off-screen). The
    //    track is a real horizontal scroll container (SCSS) shared with
    //    every FilterCategoryChip popup: wheel-panned, mouse-drag-panned,
    //    touch pans natively, and the overflow edges fade (optionStrip's
    //    data-h-overflow sensing drives the SCSS masks). ──
    const strip = useOptionStrip();
    // A popover that closed before the pan's trailing click (window blur
    // mid-drag — pointerup lost) must not carry the swallow flag into the
    // reopened panel: the flag only ever eats the click of the pan that
    // armed it, and that click can only land while the popup still stands.
    watch(openPop, (key) => {
      if (key !== "nation") strip.resetDragged();
    });

    /** Popup explainer — four shapes: types/nations are pure filters
     *  (re-click deselects; types get the dedicated wording, nations the
     *  generic multi-select hint), winrate/battles pick a single bracket,
     *  tier is the multi-select-with-sort case. */
    const popHint = (key: CatKey) =>
      key === "type"
        ? t("ships.filter.hintTypePop")
        : key === "nation"
          ? t("ships.filter.hintMulti")
          : isSingleSel(key)
            ? t("ships.filter.hintSinglePop")
            : t("ships.filter.hintSortPop");

    /** Chip tooltip — same split as the popup hint. */
    const chipTitle = (key: CatKey) =>
      isPureCat(key)
        ? t("ships.filter.hintTypeChip")
        : isSingleSel(key)
          ? t("ships.filter.hintSingleChip")
          : t("ships.filter.hintSortChip");

    const dirIcon = (dir: SortDir) =>
      dir === "desc" ? <ArrowDown size={11} class="ship-filter-bar__dir" /> : <ArrowUp size={11} class="ship-filter-bar__dir" />;

    return () => (
      <div
        ref={chipsRow}
        class="ship-filter-bar"
        style={{ "--sfb-indent": `${chipIndent.value}px` }}
        data-dragging={chipDragging.value || undefined}
      >
        {/* Two fixed rows (styled in ShipFilterBar.scss): the chip group
            always claims a full row of its own while the meta group rides
            the first row's right end, beside the view's date tabs. Chips
            stay first in the DOM so tab order is unchanged — the visual
            order is flex `order`'s job, not the markup's. */}
        <div class="ship-filter-bar__chips">
          {order.value.map((key) => {
            const def = CAT_DEFS[key];
            const cur = sel.value[key];
            // Labels render in canonical option order (not click order) so a
            // ≥60% + 50–60% pick always reads "50–60%·≥60%".
            const byOrder = (a: string, b: string) => {
              const opts = catOptions.value[key];
              return (
                opts.findIndex((o) => o.value === a) - opts.findIndex((o) => o.value === b)
              );
            };
            const chipLabel =
              [...cur.values]
                .sort(byOrder)
                .map(
                  (v) =>
                    catOptions.value[key].find((o) => o.value === v)?.label ??
                    // Stale picks can outlive their option rows (nation
                    // options are data-derived, so a selected nation can
                    // vanish from the current date range): resolve those
                    // through the label chain so the chip still reads a
                    // localized name instead of the raw code.
                    (key === "nation" ? nationOptionLabel(v) : v),
                )
                .join("·") || t(def.allLabel);
            return (
              <div key={key} class="ship-filter-bar__chip-anchor">
                <button
                  type="button"
                  ref={(el) => {
                    chipEls.set(key, (el as HTMLElement | null) ?? null);
                  }}
                  class={[
                    "ship-filter-bar__chip",
                    cur.values.length
                      ? "ship-filter-bar__chip--on"
                      : cur.allSort
                        ? "ship-filter-bar__chip--sort"
                        : "ship-filter-bar__chip--all",
                  ]}
                  data-chip={key}
                  data-dragging={chipDragging.value === key || undefined}
                  data-hint={chipTitle(key)}
                  onPointerdown={(e: PointerEvent) => onChipPointerDown(e, key)}
                  onClick={() => onChipClick(key)}
                >
                  <GripHorizontal size={12} class="ship-filter-bar__chip-grip" />
                  <span>{chipLabel}</span>
                  {isSortCat(key) ? dirIcon(cur.dir) : null}
                </button>
                {/* The popup teleports to body (HkPopover) — no overflow
                    ancestor can clip it. On phones it docks as a bottom
                    sheet (sheetOnMobile — hikari convention: phones never
                    float anchored menus; the anchored desktop panel would
                    clip at the screen edge and read translucent where the
                    engine lacks backdrop-filter). The scrim + tap-outside
                    close ride closeOnBackdrop on phones only: the sheet
                    branch renders its dismissal scrim from that prop, while
                    desktop keeps the bar-level pointerdown outside-close
                    with hikari's own listener off (chip re-click switching
                    runs through onChipClick untouched either way). */}
                <HkPopover
                  modelValue={openPop.value === key}
                  onUpdate:modelValue={(v: boolean) => {
                    if (!v && openPop.value === key) openPop.value = null;
                  }}
                  anchorRef={chipEls.get(key) ?? null}
                  // The right-most chip's popup opens leftwards so it never
                  // leaves the strip (the old data-edge CSS hook).
                  placement={
                    key === order.value[order.value.length - 1] ? "bottom-end" : "bottom-start"
                  }
                  closeOnBackdrop={isMobile.value}
                  sheetOnMobile
                  title={t(def.title)}
                >
                  <div
                    ref={(el) => {
                      popPanelEls.set(key, (el as HTMLElement | null) ?? null);
                    }}
                    class="ship-filter-bar__pop"
                  >
                    <div class="ship-filter-bar__pop-head">
                      <span>{t(def.title)}</span>
                      <button
                        type="button"
                        class="ship-filter-bar__pop-close"
                        onClick={() => (openPop.value = null)}
                      >
                        <X size={12} />
                      </button>
                    </div>
                    {/* Option group in the segmented track look (multi-select
                        for type/nation/tier, single for winrate/battles).
                        全部… always shows the direction arrow; concrete pure
                        categories (types/nations) never do. Nation options
                        lead with their flag (NationFlag swaps to a letter
                        badge when the asset is missing), and the nation
                        track alone is a one-line pannable strip — wrapped
                        only by the phone sheet (see the SCSS). */}
                    <div
                      ref={key === "nation" ? strip.stripEl : undefined}
                      class={["ship-filter-bar__opts", key === "nation" && "ship-filter-bar__opts--scroll"]}
                      data-panning={key === "nation" && strip.panning.value ? "" : undefined}
                      onPointerdown={key === "nation" ? strip.onPointerDown : undefined}
                    >
                      {catOptions.value[key].map((o) => {
                        const isAll = o.value === "";
                        const on = isAll ? cur.values.length === 0 : cur.values.includes(o.value);
                        return (
                          <button
                            key={o.value}
                            type="button"
                            class="ship-filter-bar__opt"
                            data-active={on || undefined}
                            onClick={() => clickOption(key, o.value)}
                          >
                            {key === "nation" && !isAll ? (
                              <NationFlag nation={o.value} label={o.label} variant="flag" size="sm" />
                            ) : null}
                            <span>{o.label}</span>
                            {isAll || (on && !isPureCat(key)) ? dirIcon(cur.dir) : null}
                          </button>
                        );
                      })}
                    </div>
                    {/* The nation strip pans instead of wrapping — name the
                        gesture. Hidden on the phone sheet, whose track wraps
                        and has nothing to pan (SCSS). */}
                    {key === "nation" ? (
                      <div class="ship-filter-bar__pop-hint ship-filter-bar__scroll-hint">
                        {t("ships.filter.nationScrollHint")}
                      </div>
                    ) : null}
                    <div class="ship-filter-bar__pop-hint">{popHint(key)}</div>
                  </div>
                </HkPopover>
              </div>
            );
          })}
        </div>
        <div class="ship-filter-bar__meta">
          <span class="ship-filter-bar__summary">
            {t("ships.filter.summary", {
              ships: filteredShips.value.length,
              battles: totalBattles.value.toLocaleString(),
            })}
          </span>
          {/* Search — one button; the input lives in a popup panel that opens
              leftwards from the button (roomier than an inline box; HkPopover
              placement, teleported to body). The button stays highlighted
              while a query is in effect so the bypass-everything state is
              never invisible. */}
          <div class="ship-filter-bar__search-anchor">
            <button
              type="button"
              ref={searchBtnEl}
              class={[
                "ship-filter-bar__search-btn",
                searchOpen.value || shipQuery.value.trim() ? "ship-filter-bar__search-btn--on" : "",
              ]}
              onClick={() => {
                openPop.value = null;
                searchOpen.value = !searchOpen.value;
              }}
            >
              <Search size={13} />
              <span>{t("common.search.fuzzy")}</span>
            </button>
            <HkPopover
              modelValue={searchOpen.value}
              onUpdate:modelValue={(v: boolean) => {
                if (!v) searchOpen.value = false;
              }}
              anchorRef={searchBtnEl.value}
              placement="bottom-end"
              closeOnBackdrop={isMobile.value}
              sheetOnMobile
              title={t("common.search.fuzzy")}
            >
              <div ref={searchPanelEl} class="ship-filter-bar__search-panel">
                <div class="ship-filter-bar__search-panel-head">
                  <span>{t("common.search.fuzzy")}</span>
                  <button
                    type="button"
                    class="ship-filter-bar__search-close"
                    onClick={() => (searchOpen.value = false)}
                  >
                    <X size={12} />
                  </button>
                </div>
                <HkSearchInput
                  modelValue={shipQuery.value}
                  onUpdate:modelValue={(v: string) => (shipQuery.value = v)}
                  placeholder={t("common.search.fuzzy")}
                />
                {shipQuery.value.trim() && searchCandidates.value.length > 0 ? (
                  <div class="ship-filter-bar__candidates">
                    {searchCandidates.value.slice(0, 12).map((c) => (
                      <button
                        key={c.value}
                        type="button"
                        class="ship-filter-bar__candidate"
                        onClick={() => {
                          shipQuery.value = c.value;
                          searchOpen.value = false;
                        }}
                      >
                        <span>{c.label}</span>
                        {c.sub ? <em>{c.sub}</em> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
                {!shipQuery.value.trim() ? (
                  <div class="ship-filter-bar__search-hint">{t("common.search.hint")}</div>
                ) : null}
              </div>
            </HkPopover>
          </div>
        </div>
      </div>
    );
  },
});
