/**
 * ShipFilterBar — business component that packages ALL ship-table filtering
 * into one strip sharing the view's controls row with the date range tabs:
 * internally two fixed rows — the meta row (summary + search) pinned to the
 * tabs row's right end, the category chips claiming a full row below.
 * Emits `change` with the filtered + sorted flat list whenever any control
 * moves.
 *
 * Interaction model:
 *   - Six filter categories — type / nation / tier / winrate / battles /
 *     mode — render as collapsed chips styled after the segmented
 *     button-group triggers.
 *   - Clicking a chip opens a popup hosting the category's control. Type,
 *     nation and mode are MULTI-SELECT: the chosen options OR together
 *     inside the category (categories still AND). Winrate and battles are
 *     SINGLE-SELECT — their brackets sit on one numeric axis, so OR-ing
 *     thresholds that subsume each other (≥30 ∪ ≥100 = ≥30) only confuses;
 *     picking a bracket replaces the previous pick. The 正序/倒序 flag is
 *     SHARED by the whole category — a re-click of a picked option (or the
 *     popup's arrow toggle) flips every arrow in it at once. Ship types,
 *     nations and division modes are further special: pure filters with no
 *     direction at all, so re-clicking one of them simply deselects it.
 *   - Tier is a RANGE, not a pick set: the popup hosts the shared
 *     TierRangeSelect dual-thumb slider (1–11 with ★ for superships — the
 *     same component the compare picker and the encyclopedia grid use).
 *     Dragging either end carves a contiguous corridor; a narrowed range
 *     makes the category sort like a concrete pick would, the arrow toggle
 *     beside the 全部… pill flips that sort, and the 全部… pill itself runs
 *     the same three-click all-state cycle every other category has (with
 *     a corridor set it first resets the category).
 *   - The nation popup hosts its options as ONE capped horizontal strip
 *     (it never wraps or outruns the viewport): a hikari HkScrollContainer
 *     (axis horizontal, edge fades) panned by wheel or mouse drag (5px
 *     click/pan threshold, the pan's trailing click swallowed), touch pans
 *     natively; a hint line names the gesture. The phone sheet still wraps
 *     the track.
 *   - The 全部… option runs the all-state sort through a three-click cycle
 *     while nothing is picked: first click engages the "sort while
 *     unfiltered" mode in the category's canonical direction, the second
 *     flips it, the third switches it off entirely (the chip falls back to
 *     the gray state). With a concrete selection it resets the category to
 *     that same gray state. The direction arrow renders only while a sort
 *     is actually engaged. A chip that only sorts — sitting at 全部… —
 *     wears the intermediate --sort style.
 *   - A category is a sort key while it has a concrete selection or an
 *     engaged 全部…-sort (pure categories — types/nations/modes — only
 *     via the latter, so their picks filter without reordering). Sort
 *     priority follows the fixed canonical chip
 *     order: the earlier sorting category is the primary key, the next
 *     sorting category breaks ties, and so on; battles desc is the final
 *     fallback so the untouched view matches the pre-chip behaviour.
 *   - Fuzzy search (multilingual + pinyin) bypasses the category filters but
 *     keeps the multi-key sort.
 *
 * Data source: the ship encyclopedia (full WG API ship list, loaded lazily
 * by realm) with the offline database as fallback — so new ships never
 * vanish from filters. Selections persist to localStorage.
 */
import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { PlayerShipStats } from "@/api";
import { ArrowDown, ArrowUp, Search } from "@lucide/vue";

import { HkPopover, HkScrollContainer, HkSearchInput, useBreakpoint } from "@celestia-island/hikari";

import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { shipOfflineEntry, nationNameFromDb } from "@/features/holographic/modelLoader";
import { shipIconUrl } from "@/features/holographic/shipIcons";
import { canonicalNation } from "@/utils/nationFlags";
import { tierLabel } from "@/utils/shipCompare";
import NationFlag from "@/components/base/NationFlag";
import { useLanguage } from "@/i18n/useLanguage";
import { matchShipNames } from "@/features/search/pinyinSearch";
import { t } from "@/i18n";
import TierRangeSelect, {
  TIER_MAX,
  TIER_MIN,
  tierRangeNarrowed,
  tierRangeText,
  type TierRange,
} from "./TierRangeSelect";
import { useOptionStrip } from "./optionStrip";
import "./ShipFilterBar.scss";

type CatKey = "type" | "nation" | "tier" | "winrate" | "battles" | "mode";
/** Categories whose popup is an option-pill group — tier hosts the range
 *  slider instead and never touches the option machinery below. */
type OptCatKey = Exclude<CatKey, "tier">;
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
/** Pre-v6 tier storage: the four bracket pills. Kept ONLY as the migration
 *  table — a stored pick set folds into the contiguous corridor covering
 *  it (the slider cannot express anything else). */
const LEGACY_TIER_BRACKETS: [key: string, lo: number, hi: number][] = [
  ["I–V", 1, 5],
  ["VI–VII", 6, 7],
  ["VIII–IX", 8, 9],
  ["X–★", 10, 11],
];
function legacyBracketSpan(key: string): [number, number] | null {
  const b = LEGACY_TIER_BRACKETS.find(([k]) => k === key);
  return b ? [b[1], b[2]] : null;
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

/** [storage value, i18n label key, predicate over the row's mode breakdown].
 *  Division-mode picks read the per-ship battle-type split: every option is
 *  the same shape — the option names a battle mode, and a pick keeps ships
 *  with at least one battle in it (coop is ignored, the table is
 *  randoms-only). Rows whose `modes` is null/undefined (realms that don't
 *  serve battle-type splits, caches written before the field existed)
 *  match NO concrete option, so any mode pick filters them out. The
 *  breakdown is the CAREER split even under ranged views (1d/…/custom):
 *  history baselines carry no per-mode data, so mode picks and the
 *  div2+div3 all-sort always read career totals. */
const MODE_FILTERS: [string, string, (row: PlayerShipStats) => boolean][] = [
  ["solo", "ships.filter.modeSolo", (row) => (row.modes?.solo?.battles ?? 0) > 0],
  ["div2", "ships.filter.modeDiv2", (row) => (row.modes?.div2?.battles ?? 0) > 0],
  ["div3", "ships.filter.modeDiv3", (row) => (row.modes?.div3?.battles ?? 0) > 0],
  ["ranked", "ships.filter.modeRanked", (row) => (row.modes?.ranked?.battles ?? 0) > 0],
];

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

const CAT_DEFS: Record<OptCatKey, CatDef> = {
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
  mode: {
    title: "ships.filter.modeTitle",
    allLabel: "ships.filter.modeAll",
    matches: (row, _info, value) => MODE_FILTERS.find(([v]) => v === value)?.[2](row) ?? false,
    // The 全部…-sort axis is division battles (div2 + div3) — the mode
    // category's own numeric axis; desc (its canonical direction) leads
    // with the ship played most in divisions, rows without a breakdown
    // park at 0.
    sortValue: (row) => (row.modes?.div2?.battles ?? 0) + (row.modes?.div3?.battles ?? 0),
  },
};

/** The tier category's popup is the shared range slider, so it has no
 *  option pills — only the title/allLabel pair and the tier sort key. */
const TIER_DEF = {
  title: "ships.filter.tierTitle",
  allLabel: "ships.filter.tierAll",
  sortValue: (_row: PlayerShipStats, info: ShipMeta | null) => info?.tier ?? 0,
} satisfies Pick<CatDef, "title" | "allLabel" | "sortValue">;

const CAT_KEYS: CatKey[] = ["type", "nation", "tier", "winrate", "battles", "mode"];
const DEFAULT_ORDER: CatKey[] = [...CAT_KEYS];
/** The direction a category's 全部…-sort first engages in (and re-arms to
 *  whenever it switches off): types read in the canonical BB→CV→CA→DD→SS
 *  order, everything else leads with the useful end (high tier / good
 *  winrate / most battles / most division battles). */
const DEFAULT_DIR: Record<CatKey, SortDir> = {
  type: "asc",
  nation: "asc",
  tier: "desc",
  winrate: "desc",
  battles: "desc",
  mode: "desc",
};

/** Winrate and battles brackets carve up ONE numeric axis, so picking
 *  several at once ORs thresholds that subsume each other (≥30 ∪ ≥100 is
 *  just ≥30) — these two categories hold exactly one pick at a time;
 *  type/nation/mode stay multi-select (tier is a range, not a set). */
const SINGLE_CATS: readonly CatKey[] = ["winrate", "battles"];
const isSingleSel = (key: OptCatKey) => SINGLE_CATS.includes(key);

/** Pure-filter categories: multi-select picks with no sort direction — a
 *  re-click deselects, and only the 全部… option can engage a sort (by the
 *  category's canonical rank order). */
const PURE_CATS: readonly CatKey[] = ["type", "nation", "mode"];
const isPureCat = (key: OptCatKey) => PURE_CATS.includes(key);

/** Concrete option values of an option category in canonical (display)
 *  order — used to clamp stale multi-select storage down to the
 *  single-select model (battles keeps its lowest threshold, which is what
 *  the old OR actually filtered by). */
function canonicalValues(key: OptCatKey): string[] {
  switch (key) {
    case "type":
      return TYPE_ORDER.filter((tp) => tp !== "");
    case "nation":
      return [...NATION_FILTER_ORDER];
    case "winrate":
      return WINRATE_BRACKETS.map(([v]) => v);
    case "battles":
      return BATTLE_STEPS.map(String);
    case "mode":
      return MODE_FILTERS.map(([v]) => v);
  }
}

// ── localStorage persistence (shared by every view hosting the bar) ──

const PERSIST_KEY = "wowsp.shipFilter.v6";
/** Pre-v6 formats: v5 ({sel} with the tier category as bracket pills) and
 *  the v4/v3 drag-era blobs before it — only the selections carry forward
 *  (the tier brackets fold into the slider corridor on load). */
const LEGACY_PERSIST_KEYS = ["wowsp.shipFilter.v5", "wowsp.shipFilter.v4", "wowsp.shipFilter.v3"];

/** Per-option-category state: multi-select filter values + the SHARED sort
 *  direction + whether the category also sorts while sitting at 全部…
 *  (engaged by clicking the 全部… option). */
interface CatSel {
  values: string[];
  dir: SortDir;
  allSort: boolean;
}

/** Tier state: the corridor [lo, hi] on the 1–11 axis plus the same shared
 *  sort machinery every category carries. */
interface TierSel {
  lo: number;
  hi: number;
  dir: SortDir;
  allSort: boolean;
}

type SelMap = {
  type: CatSel;
  nation: CatSel;
  tier: TierSel;
  winrate: CatSel;
  battles: CatSel;
  mode: CatSel;
};

interface Persisted {
  sel: Partial<Record<CatKey, unknown>>;
}

function isValidWinrateValue(v: string): boolean {
  return WINRATE_BRACKETS.some(([k]) => k === v);
}
function isValidBattleValue(v: string): boolean {
  return BATTLE_STEPS.some((n) => String(n) === v);
}
function isValidValue(key: OptCatKey, v: string): boolean {
  switch (key) {
    case "type":
      return TYPE_ORDER.some((tp) => tp && tp === v);
    case "nation":
      return NATION_FILTER_ORDER.includes(v);
    case "winrate":
      return isValidWinrateValue(v);
    case "battles":
      return isValidBattleValue(v);
    case "mode":
      return MODE_FILTERS.some(([val]) => val === v);
  }
}

function loadPersisted(key: string, legacyEligible: boolean): Persisted | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      // No structural validation beyond JSON.parse: `sel` entries are
      // validated per-key by the caller, everything else is ignored.
      return { sel: (JSON.parse(raw) as Partial<Persisted>).sel ?? {} };
    }
    // Legacy migration (the DEFAULT key only — a custom-key host starts
    // fresh): only the selections carry forward. The v6 blob is
    // written back IMMEDIATELY and the legacy key swept — the migrated
    // state must survive a session with no further interaction, not
    // re-migrate from defaults on the next boot.
    if (!legacyEligible) return null;
    for (const legacy of LEGACY_PERSIST_KEYS) {
      const rawLegacy = localStorage.getItem(legacy);
      if (!rawLegacy) continue;
      const migrated: Persisted = { sel: (JSON.parse(rawLegacy) as Partial<Persisted>).sel ?? {} };
      try {
        localStorage.setItem(key, JSON.stringify(migrated));
      } catch {
        /* storage full — the migrated state still holds for the session */
      }
      localStorage.removeItem(legacy);
      return migrated;
    }
    return null;
  } catch {
    localStorage.removeItem(key);
    if (legacyEligible) {
      for (const legacy of LEGACY_PERSIST_KEYS) localStorage.removeItem(legacy);
    }
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
    /** Categories to drop entirely — no chip, no filter, no sort key, no
     *  persistence. Hosts that replace a category's control with their own
     *  (the ranked-season modal swaps the tier slider for league bracket
     *  buttons) exclude it here; the bracket filter then pre-filters the
     *  `ships` prop before the bar sees them. */
    exclude: { type: Array as () => CatKey[], default: () => [] },
    /** localStorage key for the selections. Hosts whose category set
     *  differs (a non-empty `exclude` changes the blob's shape) must use
     *  their own key so the two never overwrite each other's state. */
    persistKey: { type: String, default: PERSIST_KEY },
  },
  emits: {
    change: (_state: FilterState) => true,
  },
  setup(props, { emit }) {
    /** The chip/filter/sort category order with this host's exclusions
     *  applied (static per instance — `exclude` never changes at runtime). */
    const order: CatKey[] = DEFAULT_ORDER.filter((k) => !props.exclude.includes(k));
    const encyclopedia = useEncyclopediaStore();
    const { dataLanguage } = useLanguage();
    // Phone widths (the same <768px cut hikari's sheets use) dock every
    // popup as a bottom sheet instead of an anchored floating panel.
    const { isMobile } = useBreakpoint();

    // ── Chip state: per-category selections. Types start ascending (the
    //    canonical BB→CV→CA→DD→SS reading order), everything else descending
    //    (high tier / good winrate / most battles first) so the first
    //    engagement lands on the useful direction. ──
    const stored = loadPersisted(props.persistKey, props.persistKey === PERSIST_KEY);
    const sel = ref<SelMap>({
      type: { values: [], dir: "asc", allSort: false },
      nation: { values: [], dir: "asc", allSort: false },
      tier: { lo: TIER_MIN, hi: TIER_MAX, dir: "desc", allSort: false },
      winrate: { values: [], dir: "desc", allSort: false },
      battles: { values: [], dir: "desc", allSort: false },
      mode: { values: [], dir: "desc", allSort: false },
    });
    if (stored?.sel) {
      for (const k of order) {
        if (k === "tier") {
          const s = stored.sel.tier;
          if (!s || typeof s !== "object") continue;
          let lo: number;
          let hi: number;
          const rawValues = (s as { values?: unknown }).values;
          const legacyValues: readonly unknown[] | undefined = Array.isArray(rawValues)
            ? rawValues
            : undefined;
          if (legacyValues) {
            // v5-and-older bracket pills → the corridor covering the picked
            // set: a non-contiguous pick (I–V plus X–★) widens to its hull —
            // the slider only expresses corridors, and the superset never
            // hides a ship the old filter showed.
            let min = TIER_MAX + 1;
            let max = TIER_MIN - 1;
            for (const v of legacyValues) {
              const span = typeof v === "string" ? legacyBracketSpan(v) : null;
              if (!span) continue;
              min = Math.min(min, span[0]);
              max = Math.max(max, span[1]);
            }
            [lo, hi] = min <= max ? [min, max] : [TIER_MIN, TIER_MAX];
          } else {
            const clampTier = (v: unknown, fallback: number) => {
              // null/"" Number-coerce to 0 — a hand-corrupted blob must
              // fall back, not silently read as tier 0.
              if (v == null || v === "") return fallback;
              const n = Math.round(Number(v));
              return Number.isFinite(n)
                ? Math.min(TIER_MAX, Math.max(TIER_MIN, n))
                : fallback;
            };
            lo = clampTier((s as { lo?: unknown }).lo, TIER_MIN);
            hi = clampTier((s as { hi?: unknown }).hi, TIER_MAX);
            if (lo > hi) [lo, hi] = [hi, lo];
          }
          const allSort = (s as { allSort?: unknown }).allSort === true;
          const dirRaw = (s as { dir?: unknown }).dir;
          sel.value.tier = {
            lo,
            hi,
            // An idle corridor (full range, no 全部…-sort) re-arms from the
            // canonical direction, exactly like the option categories.
            dir:
              allSort || lo > TIER_MIN || hi < TIER_MAX
                ? (dirRaw === "asc" || dirRaw === "desc" ? dirRaw : DEFAULT_DIR.tier)
                : DEFAULT_DIR.tier,
            allSort,
          };
          continue;
        }
        const s = stored.sel[k] as { values?: unknown; dir?: unknown; allSort?: unknown } | null | undefined;
        if (!s || (s.dir !== "asc" && s.dir !== "desc") || !Array.isArray(s.values)) continue;
        // Storage written by the all-multi-select model may hold several
        // picks for a now-single-select category — clamp to one.
        const valid = s.values.filter((v) => typeof v === "string" && isValidValue(k, v));
        const values = isSingleSel(k)
          ? [...valid].sort((a, b) => canonicalValues(k).indexOf(a) - canonicalValues(k).indexOf(b)).slice(0, 1)
          : valid;
        const allSort = s.allSort === true;
        sel.value[k] = {
          values,
          // An idle category (no pick, no 全部…-sort) re-arms from its
          // canonical direction — storage from the free-flip era may hold a
          // stale off-canonical dir, and the 全部… cycle below must always
          // start from the same end.
          dir: allSort || values.length > 0 ? s.dir : DEFAULT_DIR[k],
          allSort,
        };
      }
      // The normalization above (legacy tier brackets → corridor) may
      // reshape what the raw migration wrote back — persist the normalized
      // form at once so the v6 blob never carries a legacy tier entry into
      // the next boot.
      try {
        localStorage.setItem(
          props.persistKey,
          JSON.stringify({ sel: sel.value } satisfies Persisted),
        );
      } catch {
        /* storage full / unavailable — the in-memory state still holds */
      }
    }
    watch(
      sel,
      () => {
        try {
          localStorage.setItem(
            props.persistKey,
            JSON.stringify({ sel: sel.value } satisfies Persisted),
          );
        } catch {
          /* storage full / unavailable — ignore */
        }
      },
      { deep: true },
    );

    const openPop = ref<CatKey | null>(null);

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

    /** Option rows per option category. The lists are RESIDENT: the
     *  selectable range never shrinks with the queried data, so a pick that
     *  matches nothing in the current range stays visible and re-clickable
     *  and just yields an empty result (the hosting view shows the no-match
     *  empty state) instead of degrading the popup. Nations are the
     *  exception — data-derived: only nations PRESENT in the queried list
     *  get an option (a nation with no ships can never match anything), in
     *  the canonical tech-tree reading order. */
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

    const catOptions = computed<Record<OptCatKey, { value: string; label: string }[]>>(() => ({
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
      mode: [
        { value: "", label: t(CAT_DEFS.mode.allLabel) },
        ...MODE_FILTERS.map(([v, key]) => ({ value: v, label: t(key) })),
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
        return { value: name, label: name, sub: info?.tier ? tierLabel(info.tier) : "" };
      }),
    );

    /** The tier category's corridor as the slider's model. */
    const tierRange = computed<TierRange>(() => [sel.value.tier.lo, sel.value.tier.hi]);
    function setTierRange(v: TierRange) {
      sel.value.tier = { ...sel.value.tier, lo: v[0], hi: v[1] };
    }

    /** A category contributes a sort key while it has a concrete selection
     *  or an engaged 全部…-sort. Types, nations and division modes only via
     *  the latter: a pure pick is a filter with no direction, so it must
     *  not reorder the list. The tier corridor counts as a concrete
     *  selection while it is narrowed. */
    const isSortCat = (key: CatKey) =>
      key === "tier"
        ? sel.value.tier.allSort || tierRangeNarrowed(tierRange.value)
        : sel.value[key].allSort || (sel.value[key].values.length > 0 && !isPureCat(key));

    const filteredShips = computed(() => {
      let rows = props.ships;
      const q = shipQuery.value.trim().toLowerCase();
      if (q) {
        rows = rows.filter((s) => hitNames.value.has(s.shipId));
      } else {
        // Within a category the picked options OR together; categories AND.
        // The tier corridor replaces the tier option set.
        for (const key of order) {
          if (key === "tier") {
            const tr = sel.value.tier;
            if (tierRangeNarrowed([tr.lo, tr.hi])) {
              rows = rows.filter((s) => {
                const tier = infoOf(s.shipId)?.tier ?? 0;
                return tier >= tr.lo && tier <= tr.hi;
              });
            }
            continue;
          }
          const { values } = sel.value[key];
          if (!values.length) continue;
          const def = CAT_DEFS[key];
          rows = rows.filter((s) => {
            const info = infoOf(s.shipId);
            return values.some((v) => def.matches(s, info, v));
          });
        }
      }
      // Multi-key sort: sorting categories earlier in the canonical chip
      // order win; the final battles-desc tiebreak keeps the untouched view
      // stable.
      const sortCats = order.filter(isSortCat);
      return [...rows].sort((a, b) => {
        for (const key of sortCats) {
          const def = key === "tier" ? TIER_DEF : CAT_DEFS[key];
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

    /** Click one option in an option-category popup. The 全部… option
     *  carries dual semantics: with a concrete selection it resets the whole
     *  category (filter AND all-state sort off, direction re-armed to
     *  canonical); without one it runs the all-state sort through a
     *  three-click cycle — engage in the canonical direction, flip, switch
     *  off. Concrete options join the selection when unpicked (replacing it
     *  outright in the single-select categories); when picked they flip the
     *  category's shared direction — except the pure categories
     *  (types/nations/modes), which carry no direction and simply drop
     *  out. */
    function clickOption(key: OptCatKey, value: string) {
      const s = sel.value[key];
      if (value === "") {
        if (s.values.length > 0) {
          s.values = [];
          s.allSort = false;
          s.dir = DEFAULT_DIR[key];
        } else if (s.allSort) {
          if (s.dir === DEFAULT_DIR[key]) {
            s.dir = s.dir === "desc" ? "asc" : "desc";
          } else {
            s.allSort = false;
            s.dir = DEFAULT_DIR[key];
          }
        } else {
          s.allSort = true;
          s.dir = DEFAULT_DIR[key];
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

    /** The tier popup's 全部… pill — the same three-click all-state cycle
     *  as every category's 全部…, with a narrowed corridor playing the
     *  concrete-selection role (first click resets the corridor). */
    function clickTierAll() {
      const s = sel.value.tier;
      if (tierRangeNarrowed([s.lo, s.hi])) {
        sel.value.tier = { lo: TIER_MIN, hi: TIER_MAX, dir: DEFAULT_DIR.tier, allSort: false };
      } else if (s.allSort) {
        if (s.dir === DEFAULT_DIR.tier) {
          sel.value.tier = { ...s, dir: s.dir === "desc" ? "asc" : "desc" };
        } else {
          sel.value.tier = { ...s, allSort: false, dir: DEFAULT_DIR.tier };
        }
      } else {
        sel.value.tier = { ...s, allSort: true, dir: DEFAULT_DIR.tier };
      }
    }

    /** Chip elements double as the teleported popups' anchor refs. */
    const chipEls = new Map<CatKey, HTMLElement | null>();

    function onChipClick(key: CatKey) {
      searchOpen.value = false;
      openPop.value = openPop.value === key ? null : key;
    }

    // ── Nation option strip: a single pannable line ──
    //    Fourteen flags cannot fit any sane popup width, and the old wrap
    //    never engaged (HkPopover sizes its panel to max-content, so the
    //    track always measured as ONE long line that ran off-screen). The
    //    track is a hikari HkScrollContainer (axis horizontal + fade)
    //    shared with every FilterCategoryChip popup: the library's
    //    viewport scrolls and its data-h-overflow sensing drives the edge
    //    fades, optionStrip normalizes the wheel (Firefox line mode) and
    //    pans by mouse drag; touch pans natively. ──
    const strip = useOptionStrip();
    // A popover that closed before the pan's trailing click (window blur
    // mid-drag — pointerup lost) must not carry the swallow flag into the
    // reopened panel: the flag only ever eats the click of the pan that
    // armed it, and that click can only land while the popup still stands.
    watch(openPop, (key) => {
      if (key !== "nation") strip.resetDragged();
    });

    /** Popup explainer — five shapes: types/nations/modes are pure filters
     *  (re-click deselects; types get the dedicated wording, the others the
     *  generic multi-select hint), winrate/battles pick a single bracket,
     *  tier is the range slider. */
    const popHint = (key: CatKey) =>
      key === "tier"
        ? t("ships.filter.hintTierPop")
        : key === "type"
          ? t("ships.filter.hintTypePop")
          : isPureCat(key)
            ? t("ships.filter.hintMulti")
            : isSingleSel(key)
              ? t("ships.filter.hintSinglePop")
              : t("ships.filter.hintSortPop");

    /** Chip tooltip — same split as the popup hint. */
    const chipTitle = (key: CatKey) =>
      key === "tier"
        ? t("ships.filter.hintTierChip")
        : isPureCat(key)
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
      >
        {/* Two fixed rows (styled in ShipFilterBar.scss): the chip group
            always claims a full row of its own while the meta group rides
            the first row's right end, beside the view's date tabs. Chips
            stay first in the DOM so tab order is unchanged — the visual
            order is flex `order`'s job, not the markup's. */}
        <div class="ship-filter-bar__chips">
          {order.map((key) => {
            const def = key === "tier" ? TIER_DEF : CAT_DEFS[key];
            const optCur: CatSel | null = key === "tier" ? null : sel.value[key];
            const tierCur: TierSel | null = key === "tier" ? sel.value.tier : null;
            const hasPick = tierCur
              ? tierRangeNarrowed([tierCur.lo, tierCur.hi])
              : (optCur?.values.length ?? 0) > 0;
            const curDir: SortDir = tierCur?.dir ?? optCur!.dir;
            const curAllSort = tierCur?.allSort ?? optCur!.allSort;
            // Labels render in canonical option order (not click order) so a
            // ≥60% + 50–60% pick always reads "50–60%·≥60%"; the tier chip
            // reads its corridor ("VI – ★", "VIII") or falls back to 全部….
            const byOrder = (a: string, b: string) => {
              const opts = catOptions.value[key as OptCatKey];
              return (
                opts.findIndex((o) => o.value === a) - opts.findIndex((o) => o.value === b)
              );
            };
            const chipLabel =
              (tierCur
                ? tierRangeText(tierCur.lo, tierCur.hi)
                : [...(optCur?.values ?? [])]
                    .sort(byOrder)
                    .map(
                      (v) =>
                        catOptions.value[key as OptCatKey].find((o) => o.value === v)?.label ??
                        // Stale picks can outlive their option rows (nation
                        // options are data-derived, so a selected nation can
                        // vanish from the current date range): resolve those
                        // through the label chain so the chip still reads a
                        // localized name instead of the raw code.
                        (key === "nation" ? nationOptionLabel(v) : v),
                    )
                    .join("·")) || t(def.allLabel);
            return (
              <div key={key} class="ship-filter-bar__chip-anchor">
                <button
                  type="button"
                  ref={(el) => {
                    chipEls.set(key, (el as HTMLElement | null) ?? null);
                  }}
                  class={[
                    "ship-filter-bar__chip",
                    hasPick
                      ? "ship-filter-bar__chip--on"
                      : curAllSort
                        ? "ship-filter-bar__chip--sort"
                        : "ship-filter-bar__chip--all",
                  ]}
                  data-chip={key}
                  data-hint={chipTitle(key)}
                  onClick={() => onChipClick(key)}
                >
                  <span>{chipLabel}</span>
                  {isSortCat(key) ? dirIcon(curDir) : null}
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
                    key === order[order.length - 1] ? "bottom-end" : "bottom-start"
                  }
                  closeOnBackdrop={isMobile.value}
                  sheetOnMobile
                  padding="lg"
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
                    </div>
                    {/* Category body: tier hosts the shared dual-thumb
                        corridor slider plus its action row; the option
                        categories keep the segmented track (multi-select for
                        type/nation/mode, single for winrate/battles). The
                        全部… pill carries the direction arrow only while its
                        all-state sort is engaged; concrete pure categories
                        (types/nations/modes) never show one. Nation options
                        lead with their flag (NationFlag swaps to a letter
                        badge when the asset is missing), and the nation
                        track alone is a one-line pannable strip — wrapped
                        only by the phone sheet (see the SCSS). */}
                    {key === "tier" ? (
                      <div class="ship-filter-bar__tier-pop">
                        <TierRangeSelect
                          modelValue={tierRange.value}
                          onUpdate:modelValue={setTierRange}
                          showReset={false}
                        />
                        <div class="ship-filter-bar__opts ship-filter-bar__tier-actions">
                          <button
                            type="button"
                            class="ship-filter-bar__opt"
                            data-tier-all
                            data-active={!hasPick || undefined}
                            onClick={clickTierAll}
                          >
                            <span>{t(TIER_DEF.allLabel)}</span>
                            {curAllSort ? dirIcon(curDir) : null}
                          </button>
                          {isSortCat("tier") ? (
                            <button
                              type="button"
                              class="ship-filter-bar__opt ship-filter-bar__tier-flip"
                              data-tier-flip
                              data-hint={t("ships.filter.dirFlip")}
                              aria-label={t("ships.filter.dirFlip")}
                              onClick={() => {
                                sel.value.tier = {
                                  ...sel.value.tier,
                                  dir: curDir === "desc" ? "asc" : "desc",
                                };
                              }}
                            >
                              {dirIcon(curDir)}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      (() => {
                        const cur = optCur!;
                        const optKey = key as OptCatKey;
                        const optButtons = catOptions.value[optKey].map((o) => {
                          const isAll = o.value === "";
                          const on = isAll ? cur.values.length === 0 : cur.values.includes(o.value);
                          return (
                            <button
                              key={o.value}
                              type="button"
                              class="ship-filter-bar__opt"
                              data-active={on || undefined}
                              onClick={() => clickOption(optKey, o.value)}
                            >
                              {optKey === "nation" && !isAll ? (
                                <NationFlag nation={o.value} label={o.label} variant="flag" size="sm" />
                              ) : null}
                              {/* Type options lead with the game's white
                                  battle-HUD silhouette (flipped to the
                                  enemy row's rightward facing — the same
                                  icon the PR trend popup's type row uses). */}
                              {optKey === "type" && !isAll ? (
                                <img
                                  class="ship-filter-bar__type-icon"
                                  src={shipIconUrl(o.value, "white") ?? undefined}
                                  alt=""
                                  draggable={false}
                                />
                              ) : null}
                              <span>{o.label}</span>
                              {(isAll ? cur.allSort : on && !isPureCat(optKey)) ? dirIcon(cur.dir) : null}
                            </button>
                          );
                        });
                        // The nation track renders into the pannable strip
                        // (a hikari HkScrollContainer, shared with every
                        // FilterCategoryChip popup); every other category
                        // keeps the plain wrapping track.
                        return optKey === "nation" ? (
                          <HkScrollContainer
                            ref={strip.attach}
                            class="ship-filter-bar__opts ship-filter-bar__opts--scroll"
                            axis="horizontal"
                            fade
                            data-panning={strip.panning.value ? "" : undefined}
                          >
                            <div class="ship-filter-bar__opts-track">{optButtons}</div>
                          </HkScrollContainer>
                        ) : (
                          <div class="ship-filter-bar__opts">{optButtons}</div>
                        );
                      })()
                    )}
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
              padding="lg"
              title={t("common.search.fuzzy")}
            >
              <div ref={searchPanelEl} class="ship-filter-bar__search-panel">
                <div class="ship-filter-bar__search-panel-head">
                  <span>{t("common.search.fuzzy")}</span>
                </div>
                <HkSearchInput
                  modelValue={shipQuery.value}
                  onUpdate:modelValue={(v: string) => (shipQuery.value = v)}
                  placeholder={t("common.search.fuzzy")}
                />
                {shipQuery.value.trim() && searchCandidates.value.length > 0 ? (
                  /* Fuzzy-match candidates — a capped hikari scroll
                     container (overlay bar); the row layout lives on
                     __candidates-inner. */
                  <HkScrollContainer class="ship-filter-bar__candidates">
                    <div class="ship-filter-bar__candidates-inner">
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
                  </HkScrollContainer>
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
