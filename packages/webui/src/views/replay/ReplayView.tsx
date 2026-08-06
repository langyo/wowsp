import { computed, defineComponent, onMounted, ref, watch } from "vue";
import { RefreshCw } from "lucide-vue-next";

import { useReplayParser } from "@/features/replay/useReplayParser";
import { useGameDetect } from "@/features/gamedetect/useGameDetect";
import HolographicMap from "@/features/holographic/HolographicMap";
import { api } from "@/api";
import type {
  CameraSample,
  EntityTrajectory,
  ExplosionEvent,
  GameInstallKind,
  HpSample,
  NetStatsSample,
  SquadronCreate,
  SquadronPlane,
  TorpedoLaunch,
  WeaponLockEvent,
} from "@/api";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { parsePostBattle, ribbonKeyOfIndex, isRibbonIndexVerified } from "@/features/replay/postBattle";
import { bundledRibbonUrl } from "@/features/holographic/ribbonIcons";
import ribbonNames from "@/data/ribbon_names.json";
import BattleIcon from "@/components/base/BattleIcon";
import { shipNameFromOfflineDb, shipOfflineEntry } from "@/features/holographic/modelLoader";
import { useAccountStore } from "@/stores/account";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { modeColor } from "@/utils/modeColors";
import { useToast } from "@/composables/useToast";
import { useRouter } from "vue-router";
import type { PlayerStats } from "@/api";
import SButton from "@/components/base/SButton";
import SSelect, { type SelectOption } from "@/components/base/SSelect";
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

/** Localize a replay matchGroup ("pvp"/"ranked"/…) with a generic fallback. */
function modeLabel(group?: string | null): string {
  if (!group) return t("replay.mode._fallback");
  const key = `replay.mode.${group}`;
  const lbl = t(key);
  // t() returns the key when missing — fall back to the generic battle label.
  return lbl === key ? t("replay.mode._fallback") : lbl;
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
    const allies = computed(() => {
      const rs = rows.value;
      const teamCoded = rs.filter((p) => p.team === 0).length !== 1;
      return (teamCoded ? rs.filter((p) => p.team === 0) : rs.filter((p) => p.team !== 2)).sort(
        (a, b) => b.estXp - a.estXp,
      );
    });
    const enemies = computed(() => {
      const rs = rows.value;
      const teamCoded = rs.filter((p) => p.team === 0).length !== 1;
      return (teamCoded ? rs.filter((p) => p.team === 1) : rs.filter((p) => p.team === 2)).sort(
        (a, b) => b.estXp - a.estXp,
      );
    });
    const detailOpen = ref(false);
    const rawOpen = ref(false);
    const selected = ref<ReturnType<typeof rows.value>[number] | null>(null);
    const globalStats = ref<PlayerStats | null>(null);
    const globalLoading = ref(false);
    const globalError = ref(false);

    /** AI/bot players have no WG account — skip the global-stats lookup.
     *  WoWS bot names follow "<fleet prefix>_<ship>" (KMS_panzership etc). */
    const AI_NAME = /^(KMS|IJN|USN|RN|KM|US|JP|VMF|HSF|PA|EU|FR|IT|NL|CN|SE|SP)_|_ship$|_bot$/i;
    /** Load the selected player's global stats on-demand (toast while
     *  loading; the lookup API resolves by nickname + realm). Failures are
     *  silent — AI names and rate-limited lookups are common, and an error
     *  toast for every bot would be noise. */
    async function loadGlobal(p: ReturnType<typeof rows.value>[number]) {
      globalStats.value = null;
      globalLoading.value = false;
      if (!p.realm || AI_NAME.test(p.name)) return;
      globalLoading.value = true;
      const tid = toast.loading(`加载 ${p.name} 全局战绩…`);
      try {
        globalStats.value = await api.lookupPlayerStats(p.name, p.realm);
        toast.dismiss(tid);
      } catch {
        toast.dismiss(tid);
        globalError.value = true;
      } finally {
        globalLoading.value = false;
      }
    }

    function openDetail(p: ReturnType<typeof rows.value>[number]) {
      selected.value = p;
      detailOpen.value = true;
      void loadGlobal(p);
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
      const cell = (p: ReturnType<typeof allies.value>[number]) => (
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
                variant={p.alive ? (p.accountId === pb.selfId ? "white" : "ally") : "sunk"}
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
                          variant={sel.alive ? "ally" : "sunk"}
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
                    </span>
                    <span class="replay-view__postbattle-detail-damage-label">
                      伤害 · 击沉 {sel.frags}
                      {sel.hpRatio != null ? ` · 残血 ${Math.round(sel.hpRatio)}%` : ""}
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
                          <img src={bundledRibbonUrl(key) ?? ""} width={22} height={22} alt="" />
                          <em>{x.value}</em>
                        </span>
                      );
                    })}
                  </div>
                </div>
                {/* On-demand global stats (toast while loading) */}
                <div class="replay-view__postbattle-global">
                  {globalLoading.value ? (
                    <span class="replay-view__postbattle-global-note">正在加载全局战绩…</span>
                  ) : globalStats.value ? (
                    <div class="replay-view__postbattle-global-grid">
                      <span><b>{globalStats.value.battles ?? "—"}</b> 场次</span>
                      <span><b>{globalStats.value.winrate != null ? `${globalStats.value.winrate.toFixed(1)}%` : "—"}</b> 胜率</span>
                      <span><b>{globalStats.value.avgDamage != null ? globalStats.value.avgDamage.toLocaleString() : "—"}</b> 均伤</span>
                      <span><b>{globalStats.value.kdRatio != null ? globalStats.value.kdRatio.toFixed(2) : "—"}</b> K/D</span>
                      <span><b>{globalStats.value.pr ?? "—"}</b> PR</span>
                      <span><b>{globalStats.value.survivalRate != null ? `${globalStats.value.survivalRate.toFixed(1)}%` : "—"}</b> 存活</span>
                    </div>
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

/** Best-effort ship class for the icon (offline DB only — the modal lives
 *  outside the encyclopedia store). */
function shipTypeOf(shipId: number): string {
  return shipOfflineEntry(shipId)?.type ?? "";
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

    // Auto-manage loading toast for replay operations.
    let loadingToastId = 0;
    watch(() => parser.loading.value, (v) => {
      if (v) {
        loadingToastId = toast.loading(t("replay.loading"));
      } else if (loadingToastId) {
        toast.dismiss(loadingToastId);
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

    onMounted(async () => {
      await gd.detect();
      await reload();
      void encyclopedia.load(realm.value).catch(() => {});
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
    const explosions = ref<ExplosionEvent[]>([]);
    const torpedoes = ref<TorpedoLaunch[]>([]);
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
    const showResults = ref(false);
    const trajectoryError = ref<string | null>(null);
    /** Match duration (seconds) — the max sample time across all trajectories.
     *  Only knowable after the packet stream is decoded; shown in the detail. */
    const duration = ref(0);
    watch(
      () => parser.current.value?.path,
      async (path) => {
        trajectories.value = [];
        explosions.value = [];
        torpedoes.value = [];
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
        trajectoryError.value = null;
        duration.value = 0;
        if (!path) return;
        try {
          const stream = await api.readReplayPositions(path);
          trajectories.value = stream.trajectories;
          explosions.value = stream.explosions ?? [];
          torpedoes.value = stream.torpedoes ?? [];
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
          let maxT = 0;
          for (const tr of stream.trajectories) {
            for (const s of tr.samples) if (s.time > maxT) maxT = s.time;
          }
          duration.value = maxT;
        } catch (e) {
          trajectoryError.value = (e as Error).message;
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

    const currentPath = computed(() => parser.current.value?.path ?? "");

    return () => (
      <main class="replay-view">
        <aside class="replay-view__list">
          <div class="replay-view__list-head">
            <div class="replay-view__list-head-row">
              <h2 class="replay-view__list-title">{t("replay.list.title")}</h2>
              <SButton
                size="sm"
                variant="ghost"
                disabled={!hasClient.value || refreshing.value}
                onClick={() => void onRefresh()}
                title={t("replay.refresh")}
              >
                <RefreshCw size={14} class={refreshing.value ? "replay-view__spin" : ""} />
              </SButton>
            </div>

            {hasClient.value ? (
              <SSelect
                size="sm"
                block
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
                {parser.list.value.map((r) => (
                  <li key={r.path} class="replay-view__item">
                    <button
                      type="button"
                      class={[
                        "replay-card",
                        currentPath.value === r.path ? "replay-card--active" : "",
                      ]}
                      onClick={() => parser.open(r.path)}
                    >
                      <div class="replay-card__top">
                        <span class="replay-card__ship">
                          {r.ownShipName ?? t("replay.ownShip")}
                        </span>
                        {r.matchGroup ? (
                          <span class="replay-card__pill" style={modeColor(r.matchGroup)}>
                            {modeLabel(r.matchGroup)}
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
                    style={modeColor(parser.current.value.matchGroup)}
                  >
                    {modeLabel(parser.current.value.matchGroup)}
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
                {battleResults.value ? (
                  <button
                    class="replay-view__meta-item replay-view__pill replay-view__results"
                    onClick={() => (showResults.value = !showResults.value)}
                  >
                    {t("replay.results")}
                  </button>
                ) : null}
              </header>
              {showResults.value && battleResults.value ? (
                <div class="replay-view__modal" onClick={() => (showResults.value = false)}>
                  <div
                    class="replay-view__modal-panel"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div class="replay-view__modal-head">
                      <strong>{t("replay.results")}</strong>
                      <button
                        class="replay-view__modal-close"
                        onClick={() => (showResults.value = false)}
                        aria-label="Close"
                      >
                        ✕
                      </button>
                    </div>
                    <div class="replay-view__modal-body">
                      <PostBattlePanel
                        raw={battleResults.value}
                        onClose={() => (showResults.value = false)}
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
                      replayPath={parser.current.value.path}
                      trajectories={trajectories.value}
                      explosions={explosions.value}
                      torpedoes={torpedoes.value}
                      weaponLocks={weaponLocks.value}
                      battleResults={battleResults.value}
                      replayVersion={replayVersion.value}
                      mapNamePkt={mapNamePkt.value}
                      cameraFrames={cameraFrames.value}
                      netStats={netStats.value}
                      leavesMap={leavesMap.value}
                      cameraModes={cameraModes.value}
                      squadronCreates={squadronCreates.value}
                      squadronPlanes={squadronPlanes.value}
                      vehicles={parser.current.value.vehicles}
                      encyclopedia={encyclopedia.byId.value}
                      mapId={parser.current.value.mapName ?? ""}
                      matchGroup={parser.current.value.matchGroup ?? ""}
                      mapName={parser.current.value.mapName ?? ""}
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
