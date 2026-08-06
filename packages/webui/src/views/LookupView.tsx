import { computed, defineComponent, onMounted, ref } from "vue";
import { useRoute } from "vue-router";

import StatsCard from "@/components/stats/StatsCard";
import ShipDistCharts from "@/components/stats/ShipDistCharts";
import SButton from "@/components/base/SButton";
import SSelect from "@/components/base/SSelect";
import SSegmented from "@/components/base/SSegmented";
import SSearchInput from "@/components/base/SSearchInput";
import { useStatsStore } from "@/stores/stats";
import { useShipStatsStore } from "@/stores/shipStats";
import { useToast } from "@/composables/useToast";
import { shipOfflineEntry } from "@/features/holographic/modelLoader";
import { shipIcon } from "@/features/holographic/shipIcons";
import { searchShips } from "@/features/search/pinyinSearch";
import { winrateColor } from "@/utils/winrate";
import type { PlayerStats, PlayerShipStats } from "@/api";
import { t } from "@/i18n";
import "./LookupView.scss";

interface HistoryEntry {
  name: string;
  realm: string;
  time: number;
}

const HISTORY_KEY = "wowsp.lookup.history";
const HISTORY_MAX = 20;

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as HistoryEntry[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveHistory(h: HistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, HISTORY_MAX)));
  } catch {
    /* storage full / unavailable — ignore */
  }
}

/** Ship-type groups for the per-ship list, biggest first (i18n keys are
 *  capitalized, mirroring DashboardView). */
const TYPE_ORDER = ["Battleship", "AirCarrier", "Cruiser", "Destroyer", "Submarine", ""];
const TYPE_SHORT: Record<string, string> = {
  Battleship: "BB",
  AirCarrier: "CV",
  Cruiser: "CA",
  Destroyer: "DD",
  Submarine: "SS",
  Unknown: "?",
};

/** Full Chinese names for the type filter row. */
const TYPE_FILTERS: [string, string][] = [
  ["AirCarrier", "航母"],
  ["Battleship", "战列"],
  ["Cruiser", "巡洋"],
  ["Destroyer", "驱逐"],
  ["Submarine", "潜艇"],
];

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

export default defineComponent({
  name: "LookupView",
  setup() {
    const stats = useStatsStore();
    const shipStats = useShipStatsStore();
    const toast = useToast();
    const route = useRoute();
    const nickname = ref("");
    const realm = ref("asia");
    const realms = ["ru", "eu", "na", "asia"];
    const result = ref<PlayerStats | null>(null);
    const history = ref<HistoryEntry[]>(loadHistory());
    const groupMode = ref<"type" | "nation" | "tier">("type");
    const sortKey = ref<"battles" | "winrate" | "avgDamage">("battles");
    const sortDir = ref<"desc" | "asc">("desc");
    // Level-2 filters (per groupMode); "" = all.
    const typeFilter = ref("");
    const nationFilter = ref("");
    const tierFilter = ref("");
    // Ship-name search — while non-empty, the type/nation/tier filters are
    // ignored (only the sort order still applies).
    const shipQuery = ref("");

    function toggleSort(key: typeof sortKey.value) {
      if (sortKey.value === key) {
        sortDir.value = sortDir.value === "desc" ? "asc" : "desc";
      } else {
        sortKey.value = key;
        sortDir.value = "desc";
      }
    }

    /** Nations present in the current result (for the nation filter row). */
    const nations = computed(() => {
      const set = new Set<string>();
      for (const s of shipRows.value) {
        const off = shipOfflineEntry(s.shipId);
        if (off?.nation) set.add(off.nation);
      }
      return [...set].sort();
    });

    /** Ships after name search / level-2 filters (search wins over filters). */
    /** Search hits (shipId → matched language/name) — set while searching. */
    const hitNames = computed(() =>
      searchShips(
        shipRows.value,
        shipQuery.value,
        (s) => shipOfflineEntry(s.shipId)?.names,
      ),
    );
    /** Display name for a ship row: the search-matched language when
     *  searching, otherwise the plain (English) name. */
    function displayName(s: PlayerShipStats): string {
      const hit = hitNames.value.get(s.shipId);
      return hit?.matchedName ?? s.name;
    }

    /** Dropdown candidates for the search box (matched ships). */
    const searchCandidates = computed(() =>
      [...hitNames.value.entries()].map(([shipId, hit]) => {
        const off = shipOfflineEntry(shipId);
        const tier = off?.tier != null ? `T${off.tier}` : "";
        return { value: hit.matchedName, label: hit.matchedName, sub: tier };
      }),
    );

    const filteredShips = computed(() => {
      let rows = shipRows.value;
      const q = shipQuery.value.trim().toLowerCase();
      if (q) {
        rows = rows.filter((s) => hitNames.value.has(s.shipId));
      } else {
        if (typeFilter.value) {
          rows = rows.filter((s) =>
            (shipOfflineEntry(s.shipId)?.type ?? "").startsWith(typeFilter.value!),
          );
        }
        if (nationFilter.value) {
          rows = rows.filter((s) => shipOfflineEntry(s.shipId)?.nation === nationFilter.value);
        }
        if (tierFilter.value) {
          const bracket = TIER_FILTERS.find(([k]) => k === tierFilter.value);
          const tiers = bracket ? bracketTiers(bracket[0]) : [];
          rows = rows.filter((s) => tiers.includes(shipOfflineEntry(s.shipId)?.tier ?? 0));
        }
      }
      return rows;
    });

    /** Per-ship rows enriched with offline tier/type for grouping. */
    const shipRows = computed<PlayerShipStats[]>(() => {
      const acc = result.value;
      if (!acc) return [];
      return shipStats.cache.get(`${realm.value}_${acc.accountId}`) ?? [];
    });
    const grouped = computed(() => {
      const rows = [...filteredShips.value];
      const dir = sortDir.value === "desc" ? -1 : 1;
      rows.sort((a, b) =>
        sortKey.value === "battles"
          ? (b.battles - a.battles) * dir
          : sortKey.value === "winrate"
            ? (b.winrate - a.winrate) * dir
            : (b.avgDamage - a.avgDamage) * dir,
      );
      if (groupMode.value === "type") {
        const byType = new Map<string, PlayerShipStats[]>();
        for (const s of rows) {
          const off = shipOfflineEntry(s.shipId);
          const type = off?.type ?? "";
          const key = TYPE_ORDER.find((k) => k && type.startsWith(k)) ?? "";
          if (!byType.has(key)) byType.set(key, []);
          byType.get(key)!.push(s);
        }
        return TYPE_ORDER.filter((k) => byType.has(k)).map((k) => ({
          key: k,
          label: k ? t(`dashboard.shipType.${k}`, {}) : t("dashboard.shipType.Unknown", {}),
          ships: byType.get(k)!,
        }));
      }
      if (groupMode.value === "nation") {
        const byNation = new Map<string, PlayerShipStats[]>();
        for (const s of rows) {
          const off = shipOfflineEntry(s.shipId);
          const nation = off?.nation ?? "unknown";
          if (!byNation.has(nation)) byNation.set(nation, []);
          byNation.get(nation)!.push(s);
        }
        return [...byNation.entries()].map(([k, ships]) => ({ key: k, label: k, ships }));
      }
      // tier brackets (mirrors Dashboard)
      const brackets: [string, string, number[]][] = [
        ["I–V", "I – V", [1, 2, 3, 4, 5]],
        ["VI–VII", "VI – VII", [6, 7]],
        ["VIII–IX", "VIII – IX", [8, 9]],
        ["X–★", "X – ★", [10, 11]],
      ];
      return brackets
        .map(([key, label, tiers]) => ({
          key: key,
          label: label,
          ships: rows.filter((s) => tiers.includes(shipOfflineEntry(s.shipId)?.tier ?? 0)),
        }))
        .filter((g) => g.ships.length > 0);
    });
    /** Per-type summary cards (battles + winrate), matching the Dashboard. */
    const typeSummary = computed(() => {
      const rows = filteredShips.value;
      const m = new Map<string, { battles: number; wins: number }>();
      for (const s of rows) {
        const off = shipOfflineEntry(s.shipId);
        const type = off?.type ?? "";
        const key = TYPE_ORDER.find((k) => k && type.startsWith(k)) ?? "";
        const e = m.get(key) ?? { battles: 0, wins: 0 };
        e.battles += s.battles;
        e.wins += s.wins;
        m.set(key, e);
      }
      return TYPE_ORDER.filter((k) => m.has(k)).map((k) => {
        const e = m.get(k)!;
        return {
          type: k,
          code: TYPE_SHORT[k] ?? "?",
          battles: e.battles,
          winrate: e.battles > 0 ? (e.wins / e.battles) * 100 : 0,
        };
      });
    });

    function pushHistory(name: string, r: string) {
      const h = history.value.filter((e) => !(e.name === name && e.realm === r));
      h.unshift({ name, realm: r, time: Date.now() });
      history.value = h;
      saveHistory(h);
    }

    async function doSearch(name?: string, r?: string) {
      const nm = (name ?? nickname.value).trim();
      const rl = r ?? realm.value;
      if (!nm) return;
      nickname.value = nm;
      realm.value = rl;
      result.value = null;
      const toastId = toast.loading(t("account.searching"));
      try {
        const acc = await stats.lookup(nm, rl);
        result.value = acc;
        pushHistory(nm, rl);
        // Per-ship stats load in the background (toast stays until done).
        await shipStats.load(acc.accountId, rl).catch(() => {});
      } catch {
        // error surfaced via stats.error
      } finally {
        toast.dismiss(toastId);
      }
    }

    async function search() {
      await doSearch();
    }

    // Jump-in support: /lookup?name=..&realm=.. (from the replay post-battle
    // player detail) starts a search immediately.
    onMounted(() => {
      const q = route.query;
      const name = typeof q.name === "string" ? q.name : "";
      if (!name) return;
      const r = typeof q.realm === "string" && realms.includes(q.realm) ? q.realm : "asia";
      void doSearch(name, r);
    });

    return () => (
      <div class="lookup-view">
        {/* Level-2 sidebar: search on top, query history below */}
        <aside class="lookup-view__sidebar">
          <div class="lookup-view__search">
            <SSelect
              modelValue={realm.value}
              onUpdate:modelValue={(v: string) => (realm.value = v)}
              options={realms.map((r) => ({ value: r, label: r.toUpperCase() }))}
            />
            <input
              class="lookup-view__input"
              type="text"
              placeholder={t("account.nickname")}
              value={nickname.value}
              onInput={(e) => (nickname.value = (e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void search();
              }}
            />
            <SButton size="md" onClick={() => void search()} loading={stats.loading}>
              {t("account.search")}
            </SButton>
          </div>
          <div class="lookup-view__history">
            <div class="lookup-view__history-title">查询记录</div>
            {history.value.length === 0 ? (
              <div class="lookup-view__history-empty">暂无记录</div>
            ) : (
              history.value.map((h) => (
                <button
                  key={`${h.realm}_${h.name}`}
                  class={[
                    "lookup-view__history-item",
                    h.name === result.value?.name && h.realm === realm.value
                      ? "lookup-view__history-item--active"
                      : "",
                  ]}
                  onClick={() => void doSearch(h.name, h.realm)}
                >
                  <span class="lookup-view__history-name">{h.name}</span>
                  <span class="lookup-view__history-realm">{h.realm.toUpperCase()}</span>
                </button>
              ))
            )}
          </div>
        </aside>

        {/* Main content: overview card + per-ship list */}
        <div class="lookup-view__main">
          <h1 class="lookup-view__title">{t("nav.lookup")}</h1>
          {stats.error ? <div class="lookup-view__error">{stats.error}</div> : null}
          <Transition name="s-fade-slide" mode="out-in">
            {result.value ? (
              <div class="lookup-view__result" key="result">
                <StatsCard stats={result.value} />
                {/* Ship distribution charts */}
                {shipRows.value.length > 0 ? (
                  <div class="lookup-view__dist">
                    <div class="lookup-view__dist-title">舰船分布</div>
                    <ShipDistCharts
                      ships={shipRows.value.map((s) => ({ shipId: s.shipId, battles: s.battles }))}
                    />
                  </div>
                ) : null}
                <div class="lookup-view__controls">
                  <div class="lookup-view__controlrow">
                    <SSegmented
                      modelValue={groupMode.value}
                      onUpdate:modelValue={(v: string) => (groupMode.value = v as typeof groupMode.value)}
                      options={[
                        { value: "type", label: t("dashboard.byType") },
                        { value: "nation", label: t("dashboard.byNation") },
                        { value: "tier", label: t("dashboard.byTier") },
                      ]}
                    />
                  </div>
                  {/* Level-2 filter row (per groupMode) — segmented button group */}
                  {shipQuery.value.trim() === "" ? (
                    <div class="lookup-view__controlrow">
                      {groupMode.value === "type" ? (
                        <SSegmented
                          modelValue={typeFilter.value}
                          onUpdate:modelValue={(v: string) => (typeFilter.value = v)}
                          options={[
                            { value: "", label: "全部" },
                            ...TYPE_FILTERS.map(([key, label]) => ({ value: key, label })),
                          ]}
                        />
                      ) : groupMode.value === "nation" ? (
                        <SSegmented
                          modelValue={nationFilter.value}
                          onUpdate:modelValue={(v: string) => (nationFilter.value = v)}
                          options={[
                            { value: "", label: "全部" },
                            ...nations.value.map((n) => ({
                              value: n,
                              label: NATION_LABELS[n] ?? n,
                            })),
                          ]}
                        />
                      ) : (
                        <SSegmented
                          modelValue={tierFilter.value}
                          onUpdate:modelValue={(v: string) => (tierFilter.value = v)}
                          options={[
                            { value: "", label: "全部" },
                            ...TIER_FILTERS.map(([key, label]) => ({ value: key, label })),
                          ]}
                        />
                      )}
                    </div>
                  ) : null}
                  <div class="lookup-view__controlrow">
                    {/* Sort keys with asc/desc toggle */}
                    {(
                      [
                        ["battles", t("dashboard.battles")],
                        ["winrate", t("dashboard.winrate")],
                        ["avgDamage", t("dashboard.avgDamage")],
                      ] as [typeof sortKey.value, string][]
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        class={["lookup-view__sort", sortKey.value === key ? "lookup-view__sort--on" : ""]}
                        onClick={() => toggleSort(key)}
                      >
                        {label}
                        {sortKey.value === key ? (sortDir.value === "desc" ? " ↓" : " ↑") : null}
                      </button>
                    ))}
                    {/* Ship search — same row as the sort group, right-aligned;
                        fuzzy via the shared pinyin module, with a dropdown of
                        candidates. */}
                    <SSearchInput
                      modelValue={shipQuery.value}
                      onUpdate:modelValue={(v: string) => (shipQuery.value = v)}
                      onPick={(v: string) => (shipQuery.value = v)}
                      placeholder={t("common.search.fuzzy")}
                      candidates={searchCandidates.value}
                      class="lookup-view__search"
                    />
                  </div>
                </div>
                {/* Per-type summary cards */}
                {typeSummary.value.length > 0 ? (
                  <div class="lookup-view__typegrid">
                    {typeSummary.value.map((ts) => (
                      <div class="lookup-view__typecard" key={ts.type}>
                        <span class="lookup-view__typecard-code">{ts.code}</span>
                        <span class="lookup-view__typecard-battles">{ts.battles.toLocaleString()}</span>
                        <span style={{ color: winrateColor(ts.winrate) }}>{ts.winrate.toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {/* Grouped ship table */}
                <div class="lookup-view__ships">
                  {grouped.value.map((g) => (
                    <div class="lookup-view__shipgroup" key={g.key}>
                      <div class="lookup-view__shipgroup-title">
                        {g.label}
                        <em>{g.ships.reduce((a, s) => a + s.battles, 0)} 场</em>
                      </div>
                      <div class="lookup-view__shiplist">
                        {g.ships.map((s) => {
                          const off = shipOfflineEntry(s.shipId);
                          const icon = shipIcon(off?.type ?? "", "plain");
                          const typeKey = TYPE_ORDER.find((k) => k && (off?.type ?? "").startsWith(k)) ?? "";
                          return (
                            <div class="lookup-view__ship" key={s.shipId}>
                              <span class="lookup-view__ship-ico">
                                {icon && icon.complete && icon.naturalWidth > 0 ? (
                                  <img src={icon.src} width={22} height={22} alt="" />
                                ) : null}
                              </span>
                              <span class="lookup-view__ship-type">{TYPE_SHORT[typeKey] ?? "?"}</span>
                              <span class="lookup-view__ship-name">
                                {displayName(s)}
                                {off?.tier != null ? (
                                  <em class="lookup-view__ship-tier">{off.tier}</em>
                                ) : null}
                              </span>
                              <span class="lookup-view__ship-battles">{s.battles.toLocaleString()}</span>
                              <span
                                class="lookup-view__ship-wr"
                                style={{ color: winrateColor(s.winrate), fontWeight: 600 }}
                              >
                                {s.winrate.toFixed(1)}%
                              </span>
                              <span class="lookup-view__ship-dmg">{Math.round(s.avgDamage).toLocaleString()}</span>
                              <span class="lookup-view__ship-kd">
                                {(s.frags / Math.max(1, s.battles)).toFixed(2)}
                              </span>
                              <span class="lookup-view__ship-date">
                                {s.lastBattleTime
                                  ? new Date(s.lastBattleTime * 1000).toLocaleDateString()
                                  : "—"}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </Transition>
        </div>
      </div>
    );
  },
});
