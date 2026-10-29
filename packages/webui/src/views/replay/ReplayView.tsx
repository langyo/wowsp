import { computed, defineComponent, markRaw, onMounted, onUnmounted, ref, watch, type CSSProperties, type VNode } from "vue";
import { Copy, Eye, EyeOff, FileUp, FolderOpen, Laptop, RefreshCw, X } from "@lucide/vue";

import { useReplayParser } from "@/features/replay/useReplayParser";
import { useReplayPositions } from "@/features/replay/useReplayPositions";
import { analyzeSpawnSymmetry, type EntitySide } from "@/features/replay/spawnSymmetry";
import { sanitizeReplayStream } from "@/features/replay/streamSanitize";
import { useGameDetect } from "@/features/gamedetect/useGameDetect";
import HolographicMap, { type HoloMapHandle } from "@/features/holographic/HolographicMap";
import PairingWizard from "@/features/replay/PairingWizard";
import { useGameStatusStore } from "@/stores/gameStatus";
import { usePairingStore } from "@/stores/pairing";
import { useUpdaterStore } from "@/stores/updater";
import { api, foldDamageStats, type DamageStatSample } from "@/api";
import type {
  AchievementEvent,
  ArenaPlayer,
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
  PlayerBuild,
  VehicleEntry,
  WeaponLockEvent,
  WeatherNotification,
  WeatherTransition,
} from "@/api";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { isMobileApp } from "@/utils/platform";
import { parsePostBattle, type PostBattleRibbon } from "@/features/replay/postBattle";
import { applyDarkDeathInference, resolveMaxHp } from "@/features/holographic/shipHp";
import PostBattlePanel from "@/features/replay/PostBattlePanel";
import {
  columnsNeedShipStats,
  overlayColumnDims,
  resolveRosterBattleScope,
  type ResolvedStatsMode,
} from "@/utils/statView";
import { scopedRosterView } from "@/utils/shipStatsScope";
import {
  PostBattleShareBar,
  rosterColumns,
  rosterShotCells,
  rosterShotDashes,
  rosterStatCols,
  useNickMasking,
  useShareShot,
  type RosterColumnSpec,
} from "@/features/replay/postBattleShare";
import type { ShotAgg, ShotColumn, ShotModel, ShotRow, ShotStat } from "@/features/replay/postBattleShot";
import { battlesColor, damageColor, prTier, winrateColor } from "@/utils/winrate";
import { aggregateTeamStats } from "@/utils/teamAggregate";
import { bundledRibbonUrl } from "@/features/holographic/ribbonIcons";
import ribbonNamesRaw from "@/data/ribbon_names.json";

const ribbonNames = ribbonNamesRaw as Record<string, Partial<Record<string, string>>>;
import { HkButton, HkIconButton, HkScrollContainer, HkScrollPin, HkSpinner, useToast } from "@celestia-island/hikari";
import BattleIcon from "@/components/base/BattleIcon";
import { AssetImage } from "@/components/base/AssetImage";
import ErrorCard from "@/components/base/ErrorCard";
import {
  nationNameFromDb,
  shipNameFromOfflineDb,
  shipOfflineEntry,
} from "@/features/holographic/modelLoader";
import { gameTabRowCompare, shipTierOf } from "@/utils/shipClass";
import { realmUsesShipNameOrder } from "@/utils/realms";
import { isListedPlayer, splitRosterSides } from "@/utils/rosterSides";
import { canonicalNation, resolveNationFlag } from "@/utils/nationFlags";
import { shipIconUrl, shipTypeClass } from "@/features/holographic/shipIcons";
import { tierToRoman } from "@wowsp/holo";
import { useClipboard } from "@/composables/useClipboard";
import { useAccountStore } from "@/stores/account";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useLoadingTasksStore } from "@/stores/loadingTasks";
import { useStatsStore } from "@/stores/stats";
import {
  hasSingleTeamRoster,
  isOperationBattle,
  isSingleTeamTabLayout,
  modeColor,
  modeColorOfKey,
  modeKey,
  singleTeamRosterFromCounts,
} from "@/utils/modeColors";
import { displayMapName } from "@/utils/mapNames";
import { clientMenuOptions, installFolderName, serverTagOf } from "@/utils/installLabel";
import { sameGamePath } from "@/utils/gamePath";
import MapNameTag from "@/features/replay/MapNameTag";
import ReplayListFilter, {
  modeLabelOfKey,
  useReplayListFilter,
  type ReplaySortDir,
} from "@/features/replay/ReplayListFilter";
import { prAlgoForRequest, statsPrefsState, type OverlayColumnScope } from "@/stores/statsPrefs";
import { AI_NAME, fetchRosterStatsByNames, type RosterStat } from "@/composables/useRosterStats";
import { useRoute, useRouter } from "vue-router";
import StatsCard from "@/components/stats/StatsCard";
import { markerTintClass } from "@/features/markers/markerTint";
import { markerColorLabel } from "@/features/markers/playerContextMenu";
import { useMarkersStore } from "@/stores/markers";
import type { PlayerStats } from "@/api";
import "./ReplayView.scss";

/** Localize a battle mode from its layered identity (matchGroup / scenario /
 *  eventType / roster bots / roster shape) with a generic fallback. The
 *  `singleTeamRoster` flag is the count/roster twin of hasSingleTeamRoster:
 *  a pve-family battle with players but no enemy side is a story-operation
 *  shape (行动), not plain co-op (see utils/modeColors.ts). */
function modeLabel(
  group?: string | null,
  scenario?: string | null,
  eventType?: string | null,
  botCount = 0,
  scriptedUnitCount = 0,
  singleTeamRoster: boolean | null = null,
): string {
  return modeLabelOfKey(
    modeKey(group, scenario, eventType, botCount, scriptedUnitCount, singleTeamRoster),
  );
}

/** Player count label: team-vs-team modes show "12v12" (split by the roster
 *  relation), single-sided modes (PvE, ops) show the raw count. Operations
 *  keep the relation split available but render the raw count (their
 *  scripted enemy block is nobody's "v" opponent). Scripted scenario NPCs
 *  sit out the count — the label reads like the game's own team size. */
function formatPlayerCount(
  vehicles: { relation: number; name: string }[],
  operation = false,
): string {
  const { allies, enemies } = splitRosterSides(vehicles, operation);
  if (!operation && allies.length > 0 && enemies.length > 0) {
    return `${allies.length}v${enemies.length}`;
  }
  return t("replay.players", { n: allies.length + enemies.length });
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
    /** Operation scenario (行动): the matrix renders a single allies
     *  column — the scripted enemy block is a list nobody reads (the
     *  ally rows themselves still split by relation). */
    operation: { type: Boolean, default: false },
    /** The CN pinyin ship-name row order, resolved by the parent from
     *  the replay's realm AND table shape (the single-team layouts only
     *  — issue #1360: a two-team CN battle renders the WG-family nation
     *  rank). Gated upstream so the panel never re-derives it. */
    shipNameOrder: { type: Boolean, default: false },
    /** The arena's initial player state — the authoritative entity→roster
     *  join for the per-row HP/death columns (mirror picks share one
     *  shipId, so shipId-keyed maps overwrite each other). */
    arenaPlayers: { type: Array as () => ArenaPlayer[], default: () => [] },
    /** Entity ids whose deathTime was inferred from the post-battle payload
     *  (dark kills) — the self-frag heuristic must not credit them. */
    inferredDeaths: { type: Object as () => Set<number>, default: () => new Set() },
    /** Resolved stats-source battle scope (the parent resolves the pref
     *  against the replayed battle's identity — the fallback sees no
     *  head). The ship/solo dimensions ride the shared prefs directly. */
    statsMode: { type: String as () => ResolvedStatsMode, default: "random" },
  },
  emits: ["close"],
  setup(props, { emit }) {
    const { dataLanguage } = useLanguage();
    const router = useRouter();
    const loadingTasks = useLoadingTasksStore();
    const stats = useStatsStore();
    const realm = computed(() => props.realm || "asia");
    const root = ref<HTMLElement | null>(null);

    // Share-time privacy + share shot (same controls as the results panel —
    // the fallback matrix leaks nicknames just the same).
    const masking = useNickMasking();
    // Local player markers (玩家标记) for the fallback roster rows.
    const markers = useMarkersStore();
    void markers.ensureLoaded();
    const shot = useShareShot(buildShotModel, () => root.value);
    /** One row's numbers for ONE column scope — the account careers for
     *  "global" and "solo" (the career carries the solo split), the
     *  aggregated per-ship view otherwise, against the replay's
     *  already-resolved battle scope. */
    const colViewOf = (
      scope: OverlayColumnScope,
      st: RosterStat,
      shipId: number | null,
    ) =>
      scopedRosterView(
        st,
        shipId,
        overlayColumnDims(scope, statsPrefsState.value.overlayBattleScope),
        props.statsMode,
        prAlgoForRequest() ?? "winrate",
      );
    function buildShotModel(): ShotModel {
      const mkCol = (list: typeof rows.value, enemy: boolean): ShotColumn => {
        // The shot's column-title aggregates mirror the DOM header the
        // matrix renders: one labeled team mean PER CONFIGURED COLUMN (each
        // in its own scope's view), right-aligned onto its stat column —
        // the same wording the live panel's and the results panel's shots
        // caption their columns with. The fallback carries no XP column, so
        // unlike the results panel's shot there is no trailing label-only
        // caption.
        const agg: ShotAgg[] = rosterColumns().map((col, idx) => {
          const a = teamAggFor(col.scope, list);
          const label =
            col.scope !== "global"
              ? col.head
              : col.metric === "winrate"
                ? t(
                    statsPrefsState.value.weightedTeamWr
                      ? "replay.roster.teamWrWeighted"
                      : "replay.roster.teamWrPlain",
                  )
                : col.metric === "pr"
                  ? t("replay.roster.teamAvgPr")
                  : col.metric === "battles"
                    ? t("replay.roster.battles")
                    : col.metric === "kd"
                      ? t("replay.roster.metricKd")
                      : t("replay.postbattle.avgDamage");
          if (col.metric === "winrate") {
            return {
              col: idx,
              label,
              value: a.winrate != null ? `${a.winrate.toFixed(1)}%` : "—",
              valueColor: a.winrate != null ? winrateColor(a.winrate) : undefined,
            };
          }
          if (col.metric === "pr") {
            return {
              col: idx,
              label,
              value: a.avgPr != null ? `${Math.round(a.avgPr)}` : "—",
              valueColor: a.avgPr != null ? prTier(a.avgPr).color : undefined,
            };
          }
          if (col.metric === "battles") {
            return {
              col: idx,
              label,
              value:
                a.avgBattles != null ? Math.round(a.avgBattles).toLocaleString() : "—",
              // Thin-sample red rides the ACCOUNT column only — a scoped
              // count under 200 is the norm, not a warning (same gate the
              // cells and the sibling shots keep).
              valueColor:
                col.scope === "global" && a.avgBattles != null
                  ? battlesColor(a.avgBattles)
                  : undefined,
            };
          }
          if (col.metric === "kd") {
            return {
              col: idx,
              label,
              value: a.avgKd != null ? a.avgKd.toFixed(2) : "—",
            };
          }
          return {
            col: idx,
            label,
            value:
              a.avgDamage != null ? Math.round(a.avgDamage).toLocaleString() : "—",
            valueColor: a.avgDamage != null ? damageColor(a.avgDamage) : undefined,
          };
        });
        return {
          title: enemy ? t("replay.roster.enemies") : t("replay.roster.allies"),
          agg: agg.length > 0 ? agg : undefined,
          rows: list.map((r): ShotRow => {
            const ai = AI_NAME.test(r.vehicle.name);
            const st = ai ? undefined : nameStats.value.get(r.vehicle.name);
            // The configured columns of the per-scope views the DOM matrix
            // below renders — dashes for bots / misses.
            const stats: ShotStat[] = !st
              ? rosterShotDashes()
              : rosterShotCells((scope) => colViewOf(scope, st, r.vehicle.shipId));
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
                  : r.vehicle.relation <= 1
                    ? "ally"
                    : "enemy",
              stats,
            };
          }),
        };
      };
      return {
        title: t("replay.results"),
        botLabel: t("replay.bot"),
        // Mirror the DOM's single-column rule (operations hide the enemy
        // column, as does any single-sided roster edge).
        columns:
          enemies.value.length === 0
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
    // Flipping any column past the account careers (or the PR algorithm)
    // after the one-shot load re-runs it — the fetch only attaches the
    // per-ship lists the columns in force at load time requested.
    watch(
      () =>
        [
          columnsNeedShipStats(
            statsPrefsState.value.overlayColumns,
            statsPrefsState.value.prEnabled,
          ),
          prAlgoForRequest(),
        ] as const,
      ([need]) => {
        if (need) void loadNameStats();
      },
    );
    onMounted(() => {
      void loadNameStats();
    });

    /** Ship entity → roster player id, from the arena's initial state.
     *  Lets the per-row joins key on the roster entry — mirror picks share
     *  one shipId, so shipId-keyed maps overwrite each other. */
    const entityByPlayerId = computed(() => {
      const m = new Map<number, number>();
      for (const p of props.arenaPlayers) {
        if (p.playerId != null) m.set(p.playerId, p.entityId);
      }
      return m;
    });
    /** Death time per roster id when the arena join is available, else per
     *  shipId (the pre-arena fallback, ambiguous on mirror picks). */
    const deathByRosterId = computed(() => {
      const m = new Map<number, number | null>();
      if (entityByPlayerId.value.size === 0) return m;
      for (const tr of props.trajectories) {
        const playerId = [...entityByPlayerId.value].find(
          ([, eid]) => eid === tr.entityId,
        )?.[0];
        if (playerId != null) m.set(playerId, tr.deathTime ?? null);
      }
      return m;
    });
    const deathByShipId = computed(() => {
      const m = new Map<number, number | null>();
      for (const tr of props.trajectories) {
        if (tr.kind?.shipId != null) m.set(tr.kind.shipId, tr.deathTime ?? null);
      }
      return m;
    });
    /** HP timeline per roster id when the arena join is available, else per
     *  shipId (the pre-arena fallback, ambiguous on mirror picks). */
    const hpByRosterId = computed(() => {
      const m = new Map<number, HpSample[]>();
      if (entityByPlayerId.value.size === 0) return m;
      for (const tr of props.trajectories) {
        if (!tr.hpSamples?.length) continue;
        const playerId = [...entityByPlayerId.value].find(
          ([, eid]) => eid === tr.entityId,
        )?.[0];
        if (playerId != null) m.set(playerId, tr.hpSamples);
      }
      return m;
    });
    const hpByShipId = computed(() => {
      const m = new Map<number, HpSample[]>();
      for (const tr of props.trajectories) {
        if (tr.kind?.shipId != null && tr.hpSamples?.length) {
          m.set(tr.kind.shipId, tr.hpSamples);
        }
      }
      return m;
    });
    /** Total HP per roster id from the arena's build health — the base-info
     *  source the HP-percent column divides by (a stream-peak total
     *  under-reports late-spotted ships and reads non-round in scaled
     *  modes). */
    const maxHpByRosterId = computed(() => {
      const m = new Map<number, number>();
      for (const p of props.arenaPlayers) {
        if (p.playerId != null && p.maxHealth && p.maxHealth > 0) {
          m.set(p.playerId, p.maxHealth);
        }
      }
      return m;
    });
    /** Recorder's own inferred damage dealt / frags / hits. The self
     *  trajectory is resolved through the arena join (by entity id) — the
     *  shipId fallback can grab the enemy's mirror ship. */
    const selfStats = computed(() => {
      const self = props.vehicles.find((v) => v.relation === 0);
      const selfEntityId = self
        ? entityByPlayerId.value.get(self.id)
        : undefined;
      return computeSelfStats(
        props.trajectories,
        props.shotKills ?? [],
        self?.shipId,
        props.damageStats,
        selfEntityId,
        props.inferredDeaths,
      );
    });
    const rows = computed(() =>
      // Scripted scenario NPCs (story-mode ally flagships, `IDS_*`/`#Name`)
      // are not players — the fallback matrix lists players only, matching
      // the Tab scoreboard.
      props.vehicles.filter(isListedPlayer).map((v) => {
        const hp =
          (v.shipId != null ? hpByRosterId.value.get(v.id) : undefined) ??
          (v.shipId != null ? hpByShipId.value.get(v.shipId) : undefined);
        const isSelf = v.relation === 0;
        const st = selfStats.value;
        const frags = isSelf ? st.frags : 0;
        const hits = isSelf ? st.hits : 0;
        const ribbons: PostBattleRibbon[] = [];
        if (isSelf) {
          if (hits > 0) ribbons.push({ key: "main_caliber", value: hits });
          if (frags > 0) ribbons.push({ key: "frag", value: frags });
        }
        const deathAt = deathByRosterId.value.has(v.id)
          ? deathByRosterId.value.get(v.id)
          : v.shipId != null
            ? deathByShipId.value.get(v.shipId)
            : undefined;
        return {
          vehicle: v,
          alive: !(deathAt != null),
          shipName:
            (v.shipId != null
              ? shipNameFromOfflineDb(v.shipId, dataLanguage.value)
              : null) ?? v.shipName ?? "",
          damage: isSelf ? st.damage : 0,
          frags,
          // A sunk ship reads 0 HP whatever its last observed sample said
          // (dark kills freeze the stream at a stale value).
          hpRatio: deathAt != null ? 0 : hpRatioOf(hp, maxHpByRosterId.value.get(v.id)),
          damageTaken: damageTaken(hp),
          ribbons,
          killerName: null as string | null,
          isSelf,
        };
      }),
    );
    // Sort order: the client's Tab key (alive, class, tier desc, nation,
    // ship name, '[tag]nick') — the verified WG-family base, with the
    // replay's realm AND table shape picking the flavor: the CN
    // single-team layouts (co-op / operations — the 2026-10-07
    // calibration's table) order the within-(class, tier) group by the
    // localized ship name, while a two-team CN battle renders the
    // decompiled nation rank like every other realm (issue #1360);
    // everything else keeps the decompiled nation rank (Lesta included —
    // the approximation, nation rank and name segment alike, is
    // documented in utils/shipClass). The permutation is unstable
    // per-client knowledge (utils/shipClass's module docs) — recalibrate
    // against rendered captures.
    const compareRows = (
      a: (typeof rows.value)[number],
      b: (typeof rows.value)[number],
    ) =>
      gameTabRowCompare(
        { shipId: a.vehicle.shipId, name: a.vehicle.name },
        { shipId: b.vehicle.shipId, name: b.vehicle.name },
        {
          locale: dataLanguage.value,
          clanTagOf: (v) => nameStats.value.get(v.name)?.clanTag ?? null,
          shipNameOrder: props.shipNameOrder,
        },
      );
    // The comparator skips the alive prefix on purpose (each sort orders
    // one layout), so the game's [alive] ++ [sunk] split happens here.
    const tabOrdered = (list: (typeof rows.value)[number][]) => {
      const alive = list.filter((r) => r.alive).sort(compareRows);
      const sunk = list.filter((r) => !r.alive).sort(compareRows);
      return [...alive, ...sunk];
    };
    const allies = computed(() =>
      tabOrdered(rows.value.filter((r) => r.vehicle.relation <= 1)),
    );
    const enemies = computed(() =>
      props.operation
        ? []
        : tabOrdered(rows.value.filter((r) => r.vehicle.relation > 1)),
    );

    /** One side's header aggregate FOR ONE COLUMN SCOPE — the same
     *  tier-weighted (per the stats prefs) mean winrate plus plain mean PR /
     *  battles / avg damage / K/D the live panel and the results panel
     *  caption their columns with, each in that scope's resolved view. AI
     *  names, hidden profiles and stat misses sit out. */
    const teamAggFor = (scope: OverlayColumnScope, list: typeof rows.value) =>
      aggregateTeamStats(
        list.map((r) => {
          const st = !AI_NAME.test(r.vehicle.name)
            ? nameStats.value.get(r.vehicle.name)
            : undefined;
          if (
            !st ||
            st.hidden ||
            // Only the per-ship scopes wait on the per-ship lists — the
            // plain solo scope reads the career split (utils/shipStatsScope).
            (scope !== "global" && scope !== "solo" && st.shipsLoading)
          ) {
            return {
              winrate: null,
              pr: null,
              battles: null,
              damage: null,
              kd: null,
              tier: r.vehicle.shipId != null ? shipTierOf(r.vehicle.shipId) : null,
            };
          }
          const view = colViewOf(scope, st, r.vehicle.shipId);
          return {
            winrate: view.winrate,
            pr: view.pr,
            battles: view.battles,
            damage: view.avgDamage,
            kd: view.kd,
            tier: r.vehicle.shipId != null ? shipTierOf(r.vehicle.shipId) : null,
          };
        }),
        statsPrefsState.value.weightedTeamWr,
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
        globalStats.value = await stats.lookup(name, realm.value);
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
      /** The column caption over one side's rows — the two-line mini table
       *  header the live panel and the results panel share (a tiny label
       *  over the team mean, both right-aligned onto a grid mirroring the
       *  row cells), so the fallback matrix reads the same header its
       *  siblings do. The fallback rows carry no XP cell, so the grid has
       *  no XP track; with every configured column removed the caption
       *  falls back to the bare title (nothing left to align). The header
       *  keeps the compact rows' --pad-eye right-edge compensation — the
       *  fallback rows are those same compact rows (mask eye at the end,
       *  no seal slot). */
      const colTitle = (label: string, list: typeof rows.value) => {
        const title = <span class="replay-view__postbattle-col-name">{label}</span>;
        const cols = rosterColumns();
        if (cols.length === 0) {
          return <div class="replay-view__postbattle-col-title">{title}</div>;
        }
        // Aggregate labels: the aggregate flavor wording on the global
        // columns (weighted/plain team WR etc.), the column's own head
        // (scope tag + metric) on scoped ones — the same wording the
        // sibling panels caption their columns with.
        const labelOf = (col: RosterColumnSpec): string => {
          if (col.scope !== "global") return col.head;
          if (col.metric === "winrate") {
            return t(
              statsPrefsState.value.weightedTeamWr
                ? "replay.roster.teamWrWeighted"
                : "replay.roster.teamWrPlain",
            );
          }
          if (col.metric === "pr") return t("replay.roster.teamAvgPr");
          if (col.metric === "battles") return t("replay.roster.battles");
          if (col.metric === "kd") return t("replay.roster.metricKd");
          return t("replay.postbattle.avgDamage");
        };
        const valueOf = (col: RosterColumnSpec): VNode => {
          const agg = teamAggFor(col.scope, list);
          if (col.metric === "winrate") {
            return (
              <b
                class="replay-view__postbattle-col-hval"
                style={agg.winrate != null ? { color: winrateColor(agg.winrate) } : undefined}
              >
                {agg.winrate != null ? `${agg.winrate.toFixed(1)}%` : "—"}
              </b>
            );
          }
          if (col.metric === "pr") {
            // The unicum band keeps its rainbow (彩表) face like every
            // other PR rendering.
            const band = prTier(agg.avgPr);
            return (
              <b
                class={[
                  "replay-view__postbattle-col-hval",
                  band.rainbow ? "rainbow-text" : undefined,
                ]}
                style={band.rainbow ? undefined : { color: band.color }}
              >
                {agg.avgPr != null ? Math.round(agg.avgPr) : "—"}
              </b>
            );
          }
          if (col.metric === "battles") {
            return (
              <b
                class="replay-view__postbattle-col-hval"
                style={
                  col.scope === "global" && agg.avgBattles != null
                    ? { color: battlesColor(agg.avgBattles) }
                    : undefined
                }
              >
                {agg.avgBattles != null ? Math.round(agg.avgBattles).toLocaleString() : "—"}
              </b>
            );
          }
          if (col.metric === "kd") {
            return (
              <b class="replay-view__postbattle-col-hval">
                {agg.avgKd != null ? agg.avgKd.toFixed(2) : "—"}
              </b>
            );
          }
          return (
            <b
              class="replay-view__postbattle-col-hval"
              style={agg.avgDamage != null ? { color: damageColor(agg.avgDamage) } : undefined}
            >
              {agg.avgDamage != null ? Math.round(agg.avgDamage).toLocaleString() : "—"}
            </b>
          );
        };
        return (
          <div
            class={[
              "replay-view__postbattle-col-title",
              "replay-view__postbattle-col-title--agg",
              "replay-view__postbattle-col-title--pad-eye",
            ]}
            style={{
              gridTemplateColumns: `minmax(0, 1fr) ${cols.map((c) => c.width).join(" ")}`,
            }}
          >
            {title}
            {cols.map((c) => (
              <span class="replay-view__postbattle-col-hlbl">{labelOf(c)}</span>
            ))}
            {cols.map((c) => valueOf(c))}
          </div>
        );
      };
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
            data-player-name={isBot(r) ? undefined : r.vehicle.name}
            data-player-account={
              nameStats.value.get(r.vehicle.name)?.accountId != null
                ? String(nameStats.value.get(r.vehicle.name)?.accountId)
                : undefined
            }
            data-player-realm={realm.value}
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
                {/* Local player marker (玩家标记): the name itself carries the
                    animated tint (nickname-first; account id sharpens when
                    the row has stats for it). */}
                {(() => {
                  const color = isBot(r)
                    ? null
                    : markers.colorOf(
                        r.vehicle.name,
                        nameStats.value.get(r.vehicle.name)?.accountId ?? null,
                      );
                  return (
                    <span
                      class={["replay-view__postbattle-cell-nick", markerTintClass(color)]}
                      title={color ? markerColorLabel(color) : undefined}
                    >
                      {masking.maskOf(r.vehicle.name)}
                    </span>
                  );
                })()}
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
              (st, scope) => colViewOf(scope, st, r.vehicle.shipId),
            )}
            {/* No dead-state text cell after the stat columns: a sunk row
                already reads as sunk through its icon variant + the row's
                dead dimming, and a text slot there would act as one more
                column — pushing the row's numbers off the header's aligned
                tracks (user feedback: the standalone 已击毁 marker is gone
                from every post-battle roster). */}
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
            {/* Column scroller: the hikari container owns the scrollbar
                (auto-hiding overlay track); the rows stack inside the
                inner wrapper so the column-title scrolls with them. */}
            <HkScrollContainer class="replay-view__postbattle-col">
              {/* hk-selectable: the roster IS the battle report — names,
                  clans, ship names and the stat numbers are exactly what
                  users copy out of it (hikari 0.55.224 selection policy:
                  content opts back in via this hook). */}
              <div class="hk-selectable replay-view__postbattle-col__inner">
                {colTitle(t("replay.roster.allies"), allies.value)}
                {allies.value.map(cell)}
              </div>
            </HkScrollContainer>
            {enemies.value.length > 0 ? (
              <HkScrollContainer class="replay-view__postbattle-col">
                <div class="hk-selectable replay-view__postbattle-col__inner">
                  {colTitle(t("replay.roster.enemies"), enemies.value)}
                  {enemies.value.map(cell)}
                </div>
              </HkScrollContainer>
            ) : null}
          </div>

          {detailOpen.value && sel ? (
            <div
              class="replay-view__postbattle-modal"
              onClick={() => (detailOpen.value = false)}
            >
              <div
                class="hk-selectable replay-view__postbattle-modal-panel"
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
                      {masking.maskOf(sel.vehicle.name)}
                      {isBot(sel) ? (
                        <em class="replay-view__postbattle-bot">{t("replay.bot")}</em>
                      ) : null}
                      <em class="replay-view__postbattle-detail-ship">{sel.shipName}</em>
                    </span>
                  </span>
                  <HkIconButton
                    class="hk-window-close replay-view__postbattle-modal-close"
                    size={32}
                    variant="ghost"
                    icon="close"
                    aria-label={t("common.close")}
                    onClick={() => (detailOpen.value = false)}
                  />
                </div>
                {/* Drill-down scroller: the hikari container owns the
                    scrollbar; the body blocks stack directly in its
                    viewport (no layout rules to preserve). */}
                <HkScrollContainer class="replay-view__postbattle-modal-scroll">
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
                </HkScrollContainer>
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

/** The `data-hint-card` JSON for a replay card's own-ship tag — identity +
 *  basic parameters off the offline ship DB, pre-localized per the global
 *  tooltip's string-only contract (the popup renders via DOM APIs). */
function ownShipHintCard(
  entry: NonNullable<ReturnType<typeof shipOfflineEntry>>,
  name: string,
  lang: string,
): string {
  // The offline DB spells nations GameParams-style (united_kingdom/russia/
  // events); canonicalize first or the label/flag lookups miss entirely.
  const nation = entry.nation ? canonicalNation(entry.nation) : "";
  const nationLabel = nation
    ? (nationNameFromDb(nation, lang) ?? (t(`ships.nation.${nation}`, {}) || nation))
    : null;
  const subtitle: string[] = [];
  if (nationLabel) subtitle.push(nationLabel);
  if (entry.type) subtitle.push(t(`ships.type.${entry.type}`, {}) || entry.type);
  return JSON.stringify({
    title: name,
    badge: entry.tier != null ? tierToRoman(entry.tier) : undefined,
    iconUrl: entry.type ? (shipIconUrl(entry.type, "plain") ?? undefined) : undefined,
    subtitleFlagUrl: nation ? (resolveNationFlag(nation, "flag") ?? undefined) : undefined,
    subtitle: subtitle.length > 0 ? subtitle.join(" · ") : undefined,
    rows:
      entry.hp != null
        ? [{ label: t("ships.spec.hp", {}), value: entry.hp.toLocaleString() }]
        : [],
  });
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

/** Remaining-HP percent (0..100) from the last HP sample. `maxHp` is the
 *  ship's base-info total (arena build health) when known — the stream's
 *  own peak is only the fallback (it under-reports late-spotted ships). */
function hpRatioOf(
  hp: HpSample[] | undefined | null,
  maxHp?: number,
): number | null {
  if (!hp || hp.length === 0) return null;
  let max = maxHp && maxHp > 0 ? maxHp : 0;
  if (max <= 0) {
    for (const s of hp) if (s.value > max) max = s.value;
  }
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
 *  vehicle id) remains the fallback for versions without damage stats.
 *  `inferredDeaths` lists sinks whose deathTime was inferred from the
 *  post-battle payload (never observed sinking) — the ±1.2 s death-proximity
 *  frag credit must not fire for them, or the recorder gains frags for kills
 *  someone else landed while the ship sailed dark. */
function computeSelfStats(
  trajectories: EntityTrajectory[],
  shotKills: ShotKillEvent[],
  selfShipId: number | undefined,
  damageStats?: DamageStatSample[] | null,
  selfEntityId?: number,
  inferredDeaths?: Set<number>,
): { damage: number; planeDamage: number; frags: number; hits: number } {
  const authoritative = damageStats?.length ? foldDamageStats(damageStats, Infinity) : null;
  const out = { damage: 0, planeDamage: 0, frags: 0, hits: 0 };
  if (selfShipId == null) return authoritative ? { ...out, ...authoritative } : out;
  // The arena join (entity id) wins: mirror picks share the selfShipId, so
  // the shipId find() can land on the enemy's ship and attribute its hits.
  const selfTraj = selfEntityId != null
    ? trajectories.find((tr) => tr.entityId === selfEntityId)
    : trajectories.find(
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
      if (tr.deathTime != null && !inferredDeaths?.has(tr.entityId) && Math.abs(tr.deathTime - e.time) < 1.2) {
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
 *  unclaimed roster entry, never stealing a claimed one. The relation side
 *  split holds in operations (行动) too — their rosters carry real enemy
 *  semantics. */
function assignTrajectoriesByVehicle(
  vehicles: VehicleEntry[],
  trajectories: EntityTrajectory[],
  arenaPlayers?: ArenaPlayer[],
): Map<number, EntityTrajectory> {
  const shipTrajs = trajectories.filter((tr) => tr.kind?.entityType === 2);
  // Authoritative path: the arena's initial state maps each ship entity to
  // its roster player id directly — mirror picks cannot cross.
  if (arenaPlayers && arenaPlayers.length > 0) {
    const out = new Map<number, EntityTrajectory>();
    const byEntity = new Map(arenaPlayers.map((p) => [p.entityId, p]));
    for (const traj of shipTrajs) {
      const playerId = byEntity.get(traj.entityId)?.playerId;
      if (playerId != null) out.set(playerId, traj);
    }
    if (out.size > 0) return out;
  }
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

/** Entity-id → battle-side resolver for the decode-time spawn-symmetry probe
 *  (features/replay/spawnSymmetry.ts). The arena's initial state is
 *  authoritative when it decoded: `teamId` against the recorder's side (the
 *  `isSelf` entry, or the entry matching `recorderVehicleId`). Replays whose
 *  arena state is missing/version-drifted fall back to the roster's
 *  unique-shipId join — only when BOTH the roster and the decoded entity
 *  stream carry that shipId exactly once, because mirror picks and bot lines
 *  share shipIds and a crossed join would assign the wrong side. Entities
 *  neither path can place return null, so the probe reports "not enough
 *  data" instead of guessing. */
function spawnSideResolver(
  vehicles: VehicleEntry[],
  arenaPlayers: ArenaPlayer[],
  recorderVehicleId: number | null,
  trajectories: EntityTrajectory[],
): (entityId: number) => EntitySide | null {
  let selfTeam: number | null = arenaPlayers.find((p) => p.isSelf)?.teamId ?? null;
  if (selfTeam == null && recorderVehicleId != null) {
    selfTeam = arenaPlayers.find((p) => p.entityId === recorderVehicleId)?.teamId ?? null;
  }
  const arenaTeam = new Map<number, number>();
  if (selfTeam != null) {
    for (const p of arenaPlayers) arenaTeam.set(p.entityId, p.teamId);
  }
  const rosterShipIds = new Map<number, VehicleEntry>();
  const rosterShipIdCounts = new Map<number, number>();
  for (const v of vehicles) {
    rosterShipIds.set(v.shipId, v);
    rosterShipIdCounts.set(v.shipId, (rosterShipIdCounts.get(v.shipId) ?? 0) + 1);
  }
  const trajByEntity = new Map<number, EntityTrajectory>();
  const trajShipIdCounts = new Map<number, number>();
  for (const traj of trajectories) {
    trajByEntity.set(traj.entityId, traj);
    const sid = traj.kind?.shipId;
    if (sid != null) trajShipIdCounts.set(sid, (trajShipIdCounts.get(sid) ?? 0) + 1);
  }
  return (entityId) => {
    const team = arenaTeam.get(entityId);
    if (team != null) return team === selfTeam ? "ally" : "enemy";
    const sid = trajByEntity.get(entityId)?.kind?.shipId;
    if (sid == null) return null;
    if (rosterShipIdCounts.get(sid) !== 1 || trajShipIdCounts.get(sid) !== 1) {
      return null;
    }
    const entry = rosterShipIds.get(sid);
    return entry ? (entry.relation < 2 ? "ally" : "enemy") : null;
  };
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
    /** The arena's initial player state — the authoritative entity→roster
     *  join for the sender tooltips (mirror picks share one shipId). */
    arenaPlayers: { type: Array as () => ArenaPlayer[], default: () => [] },
    /** Match duration (s) from the decoded stream — the timeline scale
     *  before the map's own clock reports in. */
    duration: { type: Number, default: 0 },
    realm: { type: String, default: "asia" },
    mapApi: { type: Object as () => HoloMapHandle | null, default: null },
  },
  setup(props) {
    const { dataLanguage } = useLanguage();
    const loadingTasks = useLoadingTasksStore();
    const stats = useStatsStore();
    const router = useRouter();
    const { copy } = useClipboard();
    const rows = computed<ChatRow[]>(() => {
      // Resolve once per recompute — the shipId join is ambiguous for mirror
      // picks, so the vehicle→trajectory mapping must go through the
      // spawn-side assignment, not a naive shipId find().
      const trajByVehicle = assignTrajectoriesByVehicle(
        props.vehicles,
        props.trajectories,
        props.arenaPlayers,
      );
      return props.events
        .filter((c) => c.playerId > 0)
        .map((c) => {
          const v = props.vehicles.find((x) => x.id === c.playerId);
          const traj = v ? trajByVehicle.get(v.id) : undefined;
          const sunk = traj?.deathTime != null && c.time >= traj.deathTime;
          // Total HP from the ship's base info: the arena's build health
          // first, stream peak / offline hull only as fallbacks (a
          // stream-peak "total" showed damaged-in non-round values).
          const arenaMax = traj
            ? props.arenaPlayers.find((p) => p.entityId === traj.entityId)?.maxHealth
            : undefined;
          const maxHp = resolveMaxHp(
            arenaMax,
            traj?.hpSamples,
            null,
            v?.shipId != null ? shipOfflineEntry(v.shipId)?.hp ?? null : null,
          );
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
      // The label keys off shipTypeClass's atlas class — an unknown type has
      // none, and a missing label beats interpolating the bare i18n key path.
      const clsKind = r.shipType ? shipTypeClass(r.shipType) : "";
      const cls = clsKind ? t(`replay.classes.${clsKind}`) : "";
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
        const row = await stats.lookup(name, props.realm || "asia");
        loadingTasks.end(tid);
        // Drop late responses for a player that is no longer selected.
        if (selected.value?.name !== name) return;
        globalStats.value = row;
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
          {/* Above the scroll: the timeline (and its legend) rides an
              HkScrollPin header, a static first child of the body (the
              message list scrolls ITSELF — see __chat-scroll in the SCSS —
              so the body never scrolls and the pin never actually pins).
              strategy="none", not the default bleed contract: bleed pulls
              the pin's flow position above the host's content box with a
              negative margin, and Chromium clamps sticky against that box,
              shifting the glass panel down by exactly the pad — its painted
              box then swallowed the first row's top slice (2026-10-22
              report, measured: pin bottom sat 9.6px into the scroller).
              With none, the pin's box rests flush on the scroller's top
              edge in flow: the body's own padding is the gutter above it,
              the timeline keeps its gap as padding so the glass runs into
              that edge, and rows clip at the scroller's crisp top edge,
              never behind the translucent pin. */}
          <HkScrollPin side="top" strategy="none">
            <ChatTimeline rows={rows.value} duration={props.duration} mapApi={props.mapApi} />
          </HkScrollPin>
          {/* Message-list scroller: the hikari container owns the scrollbar
              (auto-hiding overlay track on the list's right edge); the grid
              stays on the <ul> so the rows keep their shared subgrid axes. */}
          <HkScrollContainer class="replay-view__chat-scroll">
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
          </HkScrollContainer>
          {/* Level-2 modal: the sender's stats (reuses the post-battle
              modal chrome; sits fixed above the chat panel). */}
          {sel ? (
            <div class="replay-view__postbattle-modal" onClick={() => (selected.value = null)}>
              <div
                class="hk-selectable replay-view__postbattle-modal-panel"
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
                  <HkIconButton
                    class="hk-window-close replay-view__postbattle-modal-close"
                    size={32}
                    variant="ghost"
                    icon="close"
                    aria-label={t("common.close")}
                    onClick={() => (selected.value = null)}
                  />
                </div>
                {/* Drill-down scroller (hikari container owns the scrollbar;
                    the note blocks stack directly in its viewport). */}
                <HkScrollContainer class="replay-view__postbattle-modal-scroll">
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
                </HkScrollContainer>
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
    // Player markers (玩家标记) for the rail cards' recording-player tint;
    // the list panel keeps its own instance for the roster rows.
    const markers = useMarkersStore();
    void markers.ensureLoaded();
    const encyclopedia = useEncyclopediaStore();
    const toast = useToast();
    const loadingTasks = useLoadingTasksStore();
    const updater = useUpdaterStore();
    const { dataLanguage } = useLanguage();
    const mapLang = computed(() => dataLanguage.value);
    const gameStatus = useGameStatusStore();
    // Rail filter — mode multi-select + match-time order (persisted) + a
    // session-only date window; see ReplayListFilter for the interaction
    // model.
    // The rail lists what the user can act on: an install removed from the
    // settings list takes its replays with it (the Rust all-clients scan
    // keeps finding the folder — the ignore is presentation-level, webui
    // only — and a card whose client no dropdown can pick is a dead end).
    const scannedReplays = computed(() =>
      parser.list.value.filter((r) => !gd.config.isIgnoredPath(r.installPath)),
    );
    const listFilter = useReplayListFilter(scannedReplays, parser.external);
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

    const hasClient = computed(() => gd.config.installs.length > 0);

    /** The server tag of an entry — realm first ("ASIA"/"CN"/"RU"), else the
     *  client kind's label, else empty for a file under no detected install.
     *  One vocabulary for the cards, the count row and the client filter. */
    function serverTagOfMeta(r: ReplayMetaLite): string {
      return serverTagOf(r.installKind, r.installRealm);
    }

    /** The realm the OPEN replay's own client carries, when the scan tagged
     *  it. The rail now mixes clients, so roster lookups must follow the
     *  replay being reviewed rather than whatever install is active
     *  app-wide (a CN replay opened while Steam is active would otherwise
     *  query the ASIA stats API). */
    const openReplayRealm = computed(() => {
      const path = parser.selectedPath.value;
      if (!path) return null;
      const entry = [...scannedReplays.value, ...parser.external.value].find(
        (r) => r.path === path,
      );
      return entry?.installRealm ?? null;
    });

    /** The realm to query player stats against: the open replay's client,
     *  then the active install, then the bound account, else the UI
     *  default. */
    const realm = computed(
      () =>
        openReplayRealm.value ??
        gd.config.activeInstall?.realm ??
        accounts.activeAccount?.realm ??
        accounts.activeRealm ??
        "asia",
    );

    /** The client (owning install) options of the rail's client dimension:
     *  every detected install, labelled the way the sidebar/settings name it
     *  (same-labelled installs disambiguated by folder — see
     *  clientMenuOptions). A persisted pick whose install has since
     *  disappeared is appended by its folder name so the stale selection
     *  stays visible and clearable instead of silently filtering everything
     *  out. */
    const clientOptions = computed(() => {
      const opts = clientMenuOptions(gd.config.installs);
      const picked = listFilter.selectedClient.value;
      if (picked && !opts.some((o) => sameGamePath(o.value, picked))) {
        opts.push({ value: picked, label: installFolderName(picked) });
      }
      return opts;
    });

    /** Server tags present in the VISIBLE rail, with their entry counts, in
     *  first-appearance order — under the default newest-first sort the
     *  freshest client leads, and a sort flip just reorders the chips. This
     *  is the count row's answer to "whose replays am I looking at": the
     *  per-card tag says it for one entry, this says it for the whole list. */
    const serverBreakdown = computed(() => {
      const counts = new Map<string, number>();
      for (const r of listFilter.visibleList.value) {
        const tag = serverTagOfMeta(r);
        if (!tag) continue;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
      return [...counts.entries()].map(([tag, count]) => ({ tag, count }));
    });

    /** Reload the rail: EVERY detected client's replays in one list, each
     *  entry stamped with its owning install (see the Rust command's `all`
     *  mode). The app-wide active install no longer decides what the rail
     *  shows — it only decides which client the OTHER data reads (mods,
     *  stats, live) follow — so a client that is not active is still
     *  browsable here, filtered by the rail's client dimension. */
    async function reload() {
      try {
        await parser.refreshAll();
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
        const list = scannedReplays.value;
        const idx = /^\d+$/.test(String(want))
          ? Number(want)
          : list.findIndex((r) => r.path.includes(String(want)));
        const hit = idx >= 0 ? list[idx] : undefined;
        if (hit) {
          void parser.open(hit.path);
        }
      }
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
          void parser.open(first);
        }
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        openingExternal.value = false;
      }
    }

    /** Drop an external entry; the store also clears its pending selection. */
    function onCloseExternal(path: string) {
      parser.removeExternal(path);
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
    const arenaPlayers = ref<ArenaPlayer[]>([]);
    /** The recorder's own vehicle entity id — the results modal's self view
     *  (我的战绩) anchors its identity join on it (see buildSelfStats). */
    const recorderVehicleId = ref<number | null>(null);
    /** Entity ids whose deathTime was inferred from the post-battle payload
     *  (ships that sank while un-spotted) — heuristics crediting kills from
     *  death-time proximity must stand down for them (shipHp.ts). */
    const inferredDeaths = ref<Set<number>>(new Set());
    /** Global-weather timeline (cyclone) — badge + minimap darkening. */
    const weatherTransitions = ref<WeatherTransition[]>([]);
    const weatherNotifications = ref<WeatherNotification[]>([]);
    /** Ally ship builds decoded off the replay's create states (self + team
     *  only — the Rust IPC exit filters enemy and mirror-ambiguous builds). */
    const allyBuilds = ref<PlayerBuild[]>([]);
    const showResults = ref(false);
    const showChat = ref(false);
    /** HolographicMap's exposed playback surface (see HoloMapHandle) — the
     *  chat panel reads its clock for the playhead and calls its pausing
     *  seek when a timeline dot/track is clicked. Null while no map mounts
     *  (decode error) — the panel then renders without the playhead. */
    const mapRef = ref<HoloMapHandle | null>(null);
    /** Match duration (seconds) — the max sample time across all trajectories.
     *  Only knowable after the packet stream is decoded; shown in the detail. */
    const duration = ref(0);
    /** Stats-source mode for the fallback matrix (the pref resolved
     *  against the replayed battle's identity). */
    const fallbackStatsMode = computed<ResolvedStatsMode>(() => {
      const cur = parser.current.value;
      return resolveRosterBattleScope(statsPrefsState.value.overlayBattleScope, {
        matchGroup: cur?.matchGroup ?? null,
        scenario: cur?.scenario ?? null,
        eventType: cur?.eventType ?? null,
      });
    });
    /** Decode-time spawn-symmetry probe for the OPENED replay — the weak,
     *  supplemental 行动 signal from the user's criterion: fleet battles
     *  (co-op / PvP) spawn both sides in roughly mirrored clusters, while a
     *  scripted operation spawns its enemies progressively in waves, so the
     *  enemy spawn cloud is not a mirror of the ally cloud. Only available
     *  after the packet decode (the list scan cannot see packets); null until
     *  then or when the sides cannot be resolved. See spawnSymmetry.ts for
     *  the model, heuristic thresholds and limitations. */
    const spawnSymmetry = computed(() => {
      const cur = parser.current.value;
      if (!cur || trajectories.value.length === 0) return null;
      return analyzeSpawnSymmetry(
        trajectories.value,
        spawnSideResolver(
          cur.vehicles,
          arenaPlayers.value,
          recorderVehicleId.value,
          trajectories.value,
        ),
      );
    });
    /** Decode-time operation refinement: ONLY a plain-co-op descriptor label
     *  plus CLEARLY one-sided enemy spawns may promote the battle to 行动.
     *  Never a non-cooperative descriptor key, never operation -> co-op, and
     *  never on a null/true probe — a weak heuristic must only add the label
     *  the user's operation replay was missing, not overrule the descriptor. */
    const spawnSymmetryOperation = computed(() => {
      const cur = parser.current.value;
      if (!cur) return false;
      const key = modeKey(
        cur.matchGroup,
        cur.scenario,
        cur.eventType,
        cur.botCount ?? 0,
        cur.scriptedUnitCount ?? 0,
        hasSingleTeamRoster(cur.vehicles),
      );
      return key === "cooperative" && spawnSymmetry.value?.symmetric === false;
    });
    /** Operation scenario (行动): single-team battle — drives the single
     *  allies column, the "N players" count and the icon variants. The
     *  descriptor/roster classifier is authoritative; the decode-time probe
     *  only promotes its residual plain-co-op label (see above). */
    const isOperation = computed(() => {
      const cur = parser.current.value;
      if (!cur) return false;
      const descriptorOperation = isOperationBattle(
        cur.matchGroup,
        cur.scenario,
        cur.eventType,
        cur.vehicles.map((v) => v.name),
        hasSingleTeamRoster(cur.vehicles),
      );
      return descriptorOperation || spawnSymmetryOperation.value;
    });
    /** The CN pinyin ship-name row order for THIS replay — realm AND
     *  table shape (issue #1360: the 2026-10-07 pinyin calibration was
     *  taken on the single-team layouts; a two-team CN replay renders
     *  the WG-family nation rank). Drives the fallback matrix's row
     *  order and the holographic map's roster strip. A battle promoted to
     *  operation by the decode-time spawn probe counts as the single-team
     *  layout too — the promotion is exactly what makes it single-team, so
     *  without the OR the CN row order would disagree with the promoted
     *  layout and mix the two calibrations on screen. */
    const shipNameOrder = computed(() => {
      const cur = parser.current.value;
      if (!cur) return false;
      return (
        realmUsesShipNameOrder(realm.value) &&
        (isSingleTeamTabLayout(
          cur.matchGroup,
          cur.scenario,
          cur.eventType,
          cur.vehicles.map((v) => v.name),
          hasSingleTeamRoster(cur.vehicles),
        ) ||
          spawnSymmetryOperation.value)
      );
    });
    const { loading: resultsLoading, error: trajectoryError } = useReplayPositions(parser.current, {
      reset() {
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
        arenaPlayers.value = [];
        weatherTransitions.value = [];
        weatherNotifications.value = [];
        allyBuilds.value = [];
        inferredDeaths.value = new Set();
        showChat.value = false;
        duration.value = 0;
      },
      apply(stream, replay) {
        // Boundary normalization FIRST: a live in-progress recording (the
        // temp container opened while the battle runs) decodes entity
        // timelines that never received a position packet, and any nullish
        // or non-finite sample slipping through would crash the map render
        // with the "reading 'time'" class (#956). One pass here lets every
        // downstream consumer trust dense, finite timelines.
        sanitizeReplayStream(stream);
        // Ships the stream never caught sinking — killed while un-spotted;
        // modern clients emit no EntityDestroy and the HP stream only
        // updates while observed, so they would keep sailing at their
        // last (often full) HP reading. Patch the post-battle payload's
        // authoritative sink list (killerId) into the trajectories once
        // here, so the map, roster strip, tooltip and chat panel all
        // read one uniform deathTime (see shipHp.ts for the caveats).
        inferredDeaths.value = applyDarkDeathInference(
          stream.trajectories,
          parsePostBattle(stream.battleResults ?? null),
          replay.vehicles,
          stream.arenaPlayers,
        );
        // markRaw: the decoded timelines are immutable bulk data (~46k
        //  position samples per 20-min match) — every hot-path reader
        //  (sampleAt, hpAtTime, the painters) was paying a reactive-proxy
        //  toll per property read. Consumers only ever react to the ARRAY
        //  being replaced, which the ref still tracks.
        trajectories.value = markRaw(stream.trajectories);
        recorderVehicleId.value = stream.recorderVehicleId ?? null;
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
        arenaPlayers.value = stream.arenaPlayers ?? [];
        weatherTransitions.value = stream.weatherTransitions ?? [];
        weatherNotifications.value = stream.weatherNotifications ?? [];
        allyBuilds.value = stream.allyBuilds ?? [];
        let maxT = 0;
        for (const tr of stream.trajectories) {
          for (const s of tr.samples) if (s.time > maxT) maxT = s.time;
        }
        duration.value = maxT;
      },
    });

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
      // The lite scanner only carries the own ship's id — resolve the
      // localized name + class off the offline DB (same pattern as the
      // roster panels); cards without a resolvable ship keep the old foot.
      const ownEntry = r.ownShipId != null ? shipOfflineEntry(r.ownShipId) : null;
      const shipName =
        r.ownShipId != null ? shipNameFromOfflineDb(r.ownShipId, dataLanguage.value) : null;
      const ownShipType = ownEntry?.type ?? null;
      // The card's title is the RECORDING PLAYER, not the hull: a client
      // shared by several accounts (the same install played by different
      // nicknames in turn) is told apart by exactly this line, and the
      // player filter above the rail groups by it. The hull rides the foot.
      const serverTag = serverTagOfMeta(r);
      return (
        <li key={external ? `ext_${r.path}` : r.path} class="replay-view__item">
          <button
            type="button"
            class={[
              "replay-card",
              external ? "replay-card--external" : "",
              parser.selectedPath.value === r.path
                ? "replay-card--active"
                : "",
            ]}
            onClick={() => {
              void parser.open(r.path);
            }}
          >
            <div class="replay-card__top">
              {/* The recording player's nickname is a player surface too —
                  right-click opens the shared marker/context menu (the
                  app-global binding resolves the attrs; unknown stays inert). */}
              {(() => {
                const color = r.playerName ? markers.colorOf(r.playerName) : null;
                return (
                  <span
                    class={["replay-card__ship", markerTintClass(color)]}
                    data-player-name={r.playerName ?? undefined}
                    data-player-realm={r.installRealm ?? undefined}
                    title={color ? markerColorLabel(color) : undefined}
                  >
                    {r.playerName ?? t("replay.list.unknownPlayer")}
                  </span>
                );
              })()}
              <span class="replay-card__pills">
                {external ? (
                  <span class="replay-card__pill replay-card__pill--external">
                    {t("replay.external.tag")}
                  </span>
                ) : null}
                {/* The replay's server — which client's folder it came from.
                    The rail mixes every detected client now, so each card
                    says where it belongs; entries under no known install
                    (a picked file, the phone's managed dir) carry none. */}
                {serverTag ? (
                  <span class="replay-card__pill replay-card__pill--server">
                    {serverTag}
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
                        // The lite row carries only the scan's summary
                        // counts: a pve-family operation with players but no
                        // enemy side is a story operation (行动) even when
                        // its descriptor has no scenario/script fingerprint.
                        singleTeamRosterFromCounts(r.playerCount, r.enemyCount),
                      ) as CSSProperties
                    }
                  >
                    {modeLabel(
                      r.matchGroup,
                      r.scenario,
                      r.eventType,
                      r.botCount ?? 0,
                      r.scriptedUnitCount ?? 0,
                      singleTeamRosterFromCounts(r.playerCount, r.enemyCount),
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
              {shipName && ownEntry ? (
                <span
                  class="replay-card__vessel"
                  data-hint-card={ownShipHintCard(ownEntry, shipName, dataLanguage.value)}
                >
                  {ownShipType ? (
                    <BattleIcon type={ownShipType} variant="plain" size={17} />
                  ) : null}
                  <span class="replay-card__vessel-name">{shipName}</span>
                </span>
              ) : null}
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
                {/* The filter trigger leads the action row (the funnel, left
                    of the open-external picker); it renders whenever ANYTHING
                    can be filtered — external picks included — so a
                    persisted selection is always inspectable and clearable;
                    gated on the scanned list alone it would dead-end the
                    no-match state below. */}
                {scannedReplays.value.length + parser.external.value.length > 0 ? (
                  <ReplayListFilter
                    modeOptions={listFilter.modeOptions.value}
                    selectedModes={listFilter.selectedModes.value}
                    sortDir={listFilter.sortDir.value}
                    onUpdate:selectedModes={(s: Set<string>) => (listFilter.selectedModes.value = s)}
                    onUpdate:sortDir={(d: ReplaySortDir) => (listFilter.sortDir.value = d)}
                    dateFrom={listFilter.dateFrom.value}
                    dateTo={listFilter.dateTo.value}
                    onUpdate:dateFrom={(v: string | null) => (listFilter.dateFrom.value = v)}
                    onUpdate:dateTo={(v: string | null) => (listFilter.dateTo.value = v)}
                    selectedClient={listFilter.selectedClient.value}
                    clientOptions={clientOptions.value}
                    onUpdate:selectedClient={(v: string) => (listFilter.selectedClient.value = v)}
                    selectedPlayer={listFilter.selectedPlayer.value}
                    playerOptions={listFilter.playerOptions.value}
                    onUpdate:selectedPlayer={(v: string) => (listFilter.selectedPlayer.value = v)}
                  />
                ) : null}
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

            {/* The rail scans EVERY detected client (no active-install
                scoping — the sidebar footer's picker decides what the other
                data reads follow, not what is listed here). No detected
                install means nothing to scan on desktop; the phone build
                reads its managed import dir instead. */}
            {!hasClient.value && !isMobileApp() ? (
              <p class="replay-view__no-client">{t("replay.list.noClient")}</p>
            ) : null}

            {/* The count stays scoped to the scanned list (externals are
                session-temporary picks), even though the filter above also
                applies to them. */}
            {scannedReplays.value.length > 0 ? (
              <span class="replay-view__count">
                {listFilter.filterActive.value
                  ? t("replay.list.countFiltered", {
                      n: listFilter.visibleList.value.length,
                      total: scannedReplays.value.length,
                    })
                  : t("replay.list.count", { n: scannedReplays.value.length })}
                {/* Which servers the visible replays come from, with counts
                    — the at-a-glance "is every client's history in here"
                    answer the per-card tags give one entry at a time. */}
                {serverBreakdown.value.length > 0 ? (
                  <span class="replay-view__count-servers">
                    {serverBreakdown.value.map((s) => (
                      <span key={s.tag} class="replay-view__count-server">
                        <span class="replay-view__count-server-tag">{s.tag}</span>
                        {s.count}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>

          {/* Rail scroller: the hikari container owns the scrollbar
              (auto-hiding overlay track over the rail's right edge); the
              cards and empty states scroll inside its viewport. */}
          <HkScrollContainer class="replay-view__list-scroll">
            <div class="replay-view__list-scroll__inner">
              {parser.external.value.length === 0 && scannedReplays.value.length === 0 ? (
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
              ) : listFilter.visibleExternal.value.length === 0 &&
                  listFilter.visibleList.value.length === 0 ? (
                /* Everything is filtered out — the strip above stays reachable
                   so the state is self-explanatory (and clearable). */
                <p class="replay-view__empty">{t("replay.filter.noMatch")}</p>
              ) : (
                <ul class="replay-view__items">
                  {/* Manually picked files (session-temporary) stay pinned
                      above the scanned list; the filter and the sort apply to
                      both blocks independently. */}
                  {listFilter.visibleExternal.value.map((r) => renderReplayCard(r, true))}
                  {listFilter.visibleList.value.map((r) => renderReplayCard(r, false))}
                </ul>
              )}
            </div>
          </HkScrollContainer>
        </aside>

        <section class="replay-view__main">
          {/* Phone-only page scroller (≤767px the stacked detail scrolls
              here): the hikari container owns the scrollbar, and the inner
              wrapper keeps the former direct-child flex chain (__content
              flex:1 etc.) intact — on desktop nothing overflows, so the
              roster/map keep managing their own scroll exactly as before. */}
          <HkScrollContainer class="replay-view__main-scroll">
            <div class="replay-view__main-inner">
              {parser.current.value ? (
                <div class="replay-view__content">
                  {parser.error.value ? (
                    <ErrorCard error={parser.error.value} />
                  ) : null}
                  <header class="replay-view__meta">
                    {/* The map as a jump tag (shared with the live head): hover
                        previews the map's bundled minimap, click opens the map's
                        tactical board — see MapNameTag. */}
                    <MapNameTag class="replay-view__map" spaceId={parser.current.value.mapName} lang={mapLang.value} />
                    <span class="replay-view__meta-item">
                      {formatDateTime(parser.current.value.dateTime)}
                    </span>
                    {parser.current.value.matchGroup ? (
                      <span
                        class="replay-view__meta-item replay-view__pill"
                        style={
                          (spawnSymmetryOperation.value
                            ? // Decode-time refinement: the spawn probe
                              // promoted a plain-co-op descriptor label to
                              // 行动 (see spawnSymmetryOperation above).
                              modeColorOfKey("operation")
                            : modeColor(
                                parser.current.value.matchGroup,
                                parser.current.value.scenario,
                                parser.current.value.eventType,
                                parser.current.value.botCount ?? 0,
                                parser.current.value.scriptedUnitCount ?? 0,
                                hasSingleTeamRoster(parser.current.value.vehicles),
                              )) as CSSProperties
                        }
                      >
                        {spawnSymmetryOperation.value
                          ? modeLabelOfKey("operation")
                          : modeLabel(
                              parser.current.value.matchGroup,
                              parser.current.value.scenario,
                              parser.current.value.eventType,
                              parser.current.value.botCount ?? 0,
                              parser.current.value.scriptedUnitCount ?? 0,
                              hasSingleTeamRoster(parser.current.value.vehicles),
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
                          <HkIconButton
                            class="hk-window-close replay-view__modal-close"
                            size={32}
                            variant="ghost"
                            icon="close"
                            aria-label={t("common.close")}
                            onClick={() => (showResults.value = false)}
                          />
                        </div>
                        {/* Results-body scroller: the hikari container owns the
                            scrollbar (auto-hiding overlay track); the panel
                            scrolls inside its viewport. Nothing pins in here,
                            and no pin anywhere consumes a whitespace contract
                            (the chat body's timeline pin rides strategy="none"). */}
                        <HkScrollContainer class="replay-view__modal-body">
                          <div class="replay-view__modal-body__inner">
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
                                stream={{
                                  trajectories: trajectories.value,
                                  recorderVehicleId: recorderVehicleId.value,
                                  shotKills: shotKills.value,
                                  damageStats: damageStats.value,
                                  achievements: achievements.value,
                                  arenaPlayers: arenaPlayers.value,
                                  shellLaunches: shellLaunches.value,
                                  torpedoes: torpedoes.value,
                                }}
                                roster={parser.current.value.vehicles}
                                builds={allyBuilds.value}
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
                                shipNameOrder={shipNameOrder.value}
                                arenaPlayers={arenaPlayers.value}
                                inferredDeaths={inferredDeaths.value}
                                statsMode={fallbackStatsMode.value}
                                onClose={() => (showResults.value = false)}
                              />
                            )}
                          </div>
                        </HkScrollContainer>
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
                          <HkIconButton
                            class="hk-window-close replay-view__modal-close"
                            size={32}
                            variant="ghost"
                            icon="close"
                            aria-label={t("common.close")}
                            onClick={() => (showChat.value = false)}
                          />
                        </div>
                        <div class="replay-view__modal-body hk-scroll-pin-host" data-scroll-axis="vertical">
                          <ChatLogPanel
                            events={chatMessages.value}
                            vehicles={parser.current.value.vehicles}
                            trajectories={trajectories.value}
                            arenaPlayers={arenaPlayers.value}
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
                        // Hardcoded English on purpose — the trajectory
                        // decoder is a power-user diagnostic path without a
                        // translation budget (kept verbatim from the old
                        // placeholder).
                        <div class="replay-view__placeholder">
                          <ErrorCard title="Trajectory decode failed" error={trajectoryError.value} />
                        </div>
                      ) : updater.portable ? (
                        // The portable edition ships no 3D — the
                        // holographic map gives way to the install hint.
                        <div class="replay-view__placeholder">{t("common.portable3dBlocked")}</div>
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
                          arenaPlayers={arenaPlayers.value}
                          inferredDeaths={inferredDeaths.value}
                          weatherTransitions={weatherTransitions.value}
                          weatherNotifications={weatherNotifications.value}
                          vehicles={parser.current.value.vehicles}
                          operation={isOperation.value}
                          encyclopedia={encyclopedia.byId}
                          mapId={parser.current.value.mapName ?? ""}
                          matchGroup={parser.current.value.matchGroup ?? ""}
                          mapName={parser.current.value.mapName ?? ""}
                          initialTime={initialSeek}
                          initialMinimapZoom={route.query.mm === "1"}
                          realm={realm.value}
                          shipNameOrder={shipNameOrder.value}
                          statsMode={fallbackStatsMode.value}
                        />
                      )}
                    </div>
                  </div>
                </div>
              ) : parser.error.value ? (
                <div class="replay-view__placeholder">
                  <ErrorCard error={parser.error.value} />
                </div>
              ) : (
                <div class="replay-view__placeholder">{t("replay.select")}</div>
              )}
            </div>
          </HkScrollContainer>
        </section>

        {/* Hidden HTML file picker backing the mobile import action (the
            styled button clicks it). Multi-select .wowsreplay only. Rendered
            only on the phone build — desktop uses the native picker. */}
        {isMobileApp() ? (
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".wowsreplay,.korablireplay"
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
