import { computed, defineComponent, onMounted, onUnmounted, ref, watch, type CSSProperties } from "vue";
import { Copy, Eye, EyeOff, FileUp, FolderOpen, Laptop, RefreshCw, X } from "@lucide/vue";

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
import { type PostBattleRibbon } from "@/features/replay/postBattle";
import PostBattlePanel from "@/features/replay/PostBattlePanel";
import {
  resolveRosterStatsMode,
  rosterStatView,
  type ResolvedStatsMode,
} from "@/utils/statView";
import {
  PostBattleShareBar,
  rosterShotCells,
  rosterShotDashes,
  rosterStatCols,
  useNickMasking,
  useShareShot,
} from "@/features/replay/postBattleShare";
import type { ShotColumn, ShotModel, ShotRow, ShotStat } from "@/features/replay/postBattleShot";
import { bundledRibbonUrl } from "@/features/holographic/ribbonIcons";
import ribbonNamesRaw from "@/data/ribbon_names.json";

const ribbonNames = ribbonNamesRaw as Record<string, Partial<Record<string, string>>>;
import { HkButton, HkScrollPin, HkSpinner, useToast } from "@celestia-island/hikari";
import BattleIcon from "@/components/base/BattleIcon";
import { AssetImage } from "@/components/base/AssetImage";
import { shipNameFromOfflineDb, shipOfflineEntry } from "@/features/holographic/modelLoader";
import { gameTabRowKey } from "@/utils/shipClass";
import { shipTypeClass } from "@/features/holographic/shipIcons";
import { tierToRoman } from "@wowsp/holo";
import { useClipboard } from "@/composables/useClipboard";
import { useAccountStore } from "@/stores/account";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useLoadingTasksStore } from "@/stores/loadingTasks";
import { isOperationBattle, modeColor, modeKey } from "@/utils/modeColors";
import { displayMapName, replaysDir } from "@/utils/mapNames";
import { prAlgoForRequest, statsPrefsState } from "@/stores/statsPrefs";
import { AI_NAME, fetchRosterStatsByNames, type RosterStat } from "@/composables/useRosterStats";
import { useRoute, useRouter } from "vue-router";
import StatsCard from "@/components/stats/StatsCard";
import type { PlayerStats } from "@/api";
import "./ReplayView.scss";

/** Localize a battle mode from its layered identity (matchGroup / scenario /
 *  eventType / roster bots) with a generic fallback. */
function modeLabel(
  group?: string | null,
  scenario?: string | null,
  eventType?: string | null,
  botCount = 0,
  scriptedUnitCount = 0,
): string {
  const key = modeKey(group, scenario, eventType, botCount, scriptedUnitCount);
  if (!key) return t("replay.mode._fallback");
  const i18nKey = `replay.mode.${key}`;
  const lbl = t(i18nKey);
  // t() returns the key when missing — fall back to the generic battle label.
  return lbl === i18nKey ? t("replay.mode._fallback") : lbl;
}

/** Player count label: team-vs-team modes show "12v12" (split by the roster
 *  relation), single-sided modes (PvE, ops) show the raw count. Operations
 *  skip the split entirely — their relation values follow scenario slots. */
function formatPlayerCount(
  vehicles: { relation: number }[],
  operation = false,
): string {
  if (!operation) {
    const ally = vehicles.filter((v) => v.relation <= 1).length;
    const enemy = vehicles.filter((v) => v.relation > 1).length;
    if (ally > 0 && enemy > 0) return `${ally}v${enemy}`;
  }
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

/** The replay descriptor's game version arrives comma-separated
 *  ("14,1,0,1234567" from clientVersionFromExe); normalize to the dotted
 *  "14.1.0" display form with the build hash dropped. Null when the
 *  descriptor carries no parsable version. */
function gameVersionOf(raw: unknown): string | null {
  const v = (raw as { clientVersionFromExe?: unknown } | null)?.clientVersionFromExe;
  if (typeof v !== "string") return null;
  const parts = v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
  return parts.length >= 2 ? parts.slice(0, 3).join(".") : null;
}

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
    /** Operation scenario (行动): the roster's relation values follow
     *  scenario team slots, not enemy semantics — the matrix renders a
     *  single allies column. */
    operation: { type: Boolean, default: false },
    /** Resolved stats-source mode (the parent resolves the pref against
     *  the replayed battle's identity — the fallback sees no head). */
    statsMode: { type: String as () => ResolvedStatsMode, default: "random" },
  },
  emits: ["close"],
  setup(props, { emit }) {
    const { dataLanguage } = useLanguage();
    const router = useRouter();
    const loadingTasks = useLoadingTasksStore();
    const realm = computed(() => props.realm || "asia");
    const root = ref<HTMLElement | null>(null);

    // Share-time privacy + share shot (same controls as the results panel —
    // the fallback matrix leaks nicknames just the same).
    const masking = useNickMasking();
    const shot = useShareShot(buildShotModel, () => root.value);
    function buildShotModel(): ShotModel {
      const mkCol = (list: typeof rows.value, enemy: boolean): ShotColumn => ({
        title: enemy ? t("replay.roster.enemies") : t("replay.roster.allies"),
        rows: list.map((r): ShotRow => {
          const ai = AI_NAME.test(r.vehicle.name);
          const st = ai ? undefined : nameStats.value.get(r.vehicle.name);
          // The chip-gated columns of the SAME stats-source view the DOM
          // matrix below renders — dashes for bots / misses.
          const stats: ShotStat[] = !st
            ? rosterShotDashes()
            : rosterShotCells(rosterStatView(st, props.statsMode));
          return {
            nick: masking.maskOf(r.vehicle.name),
            clanTag: st?.clanTag ?? null,
            shipName: r.shipName,
            bot: ai,
            dim: !r.alive,
            shipType: r.vehicle.shipId != null ? shipOfflineEntry(r.vehicle.shipId)?.type ?? null : null,
            iconVariant: !r.alive
              ? "sunk"
              : r.vehicle.relation === 0
                ? "white"
                : props.operation || r.vehicle.relation <= 1
                  ? "ally"
                  : "enemy",
            stats,
          };
        }),
      });
      return {
        title: t("replay.results"),
        botLabel: t("replay.bot"),
        // Mirror the DOM's single-column rule (operations and any
        // single-sided roster edge).
        columns:
          props.operation || enemies.value.length === 0
            ? [mkCol(allies.value, false)]
            : [mkCol(allies.value, false), mkCol(enemies.value, true)],
      };
    }

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
    // Sort order: the game's own fixed Tab key (alive, class, tier desc,
    // nation, ship name, '[tag]nick') — the exact row order the in-game
    // table shows, instead of a hand-rolled approximation.
    const sortRows = (
      a: (typeof rows.value)[number],
      b: (typeof rows.value)[number],
    ) => {
      const keyOf = (r: (typeof rows.value)[number]) =>
        gameTabRowKey(
          { shipId: r.vehicle.shipId, name: r.vehicle.name },
          r.alive,
          dataLanguage.value,
          (n) => nameStats.value.get(n)?.clanTag ?? null,
        );
      const ka = keyOf(a);
      const kb = keyOf(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    };
    const allies = computed(() =>
      (props.operation
        ? rows.value
        : rows.value.filter((r) => r.vehicle.relation <= 1)
      ).sort(sortRows),
    );
    const enemies = computed(() =>
      (props.operation
        ? []
        : rows.value.filter((r) => r.vehicle.relation > 1)
      ).sort(sortRows),
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
      const tid = loadingTasks.begin(t("replay.postbattle.loadingGlobal", { name }));
      try {
        globalStats.value = await api.lookupPlayerStats(name, realm.value, prAlgoForRequest());
        loadingTasks.end(tid);
      } catch {
        loadingTasks.end(tid);
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
        <div
          class={[
            "replay-view__postbattle-cell",
            !r.alive ? "replay-view__postbattle-cell--dead" : "",
          ]}
        >
          <button
            class="replay-view__postbattle-cell-btn"
            type="button"
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
                      : props.operation || r.vehicle.relation <= 1
                        ? "ally"
                        : "enemy"
                }
                size={20}
              />
            </span>
            <span class="replay-view__postbattle-cell-main">
              <span class="replay-view__postbattle-cell-name">
                <span class="replay-view__postbattle-cell-nick">
                  {masking.maskOf(r.vehicle.name)}
                </span>
                {nameStats.value.get(r.vehicle.name)?.clanTag ? (
                  <span class="replay-view__postbattle-cell-clan">
                    [{nameStats.value.get(r.vehicle.name)?.clanTag}]
                  </span>
                ) : null}
                {isBot(r) ? (
                  <em class="replay-view__postbattle-bot">{t("replay.bot")}</em>
                ) : null}
              </span>
              <span class="replay-view__postbattle-cell-sub">{r.shipName}</span>
            </span>
            {rosterStatCols(
              r.vehicle.name,
              nameStats.value,
              nameStatsLoading.value,
              (st) => rosterStatView(st, props.statsMode),
            )}
            <span class="replay-view__postbattle-cell-status">
              {!r.alive ? t("replay.legend.dead") : ""}
            </span>
          </button>
          {isBot(r) ? null : (
            <button
              class={[
                "replay-view__postbattle-cell-eye",
                { "replay-view__postbattle-cell-eye--on": masking.isHidden(r.vehicle.name) },
              ]}
              type="button"
              data-hint={
                masking.isHidden(r.vehicle.name)
                  ? t("replay.postbattle.showName")
                  : t("replay.postbattle.hideName")
              }
              aria-label={
                masking.isHidden(r.vehicle.name)
                  ? t("replay.postbattle.showName")
                  : t("replay.postbattle.hideName")
              }
              onClick={() => masking.toggleOne(r.vehicle.name)}
            >
              {masking.isHidden(r.vehicle.name) ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
          )}
        </div>
      );
      const sel = selected.value;
      return (
        <div class="replay-view__postbattle" ref={root}>
          <PostBattleShareBar
            hideAll={masking.hideAll.value}
            shotBusy={shot.busy.value}
            onToggleAll={() => masking.toggleAll()}
            onShot={() => void shot.copyShot()}
          />
          <div
            class={[
              "replay-view__postbattle-matrix",
              // Single-sided battle (operations): one full-width allies
              // column, no enemy column at all.
              { "replay-view__postbattle-matrix--single": enemies.value.length === 0 },
            ]}
          >
            <div class="replay-view__postbattle-col">
              <div class="replay-view__postbattle-col-title">
                {t("replay.roster.allies")}
              </div>
              {allies.value.map(cell)}
            </div>
            {enemies.value.length > 0 ? (
              <div class="replay-view__postbattle-col">
                <div class="replay-view__postbattle-col-title">
                  {t("replay.roster.enemies")}
                </div>
                {enemies.value.map(cell)}
              </div>
            ) : null}
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
                            : props.operation || sel.vehicle.relation <= 1
                              ? "ally"
                              : "enemy"
                        }
                        size={24}
                      />
                    </span>
                    <span class="replay-view__postbattle-detail-name">
                      {masking.maskOf(sel.vehicle.name)}
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
                          <HkSpinner size="md" tone="current" />
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
 *  unclaimed roster entry, never stealing a claimed one. Operation
 *  scenarios (`operation`, 行动) skip the side split — their relation
 *  values follow scenario team slots, so ambiguous picks just take the
 *  first unclaimed entry. */
function assignTrajectoriesByVehicle(
  vehicles: VehicleEntry[],
  trajectories: EntityTrajectory[],
  operation = false,
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
      if (operation || v.relation <= 1) { ax += s.x; az += s.z; an++; }
      else { ex += s.x; ez += s.z; en++; }
    }
    for (const { traj, entries } of ambiguous) {
      const unclaimed = entries.filter((e) => !claimed.has(e.id));
      let pick: VehicleEntry | undefined;
      if (!operation && an > 0 && en > 0) {
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
    /** Operation scenario (行动): the vehicle→trajectory join skips the
     *  ally/enemy spawn split (relation follows scenario team slots). */
    operation: { type: Boolean, default: false },
    /** Match duration (s) from the decoded stream — the timeline scale
     *  before the map's own clock reports in. */
    duration: { type: Number, default: 0 },
    realm: { type: String, default: "asia" },
    mapApi: { type: Object as () => HoloMapHandle | null, default: null },
  },
  setup(props) {
    const { dataLanguage } = useLanguage();
    const loadingTasks = useLoadingTasksStore();
    const router = useRouter();
    const { copy } = useClipboard();
    const rows = computed<ChatRow[]>(() => {
      // Resolve once per recompute — the shipId join is ambiguous for mirror
      // picks, so the vehicle→trajectory mapping must go through the
      // spawn-side assignment, not a naive shipId find().
      const trajByVehicle = assignTrajectoriesByVehicle(
        props.vehicles,
        props.trajectories,
        props.operation,
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
            // Operations: relation follows scenario slots — nobody reads
            // as enemy (same gate as the event feed's tint).
            enemy: !props.operation && (v?.relation ?? 0) >= 2,
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
      const tid = loadingTasks.begin(t("replay.postbattle.loadingGlobal", { name }));
      try {
        const stats = await api.lookupPlayerStats(name, props.realm || "asia", prAlgoForRequest());
        loadingTasks.end(tid);
        // Drop late responses for a player that is no longer selected.
        if (selected.value?.name !== name) return;
        globalStats.value = stats;
      } catch {
        loadingTasks.end(tid);
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
              HkScrollPin so the message list scrolls underneath it instead of
              carrying it away. Bleed contract: the pin must stay the FIRST
              element of the scroll body (host class + pad var on
              __modal-body), and the timeline keeps its gap as padding so the
              pin's painted box covers it. */}
          <HkScrollPin side="top">
            <ChatTimeline rows={rows.value} duration={props.duration} mapApi={props.mapApi} />
          </HkScrollPin>
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
                          <HkSpinner size="md" tone="current" />
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
    const loadingTasks = useLoadingTasksStore();
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

    // Persistent progress for replay operations rides the title-bar chip.
    let loadingTaskId = 0;
    watch(() => parser.loading.value, (v) => {
      if (v) {
        loadingTaskId = loadingTasks.begin(t("replay.loading"));
      } else if (loadingTaskId) {
        loadingTasks.end(loadingTaskId);
        loadingTaskId = 0;
      }
    });
    // A mid-load unmount stops the watcher before the false transition —
    // release the chip here or it would stick until the next load.
    onUnmounted(() => {
      if (loadingTaskId) {
        loadingTasks.end(loadingTaskId);
        loadingTaskId = 0;
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
    /** Stats-source mode for the fallback matrix (the pref resolved
     *  against the replayed battle's identity). */
    const fallbackStatsMode = computed<ResolvedStatsMode>(() => {
      const cur = parser.current.value;
      return resolveRosterStatsMode(statsPrefsState.value.overlayStatsMode, {
        matchGroup: cur?.matchGroup ?? null,
        scenario: cur?.scenario ?? null,
        eventType: cur?.eventType ?? null,
      });
    });
    /** Operation scenario (行动): single-team battle — drives the single
     *  allies column, the "N players" count and the icon variants. */
    const isOperation = computed(() => {
      const cur = parser.current.value;
      if (!cur) return false;
      return isOperationBattle(
        cur.matchGroup,
        cur.scenario,
        cur.eventType,
        cur.vehicles.map((v) => v.name),
      );
    });
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
                    style={
                      modeColor(
                        r.matchGroup,
                        r.scenario,
                        r.eventType,
                        r.botCount ?? 0,
                        r.scriptedUnitCount ?? 0,
                      ) as CSSProperties
                    }
                  >
                    {modeLabel(
                      r.matchGroup,
                      r.scenario,
                      r.eventType,
                      r.botCount ?? 0,
                      r.scriptedUnitCount ?? 0,
                    )}
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
                    <HkButton
                      size="sm"
                      variant="ghost"
                      loading={importing.value}
                      onClick={onPickFiles}
                      ariaLabel={t("replay.acquire.pickFiles")}
                    >
                      <FileUp size={14} />
                    </HkButton>
                    <HkButton
                      size="sm"
                      variant="ghost"
                      onClick={() => (wizardOpen.value = true)}
                      ariaLabel={t("replay.acquire.fromDesktop")}
                    >
                      <Laptop size={14} />
                    </HkButton>
                  </>
                ) : (
                  <HkButton
                    size="sm"
                    variant="ghost"
                    loading={openingExternal.value}
                    onClick={() => void onOpenExternal()}
                    ariaLabel={t("replay.list.openExternal")}
                  >
                    <FolderOpen size={14} />
                  </HkButton>
                )}
                <HkButton
                  size="sm"
                  variant="ghost"
                  disabled={(!hasClient.value && !isMobileApp()) || refreshing.value}
                  onClick={() => void onRefresh()}
                  ariaLabel={t("replay.refresh")}
                >
                  <RefreshCw size={14} class={refreshing.value ? "replay-view__spin" : ""} />
                </HkButton>
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
                    <HkButton
                      variant="primary"
                      loading={importing.value}
                      onClick={onPickFiles}
                    >
                      <FileUp size={15} />
                      {t("replay.acquire.pickFiles")}
                    </HkButton>
                    <HkButton
                      variant="secondary"
                      onClick={() => (wizardOpen.value = true)}
                    >
                      <Laptop size={15} />
                      {t("replay.acquire.fromDesktop")}
                    </HkButton>
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
                        parser.current.value.scriptedUnitCount ?? 0,
                      ) as CSSProperties
                    }
                  >
                    {modeLabel(
                      parser.current.value.matchGroup,
                      parser.current.value.scenario,
                      parser.current.value.eventType,
                      parser.current.value.botCount ?? 0,
                      parser.current.value.scriptedUnitCount ?? 0,
                    )}
                  </span>
                ) : null}
                <span class="replay-view__meta-item replay-view__count">
                  {formatPlayerCount(parser.current.value.vehicles, isOperation.value)}
                </span>
                {duration.value > 0 ? (
                  <span class="replay-view__meta-item">
                    {t("replay.duration")}: <strong>{formatDuration(duration.value)}</strong>
                  </span>
                ) : null}
                {resultsLoading.value ? (
                  <span class="replay-view__meta-item replay-view__pill replay-view__results replay-view__results--loading">
                    {t("replay.results")}
                    <HkSpinner size="xs" tone="current" />
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
                          head={{
                            matchGroup: parser.current.value.matchGroup,
                            scenario: parser.current.value.scenario,
                            eventType: parser.current.value.eventType,
                            botCount: parser.current.value.botCount ?? null,
                            scriptedUnitCount: parser.current.value.scriptedUnitCount ?? null,
                            mapName: parser.current.value.mapName,
                            realm: realm.value,
                            gameVersion: gameVersionOf(parser.current.value.raw),
                            battleTime: parser.current.value.dateTime
                              ? formatDateTime(parser.current.value.dateTime)
                              : null,
                            durationSec: duration.value > 0 ? duration.value : null,
                          }}
                          operation={isOperation.value}
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
                          operation={isOperation.value}
                          statsMode={fallbackStatsMode.value}
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
                        operation={isOperation.value}
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
                      operation={isOperation.value}
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
            on phone layout through hikari's HkModal). */}
        <PairingWizard
          open={wizardOpen.value}
          onClose={() => (wizardOpen.value = false)}
          onImported={onPairingImported}
        />
      </main>
    );
  },
});
