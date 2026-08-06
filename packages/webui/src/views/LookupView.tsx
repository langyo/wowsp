import { computed, defineComponent, onMounted, ref } from "vue";
import { useRoute } from "vue-router";

import StatsCard from "@/components/stats/StatsCard";
import SButton from "@/components/base/SButton";
import SSelect from "@/components/base/SSelect";
import { useStatsStore } from "@/stores/stats";
import { useShipStatsStore } from "@/stores/shipStats";
import { useToast } from "@/composables/useToast";
import { shipOfflineEntry } from "@/features/holographic/modelLoader";
import { shipIcon } from "@/features/holographic/shipIcons";
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

    /** Per-ship rows enriched with offline tier/type for grouping. */
    const shipRows = computed<PlayerShipStats[]>(() => {
      const acc = result.value;
      if (!acc) return [];
      return shipStats.cache.get(`${realm.value}_${acc.accountId}`) ?? [];
    });
    const grouped = computed(() => {
      const byType = new Map<string, PlayerShipStats[]>();
      for (const s of shipRows.value) {
        const off = shipOfflineEntry(s.shipId);
        const type = off?.type ?? "";
        const key = TYPE_ORDER.find((k) => k && type.startsWith(k)) ?? "";
        if (!byType.has(key)) byType.set(key, []);
        byType.get(key)!.push(s);
      }
      const out: { key: string; ships: PlayerShipStats[] }[] = [];
      for (const key of TYPE_ORDER) {
        const ships = byType.get(key);
        if (ships && ships.length > 0) {
          ships.sort((a, b) => b.battles - a.battles);
          out.push({ key, ships });
        }
      }
      return out;
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
                <div class="lookup-view__ships">
                  {grouped.value.map((g) => (
                    <div class="lookup-view__shipgroup" key={g.key}>
                      <div class="lookup-view__shipgroup-title">
                        {g.key ? t(`dashboard.shipType.${g.key}`, {}) : t("dashboard.shipType.Unknown", {})}
                        <em>{g.ships.reduce((a, s) => a + s.battles, 0)} 场</em>
                      </div>
                      <div class="lookup-view__shiplist">
                        {g.ships.map((s) => {
                          const off = shipOfflineEntry(s.shipId);
                          const icon = shipIcon(off?.type ?? "", "plain");
                          return (
                            <div class="lookup-view__ship" key={s.shipId}>
                              <span class="lookup-view__ship-ico">
                                {icon && icon.complete && icon.naturalWidth > 0 ? (
                                  <img src={icon.src} width={22} height={22} alt="" />
                                ) : null}
                              </span>
                              <span class="lookup-view__ship-name">
                                {s.name}
                                {off?.tier != null ? (
                                  <em class="lookup-view__ship-tier">{off.tier}</em>
                                ) : null}
                              </span>
                              <span class="lookup-view__ship-battles">{s.battles}</span>
                              <span class="lookup-view__ship-wr">{s.winrate.toFixed(1)}%</span>
                              <span class="lookup-view__ship-dmg">{s.avgDamage.toLocaleString()}</span>
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
