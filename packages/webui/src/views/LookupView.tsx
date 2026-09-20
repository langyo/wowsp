import { computed, defineComponent, onMounted, ref, Transition } from "vue";
import { useRoute } from "vue-router";

import StatsCard from "@/components/stats/StatsCard";
import ClanCard from "@/components/stats/ClanCard";
import ShipDistCharts from "@/components/stats/ShipDistCharts";
import AsyncSearchCombo from "@/components/search/AsyncSearchCombo";
import { HTabs, useToast } from "@celestia-island/hikari";
import { User, Users } from "@lucide/vue";

import ShipFilterBar from "@/components/ships/ShipFilterBar";
import ShipDetailModal from "@/components/ships/ShipDetailModal";
import { useShipDetail } from "@/composables/useShipDetail";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useStatsStore } from "@/stores/stats";
import { useClanStatsStore, clanCacheKey } from "@/stores/clanStats";
import { useRankedStore } from "@/stores/ranked";
import { useShipStatsStore } from "@/stores/shipStats";
import { shipNameFromModelDb, shipOfflineEntry, shipNameFromOfflineDb } from "@/features/holographic/modelLoader";
import { shipIcon } from "@/features/holographic/shipIcons";
import { winrateColor } from "@/utils/winrate";
import {
  computeRecentDelta,
  dateRangeCutoff,
  filterByDateRange,
  type DateRange,
} from "@/utils/shipAggregation";
import { api, type ClanInfo, type ClanSuggestion, type PlayerShipStats, type PlayerSuggestion, type PlayerStats } from "@/api";
import { t } from "@/i18n";
import "./LookupView.scss";

/** Lookup target — the second sidebar row's segmented group. */
type LookupKind = "player" | "clan";

interface HistoryEntry {
  kind: LookupKind;
  /** Display name (player nickname or clan tag). */
  name: string;
  realm: string;
  /** accountId (player) or clanId (clan) — the replay key. */
  id?: number;
  time: number;
}

const HISTORY_KEY = "wowsp.lookup.history";
const HISTORY_MAX = 20;

/** Last successful lookup, kept at module scope so route switches don't
 *  lose the result view: LookupView unmounts on navigation (no KeepAlive),
 *  but on remount the overview card + ship table re-seed from the stats
 *  stores' in-memory caches — no WG API re-hit. */
const lastLookup = ref<{
  kind: LookupKind;
  name: string;
  realm: string;
  id: number;
} | null>(null);

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as (HistoryEntry & { kind?: LookupKind })[];
    if (!Array.isArray(arr)) return [];
    // Entries written before clan lookup existed carry no kind — they are
    // player lookups by definition.
    return arr
      .filter((e) => e && typeof e.name === "string")
      .map((e) => ({
        kind: e.kind === "clan" ? "clan" : "player",
        name: e.name,
        realm: e.realm,
        id: e.id,
        time: e.time,
      }));
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

/** Ship-type canonical order for summary cards + row badges, biggest first
 *  (i18n keys are capitalized, mirroring DashboardView). */
const TYPE_ORDER = ["Battleship", "AirCarrier", "Cruiser", "Destroyer", "Submarine", ""];
const TYPE_SHORT: Record<string, string> = {
  Battleship: "BB",
  AirCarrier: "CV",
  Cruiser: "CA",
  Destroyer: "DD",
  Submarine: "SS",
  Unknown: "?",
};


export default defineComponent({
  name: "LookupView",
  setup() {
    const stats = useStatsStore();
    const clanStats = useClanStatsStore();
    const shipStats = useShipStatsStore();
    const ranked = useRankedStore();
    const toast = useToast();
    const route = useRoute();
    const mode = ref<LookupKind>(lastLookup.value?.kind ?? "player");
    const realm = ref(lastLookup.value?.realm ?? "asia");
    const realms = ["ru", "eu", "na", "asia", "cn"];
    const result = ref<PlayerStats | null>(
      lastLookup.value?.kind === "player"
        ? (stats.cache.get(`${lastLookup.value.realm}_${lastLookup.value.id}`) ?? null)
        : null,
    );
    const clanResult = ref<ClanInfo | null>(
      lastLookup.value?.kind === "clan"
        ? (clanStats.cache.get(clanCacheKey(lastLookup.value.realm, lastLookup.value.id)) ?? null)
        : null,
    );
    const history = ref<HistoryEntry[]>(loadHistory());
    const encyclopedia = useEncyclopediaStore();

    // Ship detail popup (opened from the per-ship table rows). The player
    // context is the LOOKED-UP account, not the bound one.
    const shipDetail = useShipDetail();

    /** Unified ship metadata: encyclopedia first, offline DB fallback. */
    const infoOf = (shipId: number) => {
      const enc = encyclopedia.byId.get(shipId);
      if (enc) return enc;
      const off = shipOfflineEntry(shipId);
      return off
        ? { shipId, tier: off.tier ?? 0, type: off.type ?? "", nation: off.nation ?? "" }
        : null;
    };

    /** Filtered + multi-key-sorted ships and search-hit names, from
     *  ShipFilterBar (the chip drag order defines the sort priority). */
    const filterState = ref<{
      ships: PlayerShipStats[];
      hits: Map<number, string>;
    }>({ ships: [], hits: new Map() });
    const filteredShips = computed(() => filterState.value.ships);
    function displayName(s: PlayerShipStats): string {
      return (
        filterState.value.hits.get(s.shipId) ??
        encyclopedia.byId.get(s.shipId)?.name ??
        shipNameFromOfflineDb(s.shipId, "zh-CN") ??
        (s.name || shipNameFromModelDb(s.shipId) || `#${s.shipId}`)
      );
    }

    /** Date range — same semantics as Dashboard's: real per-ship deltas
     *  against the latest locally recorded baseline at or before the range
     *  cutoff (WG has no per-battle data), with the labeled career
     *  fallback while no old-enough baseline exists. */
    const dateRange = ref<DateRange>("all");
    const recentDelta = computed(() => {
      if (dateRange.value === "all") return null;
      const acc = result.value;
      if (!acc) return null;
      const hist = shipStats.history.get(`${realm.value}_${acc.accountId}`) ?? [];
      return computeRecentDelta(shipRows.value, hist, dateRangeCutoff(dateRange.value));
    });
    const dateFiltered = computed(
      () => recentDelta.value?.ships ?? filterByDateRange(shipRows.value, dateRange.value),
    );
    const rangeOptions = [
      { value: "1d", label: t("dashboard.range1d") },
      { value: "7d", label: t("dashboard.range7d") },
      { value: "30d", label: t("dashboard.range30d") },
      { value: "all", label: t("dashboard.rangeAll") },
    ];

    /** Per-ship rows enriched with offline tier/type for grouping. */
    const shipRows = computed<PlayerShipStats[]>(() => {
      const acc = result.value;
      if (!acc) return [];
      return shipStats.cache.get(`${realm.value}_${acc.accountId}`) ?? [];
    });
    /** Per-type summary cards (battles + winrate), matching the Dashboard. */
    const typeSummary = computed(() => {
      const rows = filteredShips.value;
      const m = new Map<string, { battles: number; wins: number }>();
      for (const s of rows) {
        const type = infoOf(s.shipId)?.type ?? "";
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

    function pushHistory(e: Omit<HistoryEntry, "time">) {
      const h = history.value.filter(
        (x) => !(x.kind === e.kind && x.name === e.name && x.realm === e.realm),
      );
      h.unshift({ ...e, time: Date.now() });
      history.value = h;
      saveHistory(h);
    }

    async function doSearch(name: string, r?: string) {
      const nm = name.trim();
      const rl = r ?? realm.value;
      if (!nm) return;
      mode.value = "player";
      realm.value = rl;
      result.value = null;
      ranked.reset();
      const toastId = toast.loading(t("account.searching"));
      try {
        // Explicit user query — always re-pull from the WG API. `nm` may be
        // a nickname or a numeric account id (both resolve server-side).
        const acc = await stats.lookup(nm, rl, { force: true });
        result.value = acc;
        lastLookup.value = { kind: "player", name: acc.name, realm: rl, id: acc.accountId };
        pushHistory({ kind: "player", name: acc.name, realm: rl, id: acc.accountId });
        // Ranked seasons load in parallel (last 5, feeds the card's ranked
        // split); per-ship stats load in the background (toast stays until
        // done).
        void ranked.load(acc.accountId, rl, 5);
        await shipStats.load(acc.accountId, rl).catch(() => {});
      } catch {
        // error surfaced via stats.error
      } finally {
        toast.remove(toastId);
      }
    }

    async function doClanLookup(clanId: number, r?: string) {
      const rl = r ?? realm.value;
      mode.value = "clan";
      realm.value = rl;
      clanResult.value = null;
      const toastId = toast.loading(t("account.searching"));
      try {
        const clan = await clanStats.lookup(clanId, rl, { force: true });
        clanResult.value = clan;
        lastLookup.value = { kind: "clan", name: clan.tag, realm: rl, id: clan.clanId };
        pushHistory({ kind: "clan", name: clan.tag, realm: rl, id: clan.clanId });
      } catch {
        // error surfaced via clanStats.error
      } finally {
        toast.remove(toastId);
      }
    }

    function replayHistory(h: HistoryEntry) {
      if (h.kind === "clan") {
        if (h.id != null) void doClanLookup(h.id, h.realm);
      } else {
        void doSearch(h.id != null ? String(h.id) : h.name, h.realm);
      }
    }

    // ── Live search combo (player / clan autocomplete) ──────────────────
    const comboSearch = (q: string) =>
      mode.value === "clan"
        ? api.suggestClans(q, realm.value).then((r) => r as unknown[])
        : api.suggestPlayers(q, realm.value).then((r) => r as unknown[]);

    const comboSelect = (item: unknown) => {
      if (mode.value === "clan") {
        const c = item as ClanSuggestion;
        if (c.clanId != null) void doClanLookup(c.clanId, realm.value);
      } else {
        const p = item as PlayerSuggestion;
        void doSearch(String(p.accountId), realm.value);
      }
    };

    const comboItemKey = (item: unknown) =>
      mode.value === "clan"
        ? (item as ClanSuggestion).clanId
        : (item as PlayerSuggestion).accountId;

    const comboRenderItem = (item: unknown) => {
      if (mode.value === "clan") {
        const c = item as ClanSuggestion;
        return (
          <span class="lookup-view__combo-row">
            <em class="lookup-view__combo-tag">[{c.tag}]</em>
            <span class="lookup-view__combo-name">{c.name}</span>
            {c.membersCount != null ? (
              <span class="lookup-view__combo-meta">{c.membersCount}</span>
            ) : null}
          </span>
        );
      }
      const p = item as PlayerSuggestion;
      return (
        <span class="lookup-view__combo-row">
          <span class="lookup-view__combo-name">{p.nickname}</span>
          <span class="lookup-view__combo-meta">{p.accountId}</span>
        </span>
      );
    };

    // Jump-in support: /lookup?name=..&realm=.. (from the replay post-battle
    // player detail) starts a player search, and /lookup?clan=..&realm=..
    // (from the dashboard's clan tag) lands in clan mode — either starts
    // immediately on mount.
    onMounted(() => {
      const q = route.query;
      const r = typeof q.realm === "string" && realms.includes(q.realm) ? q.realm : "asia";
      const clan = typeof q.clan === "string" ? Number(q.clan) : NaN;
      if (Number.isFinite(clan) && clan > 0) {
        void doClanLookup(clan, r);
        return;
      }
      const name = typeof q.name === "string" ? q.name : "";
      if (!name) return;
      void doSearch(name, r);
    });

    return () => (
      <div class="lookup-view">
        {/* Level-2 sidebar: search on top, query history below */}
        <aside class="lookup-view__sidebar">
          <div class="lookup-view__search">
            {/* Row 1 — realm picker as a segmented button group */}
            <HTabs
              variant="segmented"
              block
              modelValue={realm.value}
              onUpdate:modelValue={(v: string) => (realm.value = v)}
              tabs={realms.map((r) => ({ key: r, label: r.toUpperCase() }))}
            />
            {/* Row 2 — player/clan target picker + live search trigger */}
            <div class="lookup-view__row2">
              <HTabs
                variant="segmented"
                block
                modelValue={mode.value}
                onUpdate:modelValue={(v: string) => (mode.value = v as LookupKind)}
                tabs={[
                  { key: "player", label: t("lookup.player") },
                  { key: "clan", label: t("lookup.clan") },
                ]}
              />
              {/* key=mode+realm: remount on target/realm switch so stale
                  candidates from another scope (ids are realm-scoped) can
                  never be picked */}
              <AsyncSearchCombo
                key={`${mode.value}_${realm.value}`}
                search={comboSearch}
                itemKey={comboItemKey}
                renderItem={comboRenderItem}
                onSelect={comboSelect}
                title={mode.value === "clan" ? t("lookup.searchClanTitle") : t("lookup.searchPlayerTitle")}
                placeholder={
                  mode.value === "clan"
                    ? t("lookup.searchClanPlaceholder")
                    : t("lookup.searchPlayerPlaceholder")
                }
                minCharsHint={t("lookup.searchHint")}
                noResultsText={t("lookup.noResults")}
                searchingText={t("lookup.searching")}
              />
            </div>
          </div>
          <div class="lookup-view__history">
            <div class="lookup-view__history-title">{t("lookup.history")}</div>
            {history.value.length === 0 ? (
              <div class="lookup-view__history-empty">{t("lookup.historyEmpty")}</div>
            ) : (
              history.value.map((h) => (
                <button
                  key={`${h.realm}_${h.kind}_${h.name}`}
                  class={[
                    "lookup-view__history-item",
                    mode.value === h.kind &&
                      h.realm === realm.value &&
                      ((h.kind === "player" && h.name === result.value?.name) ||
                        (h.kind === "clan" && h.name === clanResult.value?.tag))
                      ? "lookup-view__history-item--active"
                      : "",
                  ]}
                  onClick={() => replayHistory(h)}
                >
                  <span
                    class={[
                      "lookup-view__history-kind",
                      h.kind === "clan" ? "lookup-view__history-kind--clan" : "",
                    ]}
                  >
                    {h.kind === "clan" ? <Users size={11} /> : <User size={11} />}
                  </span>
                  <span class="lookup-view__history-name">{h.name}</span>
                  <span class="lookup-view__history-realm">{h.realm.toUpperCase()}</span>
                </button>
              ))
            )}
          </div>
        </aside>

        {/* Main content: overview card + per-ship list (player) or clan card */}
        <div class="lookup-view__main">
          <h1 class="lookup-view__title">{t("nav.lookup")}</h1>
          {mode.value === "player" && stats.error ? (
            <div class="lookup-view__error">{stats.error}</div>
          ) : null}
          {mode.value === "clan" && clanStats.error ? (
            <div class="lookup-view__error">{clanStats.error}</div>
          ) : null}
          <Transition name="s-fade-slide" mode="out-in">
            {mode.value === "clan" && clanResult.value ? (
              <div class="lookup-view__result" key="clan">
                <ClanCard
                  clan={clanResult.value}
                  onMemberClick={(m) => void doSearch(String(m.accountId), realm.value)}
                />
              </div>
            ) : mode.value === "player" && result.value ? (
              <div class="lookup-view__result" key="result">
                <StatsCard
                  stats={result.value}
                  rankedWr={ranked.winrate}
                  onClanClick={
                    result.value.clanId != null
                      ? () => void doClanLookup(result.value!.clanId!, realm.value)
                      : undefined
                  }
                />
                {/* Ship distribution charts */}
                {shipRows.value.length > 0 ? (
                  <div class="lookup-view__dist">
                    <div class="lookup-view__dist-title">{t("lookup.distTitle")}</div>
                    <ShipDistCharts
                      ships={filteredShips.value.map((s) => ({ shipId: s.shipId, battles: s.battles }))}
                    />
                  </div>
                ) : null}
                <div class="lookup-view__controls">
                  <HTabs
                    variant="segmented"
                    modelValue={dateRange.value}
                    onUpdate:modelValue={(v: string) => (dateRange.value = v as DateRange)}
                    tabs={rangeOptions.map((o) => ({ key: o.value, label: o.label }))}
                  />
                  {/* Filter chips share the date-range row's height */}
                  <ShipFilterBar
                    ships={dateFiltered.value}
                    realm={realm.value}
                    onChange={(v) => (filterState.value = v)}
                  />
                </div>
                {/* What the selected range actually covers — WG only serves
                    career totals, so deltas need a local baseline. */}
                {dateRange.value !== "all" ? (
                  <p class="lookup-view__range-note">
                    {recentDelta.value
                      ? t("dashboard.rangeSince", {
                          date: new Date(recentDelta.value.sinceTs * 1000).toLocaleDateString(),
                        })
                      : t("dashboard.rangeNoHistory")}
                  </p>
                ) : null}
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
                {/* Flat ship table — multi-key sorted by the filter chips'
                    drag order (leftmost active chip = primary key). */}
                <div class="lookup-view__ships">
                  {filteredShips.value.length > 0 ? (
                    <div class="lookup-view__shiplist">
                      {filteredShips.value.map((s) => {
                        const off = shipOfflineEntry(s.shipId);
                        const icon = shipIcon(off?.type ?? "", "plain");
                        const typeKey = TYPE_ORDER.find((k) => k && (off?.type ?? "").startsWith(k)) ?? "";
                        return (
                          <div
                            class="lookup-view__ship lookup-view__ship--link"
                            key={s.shipId}
                            role="button"
                            tabindex={0}
                            data-hint={t("ships.detail.openHint")}
                            onClick={() => shipDetail.openShip(s.shipId, displayName(s), realm.value)}
                            onKeydown={(e: KeyboardEvent) => {
                              if (e.key !== "Enter" && e.key !== " ") return;
                              e.preventDefault();
                              shipDetail.openShip(s.shipId, displayName(s), realm.value);
                            }}
                          >
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
                  ) : null}
                </div>
              </div>
            ) : null}
          </Transition>
        </div>

        {/* Ship detail popup — water-table context on the looked-up player:
            defaults to the My Stats tab, holographic stage collapsed. */}
        <ShipDetailModal
          ship={shipDetail.selectedShip.value}
          source="water"
          accountId={result.value?.accountId ?? null}
          realm={result.value ? realm.value : null}
          gameRoot={shipDetail.gameRoot.value}
          onClose={() => shipDetail.closeShip()}
        />
      </div>
    );
  },
});
