/**
 * ShipFilterBar — business component that packages ALL ship-table filtering
 * (group dimension + level-2 filters + sort + fuzzy search + min-battles +
 * summary) into one card, like StatsCard. Emits `change` with the filtered
 * list whenever any control moves.
 *
 * Data source: the ship encyclopedia (full WG API ship list, loaded lazily
 * by realm) with the offline database as fallback — so new ships never
 * vanish from filters.
 */
import { computed, defineComponent, onMounted, ref, watch } from "vue";
import type { PlayerShipStats } from "@/api";

import SSegmented from "@/components/base/SSegmented";
import SSearchInput from "@/components/base/SSearchInput";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { shipOfflineEntry } from "@/features/holographic/modelLoader";
import { matchShipNames } from "@/features/search/pinyinSearch";
import { t } from "@/i18n";
import "./ShipFilterBar.scss";

const TYPE_ORDER = ["Battleship", "AirCarrier", "Cruiser", "Destroyer", "Submarine", ""];
const TYPE_SHORT: Record<string, string> = {
  Battleship: "BB",
  AirCarrier: "CV",
  Cruiser: "CA",
  Destroyer: "DD",
  Submarine: "SS",
  Unknown: "?",
};
const NATION_LABELS: Record<string, string> = {
  usa: "美国",
  japan: "日本",
  germany: "德国",
  uk: "英国",
  france: "法国",
  ussr: "苏联",
  italy: "意大利",
  pan_asia: "泛亚",
  pan_europe: "泛欧",
  pan_america: "泛美",
  netherlands: "荷兰",
  sweden: "瑞典",
  poland: "波兰",
  europe: "欧洲",
  commonwealth: "英联邦",
  spain: "西班牙",
};
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

export interface FilterState {
  ships: PlayerShipStats[];
  groupMode: "type" | "nation" | "tier";
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

    const groupMode = ref<"type" | "nation" | "tier">("type");
    const typeFilter = ref("");
    const nationFilter = ref("");
    const tierFilter = ref("");
    const minBattles = ref("");
    const sortKey = ref<"battles" | "winrate" | "avgDamage">("battles");
    const sortDir = ref<"desc" | "asc">("desc");
    const shipQuery = ref("");

    onMounted(() => {
      // Pinia setup-store refs are auto-unwrapped — no `.value` here.
      if (props.realm && !encyclopedia.loadedRealm && !encyclopedia.loading) {
        void encyclopedia.load(props.realm).catch(() => {});
      }
    });

    /** Unified ship metadata: encyclopedia first (full API list), offline
     *  DB as fallback for brand-new ships. */
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
            name: off.names?.["zh-CN"] ?? off.names?.["en-US"] ?? `#${shipId}`,
          }
        : null;
    };

    const nations = computed(() => {
      const set = new Set<string>();
      for (const s of props.ships) {
        const info = infoOf(s.shipId);
        if (info?.nation) set.add(info.nation);
      }
      return [...set].sort();
    });

    /** Search hits (shipId → matched name) — fuzzy + multilingual. */
    const hitNames = computed(() => {
      const hits = new Map<number, string>();
      if (!shipQuery.value.trim()) return hits;
      for (const s of props.ships) {
        const info = infoOf(s.shipId);
        const names = info ? { "zh-CN": info.name } : undefined;
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

    const filteredShips = computed(() => {
      let rows = props.ships;
      const q = shipQuery.value.trim().toLowerCase();
      if (q) {
        rows = rows.filter((s) => hitNames.value.has(s.shipId));
      } else {
        if (typeFilter.value) {
          rows = rows.filter((s) => (infoOf(s.shipId)?.type ?? "").startsWith(typeFilter.value));
        }
        if (nationFilter.value) {
          rows = rows.filter((s) => infoOf(s.shipId)?.nation === nationFilter.value);
        }
        if (tierFilter.value) {
          const tiers = bracketTiers(tierFilter.value);
          rows = rows.filter((s) => tiers.includes(infoOf(s.shipId)?.tier ?? 0));
        }
        if (minBattles.value) {
          const min = Number(minBattles.value) || 0;
          rows = rows.filter((s) => s.battles >= min);
        }
      }
      const dir = sortDir.value === "desc" ? -1 : 1;
      return [...rows].sort((a, b) =>
        sortKey.value === "battles"
          ? (b.battles - a.battles) * dir
          : sortKey.value === "winrate"
            ? (b.winrate - a.winrate) * dir
            : (b.avgDamage - a.avgDamage) * dir,
      );
    });

    function toggleSort(key: typeof sortKey.value) {
      if (sortKey.value === key) {
        sortDir.value = sortDir.value === "desc" ? "asc" : "desc";
      } else {
        sortKey.value = key;
        sortDir.value = "desc";
      }
    }

    watch(filteredShips, () => {
      emit("change", {
        ships: filteredShips.value,
        groupMode: groupMode.value,
        hits: hitNames.value,
      });
    }, { immediate: true });

    const totalBattles = computed(() => filteredShips.value.reduce((a, s) => a + s.battles, 0));

    const typeOptions = () => [
      { value: "", label: "全部" },
      ...TYPE_ORDER.filter((k) => k && props.ships.some((s) => (infoOf(s.shipId)?.type ?? "").startsWith(k))).map((k) => ({
        value: k,
        label: t(`dashboard.shipType.${k}`, {}),
      })),
    ];
    const tierOptions = () => [
      { value: "", label: "全部" },
      ...TIER_FILTERS.map(([k, label]) => ({ value: k, label })),
    ];

    return () => (
      <div class="ship-filter-bar">
        <div class="ship-filter-bar__head">
          <span class="ship-filter-bar__title">舰船筛选</span>
          <span class="ship-filter-bar__summary">
            {filteredShips.value.length} 艘 · {totalBattles.value.toLocaleString()} 场
          </span>
        </div>
        <div class="ship-filter-bar__row">
          <SSegmented
            modelValue={groupMode.value}
            onUpdate:modelValue={(v: string) => (groupMode.value = v as typeof groupMode.value)}
            options={[
              { value: "type", label: t("dashboard.byType") },
              { value: "nation", label: t("dashboard.byNation") },
              { value: "tier", label: t("dashboard.byTier") },
            ]}
          />
          {!shipQuery.value.trim() ? (
            groupMode.value === "type" ? (
              <SSegmented
                modelValue={typeFilter.value}
                onUpdate:modelValue={(v: string) => (typeFilter.value = v)}
                options={typeOptions()}
              />
            ) : groupMode.value === "nation" ? (
              <SSegmented
                modelValue={nationFilter.value}
                onUpdate:modelValue={(v: string) => (nationFilter.value = v)}
                options={[
                  { value: "", label: "全部" },
                  ...nations.value.map((n) => ({ value: n, label: NATION_LABELS[n] ?? n })),
                ]}
              />
            ) : (
              <SSegmented
                modelValue={tierFilter.value}
                onUpdate:modelValue={(v: string) => (tierFilter.value = v)}
                options={tierOptions()}
              />
            )
          ) : null}
        </div>
        <div class="ship-filter-bar__row">
          <SSegmented
            modelValue={minBattles.value}
            onUpdate:modelValue={(v: string) => (minBattles.value = v)}
            options={[
              { value: "", label: "全部场次" },
              { value: "10", label: "≥10 场" },
              { value: "50", label: "≥50 场" },
              { value: "100", label: "≥100 场" },
            ]}
          />
          <div class="ship-filter-bar__sort">
            {(
              [
                ["battles", t("dashboard.battles")],
                ["winrate", t("dashboard.winrate")],
                ["avgDamage", t("dashboard.avgDamage")],
              ] as [typeof sortKey.value, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                class={["ship-filter-bar__sort-btn", sortKey.value === key ? "ship-filter-bar__sort-btn--on" : ""]}
                onClick={() => toggleSort(key)}
              >
                {label}
                {sortKey.value === key ? (sortDir.value === "desc" ? " ↓" : " ↑") : null}
              </button>
            ))}
          </div>
          <SSearchInput
            modelValue={shipQuery.value}
            onUpdate:modelValue={(v: string) => (shipQuery.value = v)}
            onPick={(v: string) => (shipQuery.value = v)}
            placeholder={t("common.search.fuzzy")}
            candidates={searchCandidates.value}
            class="ship-filter-bar__search"
          />
        </div>
      </div>
    );
  },
});

export { TYPE_ORDER, TYPE_SHORT, NATION_LABELS };
