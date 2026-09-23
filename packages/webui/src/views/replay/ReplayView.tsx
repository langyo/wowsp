import { computed, defineComponent, onMounted, ref, watch, type CSSProperties } from "vue";
import { Copy, FileUp, FolderOpen, Laptop, RefreshCw, X } from "@lucide/vue";

import { useReplayParser } from "@/features/replay/useReplayParser";
import { useGameDetect } from "@/features/gamedetect/useGameDetect";
import HolographicMap, { type HoloMapHandle } from "@/features/holographic/HolographicMap";
import PairingWizard from "@/features/replay/PairingWizard";
import { useGameStatusStore } from "@/stores/gameStatus";
import { usePairingStore } from "@/stores/pairing";
import { api, foldDamageStats, type DamageStatSample } from "@/api";
import type {
  AchievementEvent,
  CameraSample,
  ChatEvent,
  EntityTrajectory,
  ExplosionEvent,
  HpSample,
  MinimapSquadronAdd,
  MinimapSquadronMove,
  MinimapSquadronRemove,
  ReplayMetaLite,
  ShotKillEvent,
  WardEvent,
  WardRemoveEvent,
  NetStatsSample,
  ShellLaunchEvent,
  SquadronCreate,
  SquadronPlane,
  TorpedoLaunch,
  TorpedoSteer,
  VehicleEntry,
  WeaponLockEvent,
} from "@/api";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { isMobileApp } from "@/utils/platform";
import { parsePostBattle, type PostBattleRibbon } from "@/features/replay/postBattle";
import { bundledRibbonUrl } from "@/features/holographic/ribbonIcons";
import ribbonNamesRaw from "@/data/ribbon_names.json";

const ribbonNames = ribbonNamesRaw as Record<string, Partial<Record<string, string>>>;
import { HButton, HScrollPin, HSpinner, useToast } from "@celestia-island/hikari";
import BattleIcon from "@/components/base/BattleIcon";
import { AssetImage } from "@/components/base/AssetImage";
import { shipNameFromOfflineDb, shipOfflineEntry } from "@/features/holographic/modelLoader";
import { shipClassRank } from "@/utils/shipClass";
import { shipTypeClass } from "@/features/holographic/shipIcons";
import { tierToRoman } from "@/utils/tierRoman";
import { useClipboard } from "@/composables/useClipboard";
import { useAccountStore } from "@/stores/account";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { modeColor, modeKey } from "@/utils/modeColors";
import { displayMapName, replaysDir } from "@/utils/mapNames";
import { damageColor, winrateColor } from "@/utils/winrate";
import { prAlgoForRequest } from "@/stores/statsPrefs";
import { fetchRosterStatsByNames, isAiName, type RosterStat } from "@/composables/useRosterStats";
import { useRoute, useRouter } from "vue-router";
import StatsCard from "@/components/stats/StatsCard";
import ShipDistCharts, { type DistDatum } from "@/components/stats/ShipDistCharts";
import type { PlayerStats } from "@/api";
import "./ReplayView.scss";

/** Localize a battle mode from its layered identity (matchGroup / scenario /
 *  eventType / roster bots) with a generic fallback. */
function modeLabel(
  group?: string | null,
  scenario?: string | null,
  eventType?: string | null,
  botCount = 0,
): string {
  const key = modeKey(group, scenario, eventType, botCount);
  if (!key) return t("replay.mode._fallback");
  const i18nKey = `replay.mode.${key}`;
  const lbl = t(i18nKey);
  // t() returns the key when missing — fall back to the generic battle label.
  return lbl === i18nKey ? t("replay.mode._fallback") : lbl;
}

/** Player count label: team-vs-team modes show "12v12" (split by the roster
 *  relation), single-sided modes (PvE, ops) show the raw count. */
function formatPlayerCount(vehicles: { relation: number }[]): string {
  const ally = vehicles.filter((v) => v.relation <= 1).length;
  const enemy = vehicles.filter((v) => v.relation > 1).length;
  if (ally > 0 && enemy > 0) return `${ally}v${enemy}`;
  return t("replay.players", { n: vehicles.length });
}

/** Format a `YYYYMMDD[_HHMMSS]` timestamp from the replay filename into a
 *  locale-friendly date(+time) string. Returns "—" if unparseable. */
function formatDateTime(dt?: string | null): string {
  if (!dt) return "—";
  const m = dt.match(/^(\d{4})(\d{2})(\d{2})(?:_(\d{2})(\d{2})(\d{2}))?$/);
  if (!m) return dt;
  const [, y, mo, d, hh, mm] = m;
  const hhmm = hh ? ` ${hh}:${mm}` : "";
  return `${y}-${mo}-${d}${hhmm}`;
}

/** The two aligned roster-stat columns for one player name — overall winrate
 *  and avg damage, tier-colored (the XVM-style level coloring from
 *  utils/winrate). A tiny spinner rides while the batch lookup runs; bots /
 *  hidden profiles / lookup misses render a muted "—". Shared by both
 *  post-battle panels. */
function rosterStatCols(
  name: string,
  stats: Map<string, RosterStat>,
  loading: boolean,
) {
  const ai = isAiName(name);
  const stat = ai ? undefined : stats.get(name);
  const col = (
    mod: string,
    title: string,
    pick: (s: RosterStat) => number | null,
    colorOf: (v: number) => string,
    fmt: (v: number) => string,
  ) => {
    let tip = title;
    let body;
    if (ai) {
      tip = t("replay.botNote");
      body = <em>—</em>;
    } else if (!stat || loading) {
      body = <HSpinner size="xs" tone="current" />;
    } else {
      const v = pick(stat);
      if (v == null) {
        if (stat.hidden) tip = t("replay.live.hiddenProfile");
        body = <em>—</em>;
      } else {
        body = <b style={{ color: colorOf(v) }}>{fmt(v)}</b>;
      }
    }
    return (
      <span
        class={`replay-view__postbattle-cell-stat ${mod}`}
        data-hint={tip}
      >
        {body}
      </span>
    );
  };
  return (
    <>
      {col(
        "replay-view__postbattle-cell-stat--wr",
        t("replay.postbattle.winrate"),
        (s) => s.winrate,
        winrateColor,
        (v) => `${v.toFixed(1)}%`,
      )}
      {col(
        "replay-view__postbattle-cell-stat--dmg",
        t("replay.postbattle.avgDamage"),
        (s) => s.avgDamage,
        damageColor,
        (v) => Math.round(v).toLocaleString(),
      )}
    </>
  );
}

/** Post-battle modal: two-column team matrix (allies left, enemies right)
 *  sorted by settlement XP (real base exp from the results payload, with an
 *  estimate fallback on legacy short arrays). Clicking a player opens a real
 *  second-level modal with the match result + on-demand global stats (toast
 *  while loading) and a jump link into the lookup screen. */
const PostBattlePanel = defineComponent({
  name: "PostBattlePanel",
  props: { raw: { type: String, required: true } },
  emits: ["close"],
  setup(props, { emit }) {
    const parsed = computed(() => parsePostBattle(props.raw));
    const { dataLanguage } = useLanguage();
    const toast = useToast();
    const router = useRouter();
    const rows = computed(() => {
      const pb = parsed.value;
      if (!pb) return [];
      const names = new Map(pb.players.map((p) => [p.accountId, p.name]));
      return pb.players.map((p) => ({
        ...p,
        shipName:
          (p.shipId != null ? shipNameFromOfflineDb(p.shipId, dataLanguage.value) : null) ??
          "",
        killerName: p.killerId != null ? names.get(p.killerId) ?? null : null,
        // Settlement XP: the real base exp streamed per player (bots carry
        // 0); falls back to a rough estimate for legacy short arrays only.
        xp: p.exp ?? Math.round(p.damage * 0.1 + p.frags * 250 + (p.alive ? 100 : 0)),
      }));
    });
    /** The recorder's own team. `playersPublicInfo[6]` is a 0/1 TEAM number
     *  (12 vs 12), NOT a 0=self/1=ally/2=enemy relation — the recorder's
     *  team is always the "allies" column. Falls back to team 0 when the
     *  recorder isn't in the player list (watching someone else's replay). */
    const selfTeam = computed(() => {
      const pb = parsed.value;
      if (!pb) return null;
      return pb.players.find((p) => p.accountId === pb.selfId)?.team ?? null;
    });
    const allies = computed(() => {
      const st = selfTeam.value;
      return rows.value
        .filter((p) => (st != null ? p.team === st : p.team !== 1))
        .sort((a, b) => b.xp - a.xp);
    });
    const enemies = computed(() => {
      const st = selfTeam.value;
      return rows.value
        .filter((p) => p.team !== null && (st != null ? p.team !== st : p.team === 1))
        .sort((a, b) => b.xp - a.xp);
    });
    const detailOpen = ref(false);
    const selected = ref<(typeof rows.value)[number] | null>(null);
    const globalStats = ref<PlayerStats | null>(null);
    const globalLoading = ref(false);
    const globalError = ref(false);
    /** Battles per tier (index 1..10) and per ship type — for spotting
     *  low-tier farmers / CV-SS specialists. */
    const shipDistList = ref<DistDatum[]>([]);

    /** Load the player's per-ship stats and aggregate tier/type distribution. */
    async function loadShipDist(p: (typeof rows.value)[number]) {
      shipDistList.value = [];
      if (!p.realm) return;
      try {
        const list = await api.lookupPlayerShipStats(p.accountId, p.realm, prAlgoForRequest());
        shipDistList.value = list.map((s) => ({ shipId: s.shipId, battles: s.battles }));
      } catch {
        /* distribution unavailable — hide */
      }
    }

    /** AI/bot players have no WG account — skip the global-stats lookup.
     *  In replays they appear as ":Name:" (colon-wrapped, e.g. ":Millo:"). */
    const AI_NAME = /^:.*:$/;

    /** Roster WR / avg-damage per player name for the matrix columns (one
     *  batched lookup on mount, warm-served from the shared roster-stats
     *  cache). Entries without a realm ride the roster's dominant one — a
     *  battle is single-realm in practice. */
    const nameStats = ref<Map<string, RosterStat>>(new Map());
    const nameStatsLoading = ref(false);
    async function loadNameStats() {
      const pb = parsed.value;
      if (!pb) return;
      const dominant = pb.players.find((p) => p.realm)?.realm ?? null;
      const byRealm = new Map<string, Set<string>>();
      for (const p of pb.players) {
        if (AI_NAME.test(p.name)) continue;
        const realm = p.realm ?? dominant;
        if (!realm) continue;
        const set = byRealm.get(realm) ?? new Set<string>();
        set.add(p.name);
        byRealm.set(realm, set);
      }
      if (byRealm.size === 0) return;
      nameStatsLoading.value = true;
      try {
        const maps = await Promise.all(
          [...byRealm].map(([realm, names]) =>
            fetchRosterStatsByNames([...names], realm),
          ),
        );
        const merged = new Map<string, RosterStat>();
        for (const m of maps) for (const [k, v] of m) merged.set(k, v);
        nameStats.value = merged;
      } finally {
        nameStatsLoading.value = false;
      }
    }
    onMounted(() => {
      void loadNameStats();
    });
    /** Load the selected player's global stats on-demand (toast while
     *  loading; the lookup API resolves by nickname + realm). Failures are
     *  silent — AI names and rate-limited lookups are common, and an error
     *  toast for every bot would be noise. */
    async function loadGlobal(p: (typeof rows.value)[number]) {
      globalStats.value = null;
      globalLoading.value = false;
      if (!p.realm || AI_NAME.test(p.name)) return;
      globalLoading.value = true;
      const tid = toast.loading(t("replay.postbattle.loadingGlobal", { name: p.name }));
      try {
        globalStats.value = await api.lookupPlayerStats(p.name, p.realm, prAlgoForRequest());
        toast.remove(tid);
      } catch {
        toast.remove(tid);
        globalError.value = true;
      } finally {
        globalLoading.value = false;
      }
    }

    function openDetail(p: (typeof rows.value)[number]) {
      selected.value = p;
      detailOpen.value = true;
      void loadGlobal(p);
      void loadShipDist(p);
    }

    /** Jump into the lookup screen for this player, closing the modal. */
    function jumpToLookup() {
      const p = selected.value;
      detailOpen.value = false;
      emit("close");
      if (p) {
        void router.push({ path: "/lookup", query: { name: p.name, realm: p.realm ?? "asia" } });
      }
    }

    return () => {
      const pb = parsed.value;
      if (!pb) return <pre>{props.raw}</pre>;
      const st = selfTeam.value;
      const isEnemy = (p: (typeof rows.value)[number]) =>
        p.team !== null && (st != null ? p.team !== st : p.team === 1);
      const cell = (p: (typeof allies.value)[number]) => (
        <button
          class={[
            "replay-view__postbattle-cell",
            p.alive ? "" : "replay-view__postbattle-cell--dead",
            p.accountId === pb.selfId ? "replay-view__postbattle-cell--self" : "",
          ]}
          onClick={() => openDetail(p)}
        >
          <span class="replay-view__postbattle-cell-ico">
            {p.shipId != null ? (
              <BattleIcon
                type={shipTypeOf(p.shipId)}
                variant={p.alive ? (isEnemy(p) ? "enemy" : p.accountId === pb.selfId ? "white" : "ally") : "sunk"}
                size={20}
              />
            ) : null}
          </span>
          <span class="replay-view__postbattle-cell-main">
            <span class="replay-view__postbattle-cell-name">{p.name}</span>
            <span class="replay-view__postbattle-cell-sub">{p.shipName}</span>
          </span>
          {rosterStatCols(p.name, nameStats.value, nameStatsLoading.value)}
          <span class="replay-view__postbattle-cell-xp">{p.xp.toLocaleString()}</span>
        </button>
      );
      const sel = selected.value;
      return (
        <div class="replay-view__postbattle">
          <div class="replay-view__postbattle-matrix">
            <div class="replay-view__postbattle-col">
              <div class="replay-view__postbattle-col-title">{t("replay.roster.allies")}</div>
              {allies.value.map(cell)}
            </div>
            <div class="replay-view__postbattle-col">
              <div class="replay-view__postbattle-col-title">{t("replay.roster.enemies")}</div>
              {enemies.value.map(cell)}
            </div>
          </div>

          {/* Level-2 modal: player detail */}
          {detailOpen.value && sel ? (
            <div
              class="replay-view__postbattle-modal"
              onClick={() => (detailOpen.value = false)}
            >
              <div
                class="replay-view__postbattle-modal-panel"
                onClick={(e) => e.stopPropagation()}
              >
                <div class="replay-view__postbattle-modal-head">
                  <span class="replay-view__postbattle-detail-head">
                    <span class="replay-view__postbattle-detail-ico">
                      {sel.shipId != null ? (
                        <BattleIcon
                          type={shipTypeOf(sel.shipId)}
                          variant={sel.alive ? (isEnemy(sel) ? "enemy" : "ally") : "sunk"}
                          size={24}
                        />
                      ) : null}
                    </span>
                    <span class="replay-view__postbattle-detail-name">
                      {sel.name}
                      <em class="replay-view__postbattle-detail-ship">{sel.shipName}</em>
                    </span>
                  </span>
                  <button onClick={() => (detailOpen.value = false)}><X size={12} /></button>
                </div>
                <div class="replay-view__postbattle-modal-scroll">
                  {!sel.alive && sel.killerName ? (
                    <div class="replay-view__postbattle-killed">
                      {t("replay.postbattle.destroyedBy", { name: sel.killerName })}
                    </div>
                  ) : null}
                  <div class="replay-view__postbattle-detail-body">
                    <div class="replay-view__postbattle-detail-damage">
                      <span class="replay-view__postbattle-detail-damage-num">
                        {sel.damage.toLocaleString()}
                        {sel.accountId !== pb.selfId ? (
                          <em
                            class="replay-view__postbattle-damage-unknown"
                            data-hint={t("replay.postbattle.damageUnknownNote")}
                          >
                            *
                          </em>
                        ) : null}
                      </span>
                      <span class="replay-view__postbattle-detail-damage-label">
                        {t("replay.damageTaken")} {sel.damageTaken.toLocaleString()}
                        {sel.hpRatio != null
                          ? ` · ${t("replay.hpRemaining")} ${Math.round(sel.hpRatio)}%`
                          : ""}
                      </span>
                    </div>
                    <div class="replay-view__postbattle-detail-ribbons">
                      {sel.ribbons.map((x) => {
                        const name = ribbonNames[x.key]?.[dataLanguage.value] ?? x.key;
                        return (
                          <span
                            key={x.key}
                            class="replay-view__postbattle-detail-ribbon"
                            data-hint={`${name} ×${x.value}`}
                          >
                            <AssetImage src={bundledRibbonUrl(x.key)} width={40} height={15} alt="" />
                            <em>{x.value}</em>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                  {/* Own full settlement data — the replay only streams the
                      recorder's private results. */}
                  {sel.accountId === pb.selfId && (pb.selfExp != null || pb.selfCredits != null) ? (
                    <div class="replay-view__postbattle-settlement">
                      <span>{t("replay.postbattle.xp")} <b>{pb.selfExp?.toLocaleString() ?? "—"}</b></span>
                      <span>{t("replay.postbattle.credits")} <b>{pb.selfCredits?.toLocaleString() ?? "—"}</b></span>
                    </div>
                  ) : null}
                  {/* On-demand global stats (toast while loading) */}
                  <div class="replay-view__postbattle-global">
                    {globalLoading.value ? (
                      <span class="replay-view__postbattle-global-note replay-view__postbattle-global-note--loading">
                        <HSpinner size="md" tone="current" />
                      </span>
                    ) : globalStats.value ? (
                      <StatsCard stats={globalStats.value} />
                    ) : globalError.value ? (
                      <span class="replay-view__postbattle-global-note">
                        {t("replay.postbattle.globalFailedAi")}
                      </span>
                    ) : (
                      <span class="replay-view__postbattle-global-note">
                        {t("replay.postbattle.globalUnavailable")}
                        {sel.realm ? "" : t("replay.postbattle.noRealm")}
                      </span>
                    )}
                  </div>
                  {/* Ship distribution: tier histogram + class pie — spot
                      low-tier farmers / CV-SS specialists. */}
                  {shipDistList.value.length > 0 ? (
                    <div class="replay-view__postbattle-dist">
                      <div class="replay-view__postbattle-dist-title">
                        {t("replay.postbattle.tierDist")}
                      </div>
                      <ShipDistCharts ships={shipDistList.value} />
                    </div>
                  ) : null}
                </div>
                <button class="replay-view__postbattle-jump" onClick={jumpToLookup}>
                  {t("replay.postbattle.fullStats")}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      );
    };
  },
});

/**
 * Fallback post-battle panel for replays whose BattleResults packet is missing
 * (the replay ended before the server settlement was recorded). Shows the last
 * recorded state — which roster ships were already sunk — instead of the final
 * result, with a clear "incomplete" note.
 */
const PostBattleFallbackPanel = defineComponent({
  name: "PostBattleFallbackPanel",
  props: {
    vehicles: { type: Array as () => VehicleEntry[], required: true },
    trajectories: { type: Array as () => EntityTrajectory[], required: true },
    explosions: { type: Array as () => ExplosionEvent[], default: () => [] },
    shotKills: { type: Array as () => ShotKillEvent[], default: () => [] },
    /** Server-authoritative damage stats (receiveDamageStat) — preferred
     *  over the shot-kill HP-delta heuristic when present. */
    damageStats: { type: Array as () => DamageStatSample[], default: () => [] },
    /** Query realm (shared with the parent view) — the replay belongs to
     *  the client install, not to the bound account. */
    realm: { type: String, default: "asia" },
  },
  emits: ["close"],
  setup(props, { emit }) {
    const { dataLanguage } = useLanguage();
    const router = useRouter();
    const toast = useToast();
    /** AI/bot players (":Name:") have no WG account. */
    const AI_NAME = /^:.*:$/;
    const realm = computed(() => props.realm || "asia");

    /** Roster WR / avg-damage columns — same batched lookup as the main
     *  panel; the whole fallback roster lives on the query realm. */
    const nameStats = ref<Map<string, RosterStat>>(new Map());
    const nameStatsLoading = ref(false);
    async function loadNameStats() {
      const names = [...new Set(props.vehicles.map((v) => v.name))].filter(
        (n) => !AI_NAME.test(n),
      );
      if (names.length === 0 || !realm.value) return;
      nameStatsLoading.value = true;
      try {
        nameStats.value = await fetchRosterStatsByNames(names, realm.value);
      } finally {
        nameStatsLoading.value = false;
      }
    }
    onMounted(() => {
      void loadNameStats();
    });

    /** Death time per shipId (same join the scorebar strip uses). */
    const deathByShipId = computed(() => {
      const m = new Map<number, number | null>();
      for (const tr of props.trajectories) {
        if (tr.kind?.shipId != null) m.set(tr.kind.shipId, tr.deathTime ?? null);
      }
      return m;
    });
    /** HP timeline per shipId (same join; shared shipIds take the last stream). */
    const hpByShipId = computed(() => {
      const m = new Map<number, HpSample[]>();
      for (const tr of props.trajectories) {
        if (tr.kind?.shipId != null && tr.hpSamples?.length) {
          m.set(tr.kind.shipId, tr.hpSamples);
        }
      }
      return m;
    });
    /** Recorder's own inferred damage dealt / frags / hits. */
    const selfStats = computed(() => {
      const self = props.vehicles.find((v) => v.relation === 0);
      return computeSelfStats(
        props.trajectories,
        props.shotKills ?? [],
        self?.shipId,
        props.damageStats,
      );
    });
    const rows = computed(() =>
      props.vehicles.map((v) => {
        const hp = v.shipId != null ? hpByShipId.value.get(v.shipId) : undefined;
        const isSelf = v.relation === 0;
        const st = selfStats.value;
        const frags = isSelf ? st.frags : 0;
        const hits = isSelf ? st.hits : 0;
        const ribbons: PostBattleRibbon[] = [];
        if (isSelf) {
          if (hits > 0) ribbons.push({ key: "main_caliber", value: hits });
          if (frags > 0) ribbons.push({ key: "frag", value: frags });
        }
        return {
          vehicle: v,
          alive: !(v.shipId != null && deathByShipId.value.get(v.shipId) != null),
          shipName:
            (v.shipId != null
              ? shipNameFromOfflineDb(v.shipId, dataLanguage.value)
              : null) ?? v.shipName ?? "",
          tier: v.shipId != null ? (shipOfflineEntry(v.shipId)?.tier ?? 0) : 0,
          damage: isSelf ? st.damage : 0,
          frags,
          hpRatio: hpRatioOf(hp),
          damageTaken: damageTaken(hp),
          ribbons,
          killerName: null as string | null,
          isSelf,
        };
      }),
    );
    // Sort order: survivors first, then ship class (carrier > BB > CA > DD >
    // SS), then tier, then human before bot, then name case-sensitive.
    const sortRows = (
      a: (typeof rows.value)[number],
      b: (typeof rows.value)[number],
    ) =>
      Number(!a.alive) - Number(!b.alive) ||
      shipClassRank(a.vehicle.shipId) - shipClassRank(b.vehicle.shipId) ||
      b.tier - a.tier ||
      Number(AI_NAME.test(a.vehicle.name)) -
        Number(AI_NAME.test(b.vehicle.name)) ||
      a.vehicle.name.localeCompare(b.vehicle.name);
    const allies = computed(() =>
      rows.value.filter((r) => r.vehicle.relation <= 1).sort(sortRows),
    );
    const enemies = computed(() =>
      rows.value.filter((r) => r.vehicle.relation > 1).sort(sortRows),
    );

    const selected = ref<null | (typeof rows.value)[number]>(null);
    const detailOpen = ref(false);
    const globalStats = ref<PlayerStats | null>(null);
    const globalLoading = ref(false);
    const globalError = ref(false);

    async function loadGlobal(name: string) {
      globalStats.value = null;
      globalLoading.value = false;
      globalError.value = false;
      globalLoading.value = true;
      const tid = toast.loading(t("replay.postbattle.loadingGlobal", { name }));
      try {
        globalStats.value = await api.lookupPlayerStats(name, realm.value, prAlgoForRequest());
        toast.remove(tid);
      } catch {
        toast.remove(tid);
        globalError.value = true;
      } finally {
        globalLoading.value = false;
      }
    }

    function openPlayer(r: (typeof rows.value)[number]) {
      selected.value = r;
      detailOpen.value = true;
      if (!AI_NAME.test(r.vehicle.name)) {
        void loadGlobal(r.vehicle.name);
      }
    }

    function jumpToLookup() {
      const p = selected.value;
      detailOpen.value = false;
      emit("close");
      if (p) {
        void router.push({
          path: "/lookup",
          query: { name: p.vehicle.name, realm: realm.value },
        });
      }
    }

    return () => {
      const isBot = (r: (typeof rows.value)[number]) => AI_NAME.test(r.vehicle.name);
      const cell = (r: (typeof rows.value)[number]) => (
        <button
          class={[
            "replay-view__postbattle-cell",
            !r.alive ? "replay-view__postbattle-cell--dead" : "",
          ]}
          onClick={() => openPlayer(r)}
        >
          <span class="replay-view__postbattle-cell-ico">
            <BattleIcon
              type={shipTypeOf(r.vehicle.shipId)}
              variant={
                !r.alive
                  ? "sunk"
                  : r.vehicle.relation === 0
                    ? "white"
                    : r.vehicle.relation <= 1
                      ? "ally"
                      : "enemy"
              }
              size={20}
            />
          </span>
          <span class="replay-view__postbattle-cell-main">
            <span class="replay-view__postbattle-cell-name">
              {r.vehicle.name}
              {isBot(r) ? (
                <em class="replay-view__postbattle-bot">{t("replay.bot")}</em>
              ) : null}
            </span>
            <span class="replay-view__postbattle-cell-sub">{r.shipName}</span>
          </span>
          {rosterStatCols(r.vehicle.name, nameStats.value, nameStatsLoading.value)}
          <span class="replay-view__postbattle-cell-status">
            {!r.alive ? t("replay.legend.dead") : ""}
          </span>
        </button>
      );
      const sel = selected.value;
      return (
        <div class="replay-view__postbattle">
          <div class="replay-view__postbattle-matrix">
            <div class="replay-view__postbattle-col">
              <div class="replay-view__postbattle-col-title">
                {t("replay.roster.allies")}
              </div>
              {allies.value.map(cell)}
            </div>
            <div class="replay-view__postbattle-col">
              <div class="replay-view__postbattle-col-title">
                {t("replay.roster.enemies")}
              </div>
              {enemies.value.map(cell)}
            </div>
          </div>

          {detailOpen.value && sel ? (
            <div
              class="replay-view__postbattle-modal"
              onClick={() => (detailOpen.value = false)}
            >
              <div
                class="replay-view__postbattle-modal-panel"
                onClick={(e) => e.stopPropagation()}
              >
                <div class="replay-view__postbattle-modal-head">
                  <span class="replay-view__postbattle-detail-head">
                    <span class="replay-view__postbattle-detail-ico">
                      <BattleIcon
                        type={shipTypeOf(sel.vehicle.shipId)}
                        variant={
                          !sel.alive
                            ? "sunk"
                            : sel.vehicle.relation <= 1
                              ? "ally"
                              : "enemy"
                        }
                        size={24}
                      />
                    </span>
                    <span class="replay-view__postbattle-detail-name">
                      {sel.vehicle.name}
                      {isBot(sel) ? (
                        <em class="replay-view__postbattle-bot">{t("replay.bot")}</em>
                      ) : null}
                      <em class="replay-view__postbattle-detail-ship">{sel.shipName}</em>
                    </span>
                  </span>
                  <button onClick={() => (detailOpen.value = false)}><X size={12} /></button>
                </div>
                <div class="replay-view__postbattle-modal-scroll">
                  <div class="replay-view__postbattle-detail-body">
                    <div class="replay-view__postbattle-detail-damage">
                      <span class="replay-view__postbattle-detail-damage-num">
                        {sel.damage.toLocaleString()}
                      </span>
                      <span class="replay-view__postbattle-detail-damage-label">
                        {t("replay.damageTaken")} {sel.damageTaken.toLocaleString()}
                        {sel.hpRatio != null
                          ? " · " + t("replay.hpRemaining") + " " + Math.round(sel.hpRatio) + "%"
                          : ""}
                      </span>
                    </div>
                    <div class="replay-view__postbattle-detail-ribbons">
                      {sel.ribbons.map((x) => {
                        const name = ribbonNames[x.key]?.[dataLanguage.value] ?? x.key;
                        return (
                          <span
                            key={x.key}
                            class="replay-view__postbattle-detail-ribbon"
                            data-hint={`${name} ×${x.value}`}
                          >
                            <AssetImage
                              src={bundledRibbonUrl(x.key)}
                              width={40}
                              height={15}
                              alt=""
                            />
                            <em>{x.value}</em>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                  <div class="replay-view__postbattle-global">
                    <span class="replay-view__postbattle-global-note">
                      {t("replay.noDamageData")}
                    </span>
                  </div>
                  {isBot(sel) ? (
                    <div class="replay-view__postbattle-global">
                      <span class="replay-view__postbattle-global-note">
                        {t("replay.botNote")}
                      </span>
                    </div>
                  ) : (
                    <div class="replay-view__postbattle-global">
                      {globalLoading.value ? (
                        <span class="replay-view__postbattle-global-note replay-view__postbattle-global-note--loading">
                          <HSpinner size="md" tone="current" />
                        </span>
                      ) : globalStats.value ? (
                        <StatsCard stats={globalStats.value} />
                      ) : globalError.value ? (
                        <span class="replay-view__postbattle-global-note">
                          {t("replay.postbattle.globalFailed")}
                        </span>
                      ) : null}
                    </div>
                  )}
                </div>
                {!isBot(sel) ? (
                  <button class="replay-view__postbattle-jump" onClick={jumpToLookup}>
                    {t("replay.postbattle.fullStats")}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      );
    };
  },
});

/** Best-effort ship class for the icon (offline DB only — the modal lives
 *  outside the encyclopedia store). Shared with the live-battle panel —
 *  see `utils/shipClass.ts`. */
function shipTypeOf(shipId: number): string {
  return shipOfflineEntry(shipId)?.type ?? "";
}

/** Total HP lost across a ship's HP timeline (damage taken). */
function damageTaken(hp: HpSample[] | undefined | null): number {
  if (!hp || hp.length < 2) return 0;
  let dmg = 0;
  for (let i = 1; i < hp.length; i++) {
    const d = hp[i - 1].value - hp[i].value;
    if (d > 0) dmg += d;
  }
  return dmg;
}

/** Remaining-HP percent (0..100) from the last HP sample. */
function hpRatioOf(hp: HpSample[] | undefined | null): number | null {
  if (!hp || hp.length === 0) return null;
  let max = 0;
  for (const s of hp) if (s.value > max) max = s.value;
  if (max <= 0) return null;
  return (hp[hp.length - 1].value / max) * 100;
}

function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Position sample at time t (linear interpolation, mirrors HolographicMap). */
function sampleAtTraj(
  traj: EntityTrajectory,
  t: number,
): { x: number; z: number; yaw: number } | null {
  const ss = traj.samples;
  if (!ss || ss.length === 0) return null;
  if (t <= ss[0].time) return ss[0];
  if (t >= ss[ss.length - 1].time) return ss[ss.length - 1];
  let lo = 0;
  let hi = ss.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ss[mid].time < t) lo = mid;
    else hi = mid;
  }
  const a = ss[lo];
  const b = ss[hi];
  const f = (t - a.time) / (b.time - a.time || 1);
  return {
    x: a.x + (b.x - a.x) * f,
    z: a.z + (b.z - a.z) * f,
    yaw: a.yaw + angleDiff(a.yaw, b.yaw) * f,
  };
}

/** HP at time t (last sample at or before t). */
function hpAtTime(hp: HpSample[] | undefined, t: number): number | null {
  if (!hp || hp.length === 0) return null;
  let last = hp[0].value;
  for (const s of hp) {
    if (s.time > t) break;
    last = s.value;
  }
  return last;
}

/** Recorder's own damage dealt / frags / hits. Damage PREFERS the
 *  server-authoritative receiveDamageStat stream (exact, per-weapon, incl.
 *  aircraft weapons — the HP-delta heuristic below over-counts multi-hit
 *  salvos and misses out-of-view DoT); the heuristic from the projectile-kill
 *  stream (receiveShotKills — server-confirmed hits carrying the firing
 *  vehicle id) remains the fallback for versions without damage stats. */
function computeSelfStats(
  trajectories: EntityTrajectory[],
  shotKills: ShotKillEvent[],
  selfShipId: number | undefined,
  damageStats?: DamageStatSample[] | null,
): { damage: number; planeDamage: number; frags: number; hits: number } {
  const authoritative = damageStats?.length ? foldDamageStats(damageStats, Infinity) : null;
  const out = { damage: 0, planeDamage: 0, frags: 0, hits: 0 };
  if (selfShipId == null) return authoritative ? { ...out, ...authoritative } : out;
  const selfTraj = trajectories.find(
    (tr) => tr.kind?.entityType === 2 && tr.kind?.shipId === selfShipId,
  );
  if (!selfTraj || selfTraj.samples.length === 0) {
    return authoritative ? { ...out, ...authoritative } : out;
  }
  for (const e of shotKills) {
    if (e.ownerId !== selfTraj.entityId) continue;
    out.hits++;
    for (const tr of trajectories) {
      if (tr.kind?.entityType !== 2 || tr.entityId === selfTraj.entityId) continue;
      const at = sampleAtTraj(tr, e.time);
      if (!at) continue;
      if (Math.hypot(at.x - e.x, at.z - e.z) > 500) continue;
      const hpBefore = hpAtTime(tr.hpSamples, e.time - 0.4);
      const hpAfter = hpAtTime(tr.hpSamples, e.time + 0.6);
      if (hpBefore != null && hpAfter != null && hpBefore - hpAfter > 50) {
        out.damage += hpBefore - hpAfter;
      }
      if (tr.deathTime != null && Math.abs(tr.deathTime - e.time) < 1.2) {
        out.frags++;
      }
    }
  }
  if (authoritative) {
    out.damage = authoritative.damage;
    out.planeDamage = authoritative.planeDamage;
    out.hits = authoritative.hits;
  }
  return out;
}

/** Match-time stamp (M:SS) for chat rows and timeline dot hints. */
function formatClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Chat channels as the UI colours them: team (家里) green, all white,
 *  division yellow, private purple. The wire side only ever carries real
 *  namespace strings — `battle_common` (all chat), `battle_team` (team chat)
 *  and `battle_prebattle` (division chat) are the audiences the game client's
 *  BattleController understands; anything else (server-specific whisper-ish
 *  namespaces) is presented as private. */
type ChatChannelKey = "team" | "all" | "division" | "private";

const CHANNEL_BY_NAMESPACE: Record<string, ChatChannelKey> = {
  battle_common: "all",
  battle_team: "team",
  battle_prebattle: "division",
};

function chatChannelOf(namespace: string): ChatChannelKey {
  return CHANNEL_BY_NAMESPACE[namespace] ?? "private";
}

const CHANNEL_KEYS: ChatChannelKey[] = ["team", "all", "division", "private"];

/** Vehicle-id → ship-trajectory join for the chat tooltips. shipId is NOT
 *  unique per match (mirror picks, bot lines), so a naive shipId lookup can
 *  read another player's HP. Mirrors HolographicMap's
 *  `resolveRosterAssignments`: unique shipIds join directly; each ambiguous
 *  trajectory takes the same-side (nearest ally/enemy spawn centroid)
 *  unclaimed roster entry, never stealing a claimed one. */
function assignTrajectoriesByVehicle(
  vehicles: VehicleEntry[],
  trajectories: EntityTrajectory[],
): Map<number, EntityTrajectory> {
  const shipTrajs = trajectories.filter((tr) => tr.kind?.entityType === 2);
  const byShipId = new Map<number, VehicleEntry[]>();
  for (const v of vehicles) {
    const arr = byShipId.get(v.shipId) ?? [];
    arr.push(v);
    byShipId.set(v.shipId, arr);
  }
  const spawnOf = (t: EntityTrajectory) => ({
    x: t.kind?.initialX ?? t.samples[0]?.x ?? 0,
    z: t.kind?.initialZ ?? t.samples[0]?.z ?? 0,
  });
  const out = new Map<number, EntityTrajectory>();
  const ambiguous: { traj: EntityTrajectory; entries: VehicleEntry[] }[] = [];
  for (const traj of shipTrajs) {
    const sid = traj.kind?.shipId;
    const entries = sid != null ? byShipId.get(sid) : undefined;
    if (entries && entries.length === 1) {
      out.set(entries[0].id, traj);
    } else if (entries && entries.length > 1) {
      ambiguous.push({ traj, entries });
    }
  }
  if (ambiguous.length > 0) {
    // Ally/enemy spawn centroids from the already-unambiguous joins.
    let ax = 0, az = 0, an = 0, ex = 0, ez = 0, en = 0;
    const claimed = new Set<number>();
    for (const [vid, traj] of out) {
      claimed.add(vid);
      const v = vehicles.find((x) => x.id === vid);
      if (!v) continue;
      const s = spawnOf(traj);
      if (v.relation <= 1) { ax += s.x; az += s.z; an++; }
      else { ex += s.x; ez += s.z; en++; }
    }
    for (const { traj, entries } of ambiguous) {
      const unclaimed = entries.filter((e) => !claimed.has(e.id));
      let pick: VehicleEntry | undefined;
      if (an > 0 && en > 0) {
        const s = spawnOf(traj);
        const dAlly = (s.x - ax / an) ** 2 + (s.z - az / an) ** 2;
        const dEnemy = (s.x - ex / en) ** 2 + (s.z - ez / en) ** 2;
        const wantAlly = dAlly < dEnemy;
        pick =
          unclaimed.find((e) => (wantAlly ? e.relation <= 1 : e.relation > 1)) ??
          unclaimed[0];
      } else {
        pick = unclaimed[0];
      }
      if (pick) {
        out.set(pick.id, traj);
        claimed.add(pick.id);
      }
    }
  }
  return out;
}

/** One chat row joined to the roster + the sender's trajectory: everything
 *  the timeline, the copy button and the sender tooltip need. */
interface ChatRow {
  time: number;
  /** Display name — falls back to `#<playerId>` when the roster can't join. */
  sender: string;
  /** Raw roster name; empty when unjoinable (no stats lookup possible). */
  name: string;
  message: string;
  channel: ChatChannelKey;
  enemy: boolean;
  shipId: number;
  shipType: string;
  shipName: string;
  tier: number;
  /** HP at the message time (null when the HP timeline is missing). */
  hp: number | null;
  maxHp: number | null;
  /** Already sunk when the message was sent. */
  sunk: boolean;
  bot: boolean;
}

/** The chat-log modal body: a mini timeline up top (one channel-tinted dot
 *  per message; a playhead tracks the map's battle clock; click dot/track =
 *  seek), then the message grid — time | right-aligned sender | left-aligned
 *  message | hover copy button. Hovering the sender shows ship + HP at that
 *  moment; clicking opens the player-stats modal. */
const ChatLogPanel = defineComponent({
  name: "ChatLogPanel",
  props: {
    events: { type: Array as () => ChatEvent[], required: true },
    vehicles: { type: Array as () => VehicleEntry[], required: true },
    trajectories: { type: Array as () => EntityTrajectory[], required: true },
    /** Match duration (s) from the decoded stream — the timeline scale
     *  before the map's own clock reports in. */
    duration: { type: Number, default: 0 },
    realm: { type: String, default: "asia" },
    mapApi: { type: Object as () => HoloMapHandle | null, default: null },
  },
  setup(props) {
    const { dataLanguage } = useLanguage();
    const toast = useToast();
    const router = useRouter();
    const { copy } = useClipboard();
    /** AI/bot players (":Name:") have no WG account. Same rule as the
     *  post-battle panels. */
    const AI_NAME = /^:.*:$/;

    const rows = computed<ChatRow[]>(() => {
      // Resolve once per recompute — the shipId join is ambiguous for mirror
      // picks, so the vehicle→trajectory mapping must go through the
      // spawn-side assignment, not a naive shipId find().
      const trajByVehicle = assignTrajectoriesByVehicle(
        props.vehicles,
        props.trajectories,
      );
      return props.events
        .filter((c) => c.playerId > 0)
        .map((c) => {
          const v = props.vehicles.find((x) => x.id === c.playerId);
          const traj = v ? trajByVehicle.get(v.id) : undefined;
          const sunk = traj?.deathTime != null && c.time >= traj.deathTime;
          let maxHp: number | null = null;
          if (traj?.hpSamples?.length) {
            for (const s of traj.hpSamples) if (s.value > (maxHp ?? 0)) maxHp = s.value;
          }
          return {
            time: c.time,
            sender: v?.name ?? `#${c.playerId}`,
            name: v?.name ?? "",
            message: c.message,
            channel: chatChannelOf(c.namespace),
            enemy: (v?.relation ?? 0) >= 2,
            shipId: v?.shipId ?? 0,
            shipType: v ? shipOfflineEntry(v.shipId)?.type ?? "" : "",
            shipName:
              (v ? shipNameFromOfflineDb(v.shipId, dataLanguage.value) : null) ??
              v?.shipName ??
              "",
            tier: v ? shipOfflineEntry(v.shipId)?.tier ?? 0 : 0,
            hp: sunk ? 0 : hpAtTime(traj?.hpSamples, c.time),
            maxHp,
            sunk,
            bot: v ? AI_NAME.test(v.name) : false,
          };
        });
    });

    /** Sender hover hint: ship + tier/class + HP at the message time. Single
     *  line (the global tooltip popup doesn't preserve newlines). */
    function senderHint(r: ChatRow): string {
      const bits: string[] = [r.shipName || "—"];
      const cls = r.shipType
        ? t(`replay.classes.${shipTypeClass(r.shipType)}`)
        : "";
      const label = [r.tier ? tierToRoman(r.tier) : "", cls].filter(Boolean).join(" ");
      if (label) bits.push(label);
      if (r.hp != null) {
        const hp = `${t("replay.hpRemaining")} ${Math.round(r.hp).toLocaleString()}${
          r.maxHp ? ` / ${Math.round(r.maxHp).toLocaleString()}` : ""
        }`;
        bits.push(hp);
      }
      if (r.sunk) bits.push(t("replay.legend.dead"));
      return bits.join(" · ");
    }

    // ── Player stats drill-down (same shape as the post-battle level-2
    //    modal: head with ship icon, on-demand global stats, jump link). ──
    const selected = ref<ChatRow | null>(null);
    const globalStats = ref<PlayerStats | null>(null);
    const globalLoading = ref(false);
    const globalError = ref(false);

    async function loadGlobal(name: string) {
      globalStats.value = null;
      globalLoading.value = false;
      globalError.value = false;
      globalLoading.value = true;
      const tid = toast.loading(t("replay.postbattle.loadingGlobal", { name }));
      try {
        const stats = await api.lookupPlayerStats(name, props.realm || "asia", prAlgoForRequest());
        toast.remove(tid);
        // Drop late responses for a player that is no longer selected.
        if (selected.value?.name !== name) return;
        globalStats.value = stats;
      } catch {
        toast.remove(tid);
        if (selected.value?.name !== name) return;
        globalError.value = true;
      } finally {
        globalLoading.value = false;
      }
    }

    function openDetail(r: ChatRow) {
      selected.value = r;
      globalStats.value = null;
      globalError.value = false;
      if (!r.bot) void loadGlobal(r.name);
    }

    /** Jump into the lookup screen for this player (the chat modal stays
     *  open behind — the route change tears the whole view down). */
    function jumpToLookup() {
      const r = selected.value;
      if (r) {
        void router.push({
          path: "/lookup",
          query: { name: r.name, realm: props.realm || "asia" },
        });
      }
    }

    return () => {
      const sel = selected.value;
      return (
        <>
          {/* Pinned above the scroll: the timeline (and its legend) rides an
              HScrollPin so the message list scrolls underneath it instead of
              carrying it away. Bleed contract: the pin must stay the FIRST
              element of the scroll body (host class + pad var on
              __modal-body), and the timeline keeps its gap as padding so the
              pin's painted box covers it. */}
          <HScrollPin side="top">
            <ChatTimeline rows={rows.value} duration={props.duration} mapApi={props.mapApi} />
          </HScrollPin>
          <ul class="replay-view__chat-list">
            {rows.value.map((r, i) => (
              <li key={i} class={["replay-view__chat-row", `replay-view__chat-row--${r.channel}`]}>
                <span class="replay-view__chat-time">{formatClock(r.time)}</span>
                {r.name ? (
                  <button
                    class="replay-view__chat-sender"
                    data-hint={senderHint(r)}
                    onClick={() => openDetail(r)}
                  >
                    {r.sender}
                  </button>
                ) : (
                  <span class="replay-view__chat-sender replay-view__chat-sender--static">
                    {r.sender}
                  </span>
                )}
                <span class="replay-view__chat-text">{r.message}</span>
                <button
                  class="replay-view__chat-copy"
                  data-hint={t("replay.chat.copy")}
                  aria-label={t("replay.chat.copy")}
                  onClick={() => void copy(r.message)}
                >
                  <Copy size={12} />
                </button>
              </li>
            ))}
          </ul>
          {/* Level-2 modal: the sender's stats (reuses the post-battle
              modal chrome; sits fixed above the chat panel). */}
          {sel ? (
            <div class="replay-view__postbattle-modal" onClick={() => (selected.value = null)}>
              <div
                class="replay-view__postbattle-modal-panel"
                onClick={(e) => e.stopPropagation()}
              >
                <div class="replay-view__postbattle-modal-head">
                  <span class="replay-view__postbattle-detail-head">
                    <span class="replay-view__postbattle-detail-ico">
                      {sel.shipId ? (
                        <BattleIcon
                          type={sel.shipType}
                          variant={sel.enemy ? "enemy" : "ally"}
                          size={24}
                        />
                      ) : null}
                    </span>
                    <span class="replay-view__postbattle-detail-name">
                      {sel.sender}
                      {sel.bot ? (
                        <em class="replay-view__postbattle-bot">{t("replay.bot")}</em>
                      ) : null}
                      <em class="replay-view__postbattle-detail-ship">{sel.shipName}</em>
                    </span>
                  </span>
                  <button onClick={() => (selected.value = null)}><X size={12} /></button>
                </div>
                <div class="replay-view__postbattle-modal-scroll">
                  {sel.bot ? (
                    <div class="replay-view__postbattle-global">
                      <span class="replay-view__postbattle-global-note">
                        {t("replay.botNote")}
                      </span>
                    </div>
                  ) : (
                    <div class="replay-view__postbattle-global">
                      {globalLoading.value ? (
                        <span class="replay-view__postbattle-global-note replay-view__postbattle-global-note--loading">
                          <HSpinner size="md" tone="current" />
                        </span>
                      ) : globalStats.value ? (
                        <StatsCard stats={globalStats.value} />
                      ) : globalError.value ? (
                        <span class="replay-view__postbattle-global-note">
                          {t("replay.postbattle.globalFailedAi")}
                        </span>
                      ) : (
                        <span class="replay-view__postbattle-global-note">
                          {t("replay.postbattle.globalUnavailable")}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {!sel.bot ? (
                  <button class="replay-view__postbattle-jump" onClick={jumpToLookup}>
                    {t("replay.postbattle.fullStats")}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      );
    };
  },
});

/** The chat panel's mini timeline. Isolated in its own component so the
 *  per-frame playhead updates re-render only this subtree, never the message
 *  list. Clicking the track seeks proportionally; clicking a dot jumps to
 *  that message's moment (both via the map's pausing seek). */
const ChatTimeline = defineComponent({
  name: "ChatTimeline",
  props: {
    rows: { type: Array as () => ChatRow[], required: true },
    duration: { type: Number, default: 0 },
    mapApi: { type: Object as () => HoloMapHandle | null, default: null },
  },
  setup(props) {
    // The travel rail inset past the pill's rounded end caps — dots and the
    // playhead map 0–100% onto THIS box, so the seek math must measure the
    // same rectangle (clicks on the caps themselves clamp to 0 / 100%).
    const rail = ref<HTMLSpanElement | null>(null);
    // Prefer the map's own clock span (max−first sample) once it reports in —
    // the playhead and the pausing seek both speak that clock; the stream-side
    // duration prop (absolute last-sample time) is the pre-mount fallback.
    const total = computed(() => props.mapApi?.duration || props.duration || 0);
    const pctOf = (t: number) =>
      total.value > 0 ? Math.min(100, Math.max(0, (t / total.value) * 100)) : 0;

    function seekFromTrack(e: MouseEvent) {
      const el = rail.value;
      const api = props.mapApi;
      if (!el || !api || total.value <= 0) return;
      const rect = el.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      api.seek(f * total.value);
    }

    return () => {
      const api = props.mapApi;
      return (
        <div class="replay-view__chat-timeline">
          <div
            class={["replay-view__chat-track", api ? "" : "replay-view__chat-track--static"]}
            onClick={seekFromTrack}
          >
            <span ref={rail} class="replay-view__chat-rail">
              {props.rows.map((r, i) => (
                <button
                  key={i}
                  class={["replay-view__chat-dot", `replay-view__chat-ch--${r.channel}`]}
                  style={{ left: `${pctOf(r.time)}%` }}
                  data-hint={`${formatClock(r.time)} ${r.sender}: ${r.message}`}
                  aria-label={`${formatClock(r.time)} ${r.sender}: ${r.message}`}
                  disabled={!api}
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation();
                    api?.seek(r.time);
                  }}
                />
              ))}
              {api ? (
                <span
                  class="replay-view__chat-playhead"
                  style={{ left: `${pctOf(api.current)}%` }}
                />
              ) : null}
            </span>
          </div>
          <div class="replay-view__chat-legend">
            {CHANNEL_KEYS.map((k) => (
              <span key={k} class="replay-view__chat-legend-item">
                <i class={["replay-view__chat-dot", `replay-view__chat-ch--${k}`]} />
                {t(`replay.chat.${k}`)}
              </span>
            ))}
          </div>
        </div>
      );
    };
  },
});

/**
 * Standalone review view (Mode 1). The left rail lists replays as info cards
 * indexed by match time / mode / own ship / map; picking one opens the detail
 * view: a holographic battle map, the recorder's ship as a holographic model,
 * and an enriched roster (this-match ship + ship type + on-demand avg stats).
 */
export default defineComponent({
  name: "ReplayView",
  setup() {
    const parser = useReplayParser();
    const gd = useGameDetect();
    const accounts = useAccountStore();
    const encyclopedia = useEncyclopediaStore();
    const toast = useToast();
    const { dataLanguage } = useLanguage();
    const mapLang = computed(() => dataLanguage.value);
    const gameStatus = useGameStatusStore();
    /**
     * What the main pane currently shows — a proper little state machine
     * (Rust-flavoured: None | Archive(Server, ID)). Invariant: exactly one
     * pane renders, and every rail card click *transitions* the state
     * instead of flipping independent booleans.
     */
    type Pane =
      | { kind: "none" }
      | { kind: "archive"; path: string };
    const pane = ref<Pane>({ kind: "none" });

    // The live battle has its own page (/live) now; this view only refreshes
    // the replay list when the game EXITS so the finished match appears
    // without a manual refresh (the game writes the .wowsreplay at battle
    // end — the final pass also catches late post-battle flushes).
    watch(
      () => gameStatus.process.running,
      (running) => {
        if (!running) void reload();
      },
    );

    // Auto-manage loading toast for replay operations.
    let loadingToastId = 0;
    watch(() => parser.loading.value, (v) => {
      if (v) {
        loadingToastId = toast.loading(t("replay.loading"));
      } else if (loadingToastId) {
        toast.remove(loadingToastId);
        loadingToastId = 0;
      }
    });

    const activePath = computed(() => gd.config.activeInstall?.path ?? "");
    const hasClient = computed(() => gd.config.installs.length > 0);

    /** The realm to query player stats against. Prefer the client install's
     *  realm, then the bound account's realm, else the UI default. */
    const realm = computed(
      () =>
        gd.config.activeInstall?.realm ??
        accounts.activeAccount?.realm ??
        accounts.activeRealm ??
        "asia",
    );

    /** Reload the replay list from the given (or active) client's replays dir. */
    async function reload(path?: string) {
      const dir = path ? replaysDir(path) : activePath.value ? replaysDir(activePath.value) : undefined;
      try {
        await parser.refreshList(dir);
      } catch {
        // surfaced via store.error; list stays empty
      }
    }

    const route = useRoute();
    /** One-shot deep-link seek (?t=seconds) forwarded to the map. */
    const initialSeek = Math.max(0, Number(route.query.t) || 0);

    onMounted(async () => {
      await gd.detect();
      await reload();
      void encyclopedia.load(realm.value).catch(() => {});
      // Deep link: ?open=<index|substr> auto-opens a replay from the list —
      // handy for sharing a match link and for headless render checks.
      const want = route.query.open;
      if (want != null && want !== "") {
        const list = parser.list.value;
        const idx = /^\d+$/.test(String(want))
          ? Number(want)
          : list.findIndex((r) => r.path.includes(String(want)));
        const hit = idx >= 0 ? list[idx] : undefined;
        if (hit) {
          pane.value = { kind: "archive", path: hit.path };
          void parser.open(hit.path);
        }
      }
    });

    watch(activePath, (p, prev) => {
      if (p && p !== prev) void reload(p);
    });

    /** Pick replays from anywhere on disk (shared files outside the game's
     *  replays folder). Each picked file header-parses into a temporary card
     *  queued above the scanned list; the first pick opens immediately. */
    const openingExternal = ref(false);
    async function onOpenExternal() {
      if (openingExternal.value) return;
      openingExternal.value = true;
      try {
        const picked = await api.pickReplayFiles();
        const { added, failed } = await parser.addExternal(picked);
        for (const f of failed) {
          toast.error(`${f.path}\n${f.error}`);
        }
        const first = added[0];
        if (first) {
          pane.value = { kind: "archive", path: first };
          void parser.open(first);
        }
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        openingExternal.value = false;
      }
    }

    /** Drop an external entry; reset the pane if its replay was open. */
    function onCloseExternal(path: string) {
      parser.removeExternal(path);
      if (pane.value.kind === "archive" && pane.value.path === path) {
        pane.value = { kind: "none" };
      }
    }

    // ── mobile replay acquisition (phone app build) ─────────────────────
    // pick_replay_files (the native dialog behind onOpenExternal) errors on
    // mobile, so the phone surfaces its own pair of acquisition actions:
    // an HTML file picker writing through importReplayFile, and the
    // pairing wizard pulling from the user's desktop WoWSP.
    const pairing = usePairingStore();
    const wizardOpen = ref(false);
    // Deep link: /replay?pairing=1 auto-opens the wizard — the phone
    // settings' pairing section routes here (its primary button).
    if (route.query.pairing === "1") wizardOpen.value = true;
    const fileInput = ref<HTMLInputElement | null>(null);
    const importing = ref(false);

    /** Open the (hidden) HTML file input — on Android WebView this may open
     *  the system file picker / SAF; in a browser it opens the normal
     *  chooser. Multiple .wowsreplay selection allowed. */
    function onPickFiles() {
      fileInput.value?.click();
    }

    /** Read the picked Files and import each into the managed replays dir
     *  (list refresh afterwards shows them; the backend dedupes names). */
    async function onFilesChosen(e: Event) {
      const input = e.target as HTMLInputElement;
      const files = [...(input.files ?? [])];
      // Reset so picking the same file again re-fires change.
      input.value = "";
      if (files.length === 0) return;
      importing.value = true;
      try {
        const entries = await Promise.all(
          files.map(async (f) => ({
            name: f.name,
            bytes: new Uint8Array(await f.arrayBuffer()),
          })),
        );
        const { imported, failed } = await pairing.importFiles(entries);
        for (const f of failed) {
          toast.error(`${f.name}\n${f.error}`);
        }
        if (imported.length > 0) {
          toast.success(t("replay.acquire.importedToast", { n: imported.length }));
          await reload();
        }
      } finally {
        importing.value = false;
      }
    }

    /** A remote pull finished — refresh so the landed files show locally. */
    function onPairingImported() {
      void reload();
    }

    // Decoded trajectories for the currently-open replay (M3). Loaded lazily on
    // open so the header parse stays fast; the decode is the expensive step.
    const trajectories = ref<EntityTrajectory[]>([]);
    const shellLaunches = ref<ShellLaunchEvent[]>([]);
    const explosions = ref<ExplosionEvent[]>([]);
    const torpedoes = ref<TorpedoLaunch[]>([]);
    const torpedoSteers = ref<TorpedoSteer[]>([]);
    const weaponLocks = ref<WeaponLockEvent[]>([]);
    const battleResults = ref<string | null>(null);
    const replayVersion = ref<string | null>(null);
    const mapNamePkt = ref<string | null>(null);
    const cameraFrames = ref<CameraSample[]>([]);
    const netStats = ref<NetStatsSample[]>([]);
    const leavesMap = ref<Record<string, number>>({});
    const cameraModes = ref<HpSample[]>([]);
    const squadronCreates = ref<SquadronCreate[]>([]);
    const squadronPlanes = ref<SquadronPlane[]>([]);
    const minimapSquadronAdds = ref<MinimapSquadronAdd[]>([]);
    const minimapSquadronMoves = ref<MinimapSquadronMove[]>([]);
    const minimapSquadronRemoves = ref<MinimapSquadronRemove[]>([]);
    const wards = ref<WardEvent[]>([]);
    const wardRemoves = ref<WardRemoveEvent[]>([]);
    const shotKills = ref<ShotKillEvent[]>([]);
    const damageStats = ref<DamageStatSample[]>([]);
    const chatMessages = ref<ChatEvent[]>([]);
    const achievements = ref<AchievementEvent[]>([]);
    const showResults = ref(false);
    const showChat = ref(false);
    /** HolographicMap's exposed playback surface (see HoloMapHandle) — the
     *  chat panel reads its clock for the playhead and calls its pausing
     *  seek when a timeline dot/track is clicked. Null while no map mounts
     *  (decode error) — the panel then renders without the playhead. */
    const mapRef = ref<HoloMapHandle | null>(null);
    /** True while the packet stream is decoding (post-battle results pending). */
    const resultsLoading = ref(false);
    const trajectoryError = ref<string | null>(null);
    /** Match duration (seconds) — the max sample time across all trajectories.
     *  Only knowable after the packet stream is decoded; shown in the detail. */
    const duration = ref(0);
    watch(
      () => parser.current.value?.path,
      async (path) => {
        trajectories.value = [];
        shellLaunches.value = [];
        explosions.value = [];
        torpedoes.value = [];
        torpedoSteers.value = [];
        weaponLocks.value = [];
        battleResults.value = null;
        replayVersion.value = null;
        mapNamePkt.value = null;
        cameraFrames.value = [];
        netStats.value = [];
        leavesMap.value = {};
        cameraModes.value = [];
        squadronCreates.value = [];
        squadronPlanes.value = [];
        minimapSquadronAdds.value = [];
        minimapSquadronMoves.value = [];
        minimapSquadronRemoves.value = [];
        wards.value = [];
        wardRemoves.value = [];
        shotKills.value = [];
        damageStats.value = [];
        chatMessages.value = [];
        achievements.value = [];
        showChat.value = false;
        trajectoryError.value = null;
        duration.value = 0;
        if (!path) return;
        resultsLoading.value = true;
        try {
          const stream = await api.readReplayPositions(path);
          trajectories.value = stream.trajectories;
          shellLaunches.value = stream.shellLaunches ?? [];
          explosions.value = stream.explosions ?? [];
          torpedoes.value = stream.torpedoes ?? [];
          torpedoSteers.value = stream.torpedoSteers ?? [];
          weaponLocks.value = stream.weaponLocks ?? [];
          battleResults.value = stream.battleResults ?? null;
          replayVersion.value = stream.version ?? null;
          mapNamePkt.value = stream.mapName ?? null;
          cameraFrames.value = stream.camera ?? [];
          netStats.value = stream.netStats ?? [];
          leavesMap.value = stream.leaves ?? {};
          cameraModes.value = stream.cameraModes ?? [];
          squadronCreates.value = stream.squadronCreates ?? [];
          squadronPlanes.value = stream.squadronPlanes ?? [];
          minimapSquadronAdds.value = stream.minimapSquadronAdds ?? [];
          minimapSquadronMoves.value = stream.minimapSquadronMoves ?? [];
          minimapSquadronRemoves.value = stream.minimapSquadronRemoves ?? [];
          wards.value = stream.wards ?? [];
          wardRemoves.value = stream.wardRemoves ?? [];
          shotKills.value = stream.shotKills ?? [];
          damageStats.value = stream.damageStats ?? [];
          chatMessages.value = stream.chatMessages ?? [];
          achievements.value = stream.achievements ?? [];
          let maxT = 0;
          for (const tr of stream.trajectories) {
            for (const s of tr.samples) if (s.time > maxT) maxT = s.time;
          }
          duration.value = maxT;
        } catch (e) {
          trajectoryError.value = (e as Error).message;
        } finally {
          resultsLoading.value = false;
        }
      },
    );

    /** Format a match duration (seconds) as M:SS or H:MM:SS. */
    function formatDuration(sec: number): string {
      if (!sec || sec <= 0) return "—";
      const s = Math.round(sec);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const ss = s % 60;
      const pad = (n: number) => String(n).padStart(2, "0");
      return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
    }

    /** Human-sent chat count — gates the header pill. System rows
     *  (playerId ≤ 0 — the client itself ignores those) don't count; the
     *  row join itself lives in ChatLogPanel. */
    const chatCount = computed(
      () => chatMessages.value.filter((c) => c.playerId > 0).length,
    );

    const refreshing = ref(false);
    async function onRefresh() {
      refreshing.value = true;
      try {
        await reload();
      } finally {
        refreshing.value = false;
      }
    }

    /** One replay info card. `external` cards are session-temporary picks
     *  from outside the game folder — they carry an "external" pill and a
     *  corner X icon (a sibling of the card button, so no nested buttons). Their
     *  key is namespaced so a pick that also exists in the scanned folder
     *  can't collide with the regular card's key. */
    function renderReplayCard(r: ReplayMetaLite, external: boolean) {
      return (
        <li key={external ? `ext_${r.path}` : r.path} class="replay-view__item">
          <button
            type="button"
            class={[
              "replay-card",
              external ? "replay-card--external" : "",
              pane.value.kind === "archive" && pane.value.path === r.path
                ? "replay-card--active"
                : "",
            ]}
            onClick={() => {
              // Transition the pane to the new archive BEFORE opening it —
              // exactly one pane at a time.
              pane.value = { kind: "archive", path: r.path };
              void parser.open(r.path);
            }}
          >
            <div class="replay-card__top">
              <span class="replay-card__ship">{r.ownShipName ?? t("replay.ownShip")}</span>
              <span class="replay-card__pills">
                {external ? (
                  <span class="replay-card__pill replay-card__pill--external">
                    {t("replay.external.tag")}
                  </span>
                ) : null}
                {r.matchGroup ? (
                  <span
                    class="replay-card__pill"
                    style={modeColor(r.matchGroup, r.scenario, r.eventType, r.botCount ?? 0) as CSSProperties}
                  >
                    {modeLabel(r.matchGroup, r.scenario, r.eventType, r.botCount ?? 0)}
                  </span>
                ) : null}
              </span>
            </div>
            <div class="replay-card__row">
              <span class="replay-card__label">{t("replay.matchTime")}</span>
              <span class="replay-card__val">{formatDateTime(r.dateTime)}</span>
            </div>
            <div class="replay-card__row">
              <span class="replay-card__label">{t("replay.mapLabel")}</span>
              <span class="replay-card__val">{displayMapName(r.mapName, mapLang.value)}</span>
            </div>
            <div class="replay-card__foot">
              <span class="replay-card__players">
                {t("replay.players", { n: r.playerCount })}
              </span>
            </div>
          </button>
          {external ? (
            <button
              type="button"
              class="replay-card__close"
              onClick={() => onCloseExternal(r.path)}
              aria-label={t("replay.external.close")}
            >
              <X size={12} />
            </button>
          ) : null}
        </li>
      );
    }

    return () => (
      <main class="replay-view">
        <aside class="replay-view__list">
          <div class="replay-view__list-head">
            <div class="replay-view__list-head-row">
              <h2 class="replay-view__list-title">{t("replay.list.title")}</h2>
              <span class="replay-view__list-head-actions">
                {isMobileApp() ? (
                  <>
                    {/* Phone build: the native pick dialog is unavailable
                        (pick_replay_files errors on mobile) — the HTML file
                        input + pairing wizard take over. */}
                    <HButton
                      size="sm"
                      variant="ghost"
                      loading={importing.value}
                      onClick={onPickFiles}
                      ariaLabel={t("replay.acquire.pickFiles")}
                    >
                      <FileUp size={14} />
                    </HButton>
                    <HButton
                      size="sm"
                      variant="ghost"
                      onClick={() => (wizardOpen.value = true)}
                      ariaLabel={t("replay.acquire.fromDesktop")}
                    >
                      <Laptop size={14} />
                    </HButton>
                  </>
                ) : (
                  <HButton
                    size="sm"
                    variant="ghost"
                    loading={openingExternal.value}
                    onClick={() => void onOpenExternal()}
                    ariaLabel={t("replay.list.openExternal")}
                  >
                    <FolderOpen size={14} />
                  </HButton>
                )}
                <HButton
                  size="sm"
                  variant="ghost"
                  disabled={(!hasClient.value && !isMobileApp()) || refreshing.value}
                  onClick={() => void onRefresh()}
                  ariaLabel={t("replay.refresh")}
                >
                  <RefreshCw size={14} class={refreshing.value ? "replay-view__spin" : ""} />
                </HButton>
              </span>
            </div>

            {/* The client/server selector lives in the sidebar footer (shared
                with plugin management + account switching); the replay list
                just reads the active install. (Never shown on the phone app —
                there is no local client to pick.) */}
            {!hasClient.value && !isMobileApp() ? (
              <p class="replay-view__no-client">{t("replay.list.noClient")}</p>
            ) : null}

            {parser.list.value.length > 0 ? (
              <span class="replay-view__count">
                {t("replay.list.count", { n: parser.list.value.length })}
              </span>
            ) : null}
          </div>

          <div class="replay-view__list-scroll">
            {parser.external.value.length === 0 && parser.list.value.length === 0 ? (
              isMobileApp() ? (
                /* Phone build's prominent acquisition empty state: pick
                    local .wowsreplay files, or pair with the desktop. */
                <div class="replay-view__acquire">
                  <p class="replay-view__acquire-title">{t("replay.acquire.emptyTitle")}</p>
                  <p class="replay-view__acquire-hint">{t("replay.acquire.emptyHint")}</p>
                  <div class="replay-view__acquire-actions">
                    <HButton
                      variant="primary"
                      loading={importing.value}
                      onClick={onPickFiles}
                    >
                      <FileUp size={15} />
                      {t("replay.acquire.pickFiles")}
                    </HButton>
                    <HButton
                      variant="secondary"
                      onClick={() => (wizardOpen.value = true)}
                    >
                      <Laptop size={15} />
                      {t("replay.acquire.fromDesktop")}
                    </HButton>
                  </div>
                </div>
              ) : !hasClient.value ? (
                <p class="replay-view__empty">{t("replay.list.noClient")}</p>
              ) : (
                <p class="replay-view__empty">{t("replay.list.empty")}</p>
              )
            ) : (
              <ul class="replay-view__items">
                {/* Manually picked files (session-temporary) sit above the
                    scanned list — newest picks on top. */}
                {parser.external.value.map((r) => renderReplayCard(r, true))}
                {parser.list.value.map((r) => renderReplayCard(r, false))}
              </ul>
            )}
          </div>
        </aside>

        <section class="replay-view__main">
          {parser.current.value ? (
            <div class="replay-view__content">
              {parser.error.value ? (
                <div class="replay-view__placeholder replay-view__placeholder--error">
                  {parser.error.value}
                </div>
              ) : null}
              <header class="replay-view__meta">
                <strong class="replay-view__map">
                  {displayMapName(parser.current.value.mapName, mapLang.value)}
                </strong>
                <span class="replay-view__meta-item">
                  {formatDateTime(parser.current.value.dateTime)}
                </span>
                {parser.current.value.matchGroup ? (
                  <span
                    class="replay-view__meta-item replay-view__pill"
                    style={
                      modeColor(
                        parser.current.value.matchGroup,
                        parser.current.value.scenario,
                        parser.current.value.eventType,
                        parser.current.value.botCount ?? 0,
                      ) as CSSProperties
                    }
                  >
                    {modeLabel(
                      parser.current.value.matchGroup,
                      parser.current.value.scenario,
                      parser.current.value.eventType,
                      parser.current.value.botCount ?? 0,
                    )}
                  </span>
                ) : null}
                <span class="replay-view__meta-item replay-view__count">
                  {formatPlayerCount(parser.current.value.vehicles)}
                </span>
                {duration.value > 0 ? (
                  <span class="replay-view__meta-item">
                    {t("replay.duration")}: <strong>{formatDuration(duration.value)}</strong>
                  </span>
                ) : null}
                {resultsLoading.value ? (
                  <span class="replay-view__meta-item replay-view__pill replay-view__results replay-view__results--loading">
                    {t("replay.results")}
                    <HSpinner size="xs" tone="current" />
                  </span>
                ) : battleResults.value || trajectories.value.length > 0 ? (
                  <button
                    class="replay-view__meta-item replay-view__pill replay-view__results"
                    onClick={() => (showResults.value = !showResults.value)}
                  >
                    {t("replay.results")}
                  </button>
                ) : null}
                {chatCount.value > 0 ? (
                  <button
                    class="replay-view__meta-item replay-view__pill"
                    onClick={() => (showChat.value = !showChat.value)}
                  >
                    {t("replay.chatLog")}
                  </button>
                ) : null}
              </header>
              {showResults.value && (battleResults.value || trajectories.value.length > 0) ? (
                <div class="replay-view__modal" onClick={() => (showResults.value = false)}>
                  <div
                    class="replay-view__modal-panel"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div class="replay-view__modal-head">
                      <div class="replay-view__modal-title">
                        <strong>{t("replay.results")}</strong>
                        {!battleResults.value ? (
                          <span class="replay-view__results-note">
                            {t("replay.resultsIncomplete")}
                          </span>
                        ) : null}
                      </div>
                      <button
                        class="replay-view__modal-close"
                        onClick={() => (showResults.value = false)}
                        aria-label="Close"
                      >
                        <X size={14} />
                      </button>
                    </div>
                    <div class="replay-view__modal-body">
                      {battleResults.value ? (
                        <PostBattlePanel
                          raw={battleResults.value}
                          onClose={() => (showResults.value = false)}
                        />
                      ) : (
                        <PostBattleFallbackPanel
                          vehicles={parser.current.value.vehicles}
                          trajectories={trajectories.value}
                          explosions={explosions.value}
                          shotKills={shotKills.value}
                          damageStats={damageStats.value}
                          realm={realm.value}
                          onClose={() => (showResults.value = false)}
                        />
                      )}
                    </div>
                  </div>
                </div>
              ) : null}

              {showChat.value && chatCount.value > 0 ? (
                <div class="replay-view__modal" onClick={() => (showChat.value = false)}>
                  <div
                    class="replay-view__modal-panel replay-view__chat-panel"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div class="replay-view__modal-head">
                      <div class="replay-view__modal-title">
                        <strong>{t("replay.chatLog")}</strong>
                      </div>
                      <button
                        class="replay-view__modal-close"
                        onClick={() => (showChat.value = false)}
                        aria-label="Close"
                      >
                        <X size={14} />
                      </button>
                    </div>
                    <div class="replay-view__modal-body hk-scroll-pin-host" data-scroll-axis="vertical">
                      <ChatLogPanel
                        events={chatMessages.value}
                        vehicles={parser.current.value.vehicles}
                        trajectories={trajectories.value}
                        duration={duration.value}
                        realm={realm.value}
                        mapApi={mapRef.value}
                      />
                    </div>
                  </div>
                </div>
              ) : null}

              <div class="replay-view__detail">
                <div class="replay-view__map-wrap">
                  {trajectoryError.value ? (
                    <div class="replay-view__placeholder replay-view__placeholder--error">
                      trajectory decode failed: {trajectoryError.value}
                    </div>
                  ) : (
                    <HolographicMap
                      ref={mapRef}
                      replayPath={parser.current.value.path}
                      trajectories={trajectories.value}
                      shellLaunches={shellLaunches.value}
                      explosions={explosions.value}
                      torpedoes={torpedoes.value}
                      torpedoSteers={torpedoSteers.value}
                      weaponLocks={weaponLocks.value}
                      battleResults={battleResults.value ?? undefined}
                      replayVersion={replayVersion.value ?? undefined}
                      mapNamePkt={mapNamePkt.value ?? undefined}
                      cameraFrames={cameraFrames.value}
                      netStats={netStats.value}
                      leavesMap={leavesMap.value}
                      cameraModes={cameraModes.value}
                      squadronCreates={squadronCreates.value}
                      squadronPlanes={squadronPlanes.value}
                      minimapSquadronAdds={minimapSquadronAdds.value}
                      minimapSquadronMoves={minimapSquadronMoves.value}
                      minimapSquadronRemoves={minimapSquadronRemoves.value}
                      wards={wards.value}
                      wardRemoves={wardRemoves.value}
                      shotKills={shotKills.value}
                      damageStats={damageStats.value}
                      chatMessages={chatMessages.value}
                      achievements={achievements.value}
                      vehicles={parser.current.value.vehicles}
                      encyclopedia={encyclopedia.byId}
                      mapId={parser.current.value.mapName ?? ""}
                      matchGroup={parser.current.value.matchGroup ?? ""}
                      mapName={parser.current.value.mapName ?? ""}
                      initialTime={initialSeek}
                      initialMinimapZoom={route.query.mm === "1"}
                    />
                  )}
                </div>
              </div>
            </div>
          ) : parser.error.value ? (
            <div class="replay-view__placeholder replay-view__placeholder--error">
              {parser.error.value}
            </div>
          ) : (
            <div class="replay-view__placeholder">{t("replay.select")}</div>
          )}
        </section>

        {/* Hidden HTML file picker backing the mobile import action (the
            styled button clicks it). Multi-select .wowsreplay only. Rendered
            only on the phone build — desktop uses the native picker. */}
        {isMobileApp() ? (
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".wowsreplay"
            class="replay-view__file-input"
            onChange={(e: Event) => void onFilesChosen(e)}
          />
        ) : null}

        {/* Phone-build pairing wizard (sheet-driven; docks as a bottom sheet
            on phone layout through hikari's HModal). */}
        <PairingWizard
          open={wizardOpen.value}
          onClose={() => (wizardOpen.value = false)}
          onImported={onPairingImported}
        />
      </main>
    );
  },
});
