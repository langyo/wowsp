import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from "vue";
import { Play, RefreshCw } from "@lucide/vue";

import { useReplayParser } from "@/features/replay/useReplayParser";
import { useGameDetect } from "@/features/gamedetect/useGameDetect";
import HolographicMap from "@/features/holographic/HolographicMap";
import LiveBattlePanel from "@/features/replay/LiveBattlePanel";
import { useBattleClock } from "@/features/replay/useBattleClock";
import { useGameStatusStore } from "@/stores/gameStatus";
import { useOverlayStore } from "@/stores/overlay";
import { api } from "@/api";
import type {
  CameraSample,
  EntityTrajectory,
  ExplosionEvent,
  GameInstallKind,
  HpSample,
  MinimapSquadronAdd,
  MinimapSquadronMove,
  MinimapSquadronRemove,
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
import {
  parsePostBattle,
  ribbonKeyOfIndex,
  isRibbonIndexVerified,
  type PostBattleRibbon,
} from "@/features/replay/postBattle";
import { bundledRibbonUrl } from "@/features/holographic/ribbonIcons";
import ribbonNamesRaw from "@/data/ribbon_names.json";

const ribbonNames = ribbonNamesRaw as Record<string, Partial<Record<string, string>>>;
import { HButton, HSelect, HSpinner, useToast } from "@celestia-island/hikari";

/** Hikari select option shape (HkSelectOption is not re-exported). */
type SelectOption = { value: string; label: string; disabled?: boolean };

import BattleIcon from "@/components/base/BattleIcon";
import { shipNameFromOfflineDb, shipOfflineEntry } from "@/features/holographic/modelLoader";
import { useAccountStore } from "@/stores/account";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { modeColor, modeKey } from "@/utils/modeColors";
import { useRoute, useRouter } from "vue-router";
import StatsCard from "@/components/stats/StatsCard";
import ShipDistCharts, { type DistDatum } from "@/components/stats/ShipDistCharts";
import type { PlayerStats } from "@/api";
import "./ReplayView.scss";

/** Map a client kind to its localized label (e.g. Steam / 官服 / Lesta / 国服). */
function kindLabel(kind: GameInstallKind | null | undefined): string {
  if (!kind) return "";
  return t(`common.game.kind.${kind}`);
}

/** Build a short label for a client selector option: "Steam · ASIA". */
function installLabel(kind: GameInstallKind, realm?: string | null): string {
  const parts = [kindLabel(kind)];
  if (realm) parts.push(realm.toUpperCase());
  return parts.join(" · ");
}

/** The replays subfolder of a client install. WoWS writes replays under
 *  `<install>/replays/`. */
function replaysDir(installPath: string): string {
  const trimmed = installPath.replace(/[\\/]+$/, "");
  return `${trimmed}/replays`;
}

/** Localize a battle mode from its layered identity (matchGroup / scenario /
 *  eventType) with a generic fallback. */
function modeLabel(
  group?: string | null,
  scenario?: string | null,
  eventType?: string | null,
): string {
  const key = modeKey(group, scenario, eventType);
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

/** Official map display names extracted from the game's gettext catalogs
 *  (`scripts/model_convert/extract_map_names.py`): space id → {lang: name}.
 *  Space ids often DON'T match the display name (WG renamed maps but kept
 *  the internal id — "20_NE_two_brothers" is "双峰海峡"/"Two Brothers", not
 *  "两兄弟"), so the catalog is authoritative. */
import mapNamesRaw from "@/data/map_names.json";

const MAP_NAMES = mapNamesRaw as Record<string, Record<string, string>>;

function mapNameForLang(spaceId: string, lang: string): string | null {
  const names = MAP_NAMES[spaceId];
  if (!names) return null;
  // Take the exact server language first (国服 zh-cn and 亚服 zh-sg are
  // different official translations, e.g. 断层线 vs 海神之击). Never fall
  // back across servers — if the chosen language lacks an entry (e.g. the
  // official zh-tw catalog keeps map names in English), use English, not
  // the other server's name.
  return names[lang] ?? names["en"] ?? null;
}

/** Resolve a map's localized display name from its internal space id. Falls
 *  back to the prettified id, then to the unknown-map label. */
function displayMapName(spaceId?: string | null, lang?: string): string {
  if (!spaceId) return t("replay.map.unknown");
  const clean = spaceId.replace(/^spaces\//, "");
  const official = mapNameForLang(clean, lang ?? "");
  if (official) return official;
  const key = `replay.map.names.${clean}`;
  const lbl = t(key);
  return lbl === key ? clean : lbl;
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

/** Post-battle modal: two-column team matrix (allies left, enemies right)
 *  sorted by estimated settlement XP. Clicking a player opens a real second-
 *  level modal with the match result + on-demand global stats (toast while
 *  loading) and a jump link into the lookup screen. */
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
        // Estimated settlement XP: damage + kills + survival bonus (the
        // server doesn't stream per-player XP into replays).
        estXp: Math.round(p.damage * 0.1 + p.frags * 250 + (p.alive ? 100 : 0)),
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
        .sort((a, b) => b.estXp - a.estXp);
    });
    const enemies = computed(() => {
      const st = selfTeam.value;
      return rows.value
        .filter((p) => p.team !== null && (st != null ? p.team !== st : p.team === 1))
        .sort((a, b) => b.estXp - a.estXp);
    });
    const detailOpen = ref(false);
    const rawOpen = ref(false);
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
        const list = await api.lookupPlayerShipStats(p.accountId, p.realm);
        shipDistList.value = list.map((s) => ({ shipId: s.shipId, battles: s.battles }));
      } catch {
        /* distribution unavailable — hide */
      }
    }

    /** AI/bot players have no WG account — skip the global-stats lookup.
     *  In replays they appear as ":Name:" (colon-wrapped, e.g. ":Millo:"). */
    const AI_NAME = /^:.*:$/;
    /** Load the selected player's global stats on-demand (toast while
     *  loading; the lookup API resolves by nickname + realm). Failures are
     *  silent — AI names and rate-limited lookups are common, and an error
     *  toast for every bot would be noise. */
    async function loadGlobal(p: (typeof rows.value)[number]) {
      globalStats.value = null;
      globalLoading.value = false;
      if (!p.realm || AI_NAME.test(p.name)) return;
      globalLoading.value = true;
      const tid = toast.loading(`加载 ${p.name} 全局战绩…`);
      try {
        globalStats.value = await api.lookupPlayerStats(p.name, p.realm);
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

    /** Jump into the lookup screen for this player, closing both modals. */
    function jumpToLookup() {
      const p = selected.value;
      detailOpen.value = false;
      rawOpen.value = false;
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
          <span class="replay-view__postbattle-cell-xp">{p.estXp.toLocaleString()}</span>
        </button>
      );
      const sel = selected.value;
      return (
        <div class="replay-view__postbattle">
          <div class="replay-view__postbattle-matrix">
            <div class="replay-view__postbattle-col">
              <div class="replay-view__postbattle-col-title">友方</div>
              {allies.value.map(cell)}
            </div>
            <div class="replay-view__postbattle-col">
              <div class="replay-view__postbattle-col-title">敌方</div>
              {enemies.value.map(cell)}
            </div>
          </div>
          <button
            class="replay-view__postbattle-rawbtn"
            onClick={() => (rawOpen.value = true)}
          >
            原始数据
          </button>

          {/* Level-2 modal: raw payload */}
          {rawOpen.value ? (
            <div class="replay-view__postbattle-modal" onClick={() => (rawOpen.value = false)}>
              <div
                class="replay-view__postbattle-modal-panel"
                onClick={(e) => e.stopPropagation()}
              >
                <div class="replay-view__postbattle-modal-head">
                  <span>原始数据</span>
                  <button onClick={() => (rawOpen.value = false)}>✕</button>
                </div>
                <pre class="replay-view__postbattle-modal-raw">{props.raw}</pre>
              </div>
            </div>
          ) : null}

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
                  <button onClick={() => (detailOpen.value = false)}>✕</button>
                </div>
                {!sel.alive && sel.killerName ? (
                  <div class="replay-view__postbattle-killed">
                    被 {sel.killerName} 摧毁
                    {sel.killerDamage ? `（${sel.killerDamage.toLocaleString()} 伤害）` : ""}
                  </div>
                ) : null}
                <div class="replay-view__postbattle-detail-body">
                  <div class="replay-view__postbattle-detail-damage">
                    <span class="replay-view__postbattle-detail-damage-num">
                      {sel.damage.toLocaleString()}
                      {sel.accountId !== pb.selfId ? (
                        <em
                          class="replay-view__postbattle-damage-unknown"
                          title="录像不包含完整的对局信息，部分伤害来源不可见"
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
                      const key = ribbonKeyOfIndex(x.index);
                      if (!key) return null;
                      const name = ribbonNames[key]?.[dataLanguage.value] ?? key;
                      const verified = isRibbonIndexVerified(x.index);
                      return (
                        <span
                          key={x.index}
                          class="replay-view__postbattle-detail-ribbon"
                          title={`${name} ×${x.value}${verified ? "" : "（推测）"}`}
                        >
                          <img src={bundledRibbonUrl(key) ?? ""} width={40} height={15} alt="" />
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
                    <span>经验 <b>{pb.selfExp?.toLocaleString() ?? "—"}</b></span>
                    <span>银币 <b>{pb.selfCredits?.toLocaleString() ?? "—"}</b></span>
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
                      无法获取全局战绩（可能为 AI 玩家）
                    </span>
                  ) : (
                    <span class="replay-view__postbattle-global-note">
                      全局战绩不可用{sel.realm ? "" : "（无服务器信息）"}
                    </span>
                  )}
                </div>
                {/* Ship distribution: tier histogram + class pie — spot
                    low-tier farmers / CV-SS specialists. */}
                {shipDistList.value.length > 0 ? (
                  <div class="replay-view__postbattle-dist">
                    <div class="replay-view__postbattle-dist-title">常玩等级分布</div>
                    <ShipDistCharts ships={shipDistList.value} />
                  </div>
                ) : null}
                <button class="replay-view__postbattle-jump" onClick={jumpToLookup}>
                  查看完整战绩 →
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
  },
  emits: ["close"],
  setup(props, { emit }) {
    const { dataLanguage } = useLanguage();
    const accounts = useAccountStore();
    const router = useRouter();
    const toast = useToast();
    /** AI/bot players (":Name:") have no WG account. */
    const AI_NAME = /^:.*:$/;

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
      return computeSelfStats(props.trajectories, props.explosions, self?.shipId);
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
          if (hits > 0) ribbons.push({ index: 28, value: hits });
          if (frags > 0) ribbons.push({ index: 32, value: frags });
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
          killerDamage: null as number | null,
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
      const tid = toast.loading("加载 " + name + " 全局战绩…");
      try {
        globalStats.value = await api.lookupPlayerStats(name, accounts.activeRealm);
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
          query: { name: p.vehicle.name, realm: accounts.activeRealm },
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
                  <button onClick={() => (detailOpen.value = false)}>✕</button>
                </div>
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
                      const key = ribbonKeyOfIndex(x.index);
                      if (!key) return null;
                      const name = ribbonNames[key]?.[dataLanguage.value] ?? key;
                      const verified = isRibbonIndexVerified(x.index);
                      return (
                        <span
                          key={x.index}
                          class="replay-view__postbattle-detail-ribbon"
                          title={name + " ×" + x.value + (verified ? "" : "（推测）")}
                        >
                          <img
                            src={bundledRibbonUrl(key) ?? ""}
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
                        无法获取全局战绩
                      </span>
                    ) : null}
                  </div>
                )}
                {!isBot(sel) ? (
                  <button class="replay-view__postbattle-jump" onClick={jumpToLookup}>
                    查看完整战绩 →
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
 *  outside the encyclopedia store). */
function shipTypeOf(shipId: number): string {
  return shipOfflineEntry(shipId)?.type ?? "";
}

/** Sort weight for a ship class: carrier > battleship > cruiser > destroyer
 *  > submarine, then everything else. */
function shipClassRank(shipId: number): number {
  const t = (shipOfflineEntry(shipId)?.type ?? "").toLowerCase();
  if (t.includes("aircarrier") || t.includes("aircar")) return 0;
  if (t.includes("battleship")) return 1;
  if (t.includes("cruiser")) return 2;
  if (t.includes("destroyer")) return 3;
  if (t.includes("submarine")) return 4;
  return 5;
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

/** Recorder's own damage dealt / frags / hits, inferred from the explosion
 *  stream (the same heuristic HolographicMap uses for its self-stats bar). */
function computeSelfStats(
  trajectories: EntityTrajectory[],
  explosions: ExplosionEvent[],
  selfShipId: number | undefined,
): { damage: number; frags: number; hits: number } {
  const out = { damage: 0, frags: 0, hits: 0 };
  if (selfShipId == null) return out;
  const selfTraj = trajectories.find(
    (tr) => tr.kind?.entityType === 2 && tr.kind?.shipId === selfShipId,
  );
  if (!selfTraj || selfTraj.samples.length === 0) return out;
  for (const e of explosions) {
    const s = sampleAtTraj(selfTraj, e.time);
    if (!s) continue;
    const dist = Math.hypot(s.x - e.x, s.z - e.z);
    if (dist < 300 || dist > 15000) continue;
    const aim = Math.atan2(e.x - s.x, e.z - s.z);
    let dAim = Math.abs(aim - s.yaw);
    if (dAim > Math.PI) dAim = 2 * Math.PI - dAim;
    if (dAim > 0.35) continue;
    out.hits++;
    for (const tr of trajectories) {
      if (tr.kind?.entityType !== 2 || tr.kind?.shipId === selfShipId) continue;
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
  return out;
}

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
    const overlay = useOverlayStore();
    /**
     * What the main pane currently shows — a proper little state machine
     * (Rust-flavoured: None | Live | Archive(Server, ID)). Invariant: exactly
     * one pane renders, and every rail card click *transitions* the state
     * instead of flipping independent booleans (the old liveOpen bug was a
     * replay click forgetting to transition back).
     */
    type Pane =
      | { kind: "none" }
      | { kind: "live" }
      | { kind: "archive"; path: string };
    const pane = ref<Pane>({ kind: "none" });
    /** Live battle clock (from tempArenaInfo's dateTime). */
    const liveClock = useBattleClock(() => overlay.arenaInfo?.dateTime ?? null);
    // While the live pane is open, poll the game's tempArenaInfo.json so the
    // roster refreshes as players load in / the battle ends.
    let arenaTimer: number | null = null;
    watch(
      pane,
      (p, old) => {
        if (p.kind === "live" && old.kind !== "live") {
          void overlay.refreshArenaInfo();
          arenaTimer = window.setInterval(() => void overlay.refreshArenaInfo(), 3000);
        } else if (p.kind !== "live" && arenaTimer !== null) {
          clearInterval(arenaTimer);
          arenaTimer = null;
        }
      },
      { deep: false },
    );

    /** Battle lifecycle: while the game runs, watch the replays folder —
     *  the game writes the .wowsreplay file when the battle ENDS, so a new
     *  file is the direct "match over" signal. On detection: flip the live
     *  panel to SETTLING (结算中 — stats screen, replay not yet final) and
     *  refresh the replay list so the finished match appears immediately.
     *  When the game process exits, do a final refresh (the file may grow
     *  its post-battle block) and return to idle. */
    const livePhase = ref<"idle" | "battle" | "settling">("idle");
    let baselineFiles: Set<string> | null = null;
    async function snapshotReplayDir(): Promise<Set<string> | null> {
      const dir = activePath.value ? replaysDir(activePath.value) : undefined;
      try {
        const files = await api.listReplays(dir);
        return new Set(files);
      } catch {
        return null;
      }
    }
    watch(
      () => gameStatus.process.running,
      async (running) => {
        if (running) {
          livePhase.value = "battle";
          baselineFiles = await snapshotReplayDir();
        } else {
          // Game exited: finalize whatever the battle produced.
          if (livePhase.value !== "idle") void reload();
          livePhase.value = "idle";
          baselineFiles = null;
        }
      },
    );
    let endPoll: number | null = null;
    watch(
      livePhase,
      (ph) => {
        if (ph === "battle") {
          if (endPoll === null) {
            endPoll = window.setInterval(async () => {
              if (baselineFiles == null) {
                baselineFiles = await snapshotReplayDir();
                return;
              }
              const now = await snapshotReplayDir();
              if (!now) return;
              const fresh = [...now].some((f) => !baselineFiles!.has(f));
              if (fresh) {
                livePhase.value = "settling";
                void reload();
              } else {
                baselineFiles = now;
              }
            }, 3000);
          }
        } else if (endPoll !== null) {
          clearInterval(endPoll);
          endPoll = null;
        }
      },
      { immediate: true },
    );
    onBeforeUnmount(() => {
      if (endPoll !== null) clearInterval(endPoll);
      if (arenaTimer !== null) clearInterval(arenaTimer);
    });

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

    // Client-selector options derived from detected installs.
    const clientOptions = computed<SelectOption[]>(() =>
      gd.config.installs.map((i) => ({
        value: i.path,
        label: installLabel(i.kind, i.realm),
      })),
    );
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

    async function onSelectClient(path: string) {
      await gd.config.selectInstall(path);
      await reload(path);
    }

    watch(activePath, (p, prev) => {
      if (p && p !== prev) void reload(p);
    });

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
    const showResults = ref(false);
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

    const refreshing = ref(false);
    async function onRefresh() {
      refreshing.value = true;
      try {
        await reload();
      } finally {
        refreshing.value = false;
      }
    }

    return () => (
      <main class="replay-view">
        <aside class="replay-view__list">
          <div class="replay-view__list-head">
            <div class="replay-view__list-head-row">
              <h2 class="replay-view__list-title">{t("replay.list.title")}</h2>
              <HButton
                size="sm"
                variant="ghost"
                disabled={!hasClient.value || refreshing.value}
                onClick={() => void onRefresh()}
                ariaLabel={t("replay.refresh")}
              >
                <RefreshCw size={14} class={refreshing.value ? "replay-view__spin" : ""} />
              </HButton>
            </div>

            {hasClient.value ? (
              <HSelect
                modelValue={activePath.value}
                onUpdate:modelValue={(v: string) => void onSelectClient(v)}
                options={clientOptions.value}
                placeholder={t("replay.client")}
              />
            ) : (
              <p class="replay-view__no-client">{t("replay.list.noClient")}</p>
            )}

            {parser.list.value.length > 0 ? (
              <span class="replay-view__count">
                {t("replay.list.count", { n: parser.list.value.length })}
              </span>
            ) : null}
          </div>

          <div class="replay-view__list-scroll">
            {!hasClient.value ? (
              <p class="replay-view__empty">{t("replay.list.noClient")}</p>
            ) : parser.list.value.length === 0 ? (
              <p class="replay-view__empty">{t("replay.list.empty")}</p>
            ) : (
              <ul class="replay-view__items">
                {gameStatus.process.running ? (
                  <li class="replay-view__item">
                    <button
                      type="button"
                      class={[
                        "replay-card",
                        "replay-card--live",
                        pane.value.kind === "live" ? "replay-card--active" : "",
                      ]}
                      onClick={() => {
                        pane.value = { kind: "live" };
                        parser.clear();
                      }}
                    >
                      <div class="replay-card__top">
                        <span class="replay-card__ship">
                          <Play size={13} class="replay-card__live-ico" strokeWidth={2.4} />
                          {t("replay.live.title")}
                        </span>
                        {overlay.arenaInfo?.matchGroup ? (
                          <span
                            class="replay-card__pill"
                            style={modeColor(overlay.arenaInfo.matchGroup, null, null) as CSSProperties}
                          >
                            {modeLabel(overlay.arenaInfo.matchGroup, null, null)}
                          </span>
                        ) : null}
                        {livePhase.value === "settling" ? (
                        <span class="replay-card__pill replay-card__pill--settling">
                          {t("replay.live.settling")}
                        </span>
                      ) : (
                        <span class="replay-card__pill replay-card__pill--live">LIVE</span>
                      )}
                      </div>
                      <div class="replay-card__row">
                        <span class="replay-card__label">{t("replay.mapLabel")}</span>
                        <span class="replay-card__val">
                          {overlay.arenaInfo?.mapName
                            ? displayMapName(overlay.arenaInfo.mapName, mapLang.value)
                            : t("replay.live.notStarted")}
                        </span>
                      </div>
                      <div class="replay-card__foot">
                        <span class="replay-card__players">
                          {overlay.arenaInfo
                            ? t("replay.players", { n: overlay.arenaInfo.vehicles.length })
                            : "—"}
                        </span>
                        {liveClock.label.value ? (
                          <span class="replay-card__clock">{liveClock.label.value}</span>
                        ) : null}
                      </div>
                    </button>
                  </li>
                ) : null}
                {parser.list.value.map((r) => (
                  <li key={r.path} class="replay-view__item">
                    <button
                      type="button"
                      class={[
                        "replay-card",
                        pane.value.kind === "archive" && pane.value.path === r.path
                          ? "replay-card--active"
                          : "",
                      ]}
                      onClick={() => {
                        // Transition the pane (closing any live view) BEFORE
                        // opening the archive — exactly one pane at a time.
                        pane.value = { kind: "archive", path: r.path };
                        void parser.open(r.path);
                      }}
                    >
                      <div class="replay-card__top">
                        <span class="replay-card__ship">
                          {r.ownShipName ?? t("replay.ownShip")}
                        </span>
                        {r.matchGroup ? (
                          <span class="replay-card__pill" style={modeColor(r.matchGroup, r.scenario, r.eventType) as CSSProperties}>
                            {modeLabel(r.matchGroup, r.scenario, r.eventType)}
                          </span>
                        ) : null}
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
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <section class="replay-view__main">
          {pane.value.kind === "live" ? (
            <LiveBattlePanel arena={overlay.arenaInfo} settling={livePhase.value === "settling"} />
          ) : parser.current.value ? (
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
                      ) as CSSProperties
                    }
                  >
                    {modeLabel(
                      parser.current.value.matchGroup,
                      parser.current.value.scenario,
                      parser.current.value.eventType,
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
                        ✕
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
                          onClose={() => (showResults.value = false)}
                        />
                      )}
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
      </main>
    );
  },
});
