import { computed, defineComponent, onMounted, ref, Transition } from "vue";
import { useRoute } from "vue-router";

import StatsCard from "@/components/stats/StatsCard";
import ClanCard, { defaultRosterOrder, roleLabel } from "@/components/stats/ClanCard";
import LookupErrorNotice from "@/components/stats/LookupErrorNotice";
import ShipDistCharts from "@/components/stats/ShipDistCharts";
import AsyncSearchCombo from "@/components/search/AsyncSearchCombo";
import { HkSpinner, HkTabs } from "@celestia-island/hikari";
import { User, Users } from "@lucide/vue";

import ShipFilterBar from "@/components/ships/ShipFilterBar";
import ShipDetailModal from "@/components/ships/ShipDetailModal";
import { useShipDetail } from "@/composables/useShipDetail";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useStatsStore } from "@/stores/stats";
import { useLoadingTasksStore } from "@/stores/loadingTasks";
import { useClanStatsStore, clanCacheKey } from "@/stores/clanStats";
import { useRankedStore } from "@/stores/ranked";
import { useShipStatsStore } from "@/stores/shipStats";
import { useStatsPrefsStore } from "@/stores/statsPrefs";
import { useLanguage } from "@/i18n/useLanguage";
import { useCareerStamp } from "@/composables/useCareerStamp";
import { useCompositionStamps } from "@/composables/useCompositionStamps";
import ShareShotButton from "@/features/share/ShareShotButton";
import { renderStatsShot, type StatsShotModel } from "@/features/share/statsShot";
import { renderClanShot, type ClanShotModel } from "@/features/share/clanShot";
import { useShareImage } from "@/features/share/useShareImage";
import { shipNameFromModelDb, shipOfflineEntry, shipNameFromOfflineDb } from "@/features/holographic/modelLoader";
import { shipIcon } from "@/features/holographic/shipIcons";
import { tierToRoman } from "@wowsp/holo";
import { damageColor, prTier, prTierLabel, winrateColor } from "@/utils/winrate";
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
    // Heal-write: a corrupt blob (non-array, unparseable) is swept —
    // absence means "no history", which is exactly what it degrades to.
    if (!Array.isArray(arr)) {
      localStorage.removeItem(HISTORY_KEY);
      return [];
    }
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
    localStorage.removeItem(HISTORY_KEY);
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
    const loadingTasks = useLoadingTasksStore();
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

    /** Query text of the most recent player / clan attempt (set before the
     *  await) — feeds the "seen before" hint on a not-found error: the
     *  history only records successes, so a match means the target WAS
     *  findable and is now gone. */
    const lastPlayerQuery = ref("");
    const lastClanQuery = ref("");

    /** Display name shown by the pending row while the WG request is in
     *  flight — set right before the request starts: the submitted
     *  nickname/UID for players, the clan tag in brackets when it is known
     *  up front (suggestions, history, the card's clan jump), `#<id>`
     *  otherwise (deep links only carry the numeric clan id). */
    const pendingQuery = ref("");

    /** Whether this exact target was looked up successfully before —
     *  matched by displayed name (case-insensitive) or numeric id. */
    function seenInHistory(kind: LookupKind, query: string, rlm: string): boolean {
      const q = query.toLowerCase();
      return history.value.some(
        (h) =>
          h.kind === kind &&
          h.realm === rlm &&
          (h.name.toLowerCase() === q || String(h.id) === query),
      );
    }

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
      lastPlayerQuery.value = nm;
      pendingQuery.value = nm;
      const taskId = loadingTasks.begin(t("account.searching"));
      try {
        // Explicit user query — always re-pull from the WG API. `nm` may be
        // a nickname or a numeric account id (both resolve server-side).
        const acc = await stats.lookup(nm, rl, { force: true });
        result.value = acc;
        lastLookup.value = { kind: "player", name: acc.name, realm: rl, id: acc.accountId };
        pushHistory({ kind: "player", name: acc.name, realm: rl, id: acc.accountId });
        // Ranked seasons load in parallel (every listed season, unplayed
        // ones dropped server-side — feeds the card's ranked split);
        // per-ship stats load in the background (the loading chip
        // stays until done).
        void ranked.load(acc.accountId, rl);
        await shipStats.load(acc.accountId, rl).catch(() => {});
      } catch {
        // error surfaced via stats.error
      } finally {
        loadingTasks.end(taskId);
      }
    }

    /** `label` is the clan's display tag when the caller knows it up front
     *  (suggestions / history / the card's clan jump); deep links only
     *  carry the numeric id, so the pending row falls back to `#<id>`. */
    async function doClanLookup(clanId: number, r?: string, label?: string) {
      const rl = r ?? realm.value;
      mode.value = "clan";
      realm.value = rl;
      clanResult.value = null;
      lastClanQuery.value = String(clanId);
      pendingQuery.value = label || `#${clanId}`;
      const taskId = loadingTasks.begin(t("account.searching"));
      try {
        const clan = await clanStats.lookup(clanId, rl, { force: true });
        clanResult.value = clan;
        lastLookup.value = { kind: "clan", name: clan.tag, realm: rl, id: clan.clanId };
        pushHistory({ kind: "clan", name: clan.tag, realm: rl, id: clan.clanId });
      } catch {
        // error surfaced via clanStats.error
      } finally {
        loadingTasks.end(taskId);
      }
    }

    function replayHistory(h: HistoryEntry) {
      if (h.kind === "clan") {
        // History stores the tag as the clan's display name — reuse it for
        // the pending row.
        if (h.id != null) void doClanLookup(h.id, h.realm, `[${h.name}]`);
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
        if (c.clanId != null) void doClanLookup(c.clanId, realm.value, `[${c.tag}]`);
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

    // ── Share shots ───────────────────────────────────────────────────
    // One per lookup mode, mirroring the result the user currently sees.
    // Root element feeds the live theme palette.
    const root = ref<HTMLElement | null>(null);
    const prefs = useStatsPrefsStore();
    const { uiLocale } = useLanguage();
    const stampKind = useCareerStamp(() => result.value);
    const composition = useCompositionStamps(
      () => result.value?.accountId ?? null,
      // Keyed on the RESULT's realm (what the live card shows), not the
      // realm picker, so a picker flip without a re-search cannot skew the
      // shot's composition verdicts.
      () => result.value?.realm ?? null,
    );
    const SHOT_SHIP_LIMIT = 8;
    // Clan roster cap: the shot draws two side-by-side columns (13 rows),
    // so 25 members fit without stretching the poster's height.
    const SHOT_MEMBER_LIMIT = 25;

    function buildPlayerShotModel(): StatsShotModel {
      const s = result.value;
      if (!s) throw new Error("no player result for the share shot");
      const rangeText = {
        "1d": t("dashboard.range1d"),
        "7d": t("dashboard.range7d"),
        "30d": t("dashboard.range30d"),
        all: t("dashboard.rangeAll"),
      }[dateRange.value];
      const rangeLabel =
        dateRange.value !== "all" && recentDelta.value
          ? `${rangeText} · ${new Date(recentDelta.value.sinceTs * 1000).toLocaleDateString()}`
          : rangeText;
      const pr = prTier(s.pr);
      const damageAnomaly =
        s.battles != null && s.battles > 0 && s.avgDamage != null && s.avgDamage <= 0;
      const sealsOn =
        uiLocale.value.startsWith("zh") &&
        prefs.prefs.prEnabled &&
        prefs.prefs.sealsEnabled;
      const fmtWr = (wr: number | null | undefined) =>
        wr != null ? `${wr.toFixed(1)}%` : "—";
      const ships = filteredShips.value.slice(0, SHOT_SHIP_LIMIT);
      return {
        title: t("nav.lookup"),
        rangeLabel,
        realm: s.realm,
        name: s.name,
        clanTag: s.clanTag,
        hidden: !!s.hidden,
        hiddenLabel: t("stats.hidden"),
        stamp: sealsOn ? stampKind.value : null,
        airSub: sealsOn ? composition.value : null,
        prOn: prefs.prefs.prEnabled,
        hero: {
          winrate: s.winrate != null ? `${s.winrate.toFixed(1)}%` : "—",
          winrateColor: winrateColor(s.winrate),
          winrateLabel: t("stats.winrate"),
          battlesText:
            s.battles != null ? `${s.battles.toLocaleString()} ${t("stats.battles")}` : "—",
          pr: s.pr != null ? s.pr.toLocaleString() : null,
          prColor: pr.rainbow ? undefined : pr.color,
          prRainbow: pr.rainbow,
          prLabel: prTierLabel(pr.key),
        },
        // The live card hides the strip when every split is unknown —
        // the shot keeps the same gate.
        divisions:
          [s.soloWr, s.div2Wr, s.div3Wr, ranked.winrate].some((wr) => wr != null)
            ? [
                { label: t("stats.solo"), value: fmtWr(s.soloWr), color: winrateColor(s.soloWr) },
                { label: t("stats.div2"), value: fmtWr(s.div2Wr), color: winrateColor(s.div2Wr) },
                { label: t("stats.div3"), value: fmtWr(s.div3Wr), color: winrateColor(s.div3Wr) },
                { label: t("stats.ranked"), value: fmtWr(ranked.winrate), color: winrateColor(ranked.winrate) },
              ]
            : [],
        kpis: [
          { label: t("stats.battles"), value: s.battles != null ? s.battles.toLocaleString() : "—" },
          {
            label: t("stats.avgDamage"),
            value: damageAnomaly
              ? t("stats.dataAnomaly")
              : s.avgDamage != null
                ? Math.round(s.avgDamage).toLocaleString()
                : "—",
            color: damageAnomaly ? damageColor(0) : undefined,
          },
          { label: t("stats.avgExp"), value: s.avgXp != null ? Math.round(s.avgXp).toLocaleString() : "—" },
          { label: t("stats.kdRatio"), value: s.kdRatio != null ? s.kdRatio.toFixed(2) : "—" },
          { label: t("stats.survivalRate"), value: s.survivalRate != null ? `${s.survivalRate.toFixed(0)}%` : "—" },
          { label: t("stats.hitRate"), value: s.hitRate != null ? `${s.hitRate.toFixed(0)}%` : "—" },
        ],
        typeChips: typeSummary.value.map((ts) => ({
          code: ts.code,
          battles: ts.battles.toLocaleString(),
          value: `${ts.winrate.toFixed(1)}%`,
          color: winrateColor(ts.winrate),
        })),
        shipsTitle: t("share.topShips"),
        shipsHead: [
          t("stats.battles"),
          t("stats.winrate"),
          t("stats.avgDamage"),
          t("stats.kdRatio"),
        ],
        ships: ships.map((ship) => ({
          name: displayName(ship),
          shipType: infoOf(ship.shipId)?.type ?? null,
          cells: [
            { text: ship.battles.toLocaleString() },
            { text: `${ship.winrate.toFixed(1)}%`, color: winrateColor(ship.winrate) },
            {
              text:
                ship.battles > 0 && ship.avgDamage <= 0
                  ? t("stats.dataAnomaly")
                  : Math.round(ship.avgDamage).toLocaleString(),
            },
            { text: (ship.frags / Math.max(1, ship.battles)).toFixed(2) },
          ],
        })),
        moreShips:
          filteredShips.value.length > SHOT_SHIP_LIMIT
            ? t("share.moreShips", { n: filteredShips.value.length - SHOT_SHIP_LIMIT })
            : null,
      };
    }

    function buildClanShotModel(): ClanShotModel {
      const clan = clanResult.value;
      if (!clan) throw new Error("no clan result for the share shot");
      const prOn = prefs.prefs.prEnabled;
      const avgPr = prTier(clan.avgPr ?? null);
      const top = defaultRosterOrder(clan.members).slice(0, SHOT_MEMBER_LIMIT);
      return {
        title: t("nav.lookup"),
        realm: clan.realm,
        name: clan.name,
        tag: clan.tag,
        description: clan.description || null,
        prOn,
        hero: {
          winrate: clan.winrate > 0 ? `${clan.winrate.toFixed(1)}%` : "—",
          winrateColor: winrateColor(clan.winrate),
          winrateLabel: t("stats.winrate"),
          battlesText:
            clan.totalBattles > 0
              ? `${clan.totalBattles.toLocaleString()} ${t("stats.battles")}`
              : "—",
          pr: prOn && clan.avgPr != null ? clan.avgPr.toLocaleString() : null,
          prColor: avgPr.rainbow ? undefined : avgPr.color,
          prRainbow: avgPr.rainbow,
          prLabel: prTierLabel(avgPr.key),
        },
        kpis: [
          { label: t("lookup.membersCount"), value: clan.membersCount.toLocaleString() },
          {
            label: t("stats.avgDamage"),
            value: clan.avgDamage > 0 ? Math.round(clan.avgDamage).toLocaleString() : "—",
          },
          {
            label: t("stats.hidden"),
            value: clan.hiddenCount > 0 ? clan.hiddenCount.toLocaleString() : "0",
          },
          {
            label: t("lookup.createdAt"),
            value: clan.createdAt
              ? new Date(clan.createdAt * 1000).toLocaleDateString()
              : "—",
          },
        ],
        membersTitle: t("lookup.clanMembers"),
        membersHead: prOn
          ? [t("stats.battles"), t("stats.winrate"), t("stats.pr"), t("stats.avgDamage")]
          : [t("stats.battles"), t("stats.winrate"), t("stats.avgDamage")],
        members: top.map((m) => {
          const tier = prTier(m.stats.pr);
          const cells: { text: string; color?: string; rainbow?: boolean }[] = [
            { text: m.stats.battles != null ? m.stats.battles.toLocaleString() : "—" },
            m.stats.winrate != null
              ? { text: `${m.stats.winrate.toFixed(1)}%`, color: winrateColor(m.stats.winrate) }
              : { text: "—" },
          ];
          if (prOn) {
            cells.push(
              m.stats.pr != null
                ? {
                    text: m.stats.pr.toLocaleString(),
                    color: tier.rainbow ? undefined : tier.color,
                    rainbow: tier.rainbow,
                  }
                : { text: "—" },
            );
          }
          cells.push({
            text:
              m.stats.avgDamage != null
                ? Math.round(m.stats.avgDamage).toLocaleString()
                : "—",
          });
          return { name: m.name, role: roleLabel(m.role), dim: !!m.stats.hidden, cells };
        }),
        moreMembers:
          clan.members.length > SHOT_MEMBER_LIMIT
            ? t("share.moreMembers", { n: clan.members.length - SHOT_MEMBER_LIMIT })
            : null,
      };
    }

    const playerShot = useShareImage(() =>
      renderStatsShot(buildPlayerShotModel(), { el: root.value }),
    );
    const clanShot = useShareImage(() =>
      renderClanShot(buildClanShotModel(), { el: root.value }),
    );

    return () => (
      <div class="lookup-view" ref={root}>
        {/* Level-2 sidebar: search on top, query history below */}
        <aside class="lookup-view__sidebar">
          <div class="lookup-view__search">
            {/* Row 1 — realm picker as a segmented button group */}
            <HkTabs
              variant="segmented"
              block
              modelValue={realm.value}
              onUpdate:modelValue={(v: string) => (realm.value = v)}
              tabs={realms.map((r) => ({ key: r, label: r.toUpperCase() }))}
            />
            {/* Row 2 — player/clan target picker + live search trigger */}
            <div class="lookup-view__row2">
              <HkTabs
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

        {/* Main content: overview card + per-ship list (player) or clan card.
            The title row pins above __scroll — a long ship table must not
            scroll the page title out of view. */}
        <div class="lookup-view__main">
          <h1 class="lookup-view__title">{t("nav.lookup")}</h1>
          <div class="lookup-view__scroll">
          {mode.value === "player" && stats.error ? (
            <LookupErrorNotice
              payload={stats.lookupError}
              raw={stats.error}
              seenBefore={seenInHistory("player", lastPlayerQuery.value, realm.value)}
            />
          ) : null}
          {mode.value === "clan" && clanStats.error ? (
            <LookupErrorNotice
              payload={clanStats.lookupError}
              raw={clanStats.error}
              // The fixed seenBefore copy is player-specific ("该玩家…已注
              // 销"), so the clan notice never shows it.
              seenBefore={false}
            />
          ) : null}
          {/* Pending state: while the WG query is in flight (stores' loading
              flag; they also clear the error notices above at request start
              and the result branches below stay null until the await
              settles) the result area would otherwise be blank — name the
              target being queried, realm tag styled like the history rows.
              The empty-label gate keeps a FOREIGN in-flight lookup (e.g. a
              dashboard-triggered own-account refresh while this page opens,
              before any local attempt has set a name) from rendering
              "Looking up …" blank or co-rendering above a cache-seeded
              result — pendingQuery only exists once this view started a
              lookup of its own. */}
          {pendingQuery.value !== "" &&
          ((mode.value === "player" && stats.loading) ||
            (mode.value === "clan" && clanStats.loading)) ? (
            <div class="lookup-view__pending" key="pending">
              <HkSpinner size="sm" />
              <span class="lookup-view__pending-text">
                {t("lookup.searchingWho", { name: pendingQuery.value })}
              </span>
              <span class="lookup-view__pending-realm">{realm.value.toUpperCase()}</span>
            </div>
          ) : null}
          <Transition name="s-fade-slide" mode="out-in">
            {mode.value === "clan" && clanResult.value ? (
              <div class="lookup-view__result" key="clan">
                <ClanCard
                  clan={clanResult.value}
                  onMemberClick={(m) => void doSearch(String(m.accountId), realm.value)}
                  v-slots={{
                    actions: () => (
                      <ShareShotButton
                        busy={clanShot.busy.value}
                        onShot={() => void clanShot.copyShot()}
                      />
                    ),
                  }}
                />
              </div>
            ) : mode.value === "player" && result.value ? (
              <div class="lookup-view__result" key="result">
                <StatsCard
                  stats={result.value}
                  rankedWr={ranked.winrate}
                  rankedBattles={ranked.battles}
                  onClanClick={
                    result.value.clanId != null
                      ? () => {
                          // The player card carries the clan's tag — name
                          // the pending row after it when present.
                          const tag = result.value!.clanTag;
                          void doClanLookup(
                            result.value!.clanId!,
                            realm.value,
                            tag ? `[${tag}]` : undefined,
                          );
                        }
                      : undefined
                  }
                  v-slots={{
                    actions: () => (
                      <ShareShotButton
                        busy={playerShot.busy.value}
                        onShot={() => void playerShot.copyShot()}
                      />
                    ),
                  }}
                />
                {/* Ship distribution charts — fed the UNFILTERED career list
                    (shipRows): the tier histogram and both donuts must never
                    react to the date-range tabs or the filter bar below;
                    everything else (type cards, ship table, share shot)
                    keeps the filtered view. */}
                {shipRows.value.length > 0 ? (
                  <div class="lookup-view__dist">
                    <div class="lookup-view__dist-title">{t("lookup.distTitle")}</div>
                    <ShipDistCharts
                      ships={shipRows.value.map((s) => ({ shipId: s.shipId, battles: s.battles }))}
                    />
                  </div>
                ) : null}
                <div class="lookup-view__controls">
                  <HkTabs
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
                    drag order (leftmost active chip = primary key). Two
                    empty states: the range itself played nothing vs. the
                    range has ships that the filters/search all exclude. */}
                <div class="lookup-view__ships">
                  {filteredShips.value.length === 0 ? (
                    <p class="lookup-view__ships-empty">
                      {dateFiltered.value.length === 0
                        ? t("dashboard.noShipsInRange")
                        : t("dashboard.noShipsMatchFilter")}
                    </p>
                  ) : (
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
                            <em class="lookup-view__ship-tier">
                              {off?.tier != null ? tierToRoman(off.tier) : ""}
                            </em>
                            <span class="lookup-view__ship-name">{displayName(s)}</span>
                            <span class="lookup-view__ship-battles">{s.battles.toLocaleString()}</span>
                            <span
                              class="lookup-view__ship-wr"
                              style={{ color: winrateColor(s.winrate), fontWeight: 600 }}
                            >
                              {s.winrate.toFixed(1)}%
                            </span>
                            <span class="lookup-view__ship-dmg">
                              {/* Battles with zero damage are broken snapshot
                                  data — same anomaly flag as the ship modal. */}
                              {s.battles > 0 && s.avgDamage <= 0
                                ? t("stats.dataAnomaly")
                                : Math.round(s.avgDamage).toLocaleString()}
                            </span>
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
                  )}
                </div>
              </div>
            ) : null}
          </Transition>
          </div>
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
