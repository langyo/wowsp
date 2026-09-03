/**
 * ShipFilterBar — business component that packages ALL ship-table filtering
 * into one inline strip, meant to sit on the same row as the view's date
 * range tabs. Emits `change` with the filtered + sorted flat list whenever
 * any control moves.
 *
 * Interaction model:
 *   - Four filter categories — type / tier / winrate / battles — render as
 *     collapsed chips styled after the segmented button-group triggers. A
 *     chip sitting at "all" (全部舰种 / 全部等级 / …) is grayed out and
 *     inert; a chip with a concrete selection both filters the list and acts
 *     as a sort key with its own 正序/倒序 flag.
 *   - Clicking a chip opens a popup hosting the category's original
 *     segmented HTabs group. Picking an option applies the filter; clicking
 *     the ALREADY-selected option (which HTabs never re-emits — a wrapper
 *     click intercepts it) flips its asc/desc flag; picking 全部… resets to
 *     the gray state.
 *   - Chips drag left/right (pointer-based adjacent swap) to reorder sort
 *     priority: the leftmost active chip is the primary key, the next active
 *     chip breaks ties, and so on; battles desc is the final fallback so the
 *     default view matches the pre-chip behaviour.
 *   - Fuzzy search (multilingual + pinyin) bypasses the category filters but
 *     keeps the multi-key sort.
 *
 * Data source: the ship encyclopedia (full WG API ship list, loaded lazily
 * by realm) with the offline database as fallback — so new ships never
 * vanish from filters. Chip order + selections persist to localStorage.
 */
import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { PlayerShipStats } from "@/api";
import { ArrowDown, ArrowUp, GripHorizontal, Search } from "@lucide/vue";

import { HSearchInput, HTabs } from "@celestia-island/hikari";

import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { shipOfflineEntry } from "@/features/holographic/modelLoader";
import { useLanguage } from "@/i18n/useLanguage";
import { matchShipNames } from "@/features/search/pinyinSearch";
import { t } from "@/i18n";
import "./ShipFilterBar.scss";

type CatKey = "type" | "tier" | "winrate" | "battles";
type SortDir = "asc" | "desc";

const TYPE_ORDER = ["Battleship", "AirCarrier", "Cruiser", "Destroyer", "Submarine", ""];
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
/** [min battles, label]. */
const BATTLE_STEPS: [number, string][] = [
  [30, "≥30 场"],
  [60, "≥60 场"],
  [100, "≥100 场"],
];

/** Minimal metadata slice the category predicates/sorters need — both the
 *  encyclopedia entry and the offline-DB fallback satisfy it structurally. */
interface ShipMeta {
  shipId: number;
  tier: number;
  type: string;
}

interface CatDef {
  title: string;
  allLabel: string;
  /** Filter predicate for a concrete selection. */
  matches(row: PlayerShipStats, info: ShipMeta | null, value: string): boolean;
  /** Numeric sort key; direction comes from the chip's flag. */
  sortValue(row: PlayerShipStats, info: ShipMeta | null): number;
}

/** Canonical type ordering index — unknown types sort last. */
function typeRank(type: string): number {
  const idx = TYPE_ORDER.findIndex((k) => k && type.startsWith(k));
  return idx >= 0 ? idx : TYPE_ORDER.length;
}

const CAT_DEFS: Record<CatKey, CatDef> = {
  type: {
    title: "舰种",
    allLabel: "全部舰种",
    matches: (_row, info, value) => (info?.type ?? "").startsWith(value),
    sortValue: (_row, info) => typeRank(info?.type ?? ""),
  },
  tier: {
    title: "等级",
    allLabel: "全部等级",
    matches: (_row, info, value) => bracketTiers(value).includes(info?.tier ?? 0),
    sortValue: (_row, info) => info?.tier ?? 0,
  },
  winrate: {
    title: "胜率",
    allLabel: "全部胜率",
    matches: (row, _info, value) =>
      WINRATE_BRACKETS.find(([v]) => v === value)?.[2](row.winrate) ?? true,
    sortValue: (row) => row.winrate,
  },
  battles: {
    title: "场次",
    allLabel: "全部场次",
    matches: (row, _info, value) => row.battles >= (Number(value) || 0),
    sortValue: (row) => row.battles,
  },
};

const CAT_KEYS: CatKey[] = ["type", "tier", "winrate", "battles"];
const DEFAULT_ORDER: CatKey[] = [...CAT_KEYS];

// ── localStorage persistence (shared by every view hosting the bar) ──

const PERSIST_KEY = "wowsp.shipFilter.v2";

interface Persisted {
  order: CatKey[];
  sel: Partial<Record<CatKey, { value: string; dir: SortDir }>>;
}

function isValidTierValue(v: string): boolean {
  return bracketTiers(v).length > 0;
}
function isValidWinrateValue(v: string): boolean {
  return WINRATE_BRACKETS.some(([k]) => k === v);
}
function isValidBattleValue(v: string): boolean {
  return BATTLE_STEPS.some(([n]) => String(n) === v);
}

function loadPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Persisted;
    // Order must be a permutation of the four categories, else fall back.
    if (
      !Array.isArray(p.order) ||
      p.order.length !== CAT_KEYS.length ||
      !CAT_KEYS.every((k) => p.order.includes(k))
    ) {
      return null;
    }
    return p;
  } catch {
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

    // ── Chip state: drag order (= sort priority) + per-category selection ──
    const stored = loadPersisted();
    const order = ref<CatKey[]>(stored ? [...stored.order] : [...DEFAULT_ORDER]);
    const sel = ref<Record<CatKey, { value: string; dir: SortDir }>>({
      type: { value: "", dir: "desc" },
      tier: { value: "", dir: "desc" },
      winrate: { value: "", dir: "desc" },
      battles: { value: "", dir: "desc" },
    });
    if (stored) {
      for (const k of CAT_KEYS) {
        const s = stored.sel?.[k];
        if (!s || (s.dir !== "asc" && s.dir !== "desc")) continue;
        const ok =
          s.value === "" ||
          (k === "type" && TYPE_ORDER.some((t) => t && t === s.value)) ||
          (k === "tier" && isValidTierValue(s.value)) ||
          (k === "winrate" && isValidWinrateValue(s.value)) ||
          (k === "battles" && isValidBattleValue(s.value));
        if (ok) sel.value[k] = { value: s.value, dir: s.dir };
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
    const searchAnchor = ref<HTMLDivElement | null>(null);
    const chipsRow = ref<HTMLDivElement | null>(null);

    function onDocMouseDown(e: MouseEvent) {
      const search = searchAnchor.value;
      if (search && !search.contains(e.target as Node)) searchOpen.value = false;
      const row = chipsRow.value;
      if (row && !row.contains(e.target as Node)) openPop.value = null;
    }
    onMounted(() => document.addEventListener("mousedown", onDocMouseDown));
    onBeforeUnmount(() => {
      document.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("pointermove", onChipPointerMove);
      window.removeEventListener("pointerup", onChipPointerUp);
      window.removeEventListener("pointercancel", onChipPointerCancel);
    });

    onMounted(() => {
      // Pinia setup-store refs are auto-unwrapped — no `.value` here.
      if (props.realm && !encyclopedia.loadedRealm && !encyclopedia.loading) {
        void encyclopedia.load(props.realm).catch(() => {});
      }
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

    /** Option button groups per category. Type lists only types present in
     *  the data so dead buttons never show up. */
    const catOptions = computed<Record<CatKey, { value: string; label: string }[]>>(() => ({
      type: [
        { value: "", label: CAT_DEFS.type.allLabel },
        ...TYPE_ORDER.filter((k) => k && props.ships.some((s) => (infoOf(s.shipId)?.type ?? "").startsWith(k))).map(
          (k) => ({ value: k, label: t(`dashboard.shipType.${k}`, {}) }),
        ),
      ],
      tier: [
        { value: "", label: CAT_DEFS.tier.allLabel },
        ...TIER_FILTERS.map(([v, label]) => ({ value: v, label })),
      ],
      winrate: [
        { value: "", label: CAT_DEFS.winrate.allLabel },
        ...WINRATE_BRACKETS.map(([v, label]) => ({ value: v, label })),
      ],
      battles: [
        { value: "", label: CAT_DEFS.battles.allLabel },
        ...BATTLE_STEPS.map(([n, label]) => ({ value: String(n), label })),
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

    /** Active chips in drag order — each contributes one sort key. */
    const activeCats = computed(() => order.value.filter((k) => sel.value[k].value !== ""));

    const filteredShips = computed(() => {
      let rows = props.ships;
      const q = shipQuery.value.trim().toLowerCase();
      if (q) {
        rows = rows.filter((s) => hitNames.value.has(s.shipId));
      } else {
        for (const key of order.value) {
          const { value } = sel.value[key];
          if (!value) continue;
          const def = CAT_DEFS[key];
          rows = rows.filter((s) => def.matches(s, infoOf(s.shipId), value));
        }
      }
      // Multi-key sort: chips earlier in the drag order win; the final
      // battles-desc tiebreak keeps the no-selection view stable.
      return [...rows].sort((a, b) => {
        for (const key of activeCats.value) {
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

    /** Pick an option inside a category popup: empty value resets to the
     *  gray "全部…" state, a fresh value starts descending. Direction flips
     *  go through flipActiveClick — HTabs has radio semantics and never
     *  re-emits for the already-active option. */
    function pickOption(key: CatKey, value: string) {
      const cur = sel.value[key];
      if (value === "") {
        cur.value = "";
      } else {
        cur.value = value;
        cur.dir = "desc";
      }
    }

    /** Wrapper click for the popup's HTabs: an already-active trigger never
     *  re-emits, so its click bubbles here and flips the 正序/倒序 flag. */
    function flipActiveClick(e: MouseEvent, key: CatKey) {
      const trigger = (e.target as HTMLElement | null)?.closest(".hk-tabs-trigger");
      const cur = sel.value[key];
      if (trigger?.hasAttribute("data-active") && cur.value !== "") {
        cur.dir = cur.dir === "desc" ? "asc" : "desc";
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

    const dirIcon = (dir: SortDir) =>
      dir === "desc" ? <ArrowDown size={11} class="ship-filter-bar__dir" /> : <ArrowUp size={11} class="ship-filter-bar__dir" />;

    return () => (
      <div ref={chipsRow} class="ship-filter-bar" data-dragging={chipDragging.value || undefined}>
        {order.value.map((key) => {
          const def = CAT_DEFS[key];
          const cur = sel.value[key];
          const isActive = cur.value !== "";
          const activeLabel =
            catOptions.value[key].find((o) => o.value === cur.value)?.label ?? cur.value;
          return (
            <div
              key={key}
              class="ship-filter-bar__chip-anchor"
              data-edge={key === order.value[order.value.length - 1] || undefined}
            >
              <button
                type="button"
                ref={(el) => {
                  chipEls.set(key, (el as HTMLElement | null) ?? null);
                }}
                class={[
                  "ship-filter-bar__chip",
                  isActive ? "ship-filter-bar__chip--on" : "ship-filter-bar__chip--all",
                ]}
                data-chip={key}
                data-dragging={chipDragging.value === key || undefined}
                title="点击选择筛选 · 再次点击已选项切换正序/倒序 · 左右拖拽调整排序优先级"
                onPointerdown={(e: PointerEvent) => onChipPointerDown(e, key)}
                onClick={() => onChipClick(key)}
              >
                <GripHorizontal size={12} class="ship-filter-bar__chip-grip" />
                <span>{isActive ? activeLabel : def.allLabel}</span>
                {isActive ? dirIcon(cur.dir) : null}
              </button>
              {openPop.value === key ? (
                <div class="ship-filter-bar__pop">
                  <div class="ship-filter-bar__pop-head">
                    <span>{def.title}</span>
                    <button
                      type="button"
                      class="ship-filter-bar__pop-close"
                      onClick={() => (openPop.value = null)}
                    >
                      ✕
                    </button>
                  </div>
                  {/* The category's original segmented button group; the
                      wrapper lets an already-active option flip direction. */}
                  <span class="ship-filter-bar__pop-tabs" onClick={(e: MouseEvent) => flipActiveClick(e, key)}>
                    <HTabs
                      variant="segmented"
                      modelValue={cur.value}
                      onUpdate:modelValue={(v: string) => pickOption(key, v)}
                      tabs={catOptions.value[key].map((o) => ({
                        key: o.value,
                        label: o.label,
                        icon:
                          isActive && cur.value === o.value ? dirIcon(cur.dir) : undefined,
                      }))}
                    />
                  </span>
                  <div class="ship-filter-bar__pop-hint">再次点击已选项切换 正序 ↑ / 倒序 ↓</div>
                </div>
              ) : null}
            </div>
          );
        })}
        <span class="ship-filter-bar__summary">
          {filteredShips.value.length} 艘 · {totalBattles.value.toLocaleString()} 场
        </span>
        {/* Search — one button; the input lives in a popup panel that opens
            leftwards from the button (roomier than an inline box). The
            button stays highlighted while a query is in effect so the
            bypass-everything state is never invisible. */}
        <div ref={searchAnchor} class="ship-filter-bar__search-anchor">
          <button
            type="button"
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
          {searchOpen.value ? (
            <div class="ship-filter-bar__search-panel">
              <div class="ship-filter-bar__search-panel-head">
                <span>{t("common.search.fuzzy")}</span>
                <button
                  type="button"
                  class="ship-filter-bar__search-close"
                  onClick={() => (searchOpen.value = false)}
                >
                  ✕
                </button>
              </div>
              <HSearchInput
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
          ) : null}
        </div>
      </div>
    );
  },
});

