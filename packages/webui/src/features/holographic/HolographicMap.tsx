import { computed, defineComponent, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import * as THREE from "three";
import {
  Brain, Clapperboard, Eye, EyeOff, Grid3x3, Pause, PenLine, Play, RotateCcw, RotateCw, Spline, Users,
} from "@lucide/vue";
import { extractActions } from "./tactical/actions";
import { useBreakpoint, useToast } from "@celestia-island/hikari";

import { useThreeScene } from "./useThreeScene";
import { watchStageThemeMode } from "@wowsp/holo";
import { useCapabilitiesStore } from "@/stores/capabilities";
import {
  shipModelStem,
  shipNameFromOfflineDb,
  shipSilhouetteBox,
  shipSilhouetteUrl,
  shipOfflineEntry,
  loadSilhouettes,
  wireModelPackFromShell,
  type MapBounds,
} from "./modelLoader";
import { clearShipMarkerCache } from "./shipMarker";
import { clearPropMarkerCache } from "./propMarker";
import {
  clearReplayResourceContext,
  setReplayResourceContext,
} from "./resourceHealth";
import { hpAtTime, sampleAt, samplesUpTo, UNSEEN_GAP_S } from "./trajectoryMath";
import { shouldReserveTabKey } from "./tabKeyGate";
import {
  KBD_HOLD_DELAY_MS,
  KBD_REPEAT_MS,
  clampSeekSeconds,
  isModalAboveSurface,
  kbdBaseStepSeconds,
  kbdSeekDirection,
  kbdStepSeconds,
  shouldHandleTransportKey,
} from "./kbdTransport";
import { arenaIdentities, resolveRosterAssignments } from "./rosterRoles";
import { encyclopediaHullHealth, resolveMaxHp } from "./shipHp";
import HoloShipTooltip from "./HoloShipTooltip";
import {
  clearActors,
  computeFullMapBounds,
  computeViewBounds,
  createMapInternals,
  fitCamera,
  loadMinimapBase,
  resolveRoleQuick,
  sceneMapRect,
} from "./mapInternals";
import { rebuildActors } from "./actorBuild";
import { updateMarkersAt } from "./markerUpdate";
import { updateLabelPositions, updateOverlayScale } from "./labelOverlay";
import {
  AI_FOCUS_PLANE_DIST,
  AI_FOCUS_SHIP_DIST,
  applyFollowPose,
  PLANE_CHASE_RISE_RATIO,
  followFramingCleared,
  followFramingFor,
  followFramingZoomed,
  FOLLOW_DIST_MAX,
  FOLLOW_DIST_MIN,
  initialFollowFraming,
  smoothChasePose,
  type ChaseSmoothState,
} from "./followCamera";
import {
  activeSquadronOf,
  anchorFollowPose,
  carrierHasAnySortie,
  formationFollowPose,
  latestSortiePlaneId,
} from "./followTargets";
import {
  cameraModeAt,
  isPlaneCameraMode,
  nearestPlaneCameraWindow,
  planeCameraJumpTarget,
  type RecordedCameraMode,
} from "./cameraModes";
import {
  PLANE_CARD_LABEL_ID_BASE,
  planeReturningAt,
} from "./planeWarfare";
import { planeTrailExpiry } from "./planeFormation";
import {
  chaseStrength,
  chaseCardVisible,
  consumableLabelKey,
  consumableWindowFrac,
  lastSquadronEventAt,
  planeCardExtras,
  squadronAttacking,
  squadronFlyingAt,
  squadronHpAt,
  squadronSamplesAt,
  squadronSlotGroups,
  squadronStrength,
  unpackSquadronBands,
  unknownConsumableId,
} from "./planeFollow";
import { loadSquadronStates } from "./squadronStatesLoader";
import type { SquadronStateEvents } from "@/api";
import { clearMapModel, ensureWaterFloor, reapplyWaterTheme, tryLoadMapModel } from "./mapTerrain";
import { drawMinimap, paintEnlargedMap } from "./minimapPainter";
import { bundledRibbonUrl } from "./ribbonIcons";
import {
  EXPORT_LABEL_LAYER,
  ShipLabelSpriteLayer,
  exportShipCardVisible,
  type ShipLabelSpriteInput,
} from "./exportShipLabels";
import HoloExportModal from "./HoloExportModal";
import {
  EXPORT_GOD_FOV_DEG,
  EXPORT_LOGICAL,
  EXPORT_TEAM_STAT_COLS,
  buildRecorderSourceHits,
  clampExportSettings,
  exportGodCamera,
  type ExportGodCameraPose,
  foldPlaybackRecorderStats,
  foldRecorderSources,
  frameTimesAtSpeed,
  normalizeExportRange,
  renderPlaybackExport,
  type PlaybackExportPhase,
  type PlaybackExportSettings,
  type PlaybackIconVariant,
  type PlaybackRecorderRibbon,
  type PlaybackRecorderTimeline,
  type PlaybackTeamRow,
  type PlaybackTeamSide,
  type PlaybackTeamStat,
  type PlaybackTeamStatColumn,
} from "./playbackExport";
import { formatBattleClock, saveExportBlob, saveExportBlobTo } from "./tactical/exporters";
import {
  LOGO_URL,
  darkPalette,
  loadImage,
  shareFooterStrings,
} from "@/features/share/shotKit";
import { branchOfReplay, type ShipDataBranch } from "@/utils/realms";
import {
  alignPoseHeading,
  applyRecordedCamera,
  cameraPoseAt,
  PLANE_VIEW_PITCH,
  withLookOffset,
} from "./recordedCamera";
import { activeWards, planeSmoothPosAt, torpedoPosAt } from "./minimapFx";
import {
  pickMinimapTarget,
  type MinimapHoverTarget,
  type MinimapPickCap,
  type MinimapPickInput,
  type MinimapPickPlane,
  type MinimapPickShip,
  type MinimapPickSmoke,
  type MinimapPickTorpedo,
  type MinimapPickView,
  type MinimapPickWard,
} from "./minimapPick";
import MinimapHoverTip from "./MinimapHoverTip";
import type { TeamRole } from "./teamColors";
import { disposeStormZone } from "./weatherScene";
import { applyOsdTones, createOsdContrast, OSD_REFRESH_S } from "./osdContrast";
import { buildSelfShotLedger, querySelfShotLedger } from "./selfShotLedger";
import { capLetter, isCaptureZone, type CapZoneState } from "./capZones";
import type { ShipLabel } from "./shipLabel";
import {
  REPAIR_PARTY_DAMAGE_SHARE,
  repairCoefficientFor,
  repairRecoverableFracAt,
} from "./repairPool";
import HoloEventFeed, { type FeedEntry } from "./HoloEventFeed";
import HoloCameraMenu from "./HoloCameraMenu";
import HoloRosterOverlay from "./HoloRosterOverlay";
import HoloHeatStrip from "./HoloHeatStrip";
import HoloSelfCard from "./HoloSelfCard";
import HoloPlaneFollowCard, { type HoloPlaneFollowState } from "./HoloPlaneFollowCard";
import HoloSquadronPanel, { type HoloSquadronPanelState } from "./HoloSquadronPanel";
import HoloShipStatus from "./HoloShipStatus";
import HoloWeatherBadge from "./HoloWeatherBadge";
import HoloRangeMenu from "./HoloRangeMenu";
import { syncMoveAdvisories } from "./moveAdvisories";
import { weatherStateAt, type WeatherView } from "./weather";
import {
  armRangeRingPrefsPersist,
  buildRangeRings,
  rangeRingPrefs,
  resolveSelfRings,
  updateRangeRings,
  type RangeRingDef,
} from "./rangeRings";
import type {
  AchievementEvent,
  ArenaPlayer,
  CameraSample,
  ChatEvent,
  ConsumableUseEvent,
  DamageStatSample,
  DecisionDebugReport,
  DecisionSuggestionReport,
  EntityTrajectory,
  ExplosionEvent,
  HpSample,
  MinimapSquadronAdd,
  MinimapSquadronMove,
  MinimapSquadronRemove,
  NetStatsSample,
  ShotKillEvent,
  WardEvent,
  WardRemoveEvent,
  WeatherNotification,
  WeatherTransition,
  ShellLaunchEvent,
  ShipInfo,
  PlayerComposition,
  SquadronCreate,
  SquadronPlane,
  TorpedoLaunch,
  TorpedoSteer,
  VehicleEntry,
  WeaponLockEvent,
} from "@/api";
// Alias: `setup` below destructures its OWN `api` (the Three.js scene
// handle) from useThreeScene, so the RPC client must arrive under a
// different local name.
import { api as rpcApi, foldDamageStats } from "@/api";
import { STATIC_REPORT_READ_TIMEOUT_MS as DEBUG_READ_TIMEOUT_MS } from "@/api/modules/decision";
import { parsePostBattle } from "@/features/replay/postBattle";
import LoadingNote from "@/components/base/LoadingNote";
import { AI_NAME, fetchRosterStatsByNames, type RosterStat } from "@/composables/useRosterStats";
import { tierRoman } from "@/features/replay/shipLiveStats";
import ToastCardBase, { type ToastCardBaseInstance } from "@/components/layout/ToastCardBase";
import {
  EMPTY_ROSTER_VIEW,
  overlayColumnDims,
  type ResolvedStatsMode,
} from "@/utils/statView";
import { scopedRosterView } from "@/utils/shipStatsScope";
import { aggregateTeamStats } from "@/utils/teamAggregate";
import {
  rosterColumns,
  rosterShotCells,
  rosterShotDashes,
  type RosterColumnSpec,
  teamHeadLabelOf,
} from "@/features/replay/postBattleShare";
import {
  prAlgoForRequest,
  statsPrefsState,
  useStatsPrefsStore,
  type OverlayColumnScope,
} from "@/stores/statsPrefs";
import { careerStamp, stampWording, type StampKind } from "@/utils/winrate";
import { shipTierOf } from "@/utils/shipClass";
import { useLanguage } from "@/i18n/useLanguage";
import { splitRosterSides } from "@/utils/rosterSides";
import { isScriptedUnitName } from "@/utils/aiNames";
import { hasSingleTeamRoster, modeKey } from "@/utils/modeColors";
import { modeLabelOfKey } from "@/features/replay/ReplayListFilter";
import { displayMapName } from "@/utils/mapNames";
import { useReplayStore } from "@/stores/replay";
import planeIcon from "./planeIcons";
import { shipIconUrl, shipTypeClass } from "./shipIcons";
import {
  HoloScorebar, HoloLabel, registerHoloShipIcons,
  type HoloCapZone, type HoloHudState, type HoloShip, type HoloShipCardData,
} from "@wowsp/holo";

// The shared scorebar renders the game's own HUD icons — register the
// bundled URLs once (the same SVG class art every other face draws; every
// class, auxiliary included, carries the full face set).
for (const variant of ["ally", "enemy", "sunk", "sunk-enemy"] as const) {
  registerHoloShipIcons(variant, {
    battleship: shipIconUrl("battleship", variant) ?? undefined,
    cruiser: shipIconUrl("cruiser", variant) ?? undefined,
    destroyer: shipIconUrl("destroyer", variant) ?? undefined,
    aircarrier: shipIconUrl("aircarrier", variant) ?? undefined,
    submarine: shipIconUrl("submarine", variant) ?? undefined,
    auxiliary: shipIconUrl("auxiliary", variant) ?? undefined,
  });
}
/** paramsId → plane/shell metadata comes from the shared tactical
 *  encyclopedia (tactical/shellTypes.ts) — the timeline's action markers
 *  read the same tables. */

import { useStatsStore } from "@/stores/stats";
import { useMarkersStore } from "@/stores/markers";
import { HkIconButton, HkTooltip } from "@celestia-island/hikari";
import HoloSpeedMenu from "./HoloSpeedMenu";
import TacticalBoard from "./tactical/TacticalBoard";
import {
  TACTICAL_MAX_SCALE,
  TACTICAL_SIZE,
  type TacticalView,
} from "./tactical/render";
import { t as i18nT } from "@/i18n";
import "./HolographicMap.scss";

/**
 * The holographic battle map. Renders every entity's decoded trajectory (M3)
 * as a colored line, plus a ship marker at the current playback time that
 * points along its heading. A time slider scrubs the whole match.
 *
 * Map terrain: if a converted GLB for this map's space id exists under
 * `src/res/models/maps/<spaceId>.glb`, it is loaded and added to the scene.
 * Otherwise the scene falls back to the GridHelper sea plane (defined in
 * useThreeScene). Model loading is progressive — the app works without any
 * converted assets and enriches as the user runs the conversion scripts.
 *
 * Coordinates: WoWS world space is x=east, z=north (planar). We map (x,z)
 * straight onto the three.js XZ plane and drop y. Bounds auto-fit to the data.
 */
/** Playback surface exposed to parents via the template ref. The clock refs
 *  arrive unwrapped (numbers) through the expose proxy but stay reactive, so
 *  a reader re-evaluates as playback advances; `seek` pauses and jumps.
 *  Lets overlays like the chat-log panel draw a live playhead and jump to a
 *  message without HolographicMap lifting its clock out. `focusEntity` is
 *  the programmatic chase-camera target the AI report's keyframe jump uses:
 *  it selects the analyzed ship exactly like clicking its marker would. */
export interface HoloFocusOptions {
  /** Playhead the aircraft/carrier decision is made for. Callers that seek
   *  first pass the target time so the jump does not depend on watcher
   *  ordering; omitted = the live clock. */
  time?: number;
  /** When the target is an aircraft carrier with a squadron in the air at
   *  `time`, chase that squadron instead of the hull. */
  preferAircraft?: boolean;
  /** Initial chase distance override (clamped). Omitted = the AI-report
   *  framing default for the resolved target kind. */
  distance?: number;
}

export interface HoloMapHandle {
  current: number;
  duration: number;
  playing: boolean;
  seek: (t: number) => void;
  /** Chase the given ship with the 3D camera (`null` = free orbit). */
  focusEntity: (entityId: number | null, options?: HoloFocusOptions) => void;
}

/** Upper bound on how long an export waits for the replay's one-shot
 *  roster-stats batch before its first frame. The batch resolves only when
 *  the WHOLE roster (and any per-ship lists the configured columns need)
 *  has answered, which a cold replay view can take well past the old 5 s
 *  poll; a provider that never answers must still not strand the take, so
 *  the await is raced against this and the clip keeps its honest dashes. */
const EXPORT_STATS_WAIT_MS = 20_000;

/** Hard cap on the export's medal-feed warm-up (the composition lookup).
 *  The batch has no cancellation channel of its own, so a hostile/slow
 *  provider may only ever cost this long before the feed proceeds — the
 *  clip then paints the seals it has (or none) instead of stranding the
 *  take on a lookup. */
const EXPORT_FEED_WAIT_MS = 15_000;

/** Bounded drain of the 3D take's ship hulls (the models phase). The scene
 *  installs a cone first and swaps the GLB in when it lands; a clip
 *  rendered before that bakes placeholders into every frame, so the export
 *  waits — but never forever: a hull whose GLB is missing renders as the
 *  scene's own stand-in, exactly as the live view does. */
const EXPORT_MODEL_WAIT_MS = 60_000;
/** ...and a model that stops ARRIVING ends the wait early: a failed/hung
 *  load (no model pack installed, a dead mount) must not hold the take for
 *  the full cap when nothing is coming. */
const EXPORT_MODEL_STALL_MS = 8_000;
/** How often the models phase re-reads the scene's counts. */
const EXPORT_MODEL_POLL_MS = 150;

/** The export card's phase: the renderer's own coarse phases plus the
 *  caller's final file-write stage. `feed` and `models` run BEFORE the
 *  encode loop and report no percentage — the card shows their label over
 *  an indeterminate bar instead of freezing at 0% · 0/N while the feed is
 *  assembled and the 3D hulls load. */
export type ExportCardPhase = PlaybackExportPhase | "save";

/** One reading of the 3D scene's hull state. `loaded` = markers wearing
 *  their real GLB (or a pooled stand-in); `total` = every ship marker the
 *  scene built; `pending` = the subset still in flight (not loaded AND not
 *  already parked in the map's modelWaiters — a waiter can only resolve
 *  when some OTHER hull's load finishes, so it is not work the export can
 *  wait on). */
export interface ShipModelProgress {
  loaded: number;
  total: number;
  pending: number;
}

/** The card's live readout for one phase: the meta line and the bar fill
 *  (null = indeterminate). Only the frame loop has a percentage; the
 *  pre-render stages and the encoder flush / file write are label-only.
 *  Kept module-level and pure (bar the i18n lookup) so the phase ladder
 *  feed → models (3D hulls) → render → finalize → save is unit-tested. */
export function exportCardReadout(
  phase: ExportCardPhase,
  counts: { done: number; total: number },
  models: { loaded: number; total: number } | null = null,
): { meta: string; progress: number | null } {
  if (phase === "feed") {
    return { meta: i18nT("replay.export.phaseFeed"), progress: null };
  }
  if (phase === "models") {
    return {
      meta:
        models && models.total > 0
          ? i18nT("replay.export.phaseModelsCount", {
              done: models.loaded,
              total: models.total,
            })
          : i18nT("replay.export.phaseModels"),
      progress: null,
    };
  }
  if (phase === "finalize") {
    return { meta: i18nT("replay.export.phaseFinalize"), progress: null };
  }
  if (phase === "save") {
    return { meta: i18nT("replay.export.phaseSave"), progress: null };
  }
  const { done, total } = counts;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return { meta: `${pct}% · ${done}/${total}`, progress: pct };
}

/** Which phase follows the feed assembly. Only the 3D take needs the hull
 *  wait (its map layer is the live scene); the 2D take's layer is the same
 *  painter every frame, and a fully-loaded scene skips the wait too. */
export function exportPhaseAfterFeed(
  view: "2d" | "3d",
  models: ShipModelProgress | null,
): "models" | "render" {
  if (view !== "3d" || !models) return "render";
  // `pending` (in-flight loads), NOT `total - loaded`: a hull whose GLB is
  // missing never resolves, and waiting on it would stall the take for the
  // whole cap on every export.
  return models.pending > 0 ? "models" : "render";
}

/** Await one pre-render step while honouring the export's cancel token and
 *  a hard cap. The roster batch / composition lookup have no cancel
 *  channel of their own, so a cancel stops WAITING on them instead of
 *  abandoning them (the token is polled); a step that never settles costs
 *  at most `capMs`. A rejected step resolves "done" — a failed warm-up
 *  keeps the clip's honest dashes, exactly as before. */
export function awaitExportStep(
  work: Promise<unknown>,
  token: { cancelled: boolean },
  capMs: number,
  pollMs = 100,
): Promise<"done" | "cancelled" | "timeout"> {
  return new Promise((resolve) => {
    let settled = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    let cap: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: "done" | "cancelled" | "timeout"): void => {
      if (settled) return;
      settled = true;
      if (poll !== undefined) clearInterval(poll);
      if (cap !== undefined) clearTimeout(cap);
      resolve(result);
    };
    poll = setInterval(() => {
      if (token.cancelled) finish("cancelled");
    }, pollMs);
    cap = setTimeout(() => finish("timeout"), capMs);
    void work.then(
      () => finish("done"),
      () => finish("done"),
    );
  });
}

/** Format the replay header's `YYYYMMDD[_HHMMSS]` date-time as the clip
 *  header's "YYYY-MM-DD HH:MM" start stamp. Returns null when the field is
 *  absent or unparseable (the clip then omits the line instead of printing
 *  a raw filename fragment). Same rendering as the replay list card's
 *  timestamp (ReplayView.formatDateTime, which is page-scoped). */
function replayStampLabel(dt: string | null): string | null {
  if (!dt) return null;
  const m = dt.match(/^(\d{4})(\d{2})(\d{2})(?:_(\d{2})(\d{2})\d{2})?$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}${m[4] ? ` ${m[4]}:${m[5]}` : ""}`;
}

export default defineComponent({
  name: "HolographicMap",
  props: {
    replayPath: { type: String, default: "" },
    trajectories: { type: Array as () => EntityTrajectory[], default: () => [] },
    /** Artillery launches (receiveArtilleryShots on the avatar) — the primary
     *  shell data: muzzle point, aim point and flight time per projectile. */
    shellLaunches: { type: Array as () => ShellLaunchEvent[], default: () => [] },
    /** World-space shell impacts (receiveExplosions on the avatar). */
    explosions: { type: Array as () => ExplosionEvent[], default: () => [] },
    /** Torpedo launches (receiveTorpedoes on the avatar). */
    torpedoes: { type: Array as () => TorpedoLaunch[], default: () => [] },
    /** Homing-torpedo guidance updates (receiveTorpedoDirection). */
    torpedoSteers: { type: Array as () => TorpedoSteer[], default: () => [] },
    /** Recorder weapon-lock timeline (SetWeaponLock 0x30). */
    weaponLocks: { type: Array as () => WeaponLockEvent[], default: () => [] },
    /** Raw post-battle statistics JSON (BattleResults 0x22). */
    battleResults: { type: String, default: "" },
    /** Replay protocol version (Version 0x16). */
    replayVersion: { type: String, default: "" },
    /** Map name from the Map packet (0x28). */
    mapNamePkt: { type: String, default: "" },
    /** Recorder camera timeline (Camera 0x25) — enables the original-view mode. */
    cameraFrames: { type: Array as () => CameraSample[], default: () => [] },
    /** Player net stats (PlayerNetStats 0x1d). */
    netStats: { type: Array as () => NetStatsSample[], default: () => [] },
    /** Entity id → last leave time (EntityLeave 0x04). */
    leavesMap: { type: Object as () => Record<string, number>, default: () => ({}) },
    /** Camera-mode changes (0x27). */
    cameraModes: { type: Array as () => HpSample[], default: () => [] },
    /** Aircraft squadrons (avatar receive_addSquadron / updateSquadron). */
    squadronCreates: { type: Array as () => SquadronCreate[], default: () => [] },
    squadronPlanes: { type: Array as () => SquadronPlane[], default: () => [] },
    /** Minimap squadron markers (receive_add/update/removeMinimapSquadron) —
     *  the 2D trail stream the in-game minimap itself renders. */
    minimapSquadronAdds: { type: Array as () => MinimapSquadronAdd[], default: () => [] },
    minimapSquadronMoves: { type: Array as () => MinimapSquadronMove[], default: () => [] },
    minimapSquadronRemoves: { type: Array as () => MinimapSquadronRemove[], default: () => [] },
    /** Fighter-patrol wards (receive_wardAdded) — static patrol circles. */
    wards: { type: Array as () => WardEvent[], default: () => [] },
    wardRemoves: { type: Array as () => WardRemoveEvent[], default: () => [] },
    /** Projectile kills (receiveShotKills) — snap arcs onto victims, stop
     *  in-flight torpedoes at the hit. */
    shotKills: { type: Array as () => ShotKillEvent[], default: () => [] },
    /** Server-authoritative cumulative damage stats (receiveDamageStat):
     *  exact per-weapon damage incl. aircraft weapons, tracked live against
     *  the playhead. Absent on versions without a pinned method id. */
    damageStats: { type: Array as () => DamageStatSample[], default: () => [] },
    /** Battle chat timeline (avatar onChatMessage) — fired into the event
     *  feed as the playhead crosses each message's time. */
    chatMessages: { type: Array as () => ChatEvent[], default: () => [] },
    /** In-battle achievement awards (avatar onAchievementEarned) — same
     *  playhead-crossing feed treatment as chat. */
    achievements: { type: Array as () => AchievementEvent[], default: () => [] },
    /** Vehicle consumable activations (onConsumableUsed, experiment E11) —
     *  the Repair Party (raw id 8) windows behind the floating labels' and
     *  the exported clip's grey recoverable HP segment (repairPool.ts).
     *  Absent on replays whose exposed method id is not pinned: the feature
     *  stays off and the bars render exactly as before. */
    consumableUses: { type: Array as () => ConsumableUseEvent[], default: () => [] },
    /** Global-weather timeline (BattleLogic state.weather.globalWeather) —
     *  cyclone/storm approach warnings + interpolation windows. */
    weatherTransitions: { type: Array as () => WeatherTransition[], default: () => [] },
    /** Announced upcoming weather changes (the in-game warning banners). */
    weatherNotifications: { type: Array as () => WeatherNotification[], default: () => [] },
    /** The arena's initial player state (onArenaStateReceived) — the
     *  authoritative ship-entity → team/player join for markers, minimap
     *  and the scorebar. */
    arenaPlayers: { type: Array as () => ArenaPlayer[], default: () => [] },
    /** Entity ids whose deathTime was inferred from the post-battle payload
     *  (ships that sank while un-spotted) — the self-stats frag heuristic
     *  must not credit those sinks from death-time proximity alone. */
    inferredDeaths: { type: Object as () => Set<number>, default: () => new Set() },
    /** Roster from the replay header — used to map trajectories to teams and
     *  resolve each ship's model. */
    vehicles: { type: Array as () => VehicleEntry[], default: () => [] },
    /** Operation scenario (行动): LIST surfaces only — the scorebar icon
     *  strip and the Tab roster render a single (allies) team and the
     *  player count stays raw. Map colors ignore it: the roster's relation
     *  values carry real side semantics, so hostile warships tint red like
     *  anywhere else (see utils/modeColors' isOperationBattle). */
    operation: { type: Boolean, default: false },
    /** Ship encyclopedia (shipId → ShipInfo). Used to resolve tier/nation/type
     *  for per-ship model loading + tier-based fallback when a model is missing. */
    encyclopedia: { type: Object as () => Map<number, ShipInfo>, default: () => new Map() },
    /** Map space id (e.g. "15_NE_north") — used to load the terrain GLB. */
    mapId: { type: String, default: "" },
    /** Match group from the replay descriptor (pvp/ranked/clan/brawl/...). */
    matchGroup: { type: String, default: "" },
    /** Map space id, for applying per-map domination scoring overrides. */
    mapName: { type: String, default: "" },
    /** Initial playback position (match seconds). Deep-link/dev aid; clamped
     *  to the decoded duration once trajectories arrive. */
    initialTime: { type: Number, default: 0 },
    /** Open with the enlarged 2D minimap shown (deep-link/dev aid). */
    initialMinimapZoom: { type: Boolean, default: false },
    /** Query realm for the strip-tooltip career stats (shared with the
     *  parent view — the replay belongs to the install, not the account). */
    realm: { type: String, default: "asia" },
    /** The CN pinyin ship-name row order for the roster strip, resolved
     *  by the parent from the replay's realm AND table shape (issue
     *  #1360: the pinyin permutation rides the single-team layouts only —
     *  a two-team CN battle renders the WG-family nation rank). */
    shipNameOrder: { type: Boolean, default: false },
    /** Resolved stats-source battle scope for the tooltip's stat numbers
     *  (the same mode the post-battle panels show). */
    statsMode: { type: String as () => ResolvedStatsMode, default: "random" },
    /** The recorded replay's client branch ("wg" | "lesta"): the two clients
     *  share ship ids while their consumable radii have diverged, so the
     *  stock range rings must quote the replay's own realm. The host passes
     *  the rail entry's install identity; empty falls back to the replay
     *  container extension (`.korablireplay` = Lesta) and then WG. */
    branch: { type: String, default: "" },
  },
  setup(props, { expose }) {
    // Wire the model pack HERE too, not only from AppShell: a child view
    // mounts before its parent's onMounted hook runs, so a replay opened by
    // deep link would otherwise race the shell's startup pass. Idempotent
    // (initModelPack's guard) and a no-op outside the Tauri shell — the
    // loader/diagnostic must see the cache root before the first GLB fetch.
    void wireModelPackFromShell();
    const container = ref<HTMLElement | null>(null);
    // The 2D minimap repaints at ~16 Hz — the game's own minimap cadence —
    // instead of once per render frame. The enlarged overlay repaints all
    // ship trails sample-by-sample, which dominated the frame budget when
    // it ran at 60 Hz; 16 Hz reads identically and costs a fraction.
    const MM_REDRAW_S = 0.06;
    let mmAccum = 0;
    let osdAccum = 0;
    /** Text sprites hidden around the OSD readback render (see below). */
    let osdHiddenSprites: THREE.Sprite[] = [];
    const { ready, api } = useThreeScene(container, (dt) => {
      // The playback clock rides the render tick (ONE loop, capped with
      // it): the old standalone rAF advanced the playhead at raw refresh
      // rate — 165 Vue playhead writes per second on high-refresh panels.
      advancePlayback(dt);
      const mmTweenActive = advanceMmViewTween();
      updateLabelPositions(ctx);
      mmAccum += dt;
      if (mmAccum >= MM_REDRAW_S) {
        mmAccum = 0;
        drawMinimap(ctx, {
      // The 主控 gold edge belongs to the followed carrier's active
      // squadron (followAircraft is the intent; the carrier is the selection).
      followedCarrierId: followAircraft.value ? selectedEntityId.value ?? null : null,
    });
        // ~5 Hz live hover refresh: while a 2D tooltip is open and the
        // replay plays, a moving torpedo / aircraft / smoke cluster keeps
        // its card numbers current under a stationary cursor.
        refreshMinimapHoverTip();
      }
      // Range-ring radius ease steps on the RAF clock (not the playhead)
      // so spotter/smoke transitions keep breathing while paused.
      const ringsEasing = updateRangeRings(ctx, current.value);
      if (originalView.value) applyOriginalCamera(current.value);
      else followSelected();
      // After the camera updates so the overlay scale reflects THIS frame's
      // distance/fov (the original replay camera changes fov per frame).
      updateOverlayScale(ctx);
      // OSD auto-contrast: re-render the scene into a tiny readback target
      // at 2 Hz and flip every in-scene text's ink to match the backdrop
      // it actually sits on (cyclone wash, smoke, light-theme sea). The
      // sampler is created lazily — the renderer only exists once mounted.
      // The text sprites are culled around the readback render so their
      // own ink never biases the backdrop sample, and the readback itself
      // is async (PBO) so it never stalls the pipeline.
      osdAccum += dt;
      if (osdAccum >= OSD_REFRESH_S) {
        osdAccum = 0;
        if (!ctx.osd && api.value) {
          ctx.osd = createOsdContrast(api, container, {
            cull: () => {
              osdHiddenSprites = [];
              for (const s of ctx.capLetterSprites) {
                if (s.visible) {
                  osdHiddenSprites.push(s);
                  s.visible = false;
                }
              }
              for (const cl of ctx.smokeClusters) {
                const s = cl.timeSprite;
                if (s?.visible) {
                  osdHiddenSprites.push(s);
                  s.visible = false;
                }
              }
            },
            restore: () => {
              for (const s of osdHiddenSprites) s.visible = true;
              osdHiddenSprites = [];
            },
          });
        }
        if (ctx.osd) {
          // Capture the sampler: unmount disposes ctx.osd mid-flight, and a
          // GPU reset rejects the async readback — both must stay silent.
          const osd = ctx.osd;
          osd
            .refresh()
            .then((ok) => {
              if (!ok) return;
              applyOsdTones(ctx, osd);
              // A tone flip repaints canvas sprite textures — the main
              // framebuffer needs one more pass to show it while paused.
              api.value?.requestRender();
            })
            .catch(() => {
              /* context lost / GPU reset — skip this pass */
            });
        }
      }
      // Still animating? Gates the renderer's skip-idle logic (see
      // useThreeScene): repaint while playing or while any eased overlay
      // (minimap tween, range-ring radius) is converging. Camera orbit /
      // pan is covered separately by the cameraMoved parameter.
      return playing.value || mmTweenActive || ringsEasing;
    });

    // Playback state.
    const duration = ref(0);
    const current = ref(0);
    /** Quantized playhead for the heavy HUD derivations (scorebar, roster
     *  strip, self stats, weather badge): the rAF clock advances `current`
     *  at frame rate, and recomputing those every frame dominated the main
     *  thread. They read this 10 Hz shadow instead — 100 ms of staleness
     *  is invisible on a seconds-resolution HUD. Seeks sync it instantly. */
    const hudCurrent = ref(0);
    const playing = ref(false);
    /** Playback speed multiplier; the dropdown sits next to the clock. */
    const playbackSpeed = ref(2);
    /** Playback-speed menu open state (the menu component owns the panel). */
    const speedMenuOpen = ref(false);

    // Phone layout signal: on ≤767px the two HUD pop-up menus (playback
    // speed, camera mode) dock as bottom sheets — hikari's "phones never
    // float anchored menus" convention. The panels stay hand-rolled (their
    // --holo-hud-* chrome is HUD-specific, unlike the hikari-surfaced
    // filter popovers), so the docking is CSS-only; the scrim below is the
    // phone-only dismissal surface that replaces the anchored panel's
    // tap-outside radius. Desktop keeps the anchored panels untouched.
    const { isMobile } = useBreakpoint();

    const showRoster = ref(false);
    // Toggle for the floating ship labels (info overlay).
    const showLabels = ref(true);
    /** Replay the recorder's original spectating camera (Camera 0x25 frames). */
    const originalView = ref(false);
    watch(originalView, (on) => {
      if (!on) {
        const ctrl = api.value?.controls;
        if (ctrl) ctrl.enabled = true;
      }
      // The paused scene swaps camera modes on this toggle — repaint now
      // instead of waiting for the idle heartbeat. The aircraft placement
      // switch rides a SECOND watcher registered after createMapInternals
      // (it needs ctx, and markerUpdate must not run before the actors
      // exist — it recomputes the alive counters from shipMarkers).
      api.value?.requestRender();
    });

    // Camera mode dropdown (upward-opening, replaces the old original-view
    // toggle): "free" (orbit), "original" (recorder camera) or "follow"
    // (chase a specific ship, picked from the grouped roster list). The
    // original-view bit is derived from the mode so the per-frame camera
    // dispatch (`applyOriginalCamera` vs `followSelected`) stays untouched.
    const cameraMenuOpen = ref(false);
    const cameraMode = ref<"free" | "original" | "follow">("free");
    // ── Follow-mode dolly distance ─────────────────────────────────────
    // The chase camera used to hard-stamp a fixed pose every frame, which
    // also ate the wheel: OrbitControls' dolly moved the camera, and the
    // next tick stamped the old pose back. The tick CANNOT simply read the
    // camera↔ship radius back either — a moving ship changes that radius
    // every frame all by itself, and the zoom would ride the ship's wake
    // out to the max clamp. So the dolly is detected at its SOURCE: wheel
    // / two-finger events on the canvas set dollySeen, and the next stamped
    // frame adopts the radius once (clamped, see followCamera.ts); every
    // other frame re-stamps the remembered distance from scratch, exactly
    // like the old hard stamp — drift-free by construction, and the zoom
    // PERSISTS across re-selections instead of snapping back to stock.
    /** Remembered chase framing — distance, a possibly-pending one-shot
     *  preset (AI-report / explicit distance) and the last target kind. The
     *  state machine lives in followCamera.ts: a kind switch or pending preset
     *  resets to stock, the user's wheel zoom otherwise survives, and the kind
     *  memory outlives a cleared target so plane → gap → clear → ship still
     *  resets to the ship stock. */
    let followFraming = initialFollowFraming();
    /** Damped chase-pivot memory (followCamera.smoothChasePose): the smoothed
     *  pose the previous stamped frame emitted, keyed on the playhead. Null
     *  right after a target pick — the next stamped frame snaps onto the raw
     *  pose and easing starts from there (the raw pose steps between squadron
     *  update packets; stamping it directly jittered every plane chase). */
    let chaseSmooth: ChaseSmoothState | null = null;
    /** A wheel/pinch landed since the last adoption. */
    let dollySeen = false;
    // ── Recorded-camera zoom (the plane camera's wheel dolly) ──────────
    // The original/original-camera view stamps the decoded 0x25 pose every
    // frame, so OrbitControls cannot dolly it. This shifts the camera back
    // along the recorded view axis instead: positive = pull back (the
    // squadron reads farther away), negative = move in. The AIRCRAFT
    // placement hangs off the pose, not the camera, so zooming never drags
    // the formation along (see markerUpdate's RECORDED_PLANE_PAD).
    /** Minimum height of the recorded plane-camera view above the squadron it
 *  frames: the recorder's camera occasionally dips into the terrain, and the
 *  aircraft view should sit above the aircraft. */
const PLANE_VIEW_ABOVE = 32;

const RECORDED_DOLLY_MIN = -40;
    const RECORDED_DOLLY_MAX = 600;
    let recordedDolly = 0;
    // The orbit radius bounds in force when follow began (fitCamera's
    // map-sized clamp); restored when follow ends so the free camera keeps
    // its zoom range. followSelected captures it lazily — the mode can flip
    // before the scene is ready, and only a stamped frame touches bounds.
    let followStockDist: { min: number; max: number } | null = null;
    // ── Aircraft-chasing follow mode ────────────────────────────────────
    /** Chase the target carrier's currently airborne squadron instead of its
     *  hull. Set by the camera menu's aircraft row and by the AI report's
     *  keyframe jump when the analyzed perspective is an aircraft carrier. */
    const followAircraft = ref(false);
    // Mark the dolly source on the canvas OrbitControls listens on; the
    // events still reach OrbitControls untouched (this only raises a flag).
    watch(api, (a, _prev, onCleanup) => {
      if (!a) return;
      const canvas = a.renderer.domElement;
      const markDolly = (e: WheelEvent): void => {
        dollySeen = true;
        // Recorded/original camera: zoom by dollying along the recorded
        // view axis (OrbitControls is disabled in that mode, so the wheel
        // is free). The step grows with the distance so a notch feels the
        // same near and far.
        if (!originalView.value) return;
        recordedDolly = Math.max(
          RECORDED_DOLLY_MIN,
          Math.min(
            RECORDED_DOLLY_MAX,
            recordedDolly + Math.sign(e.deltaY) * (24 + Math.abs(recordedDolly) * 0.2),
          ),
        );
        api.value?.requestRender();
      };
      const markPinch = (e: TouchEvent): void => {
        if (e.touches.length >= 2) dollySeen = true;
      };
      canvas.addEventListener("wheel", markDolly, { passive: true, capture: true });
      canvas.addEventListener("touchmove", markPinch, { passive: true });
      onCleanup(() => {
        canvas.removeEventListener("wheel", markDolly, { capture: true });
        canvas.removeEventListener("touchmove", markPinch);
      });
    });
    // Either HUD pop-up open → the phone sheet scrim shows (computed reads
    // both refs lazily, so declaring it here after the second ref is fine).
        watch(cameraMode, (m) => {
      originalView.value = m === "original";
      if (m !== "follow") {
        endFreeLook();
      endRecordedLook();
        // Free/original modes keep the stock right-drag pan; only following
        // an actual ship repurposes RMB as the free-look orbit (selectShip
        // flips the mapping once a target exists). The chase zoom clamp
        // gives way to the map's own orbit bounds again.
        const ctrl = api.value?.controls;
        if (ctrl) {
          ctrl.mouseButtons.RIGHT = THREE.MOUSE.PAN;
          if (followStockDist) {
            ctrl.minDistance = followStockDist.min;
            ctrl.maxDistance = followStockDist.max;
            followStockDist = null;
          }
        }
        selectedEntityId.value = null;
        followAircraft.value = false;
        lastAircraftHold = null;
        followFraming = followFramingCleared(followFraming);
      } else {
        // Entering the chase: forget wheel events that belonged to the free
        // camera — the first follow frame stamps the remembered follow
        // distance, never the radius the free camera happened to sit at.
        dollySeen = false;
      }
    });
    // ── Recorded camera mode (0x27) ─────────────────────────────────────
    /** Recorded camera mode at the playhead (0x27 CameraMode stream; the id
     *  table is the client's CAMERA_MODE enum — see cameraModes.ts). */
    const recordedCameraModeNow = computed<RecordedCameraMode | null>(() =>
      cameraModeAt(props.cameraModes, current.value),
    );
    /** The ORIGINAL view is actually live and sits inside a recorded
     *  aircraft-camera segment (the recorder was framing planes) — drives the
     *  HUD badge. originalView (not cameraMode) is the applied state: a replay
     *  without 0x25 frames forces originalView back off while cameraMode can
     *  still read "original". */
    const inPlaneCameraMode = computed(
      () => originalView.value && isPlaneCameraMode(recordedCameraModeNow.value),
    );
    /** Whether the replay has a recorded aircraft-camera segment to jump to.
     *  A boolean computed on purpose: exposing the window OBJECT to the
     *  template would hand the render effect a fresh reference on every
     *  playhead tick and re-render the whole map at frame rate (the HUD's
     *  10 Hz shadow clock exists to avoid exactly that). */
    const hasPlaneCameraWindow = computed(
      () =>
        props.cameraFrames.length > 0 &&
        nearestPlaneCameraWindow(props.cameraModes, duration.value, current.value) != null,
    );
    /** Jump to the nearest recorded aircraft-camera segment and hand the view
     *  back to the recorder's camera — the replay itself already followed the
     *  planes then, so no synthetic follow target is needed for this route.
     *  A playhead whose 0x27 mode is ALREADY an aircraft camera only switches
     *  the view (no rewind); otherwise seek to the segment start. The test
     *  reads the recorded mode rather than the window boundary because the
     *  last window's end is synthesized from the replay duration and can equal
     *  a playhead that is still in followingPlanes. */
    function jumpToPlaneCamera(): void {
      // 0x27 mode segments annotate the recorder's OWN camera (0x25 frames);
      // without frames there is no original view to hand the playhead to.
      if (props.cameraFrames.length === 0) return;
      const target = planeCameraJumpTarget(
        props.cameraModes,
        duration.value,
        current.value,
      );
      if (!target) return;
      const at = target.seekTo ?? current.value;
      if (target.seekTo != null) seekBattleTime(target.seekTo);
      cameraMode.value = "original";
      cameraMenuOpen.value = false;
      // The recorded camera already rides the planes, but the HUD needs a
      // real FOLLOW TARGET: without one the bottom-left aircraft readout (the
      // plane-follow pill and the squadron panel) stayed empty on this route,
      // so "jump to the nearest aircraft camera" showed the wing's view with
      // no plane HP anywhere (2026-11-12 report). Adopt the carrier whose
      // squadron is airborne at the jump target — the same (carrier,
      // aircraft) pair the menu rows and the map clicks set.
      const carrierId = carrierOfNearestAirborneSquadron(at);
      if (carrierId != null) applyFollowTarget(carrierId, { aircraft: true });
      api.value?.requestRender();
    }
    /** The carrier that owns an airborne squadron at `t`, or null when
     *  nothing is flying at that playhead. The FORMATION one is adopted: the
     *  recorded camera was riding whichever wing is airborne, so any of them
     *  is the right chase target for the HUD (the camera itself stays on the
     *  recorded mode). */
    function carrierOfNearestAirborneSquadron(t: number): number | null {
      for (const carrierId of new Set(ctx.planeCarrierOf.values())) {
        if (carrierId == null) continue;
        if (
          activeSquadronOf(
            ctx.planeTrails,
            ctx.planeCarrierOf,
            ctx.minimapTrailEnd,
            carrierId,
            t,
          ) != null
        ) {
          return carrierId;
        }
      }
      return null;
    }
    /** Player stats shown in the follow menu (entityId → "WR% · battles").
     *  Resolved lazily when the menu opens; missing/failed lookups render "—". */
    const followStats = ref<Map<number, string>>(new Map());
    let statsSeq = 0;
    // The entries are resolved against the OPEN REPLAY's realm (same rule
    // as every other replay-scoped lookup here). A realm retarget — the
    // replay chain re-resolving onto another realm — invalidates them
    // wholesale; a full replay switch is covered by the replayPath watcher
    // (realm swaps ride a replay change in practice, an external replay's
    // install-less realm chain following the selection does not).
    watch(
      () => props.realm,
      () => {
        statsSeq += 1;
        followStats.value.clear();
      },
    );
    async function loadFollowStats() {
      // The replay's own realm (the parent resolves it install-first) —
      // NOT the bound account's: reviewing another realm's replay while a
      // different realm is active must not resolve these names there.
      const realm = props.realm;
      if (!realm) return;
      const seq = ++statsSeq;
      const store = useStatsStore();
      const items = shipLabels.value.filter((l) => l.kind !== "plane");
      for (let i = 0; i < items.length; i += 6) {
        if (seq !== statsSeq) return;
        const batch = items.slice(i, i + 6);
        const results = await Promise.all(
          batch.map(async (it) => {
            if (followStats.value.has(it.entityId)) return null;
            // Scripted NPCs carry no WG account — their label's "name" is
            // the ship display name, which could resolve to an unrelated
            // real player's stats.
            if (it.scripted) return null;
            try {
              const st = await store.lookup(it.name, realm);
              if (st.hidden || st.winrate == null || st.battles == null) return null;
              return [it.entityId, `${st.winrate.toFixed(1)}% · ${st.battles.toLocaleString()}`] as const;
            } catch {
              return [it.entityId, "—"] as const;
            }
          }),
        );
        if (seq !== statsSeq) return;
        for (const r of results) {
          if (r) followStats.value.set(r[0], r[1]);
        }
      }
    }
    watch(cameraMenuOpen, (open) => { if (open) void loadFollowStats(); });

    // First-person follow: the entity id whose marker the camera tracks
    // (null = free orbit). Set by clicking a ship marker/label.
    const selectedEntityId = ref<number | null>(null);
    // clearActors (replay switch / restore rebuild) nulls the selection
    // without going through the cameraMode watcher; drop the aircraft intent
    // and a dangling follow mode with it so the menu cannot advertise a
    // follow the camera is not performing.
    watch(selectedEntityId, (id) => {
      if (id != null) return;
      followAircraft.value = false;
      lastAircraftHold = null;
      followFraming = followFramingCleared(followFraming);
      if (cameraMode.value === "follow") cameraMode.value = "free";
    });
    // Hold-RMB free look inside follow mode: while held, followSelected
    // keeps only the orbit TARGET pinned to the ship (so rotating / zooming
    // stays anchored to it) and stops hard-setting the camera pose; on
    // release the chase view snaps back immediately.
    const freeLook = ref(false);
    // Hold-RMB free look INSIDE the recorded/original camera: the pose is
    // stamped from the 0x25 stream every frame, so the look is a yaw/pitch
    // offset on top of it that resets the moment the button releases (the
    // recorded view is never permanently hijacked).
    let recordedLookYaw = 0;
    /** Eased lens heading consumed by applyOriginalCamera — see the block
     *  there; null = no active lens (re-seeded from the next published
     *  heading). */
    let lensHeadingSmooth: number | null = null;
    /** Last known follow-aircraft pose: while following planes, a dead or
     *  recalled sortie HOLDS the camera here instead of snapping back to the
     *  carrier hull, until the next sortie launches. Cleared on follow
     *  exits / target switches. */
    let lastAircraftHold: { x: number; y: number; z: number; yaw: number } | null = null;
    let recordedLookPitch = 0;
    let recordedLookPrev: { x: number; y: number } | null = null;
    function endRecordedLook(): void {
      if (!recordedLookPrev) return;
      recordedLookPrev = null;
      recordedLookYaw = 0;
      recordedLookPitch = 0;
      window.removeEventListener("pointermove", onRecordedLookMove);
      window.removeEventListener("pointerup", onRecordedLookUp);
      window.removeEventListener("pointercancel", onRecordedLookUp);
      window.removeEventListener("blur", onRecordedLookUp);
      api.value?.requestRender();
    }
    const onRecordedLookUp = (e: Event): void => {
      if (e.type === "pointerup" && (e as PointerEvent).button !== 2) return;
      endRecordedLook();
    };
    const onRecordedLookMove = (e: PointerEvent): void => {
      if (!recordedLookPrev) {
        recordedLookPrev = { x: e.clientX, y: e.clientY };
        return;
      }
      const dx = e.clientX - recordedLookPrev.x;
      const dy = e.clientY - recordedLookPrev.y;
      recordedLookPrev = { x: e.clientX, y: e.clientY };
      recordedLookYaw -= dx * 0.004;
      recordedLookPitch = Math.max(
        -1.2,
        Math.min(1.2, recordedLookPitch - dy * 0.004),
      );
      api.value?.requestRender();
    };
    function endFreeLook(): void {
      if (!freeLook.value) return;
      freeLook.value = false;
      window.removeEventListener("pointerup", onFreeLookUp);
      window.removeEventListener("pointercancel", onFreeLookUp);
      window.removeEventListener("blur", onFreeLookUp);
    }
    // Window-level release handlers are registered per-hold so releasing
    // the button outside the canvas still snaps the chase view back. The
    // blur listener shares the signature (window "blur" carries a plain
    // Event, hence the loose typing); pointercancel always ends the hold —
    // browsers report button 0 on cancel, so it can't be filtered by button.
    const onFreeLookUp = (e: Event): void => {
      if (e.type === "pointerup" && (e as PointerEvent).button !== 2) return;
      endFreeLook();
      endRecordedLook();
    };
    // 2D minimap enlarged overlay state.
    const minimapZoom = ref(props.initialMinimapZoom);
    const minimapShowTrails = ref(true);
    /** The game's A–J / 1–10 grid with edge coordinate labels (default on). */
    const minimapShowGrid = ref(true);
    /** Map rotation in degrees (canvas rotate convention, +90° per click).
     *  The whole world frame — art, grid, trails, glyphs — rotates; the
     *  grid labels and upright icons stay readable. */
    const mmRotationDeg = ref(0);
    function rotateMap(steps: number): void {
      // 90° steps keep the square map filling its viewport (45° would
      // leave dark corner wedges).
      mmRotationDeg.value += steps * 90;
    }
    /** Tactical board editing on the enlarged 2D map (annotations stay
     *  rendered read-only when off, so a composed view survives toggling). */
    const tacticalOn = ref(false);
    /** Ship-action markers for the tactical timeline (salvo-grouped shells,
     *  torpedo runs, plane sorties/attacks, speed changes). Derived once per
     *  stream; the timeline slices by its own window. */
    const shipActions = computed(() =>
      extractActions({
        trajectories: props.trajectories,
        shellLaunches: props.shellLaunches,
        torpedoes: props.torpedoes,
        explosions: props.explosions,
        minimapSquadronAdds: props.minimapSquadronAdds,
        minimapSquadronMoves: props.minimapSquadronMoves,
        minimapSquadronRemoves: props.minimapSquadronRemoves,
      }),
    );
    /** Entity id → display label (ship name / player name) for tooltips. */
    const vehicleLabelOf = (entityId: number): string => {
      const v = props.vehicles.find((q) => q.id === entityId);
      // A scripted NPC without a resolved ship name has only its raw
      // `IDS_*` text key left — the entity id reads better than that.
      if (v && isScriptedUnitName(v.name)) return v.shipName ?? String(entityId);
      return v?.shipName ?? v?.name ?? String(entityId);
    };
    /** Enlarged-2D-map viewport: world-space center + zoom (1 = full map,
     *  clamped 12×). Owned here because drawMinimap paints through it; the
     *  tactical board pans/zooms via the `viewApi` prop. */
    const mmView = ref<TacticalView>({ cx: 0, cz: 0, scale: 1 });
    /** In-flight camera tween for step flyovers (eased in the scene RAF). */
    let mmViewTween: { from: TacticalView; to: TacticalView; startedAt: number; durMs: number } | null = null;

    // ── AI analysis layer (G4-b + E18 unified) ───────────────────────────
    /** Single toggle for the whole AI analysis overlay: fire suggestions on
     *  the 2D map, movement advice arrows (2D + 3D), entity confidence
     *  badges, and the hold-Tab roster's AI score columns. One button, one
     *  state. */
    const aiAnalysisOn = ref(false);
    /** Latest report (null = nothing fetched / last call failed). Rendered
     *  by drawMinimap (minimapPainter.ts) onto the zoom canvas through the
     *  SAME projection as ship glyphs, so suggestions and markers can never
     *  drift apart. Handed to the painter through the shared MapInternals
     *  context (reactive deps), like every other overlay input. */
    const decisionReport = ref<DecisionSuggestionReport | null>(null);
    /** Battle time the last in-flight call was issued for (throttle anchor). */
    let decisionsLastFetchT = -Infinity;
    /** Monotonic sequence: drop stale responses after seeks/toggles. */
    let decisionsSeq = 0;
    /** Re-fetch only when the playhead moved this many battle seconds past
     *  the last call — the model reads coarse tactical state, finer refresh
     *  would re-run full replay decode IPC for visually identical output. */
    const DECISION_REFETCH_S = 2;

    /** Latest debug report (movement advice + the full score timeline);
     *  null = nothing fetched / last call failed. The 2D painter reads it
     *  through the shared MapInternals deps, the 3D arrows through
     *  syncMoveAdvisories. */
    const debugReport = ref<DecisionDebugReport | null>(null);
    /** True while a debug report call is in flight (cold calls are slow —
     *  the panel and the toggle badge say so). */
    const debugLoading = ref(false);
    let debugLastFetchT = -Infinity;
    let debugSeq = 0;
    let debugInFlight = false;
    /** Same coarse cadence as the fire layer: the advice reads 4 s-grid
     *  decision rows, finer refresh buys nothing. */
    const DEBUG_REFETCH_S = 2;

    /** Fetch the debug report for the current playhead, throttled. One
     *  call at a time — a cold build takes seconds and queueing a second
     *  one behind it only stalls the (cached) refresh further. Failures
     *  stay silent like the fire layer's. The invoke cannot be aborted
     *  (Tauri has no per-invoke cancel), so a watchdog bounds the VISIBLE
     *  state on the same rule as the 战报 modal / the post-battle AI
     *  column: a stalled ipc round trip must not pin `debugInFlight`
     *  forever (2026-11-13 report: the map's AI badge spun endlessly —
     *  with the latch stuck, every later playhead move was skipped too).
     *  On expiry the run's seq is invalidated, so a late answer lands as
     *  a stale no-op; the next cadence tick retries with fresh state. */
    function maybeFetchDebugReport(): void {
      if (!capabilities.aiInference || !aiAnalysisOn.value || !props.replayPath) return;
      if (debugInFlight) return;
      const t = current.value;
      if (Math.abs(t - debugLastFetchT) < DEBUG_REFETCH_S) return;
      debugLastFetchT = t;
      const seq = ++debugSeq;
      debugInFlight = true;
      debugLoading.value = true;
      const timer = setTimeout(() => {
        if (seq !== debugSeq) return; // superseded: a newer run owns the state
        debugSeq += 1; // invalidate this run: its late reply is a stale no-op
        debugInFlight = false;
        debugLoading.value = false;
      }, DEBUG_READ_TIMEOUT_MS);
      rpcApi
        .decisionDebugReport(props.replayPath, t)
        .then((report) => {
          if (seq !== debugSeq || !aiAnalysisOn.value) return;
          debugReport.value = report;
        })
        .catch(() => {
          // Older shell / mock backend / unreadable replay / missing debug
          // models — blank layer, never a throw.
          if (seq === debugSeq) debugReport.value = null;
        })
        .finally(() => {
          clearTimeout(timer);
          if (seq === debugSeq) {
            debugInFlight = false;
            debugLoading.value = false;
          }
        });
    }

    /** Reset the layer's fetched state (toggle-on, replay switch). */
    function resetMoveAdviceLayer(): void {
      debugReport.value = null;
      debugLastFetchT = -Infinity;
      debugSeq++;
      debugInFlight = false;
      debugLoading.value = false;
    }

    /** Compile-time AI availability (false in the portable flavor, which
     *  links no ONNX Runtime at all). */
    const capabilities = useCapabilitiesStore();
    void capabilities.load();
    watch(
      () => capabilities.aiInference,
      (available) => {
        if (available) return;
        // The probe can land after the layer was toggled on: disarm it and
        // drop anything a previous (full-build) session left behind.
        aiAnalysisOn.value = false;
        decisionReport.value = null;
        decisionsLastFetchT = -Infinity;
        decisionsSeq++;
        aiAnalysisOn.value = false;
        resetMoveAdviceLayer();
      },
      { immediate: true },
    );

    /** Fetch suggestions for the current playhead, throttled. Failures are
     *  silent by design: no replay open, older shell without the command or
     *  a decode error simply leaves the layer blank (never a console throw). */
    function maybeFetchDecisions(): void {
      if (!capabilities.aiInference || !aiAnalysisOn.value || !props.replayPath) return;
      const t = current.value;
      if (Math.abs(t - decisionsLastFetchT) < DECISION_REFETCH_S) return;
      decisionsLastFetchT = t;
      const seq = ++decisionsSeq;
      rpcApi
        .decisionFireSuggestions(props.replayPath, t)
        .then((report) => {
          if (seq !== decisionsSeq || !aiAnalysisOn.value) return;
          decisionReport.value = report;
        })
        .catch(() => {
          // Older shell / mock backend / unreadable replay — draw nothing.
          if (seq === decisionsSeq) decisionReport.value = null;
        });
    }

    /** Reset the layer's fetched state (toggle-on, replay switch). */
    function resetDecisionLayer(): void {
      decisionReport.value = null;
      decisionsLastFetchT = -Infinity;
      decisionsSeq++;
    }

    function formatTime(sec: number): string {
      const s = Math.max(0, Math.round(sec));
      const m = Math.floor(s / 60);
      return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    }
    /** Fixed "elapsed / total" readout — rides the 10 Hz shadow clock so
     *  the playhead's per-frame writes never re-render the map for it. */
    function displayTime(): string {
      const d = duration.value || 0;
      const c = hudCurrent.value;
      return `${formatTime(c)} / ${formatTime(d)}`;
    }

    // Score bar data. The ally count keeps the relation split in
    // operations (行动) too — their rosters carry real side semantics
    // (allied escort waves ≤ 1, enemy warships > 1); only the enemy total
    // reads 0 there (the scripted enemy fleet is nobody's scoreboard).
    // Scripted scenario NPCs count on neither side — the totals read like
    // the game's own team sizes (story rosters carry e.g. a 7-player team
    // plus an `IDS_OP_09` flagship NPC).
    const rosterSides = computed(() => splitRosterSides(props.vehicles, props.operation));
    const allyTotal = computed(() => rosterSides.value.allies.length);
    const enemyTotal = computed(() => rosterSides.value.enemies.length);
    // Ships alive = total - sunk count at current time
    const allyAlive = ref(allyTotal.value);
    const enemyAlive = ref(enemyTotal.value);
    // Per-roster-player live state, joined through the roster→trajectory
    // assignment — arena-authoritative when the decoded arena state is in
    // (mirror picks can never cross), spawn-centroid heuristic otherwise —
    // and it carries the HP stream the strip's damaged-only mini bars, the
    // hover tooltip and the Tab scoreboard read.
    interface RosterShipState {
      traj: EntityTrajectory | null;
      deathTime: number | null;
      maxHp: number | null;
    }
    const rosterState = computed<Map<number, RosterShipState>>(() => {
      const shipTrajs = props.trajectories.filter((tr) => tr.kind?.entityType === 2);
      // Prefer the assignments the actor rebuild already resolved (they
      // carry the arena identities); before the first rebuild compute the
      // same map locally — replacing the old shipId-keyed join whose
      // mirror-pick overwrite this computed exists to fix.
      const identities = arenaIdentities(props.arenaPlayers);
      const assignments =
        ctx?.rosterAssignments.size
          ? ctx.rosterAssignments
          : resolveRosterAssignments(
              shipTrajs,
              props.vehicles,
              props.operation,
              identities,
            );
      const trajById = new Map(shipTrajs.map((tr) => [tr.entityId, tr]));
      const byPlayer = new Map<number, RosterShipState>();
      for (const [entityId, v] of assignments) {
        if (!v || byPlayer.has(v.id)) continue;
        const traj = trajById.get(entityId) ?? null;
        // Total HP resolves from the ship's base information — the arena's
        // build health first, the HP stream's peak only as the fallback
        // (shipHp.ts); a stale stream peak made dark-killed ships read at
        // full HP and late-spotted ones under-report their total.
        const info = props.encyclopedia.get(v.shipId) as ShipInfo | undefined;
        const maxHp = resolveMaxHp(
          identities?.get(entityId)?.maxHealth,
          traj?.hpSamples,
          encyclopediaHullHealth(info),
          shipOfflineEntry(v.shipId)?.hp ?? null,
        );
        byPlayer.set(v.id, { traj, deathTime: traj?.deathTime ?? null, maxHp });
      }
      // Roster entries with no trajectory stream still get a stub so every
      // consumer can rely on the map being roster-complete.
      for (const v of props.vehicles) {
        if (!byPlayer.has(v.id)) {
          byPlayer.set(v.id, { traj: null, deathTime: null, maxHp: null });
        }
      }
      return byPlayer;
    });
    /** Player name -> division (组队) id from the decoded arena file's
     *  prebattle field — the Tab roster's yellow 组队 tags. Older streams
     *  carry no prebattle ids: the map stays empty and no tag renders. The
     *  lettering itself is per-table in the overlay (each side starts at A),
     *  mirroring the post-battle matrix. */
    const prebattleByPlayer = computed<Map<string, number>>(() => {
      const m = new Map<string, number>();
      for (const ap of props.arenaPlayers) {
        if (ap.name && ap.prebattle) m.set(ap.name, ap.prebattle);
      }
      return m;
    });
    /** Roster rows for the ship-icon strip under the scorebar: team icons in
     *  roster order, sunk ships pushed to the far edge and greyed out. */
    interface ShipRowEntry {
      key: number;
      vehicle: VehicleEntry;
      type: string | null;
      dead: boolean;
      hp: number | null;
      maxHp: number | null;
    }
    const shipRows = computed(() => {
      const rs = rosterState.value;
      const mk = (v: VehicleEntry): ShipRowEntry => {
        const st = rs.get(v.id);
        const d = st?.deathTime ?? null;
        const dead = d != null && d <= hudCurrent.value;
        const info = props.encyclopedia.get(v.shipId) as ShipInfo | undefined;
        const offline = shipOfflineEntry(v.shipId);
        const hp = !dead && st?.traj ? hpAtTime(st.traj.hpSamples, hudCurrent.value) : null;
        return {
          key: v.id,
          vehicle: v,
          type: info?.type ?? offline?.type ?? null,
          dead,
          hp,
          maxHp: st?.maxHp ?? null,
        };
      };
      const allies = rosterSides.value.allies.map(mk);
      const enemies = rosterSides.value.enemies.map(mk);
      // Ship-size weight: carriers/battleships biggest, subs smallest. Sunk
      // ships form their own group at the outer edge of each side (allies:
      // leftmost, enemies: rightmost); within each group the biggest ships
      // sit at the outer edge — mirror image of each other.
      const sizeOf = (r: ShipRowEntry): number => {
        const t = (r.type ?? "").toLowerCase();
        if (t.includes("aircarrier") || t.includes("aircar")) return 5;
        if (t.includes("battleship")) return 4;
        if (t.includes("cruiser")) return 3;
        if (t.includes("destroyer")) return 2;
        if (t.includes("submarine")) return 1;
        return 0;
      };
      // Allies: sunk group first (left edge), then alive; big ships to the
      // left within each group.
      const sortAlly = (a: ShipRowEntry, b: ShipRowEntry) =>
        Number(b.dead) - Number(a.dead) || sizeOf(b) - sizeOf(a);
      // Enemies: alive group first, sunk group last (right edge); big ships
      // to the right within each group.
      const sortEnemy = (a: ShipRowEntry, b: ShipRowEntry) =>
        Number(a.dead) - Number(b.dead) || sizeOf(a) - sizeOf(b);
      allies.sort(sortAlly);
      enemies.sort(sortEnemy);
      return { allies, enemies };
    });
    // Live self statistics (top-right): derived from the projectile-kill
    // stream (receiveShotKills — server-confirmed hits carrying the firing
    // vehicle id), tracking the current playhead. 15.7+ replays no longer
    // carry receiveExplosions, so this — not the explosion stream — is the
    // reliable hit signal. Damage is the HP loss of ships near the impact
    // right after it; a sinking near an impact counts as a frag.
    // The expensive part (per shot: sample every ship trajectory, HP-delta
    // attribution, frag proximity) is a pure function of immutable stream
    // data — it runs once per stream change in the ledger below, and the
    // playhead query is a binary search (selfShotLedger.ts).
    const selfShotBook = computed(() => {
      // Reading `props.vehicles` keeps the ledger in lockstep with the
      // roster-arrival rebuild (the rebuild that repopulates the
      // non-reactive roster assignments resolveRoleQuick reads below).
      void props.vehicles.length;
      const selfTraj = props.trajectories.find(
        (tr) => tr.kind?.entityType === 2 && resolveRoleQuick(ctx, tr) === "self",
      );
      if (!selfTraj || selfTraj.samples.length === 0) return null;
      return {
        selfTraj,
        ledger: buildSelfShotLedger({
          shotKills: props.shotKills,
          trajectories: props.trajectories,
          selfEntityId: selfTraj.entityId,
          inferredDeaths: props.inferredDeaths,
        }),
      };
    });
    const selfStats = computed(() => {
      // Server-authoritative totals (receiveDamageStat) — exact per-weapon
      // damage incl. aircraft weapons, folded to the playhead. When present
      // they override the heuristic damage/hits below (the HP-delta estimate
      // over-counts multi-hit salvos and misses out-of-view DoT).
      const folded = props.damageStats.length
        ? foldDamageStats(props.damageStats, hudCurrent.value)
        : null;
      const book = selfShotBook.value;
      if (!book) {
        // No trajectory join (very early battle): the authoritative stream is
        // still the recorder's own and usable on its own.
        return folded ? { ...folded, frags: 0, taken: 0 } : null;
      }
      const shot = querySelfShotLedger(book.ledger, hudCurrent.value);
      let hits = shot.hits;
      let damage = shot.damage;
      let frags = shot.frags;
      // Damage taken: every point of HP the self ship lost up to the
      // playhead (the in-game "承受伤害" readout beside the HP plaque).
      let taken = 0;
      const hps = book.selfTraj.hpSamples ?? [];
      for (let i = 1; i < hps.length; i++) {
        if (hps[i].time > hudCurrent.value) break;
        const drop = hps[i - 1].value - hps[i].value;
        if (drop > 0) taken += drop;
      }
      if (folded) {
        damage = folded.damage;
        hits = folded.hits;
      }
      return { hits, damage, frags, taken, planeDamage: folded?.planeDamage ?? 0 };
    });
    /** Post-battle payload (memoized per battleResults string) — the source
     *  of the killer attribution behind the live kill counts. */
    const pbData = computed(() => parsePostBattle(props.battleResults || null));
    /** Victim vehicle → the killer's ROSTER player id (the id space the
     *  strip/tooltip/scoreboard key players by). BattleResults ids are WG
     *  account ids, which do NOT coincide with the descriptor roster ids
     *  on every replay — resolve account → name → roster for both the
     *  victim and the killer (the same name bridge the kill feed uses).
     *  Null when the replay carries no BattleResults packet at all. */
    const killerRosterIdOf = computed<((v: VehicleEntry) => number | null) | null>(() => {
      const pb = pbData.value;
      if (!pb?.players) return null;
      const pbByAccount = new Map<number, (typeof pb.players)[number]>();
      const pbByName = new Map<string, (typeof pb.players)[number]>();
      for (const p of pb.players) {
        if (p.accountId) pbByAccount.set(p.accountId, p);
        const n = (p.name ?? "").trim().toLowerCase();
        if (n) pbByName.set(n, p);
      }
      const vehicleByAccount = new Map<number, VehicleEntry>();
      const vehicleByName = new Map<string, VehicleEntry>();
      for (const v of props.vehicles) {
        if (v.id) vehicleByAccount.set(v.id, v);
        const n = (v.name ?? "").trim().toLowerCase();
        if (n) vehicleByName.set(n, v);
      }
      const vehicleOfPb = (p: (typeof pb.players)[number] | undefined): VehicleEntry | null =>
        (p?.accountId ? vehicleByAccount.get(p.accountId) : undefined) ??
        (p ? vehicleByName.get((p.name ?? "").trim().toLowerCase()) ?? null : null);
      return (v: VehicleEntry) => {
        const victim =
          (v.id ? pbByAccount.get(v.id) : undefined) ??
          pbByName.get((v.name ?? "").trim().toLowerCase());
        const killerId = victim?.killerId;
        if (killerId == null) return null;
        // killerId is an account id — land it back on the roster (direct
        // id hit first, then the pb name bridge).
        const killerVehicle =
          vehicleByAccount.get(killerId) ??
          vehicleOfPb(pbByAccount.get(killerId));
        return killerVehicle?.id ?? null;
      };
    });
    /** Kills credited to each roster player (roster id keyed) by battle
     *  time t: a kill counts once the victim's death time is crossed AND
     *  the post-battle payload attributes it to this player. Scrub-safe —
     *  recomputed from scratch, never incremented. */
    const EMPTY_KILLS: Map<number, number> = new Map();
    function killsByPlayerAt(t: number): Map<number, number> {
      const m = new Map<number, number>();
      const killerOf = killerRosterIdOf.value;
      if (!killerOf) return m;
      const rs = rosterState.value;
      for (const v of props.vehicles) {
        const d = rs.get(v.id)?.deathTime;
        if (d == null || d > t) continue;
        const killer = killerOf(v);
        if (killer == null) continue;
        m.set(killer, (m.get(killer) ?? 0) + 1);
      }
      return m;
    }
    /** Career stats for the strip tooltip, the Tab scoreboard's clan tags
     *  AND the export clip's team columns — one WG batch per replay, armed
     *  lazily by the first strip hover / Tab hold (nobody pays for stats
     *  they never look at) and by the export job. */
    const nameStats = ref<Map<string, RosterStat>>(new Map());
    const nameStatsLoading = ref(false);
    let nameStatsLoadedFor = "";
    /** The in-flight one-shot fetch (and the replay it belongs to) so the
     *  export job can AWAIT the real answer instead of racing a timer. */
    let nameStatsInFlight: { path: string; promise: Promise<void> } | null = null;
    const markers = useMarkersStore();
    void markers.ensureLoaded();
    /** Arm (and return) the replay's roster-stats batch.
     *
     *  The 2026-11-21 「战绩没加载出来」 report: the export job used to arm
     *  this and poll `nameStatsLoading` for at most 5 s. A cold replay view
     *  (the live panel never mounts, so the batch, its queue lane and any
     *  per-ship lists are all cold) routinely needs longer than that — and
     *  because the latch below is set BEFORE the fetch, the take froze
     *  every row as "—" and no later attempt ever refetched. Two defects,
     *  both fixed here: the caller can await the actual promise, and a
     *  FAILED fetch clears the latch so the next attempt retries instead
     *  of poisoning the replay for the rest of the session. */
    function ensureRosterStats(): Promise<void> {
      const path = props.replayPath;
      if (nameStatsInFlight?.path === path) return nameStatsInFlight.promise;
      if (nameStatsLoadedFor === path) return Promise.resolve();
      const names = [...new Set(props.vehicles.map((v) => v.name))].filter(
        (n) => !AI_NAME.test(n),
      );
      if (names.length === 0 || !props.realm) return Promise.resolve();
      nameStatsLoadedFor = path;
      nameStatsLoading.value = true;
      const promise = fetchRosterStatsByNames(names, props.realm)
        .then((m) => {
          if (nameStatsLoadedFor === path) nameStats.value = m;
        })
        .catch(() => {
          // A transient provider/queue failure must not pin this replay to
          // an empty map forever: drop the latch so the next arm refetches
          // (the clip then keeps its honest dashes for this take).
          if (nameStatsLoadedFor === path) nameStatsLoadedFor = "";
        })
        .finally(() => {
          // Only THIS replay's slot retires; a newer replay's fetch owns
          // the flag by then.
          if (nameStatsInFlight?.path === path) {
            nameStatsInFlight = null;
            nameStatsLoading.value = false;
          }
        });
      nameStatsInFlight = { path, promise };
      return promise;
    }
    // ── Team-column feed (the live roster's FULL mode on the clip) ─────
    // The clip's side columns rebuild what the live battle roster shows:
    // the same configured stats columns (statsPrefs.overlayColumns), the
    // same per-column scope views (utils/statView + shipStatsScope), the
    // same team aggregates (utils/teamAggregate, tier-weighted winrate
    // included) and the same seal verdicts (careerStamp + the composition
    // batch). Nothing here invents its own numbers or labels.
    const statsPrefs = useStatsPrefsStore();
    const { uiLocale, dataLanguage } = useLanguage();
    /** The open replay's own descriptor — the clip header's corner needs
     *  its recorded date-time (the file header's field the rail's cards
     *  show), which HolographicMap does not receive as a prop. The parsed
     *  `current` entry is the authoritative one for the open file; the
     *  rail lists (scanned + externally picked) cover a header still in
     *  flight. Absent = the corner omits its start-time line. */
    const replayStore = useReplayStore();
    const recordedStamp = computed<string | null>(() => {
      const path = props.replayPath;
      const cur = replayStore.current;
      const entry =
        cur && cur.path === path
          ? cur
          : [...replayStore.list, ...replayStore.external].find((r) => r.path === path);
      return entry?.dateTime ?? null;
    });
    /** Composition-seal verdicts for the clip's medals — the SAME batch
     *  command the live roster rides (one process-lifetime backend cache,
     *  so a clip costs no extra WG request once the panel asked). Filled
     *  per export: a clip is a one-shot read.
     *  (careerStamp lives in utils/winrate; the composition half needs the
     *  per-class share verdict this batch answers.) */
    const exportCompositions = new Map<string, PlayerComposition | null>();
  let medalFeedWarm = false;
    /** Seals are a zh-only artifact on every surface (RatingStamp /
     *  StampTag gate on the UI locale) AND ride the PR + seals masters —
     *  the clip applies the same three gates before painting a badge. */
    const sealsShown = computed(
      () =>
        uiLocale.value.startsWith("zh") &&
        statsPrefs.prefs.prEnabled &&
        statsPrefs.prefs.sealsEnabled,
    );
  /** Warm the clip's medal feed (compositions + seal art) ahead of a take.
   *  Fired when the export modal opens: in the replay view the live panel
   *  never mounts, so the backend composition cache is otherwise cold and
   *  the first take would sit at "render 0/N" through the lookup. Idempotent
   *  per session; the job awaits it and gets warm caches in the common case. */
  const warmExportMedalFeed = async (): Promise<void> => {
    if (medalFeedWarm || !sealsShown.value) return;
    medalFeedWarm = true;
    const humanNames = [
      ...new Set(props.vehicles.filter((v) => !AI_NAME.test(v.name)).map((v) => v.name)),
    ];
    // The tag face is pure vector text (stampWording over sealLabels) —
    // nothing to decode; only the composition lookup needs warming.
    const comps =
      humanNames.length > 0 && props.realm
        ? await rpcApi
            .lookupPlayersComposition(humanNames, props.realm)
            .catch(() => [] as (PlayerComposition | null)[])
        : [];
    humanNames.forEach((name, i) => exportCompositions.set(name, comps[i] ?? null));
  };

    /** One row's display numbers for ONE configured column scope — the
     *  live panel's own resolver (account careers for global/solo, the
     *  aggregated per-ship view for ship/shipSolo/class). */
    const colViewOf = (
      scope: OverlayColumnScope,
      st: RosterStat | null | undefined,
      shipId: number | null,
    ) =>
      scopedRosterView(
        st,
        shipId,
        overlayColumnDims(scope, statsPrefs.prefs.overlayBattleScope),
        props.statsMode,
        prAlgoForRequest() ?? "winrate",
      );
    /** One team's aggregate FOR ONE COLUMN SCOPE — the live panel's
     *  teamAggFor verbatim: loading / hidden / bot rows sit out, each
     *  survivor resolves through its column's own scope, and the winrate
     *  mean stays tier-weighted per the stats pref. */
    const teamAggFor = (scope: OverlayColumnScope, entries: ShipRowEntry[]) =>
      aggregateTeamStats(
        entries.map((entry) => {
          const v = entry.vehicle;
          const st = nameStats.value.get(v.name);
          if (
            !st ||
            st.loading ||
            (scope !== "global" && scope !== "solo" && st.shipsLoading) ||
            st.hidden ||
            AI_NAME.test(v.name)
          ) {
            return {
              winrate: null,
              pr: null,
              battles: null,
              damage: null,
              kd: null,
              tier: shipTierOf(v.shipId),
            };
          }
          const view = colViewOf(scope, st, v.shipId);
          return {
            winrate: view.winrate,
            pr: view.pr,
            battles: view.battles,
            damage: view.avgDamage,
            kd: view.kd,
            tier: shipTierOf(v.shipId),
          };
        }),
        statsPrefs.prefs.weightedTeamWr,
      );
    /** The header label of one configured column — the stats config's own
     *  compact head ("胜率" / "单排 PR" / "K/D"), so the clip never owns a
     *  duplicated column title. The averages row below carries the team
     *  mean under each label (see the drawer). */
    const headerLabelOf = (col: RosterColumnSpec): string =>
      // The live head's own wording (加权胜率 / 平均 PR …) — col.head would
      // silently rename the column over the team mean.
      teamHeadLabelOf(col, statsPrefs.prefs.weightedTeamWr);
    /** The rows' first-two stats, formatted and coloured by the live
     *  roster's own shot-cell formatter (postBattleShare.rosterShotCells)
     *  so the clip and the DOM can never quote different numbers. */
    const statCellsOf = (
      st: RosterStat | null | undefined,
      shipId: number | null,
      blank: boolean,
    ): PlaybackTeamStat[] => {
      // A 过街老鼠 verdict (a hidden career) has no values to show, and the
      // live formatter still emits aligned "—" glyphs for it — a dash on an
      // empty band reads as a number. Such a row's cells are BLANK (the
      // 2026-11-21 report); the header averages keep the team's own values.
      if (blank) return [];
      // Bots / stats misses keep the aligned dash cells (the live roster
      // renders "—" there, never a blank band).
      if (!st) return rosterShotDashes().slice(0, EXPORT_TEAM_STAT_COLS);
      return rosterShotCells((scope) => colViewOf(scope, st, shipId)).slice(
        0,
        EXPORT_TEAM_STAT_COLS,
      );
    };
    /** The seal gate chain shared by a row's medals and its stat band: the
     *  zh-only seal surface over the PR + seals masters, a stat-resolved
     *  non-bot row, and a hidden profile whose clan gate has resolved. */
    const sealGatesOpen = (name: string, st: RosterStat | undefined): boolean => {
      if (!sealsShown.value || !st || st.loading || AI_NAME.test(name)) return false;
      // A hidden profile whose clan gate is still out holds its stamp.
      if (st.hidden && st.clanId != null && st.clanWinrate === undefined) return false;
      return true;
    };
    /** The career verdict a hull carries into the clip — the SAME careerStamp
     *  the live roster rides, behind the seal gates above. Null = no verdict
     *  (or a row the gates hold back entirely). */
    const careerOf = (name: string, st: RosterStat | undefined): StampKind | null =>
      !st || !sealGatesOpen(name, st)
        ? null
        : careerStamp(st.pr, st.battles, st.winrate, st.hidden, st.clanWinrate);
    /** One player's seal kinds, in the live roster full mode's order:
     *  the career verdict first (the row-end stamp there), then the
     *  composition tags air-before-sub. A 蛆 / 过街老鼠 verdict suppresses
     *  the composition half, exactly like compSealKindsOf. */
    const medalsOf = (name: string, st: RosterStat | undefined): string[] => {
      if (!st || !sealGatesOpen(name, st)) return [];
      const career = careerOf(name, st);
      const kinds: StampKind[] = [];
      if (career) kinds.push(career);
      if (career !== "maggot" && career !== "rat") {
        const comp = exportCompositions.get(name);
        if (comp) {
          if (comp.air) kinds.push(comp.airVeteran ? "airVeteran" : "air");
          if (comp.sub) kinds.push(comp.subVeteran ? "subVeteran" : "sub");
        }
      }
      // The TAG face's wording: the shared STAMP_WORDING with the user's
      // label edits applied (StampTag's exact recipe). A user-imported
      // seal PICTURE deliberately never enters the clip.
      return kinds
        .filter((kind) => !statsPrefs.prefs.sealDisabled[kind])
        .map((kind) => stampWording(kind, statsPrefsState.value.sealLabels));
    };
    /** One side's HEADER columns: the stats config's first two columns
     *  labelled above each metric's team mean (the live full mode's
     *  two-line header, its averages formatted by the live cell
     *  formatter so rounding/units/colours can never drift). */
    const playbackHeaderColumns = (
      entries: ShipRowEntry[],
    ): PlaybackTeamStatColumn[] => {
      const columns = rosterColumns().slice(0, EXPORT_TEAM_STAT_COLS);
      // One aggregate per DISTINCT scope (two columns may share a scope:
      // they then read different fields of the SAME team mean).
      const aggViews = new Map<OverlayColumnScope, ReturnType<typeof colViewOf>>();
      for (const col of columns) {
        if (aggViews.has(col.scope)) continue;
        const agg = teamAggFor(col.scope, entries);
        aggViews.set(col.scope, {
          winrate: agg.winrate,
          pr: agg.avgPr,
          battles: agg.avgBattles,
          avgDamage: agg.avgDamage,
          kd: agg.avgKd,
        });
      }
      const headerCells = rosterShotCells(
        (scope) => aggViews.get(scope) ?? EMPTY_ROSTER_VIEW,
      ).slice(0, columns.length);
      return columns.map((col, i) => ({
        label: headerLabelOf(col),
        text: headerCells[i]?.text ?? "\u2014",
        color: headerCells[i]?.color,
      }));
    };
    /** One entry's TIME-INVARIANT half (identity, stats, medals) - frozen
     *  once per export; the HP fraction and the dead flag are the only
     *  fields the render loop re-reads per frame. */
    const playbackRowBase = (
      r: ShipRowEntry,
      statsOn = true,
    ): Omit<PlaybackTeamRow, "hpFrac" | "dead"> => {
      const v = r.vehicle;
      const st = nameStats.value.get(v.name);
      // The career verdict drives BOTH the seal tags and the stat band: a
      // 过街老鼠 row's cells are blank (statCellsOf). A seal the user switched
      // off paints no mark, so it blanks nothing.
      const ratStamped =
        statsOn &&
        careerOf(v.name, st) === "rat" &&
        !statsPrefs.prefs.sealDisabled.rat;
      return {
        name: v.name,
        clan: st?.clanTag ?? null,
        // The live roster's own identity chain (offline DB name first -
        // the clip must read like the panel, not like the raw header).
        shipName:
          shipNameFromOfflineDb(v.shipId, dataLanguage.value) ??
          v.shipName ??
          i18nT("replay.live.unknownShip"),
        tier: tierRoman(v.shipId != null ? shipTierOf(v.shipId) : null),
        shipType: r.type,
        // Stats toggle off: no seal verdicts (they grade stats) and no
        // cells — the identity band owns the row. A rat-stamped row keeps
        // its stamp but leaves the two stat tracks empty.
        medals: statsOn ? medalsOf(v.name, st) : [],
        stats: statsOn ? statCellsOf(st, v.shipId, ratStamped) : [],
      };
    };

    /** Strip-icon hover tooltip: which roster player, anchored to which
     *  slot element. Stays mounted a beat after both icon and card are
     *  left so the pointer can travel between them. */
    const tipVehicleId = ref<number | null>(null);
    const tipAnchorEl = ref<HTMLElement | null>(null);
    const tipIconHover = ref(false);
    const tipCardHover = ref(false);
    let tipHideTimer: number | null = null;
    function syncTipPresence(): void {
      if (tipIconHover.value || tipCardHover.value) {
        if (tipHideTimer != null) {
          window.clearTimeout(tipHideTimer);
          tipHideTimer = null;
        }
        return;
      }
      if (tipHideTimer != null) return;
      tipHideTimer = window.setTimeout(() => {
        tipHideTimer = null;
        if (!tipIconHover.value && !tipCardHover.value) {
          tipVehicleId.value = null;
          tipAnchorEl.value = null;
        }
      }, 180);
    }
    watch([tipIconHover, tipCardHover], syncTipPresence);
    function onShipEnter(ship: HoloShip, el: HTMLElement): void {
      ensureRosterStats();
      if (typeof ship.key !== "number") return;
      tipVehicleId.value = ship.key;
      tipAnchorEl.value = el;
      tipIconHover.value = true;
      syncTipPresence();
    }
    function onShipLeave(): void {
      tipIconHover.value = false;
      syncTipPresence();
    }
    /** Ship class for a shipId (encyclopedia → offline DB → "". */
    // Cap zone status (A=0, B=1, C=2) — 0=neutral, 1=ally, 2=enemy
    const capStatus = ref([0, 0, 0]);
    // Estimated match score: kills (1 pt) + fully-held cap points (3 pts each).
    // WoWS doesn't stream score packets into replays, so this is a close
    // approximation of the domination scoring shown in the top bar.
    const allyScore = ref(0);
    const enemyScore = ref(0);
    /** Unified bottom-left event feed (sinks + chat + achievements), newest
     *  first; entries auto-expire after a few seconds. */
    const feed = ref<FeedEntry[]>([]);
    /** The recorder's own 0/1 side from the post-battle payload — maps a
     *  zone's teamId to the owner code (1 = own side, 2 = enemy). */
    const selfTeam = computed(() => {
      const pb = ctx.pbCache;
      if (!pb?.players || pb.selfId == null) return null;
      return pb.players.find((p) => p.accountId === pb.selfId)?.team ?? null;
    });
    const capZones = computed(() => {
      const zones = props.trajectories.filter((t) => {
        // InteractiveZone is entity type 14 on modern clients but 13 before
        // 14.5.0; isCaptureZone() still decides what is a real point.
        if (t.kind?.entityType !== 13 && t.kind?.entityType !== 14) return false;
        if (!isCaptureZone(t)) return false;
        if (t.kind.initialX == null && t.kind.initialZ == null && t.samples.length === 0) {
          return false;
        }
        return true;
      });
      // Order letters by the game's own point index (0 = A) so the scorebar
      // matches the in-match callouts.
      zones.sort(
        (a, b) =>
          (a.kind?.controlPointIndex ?? 999) - (b.kind?.controlPointIndex ?? 999),
      );
      return zones;
    });

    /** Zones that actually score: same set as the visible capture points —
     *  strike/event zones never reach this list. */
    const scoringZones = computed(() => capZones.value);
    /** Alt held → show in-game point timers on the cap letters (shared
     *  capTimer rules, same as the marketing site). */
    const showCapEta = ref(false);

    /** Hull side-silhouettes (bake output, keyed by model name). Kept in a
     *  ref so the selfCard re-renders once the async fetch resolves (a plain
     *  object would populate silently and never update the card). */
    const silhouettes = ref<Record<string, { path: string }>>({});
    void loadSilhouettes().then((j) =>
      Object.assign(silhouettes.value, j),
    );

    /** Recorder ship health plaque (shared HoloShipCard, bottom-left). */
    const selfCard = computed<HoloShipCardData | null>(() => {
      const l = shipLabels.value.find((x) => x.role === "self" && x.shipName);
      if (!l) return null;
      const stem = shipModelStem(l.shipId) ?? undefined;
      return {
        shipType: l.type ?? undefined,
        silhouetteUrl: shipSilhouetteUrl(l.shipId),
        silhouette: (stem && silhouettes.value[stem]?.path) ?? null,
        // Vertical crop of the bitmap art (alpha band inside the 404×155
        // canvas): keeps the plaque compact without squashing the hull.
        silhouetteBox: shipSilhouetteBox(l.shipId),
        name: l.shipName,
        hp: l.hp,
        maxHp: l.maxHp,
        dead: l.dead,
        // Repairable pool approximated as 60% of damage taken until the
        // replay stream carries the real value.
        repairableHp: l.hp != null && l.maxHp != null ? (l.maxHp - l.hp) * 0.6 : null,
      };
    });

    /** Recorder submarine depth for the shipcard's depth pill — mirrors
     *  ShipLabel.depthMeters (positive meters below surface; null while
     *  surfaced or on a non-submarine hull, refreshed per playhead tick). */
    const selfDepth = computed<{ meters: number } | null>(() => {
      const l = shipLabels.value.find((x) => x.role === "self");
      return l?.depthMeters != null ? { meters: l.depthMeters } : null;
    });

    // ── Hold-Tab roster (the map's ONE Tab consumer) ──────────────────
    // Tab is CLAIMED for as long as the map is mounted: the listener sits
    // in the CAPTURE phase (before any app-level handler) and
    // preventDefault runs on every keydown — repeats included. A repeat
    // with the default action intact walks the browser's focus ring one
    // control per key event, which is exactly the drift this hold must
    // stop. Only text-entry targets keep native Tab (see tabKeyGate.ts);
    // buttons/links/selects no longer bail out. keydown shows the roster,
    // keyup retires it, and a window blur or a hidden tab retires it too,
    // so a hold can never strand the overlay once focus leaves.
    onMounted(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Tab") {
          if (shouldReserveTabKey(e.target)) {
            e.preventDefault();
            showRoster.value = true;
            // The scoreboard's game-faithful order leans on clan tags —
            // arm the one-shot roster stats batch on first hold too.
            ensureRosterStats();
          }
          return;
        }
        if (e.key === "Alt") {
          showCapEta.value = true;
          updateMarkersAt(ctx, current.value);
        }
      };
      const onKeyUp = (e: KeyboardEvent) => {
        if (e.key === "Tab") {
          showRoster.value = false;
          return;
        }
        if (e.key === "Alt") {
          showCapEta.value = false;
          updateMarkersAt(ctx, current.value);
        }
      };
      const retireRoster = (): void => {
        showRoster.value = false;
      };
      const onVisibilityChange = (): void => {
        if (document.visibilityState === "hidden") retireRoster();
      };
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("keyup", onKeyUp, true);
      window.addEventListener("blur", retireRoster);
      document.addEventListener("visibilitychange", onVisibilityChange);
      onBeforeUnmount(() => {
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("keyup", onKeyUp, true);
        window.removeEventListener("blur", retireRoster);
        document.removeEventListener("visibilitychange", onVisibilityChange);
      });
    });

    // ── Keyboard transport: Space + ArrowLeft/Right ──────────────────
    // Space toggles pause/play; the arrows seek by the current playback
    // multiplier (a tap moves playbackSpeed battle-seconds, a hold ramps
    // from that rate to 10x of it — see kbdTransport.ts). The listener is
    // window-level (capture) so the map does not need to be clicked first,
    // and it stands down exactly where the rest of the app expects: typing
    // surfaces keep their keys, a window stacked OVER the map wins, the
    // export take owns the playhead, and the tactical editor (whose Space is
    // hold-to-pan) keeps its own shortcuts.
    let transportHold: { dir: -1 | 1; timer: number } | null = null;
    function stopTransportHold(): void {
      if (!transportHold) return;
      window.clearInterval(transportHold.timer);
      transportHold = null;
    }
    /** A hikari window stacked ABOVE this map. Modal content teleports to
     *  the overlay root, so "any .hk-modal-content that does not CONTAIN the
     *  map" is an overlay over it; the phone replay-detail sheet wraps the
     *  whole view and must not kill the shortcuts it contains. */
    function modalAboveReplay(): boolean {
      return isModalAboveSurface(
        container.value,
        document.querySelectorAll(".hk-modal-content"),
      );
    }
    /** The replay surface is mounted, laid out and not the tactical editor —
     *  the editor mounts INSIDE the enlarged 2D map and its own keyboard map
     *  (Space = hand tool, [ ] = step) owns the keys while it is up. */
    function replaySurfaceActive(): boolean {
      const root = container.value;
      return (
        !!root &&
        root.isConnected &&
        root.getClientRects().length > 0 &&
        !(tacticalOn.value && minimapZoom.value)
      );
    }
    function transportKeyAllowed(e: KeyboardEvent): boolean {
      const target = e.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;
      return shouldHandleTransportKey({
        typingTarget: typing,
        modalOpen: exportOpen.value || modalAboveReplay(),
        exporting: exporting.value,
        active: replaySurfaceActive(),
      });
    }
    /** Seek one step of `heldMs` into the hold, through the same path the
     *  transport slider/tactical timeline use (it pauses playback, syncs the
     *  HUD clock and repaints both map layers). */
    function stepTransport(dir: -1 | 1, heldMs: number): void {
      const step = kbdStepSeconds(kbdBaseStepSeconds(playbackSpeed.value), heldMs);
      if (step <= 0) return;
      seekBattleTime(clampSeekSeconds(current.value + dir * step, duration.value));
    }
    function onTransportKey(e: KeyboardEvent): void {
      if (e.key !== " " && e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!transportKeyAllowed(e)) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      // A focused select owns BOTH keys: Space opens it and the arrows walk
      // its options, so the transport must not shadow either.
      if (tag === "SELECT") return;
      if (e.key === " ") {
        // Never steal Space from a focused button: native activation is the
        // expected keyboard behavior there.
        if (tag === "BUTTON") return;
        e.preventDefault(); // page scroll
        if (!e.repeat) togglePlay();
        return;
      }
      const dir = kbdSeekDirection(e.key);
      if (dir === 0) return;
      e.preventDefault(); // horizontal page scroll
      // The browser's own key repeat has an OS-specific first delay; the
      // interval below is the one repeat source we control.
      if (e.repeat) return;
      stopTransportHold();
      stepTransport(dir, 0);
      const startedAt = performance.now();
      const timer = window.setInterval(() => {
        const heldMs = performance.now() - startedAt;
        // A tap must stay ONE step: no repeat before the hold window opens.
        if (heldMs < KBD_HOLD_DELAY_MS) return;
        stepTransport(dir, heldMs);
      }, KBD_REPEAT_MS);
      transportHold = { dir, timer };
    }
    function onTransportKeyUp(e: KeyboardEvent): void {
      if (transportHold && kbdSeekDirection(e.key) === transportHold.dir) {
        stopTransportHold();
      }
    }
    const onTransportVisibility = (): void => {
      if (document.visibilityState === "hidden") stopTransportHold();
    };
    onMounted(() => {
      window.addEventListener("keydown", onTransportKey, true);
      window.addEventListener("keyup", onTransportKeyUp, true);
      window.addEventListener("blur", stopTransportHold);
      document.addEventListener("visibilitychange", onTransportVisibility);
      onBeforeUnmount(() => {
        window.removeEventListener("keydown", onTransportKey, true);
        window.removeEventListener("keyup", onTransportKeyUp, true);
        window.removeEventListener("blur", stopTransportHold);
        document.removeEventListener("visibilitychange", onTransportVisibility);
        stopTransportHold();
      });
    });

    const shipLabels = ref<ShipLabel[]>([]);
    /** Synthetic menu row for one carrier's airborne squadron: the id is the
     *  aircraft-card namespace (PLANE_CARD_LABEL_ID_BASE + carrier id), the
     *  row carries the carrier's identity so the menu can render it as a
     *  plane-icon sub-row right under the hull row. */
    function aircraftMenuRow(carrier: ShipLabel, planeId: number): ShipLabel {
      return {
        entityId: PLANE_CARD_LABEL_ID_BASE + carrier.entityId,
        role: carrier.role,
        name: carrier.name,
        shipName: carrier.shipName,
        tier: carrier.tier,
        type: carrier.type,
        hp: carrier.hp,
        maxHp: carrier.maxHp,
        kind: "plane",
        planeType: ctx.planeTypesById.get(planeId * 16) ?? null,
        scripted: carrier.scripted,
        x: 0,
        y: 0,
        visible: true,
        dead: carrier.dead,
        status: null,
        belowX: 0,
        belowY: 0,
        belowVisible: false,
      };
    }
    /** Follow-menu roster grouped by allegiance: self alone, then allies,
     *  then enemies (roster order within each group). Carriers that flew
     *  ANY sortie in the replay get an extra aircraft row right below their
     *  hull row — picking it chases the airborne squadron when one is up
     *  and the hull otherwise (see selectAircraft / followSelected's
     *  fallback chain). The row is offered at EVERY playhead: gating it on
     *  the live squadron made it flicker in and out with the sorties, and
     *  carriers spend most of a match without anything up, so the plane
     *  view was practically unfindable. */
    const cameraShipGroups = computed(() => {
      const groups: { key: string; title: string; items: ShipLabel[] }[] = [];
      const self: ShipLabel[] = [];
      const ally: ShipLabel[] = [];
      const enemy: ShipLabel[] = [];
      const t = current.value;
      for (const l of shipLabels.value) {
        if (l.kind === "plane" || !l.shipName) continue;
        if (l.role === "self") self.push(l);
        else if (l.role === "ally") ally.push(l);
        else enemy.push(l);
        // Aircraft rows are carrier-only: a battleship's catapult fighter
        // (or a hybrid typed BB) would otherwise turn every jump into a
        // plane chase. Unknown/offline ship types have no class to filter
        // on — their airborne squadron is the only carrier evidence left.
        if (!/^AirCarrier/i.test(l.type ?? "") && l.type != null) continue;
        // The row gate is "flew any sortie in this replay", not "airborne
        // right now" — picking stays safe at any playhead because the
        // camera falls back to the hull when the formation is not up.
        if (!carrierHasAnySortie(ctx.planeTrails, ctx.planeCarrierOf, l.entityId)) continue;
        // Row icon: the squadron actually being flown at the playhead when
        // one is up (picking chases it), otherwise the carrier's latest
        // launch — so the icon never degrades between sorties.
        const planeId =
          activeSquadronOf(
            ctx.planeTrails,
            ctx.planeCarrierOf,
            ctx.minimapTrailEnd,
            l.entityId,
            t,
          ) ?? latestSortiePlaneId(ctx.planeTrails, ctx.planeCarrierOf, l.entityId);
        if (planeId == null) continue;
        const row = aircraftMenuRow(l, planeId);
        if (l.role === "self") self.push(row);
        else if (l.role === "ally") ally.push(row);
        else enemy.push(row);
      }
      if (self.length > 0) {
        groups.push({ key: "self", title: i18nT("replay.camera.me"), items: self });
      }
      if (ally.length > 0) {
        groups.push({ key: "ally", title: i18nT("replay.camera.allies"), items: ally });
      }
      if (enemy.length > 0) {
        groups.push({ key: "enemy", title: i18nT("replay.camera.enemies"), items: enemy });
      }
      return groups;
    });
    /** Menu highlight id: the aircraft row only while that carrier actually
     *  has a squadron up; the hull row otherwise (the camera itself falls
     *  back to the hull when the formation disappears — the camera either
     *  falls back to the hull or holds the last aircraft pose, so the
     *  highlight must follow the hull either way). */
    const selectedMenuId = computed<number | null>(() => {
      const id = selectedEntityId.value;
      if (id == null) return null;
      if (!followAircraft.value) return id;
      const planeId = activeSquadronOf(
        ctx.planeTrails,
        ctx.planeCarrierOf,
        ctx.minimapTrailEnd,
        id,
        current.value,
      );
      return planeId == null ? id : PLANE_CARD_LABEL_ID_BASE + id;
    });
    /** Pointer-down position for click-vs-drag discrimination: a click that
     *  moved more than a few px is an OrbitControls drag, and must NOT select
     *  a ship (selecting locks the camera via followSelected — dragging would
     *  fight the lock and feel "stuck"). */
    let _downPt: { x: number; y: number } | null = null;

    // Minimap canvas. The base layer is the game's own minimap art (water +
    // land composite, extracted by `extract_minimaps.py`); positions use the
    // map's world bounds from `minimaps.json` so ship dots sit on the same
    // spots as the in-battle minimap. Without art/bounds for this map we fall
    // back to the plain dark base + trajectory-derived bounds.
    const minimapCanvas = ref<HTMLCanvasElement | null>(null);
    const zoomCanvas = ref<HTMLCanvasElement | null>(null);
    /** Nearest LIVE ship marker to a world point (tactical board path
     *  pinning): scene markers store scene coords (z = -worldZ), live means
     *  observed (past firstT) and not yet sunk. Radius in world units so the
     *  hit box scales with the map. */
    function pickShipAt(x: number, z: number): { entityId: number; label: string } | null {
      // Hit radius follows the on-screen scale (the tactical viewport), so
      // zoomed-in pinning doesn't swallow neighbouring ships.
      const view = computeTacticalBounds();
      const radiusWorld = view
        ? (Math.abs(view.maxX - view.minX) / TACTICAL_SIZE) * 22
        : 400;
      const t = current.value;
      let best: { entityId: number; label: string; d: number } | null = null;
      for (const m of ctx.shipMarkers) {
        const firstT = m.userData.firstT as number | undefined;
        if (t < (firstT ?? Infinity)) continue;
        const deathTime = m.userData.deathTime as number | null;
        if (deathTime != null && t >= deathTime) continue;
        const d = Math.hypot(m.position.x - x, m.position.z + z);
        if (d <= radiusWorld && (!best || d < best.d)) {
          const entityId = m.userData.entityId as number;
          const vehicle = props.vehicles.find((v) => v.id === entityId);
          best = {
            entityId,
            // Same scripted-NPC rule as vehicleLabelOf: never surface the
            // raw `IDS_*` text key as a pin label.
            label:
              vehicle && isScriptedUnitName(vehicle.name)
                ? vehicle.shipName ?? String(entityId)
                : vehicle?.shipName ?? vehicle?.name ?? String(entityId),
            d,
          };
        }
      }
      return best ? { entityId: best.entityId, label: best.label } : null;
    }

    /** Pause + jump the battle clock to `t` and paint synchronously (markers
     *  AND the 2D map canvases). Used by the tactical board for step
     *  navigation and the offline video exporter's frame-by-frame render,
     *  which steps the clock faster than realtime without waiting on the
     *  RAF loop or the pre-flush `current` watcher. */
    function seekBattleTime(t: number): void {
      playing.value = false;
      const clamped = Math.max(0, Math.min(duration.value || t, t));
      current.value = clamped;
      hudCurrent.value = clamped;
      // A seek teleports the followed ship many units in one step — drop any
      // pending dolly flag so the next stamped frame can't adopt the radius
      // against the teleported position as if it were wheel zoom.
      dollySeen = false;
      updateMarkersAt(ctx, clamped);
      drawMinimap(ctx, {
      // The 主控 gold edge belongs to the followed carrier's active
      // squadron (followAircraft is the intent; the carrier is the selection).
      followedCarrierId: followAircraft.value ? selectedEntityId.value ?? null : null,
    });
    }

    /** Effective view window for the tactical layer (null before bounds). */
    function computeTacticalBounds(): MapBounds | null {
      const full = computeFullMapBounds(ctx);
      return full ? computeViewBounds(ctx, full) : null;
    }

    /** Step the minimap view tween; returns true while one is running (the
     *  render loop's idle gate keeps repainting until it lands). */
    function advanceMmViewTween(): boolean {
      const tw = mmViewTween;
      if (!tw) return false;
      const p = Math.min(1, (performance.now() - tw.startedAt) / tw.durMs);
      if (p >= 1) {
        // Land exactly on the captured view (no 1-ulp float drift).
        mmView.value = { ...tw.to };
        mmViewTween = null;
        return false;
      }
      const e = 1 - Math.pow(1 - p, 3); // ease-out cubic
      mmView.value = {
        cx: tw.from.cx + (tw.to.cx - tw.from.cx) * e,
        cz: tw.from.cz + (tw.to.cz - tw.from.cz) * e,
        scale: tw.from.scale + (tw.to.scale - tw.from.scale) * e,
      };
      return true;
    }

    /** Viewport handle handed to the tactical board (pan/zoom/wheel/tweens). */
    const viewApi = {
      snapshot(): TacticalView {
        const full = computeFullMapBounds(ctx);
        const v = computeViewBounds(ctx, full ?? { minX: 0, maxX: 1, minZ: 0, maxZ: 1 });
        return { cx: (v.minX + v.maxX) / 2, cz: (v.minZ + v.maxZ) / 2, scale: mmView.value.scale };
      },
      zoomAt(lx: number, ly: number, factor: number): void {
        mmViewTween = null;
        const full = computeFullMapBounds(ctx);
        if (!full) return;
        const vb = computeViewBounds(ctx, full);
        // Resync the RAW center to the effective clamped one first — the
        // anchor math below must not carry drift from before a reset or
        // from over-pans that the clamp absorbed.
        mmView.value = {
          cx: (vb.minX + vb.maxX) / 2,
          cz: (vb.minZ + vb.maxZ) / 2,
          scale: mmView.value.scale,
        };
        const wx = vb.minX + (lx / TACTICAL_SIZE) * (vb.maxX - vb.minX);
        const wz = vb.maxZ - (ly / TACTICAL_SIZE) * (vb.maxZ - vb.minZ);
        const s0 = mmView.value.scale;
        const s1 = Math.min(TACTICAL_MAX_SCALE, Math.max(1, s0 * factor));
        if (s1 === s0) return;
        // Keep the world point under the cursor at the same logical px:
        // the window shrinks around the cursor, so the center moves toward
        // it by the zoom ratio.
        mmView.value = {
          scale: s1,
          cx: wx - (wx - mmView.value.cx) * (s0 / s1),
          cz: wz - (wz - mmView.value.cz) * (s0 / s1),
        };
      },
      panByLogical(dxL: number, dyL: number): void {
        mmViewTween = null;
        const full = computeFullMapBounds(ctx);
        if (!full) return;
        const vb = computeViewBounds(ctx, full);
        // Same raw→effective resync as zoomAt (prevents clamp dead zones).
        mmView.value = {
          cx: (vb.minX + vb.maxX) / 2,
          cz: (vb.minZ + vb.maxZ) / 2,
          scale: mmView.value.scale,
        };
        const wxPerL = (vb.maxX - vb.minX) / TACTICAL_SIZE;
        const wzPerL = (vb.maxZ - vb.minZ) / TACTICAL_SIZE;
        mmView.value = {
          ...mmView.value,
          cx: mmView.value.cx - dxL * wxPerL,
          cz: mmView.value.cz + dyL * wzPerL,
        };
      },
      reset(): void {
        mmViewTween = null;
        mmView.value = { cx: 0, cz: 0, scale: 1 };
      },
      /** Eased camera move to a captured view (presentation "运镜"). */
      tweenTo(target: TacticalView, durMs = 450): void {
        const cur = viewApi.snapshot();
        mmViewTween = {
          from: cur,
          to: {
            cx: target.cx,
            cz: target.cz,
            scale: Math.min(TACTICAL_MAX_SCALE, Math.max(1, target.scale)),
          },
          startedAt: performance.now(),
          durMs: Math.max(60, durMs),
        };
      },
    };

    // Live theme switch: recolour the water planes already in the scene
    // (scene background + grid are handled inside useThreeScene) — through
    // the SHARED stageTheme source like every other 3D stage. Disposed in
    // the teardown below (this handle is not a Vue watcher).
    const stopWaterThemeWatch = watchStageThemeMode(
      () => reapplyWaterTheme(ctx),
      { immediate: false },
    );

    /** Recompute the match duration + auto-fit the camera to the data bounds. */
    function recomputeBoundsAndCamera() {
      let minT = Infinity;
      let maxT = -Infinity;
      for (const t of props.trajectories) {
        for (const s of t.samples) {
          if (s.time < minT) minT = s.time;
          if (s.time > maxT) maxT = s.time;
        }
      }
      // Active battle area: ships (type 2) + capture zones (type 14) only.
      // Planes/torpedoes roam far past the battle border and would stretch
      // the view to the whole map even when the mode restricts play to a
      // small region (e.g. brawls fight inside a 600x600 border).
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      const eat = (x: number, z: number) => {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      };
      for (const t of props.trajectories) {
        if (t.kind?.entityType === 2) {
          // Sample positions AND the spawn point: ships that stay hidden
          // early (first sample minutes in) still need their opening-phase
          // ghost at the spawn inside the initial camera view.
          for (const s of t.samples) eat(s.x, -s.z);
          eat(t.kind.initialX, -t.kind.initialZ);
        } else if (t.kind?.entityType === 13 || t.kind?.entityType === 14) {
          // 13 = InteractiveZone before 14.5.0, 14 = modern.
          eat(t.kind.initialX, -t.kind.initialZ);
        }
      }
      if (Number.isFinite(minT)) {
        duration.value = Math.max(maxT - minT, 0.1);
        if (current.value > duration.value) {
          current.value = duration.value;
          hudCurrent.value = current.value;
        }
        if (Number.isFinite(minX)) {
          const mx = Math.max((maxX - minX) * 0.08, 80);
          const mz = Math.max((maxZ - minZ) * 0.08, 80);
          ctx.bounds = { minX: minX - mx, maxX: maxX + mx, minZ: minZ - mz, maxZ: maxZ + mz };
          fitCamera(ctx, ctx.bounds);
        }
      }
    }

    const capDisplay = ref<CapZoneState[]>([]);

    /** Shared scorebar state — the app's cap simulator + roster mapped onto
     *  the @wowsp/holo contract (same component the marketing site uses).
     *  Operations (行动) carry NO points victory — their win condition is
     *  the script itself — so the score digits sit out there and the bar
     *  degrades to the cap-occupation chips, which appear progressively as
     *  the scenario creates each point (unborn zones never reach the caps
     *  array). */
    const scorebarState = computed<HoloHudState>(() => {
      const caps: HoloCapZone[] = capDisplay.value.filter((c) => c.live).map((c) => ({
        letter: c.letter,
        owner: c.owner === 1 ? "ally" : c.owner === 2 ? "enemy" : "neutral",
        progress: c.progress,
        capturing: c.capturing,
        contested: c.contested,
        captureSide: c.captureTeam === 1 ? "ally" : c.captureTeam === 2 ? "enemy" : undefined,
        etaSeconds: c.etaSeconds,
        hint: c.contested
          ? `${c.letter} ${i18nT("replay.capture.contested")}`
          : c.capturing
            ? `${c.letter} ${i18nT("replay.capture.capturing", { a: c.alliesIn, b: c.enemiesIn })}`
            : c.owner === 0
              ? `${c.letter} ${i18nT("replay.capture.neutral")}`
              : c.owner === 1
                ? `${c.letter} ${i18nT("replay.capture.ally")}`
                : `${c.letter} ${i18nT("replay.capture.enemy")}`,
      }));
      const ships: HoloShip[] = [
        ...shipRows.value.allies.map((s) => ({
          x: 0, z: 0, yaw: 0, key: s.key, name: s.vehicle.name,
          role: "ally" as const, dead: s.dead, shipType: s.type ?? undefined,
          hp: s.hp, maxHp: s.maxHp,
        })),
        ...shipRows.value.enemies.map((s) => ({
          x: 0, z: 0, yaw: 0, key: s.key, name: s.vehicle.name,
          role: "enemy" as const, dead: s.dead, shipType: s.type ?? undefined,
          hp: s.hp, maxHp: s.maxHp,
        })),
      ];
      return {
        // Score digits are a domination concept — ops hide them.
        ...(props.operation
          ? {}
          : { scoreAlly: allyScore.value, scoreEnemy: enemyScore.value }),
        aliveAlly: 0, aliveEnemy: 0,
        time: hudCurrent.value,
        duration: duration.value,
        caps,
        ships,
      };
    });

    // ── Shared map internals ───────────────────────────────────────────────
    // Every pool / slot / epoch / cache holder the scene builders and the
    // per-frame painters share lives on this one explicit context object
    // (mapInternals.ts) instead of as loose setup-closure variables — the
    // extracted map modules (actorBuild / markerUpdate / minimapPainter /
    // …) receive it instead of closing over setup state.
    const ctx = createMapInternals({
      props,
      api,
      container,
      current,
      followStats,
      selectedEntityId,
      mmView,
      minimapCanvas,
      zoomCanvas,
      minimapZoom,
      minimapShowTrails,
      minimapShowGrid,
      mmRotationDeg,
      decisionReport,
      aiAnalysisOn,
      debugReport,
      showCapEta,
      capStatus,
      allyAlive,
      enemyAlive,
      allyTotal,
      enemyTotal,
      capDisplay,
      allyScore,
      enemyScore,
      feed,
      capZones,
      scoringZones,
      selfTeam,
      shipLabels,
    });
    // Aircraft start on the synthetic patrol orbit; the recorded/original
    // camera view flips this with originalView. Registered HERE (not beside
    // the originalView ref) because the callback needs ctx, and because a
    // setup-time toggle must not run a marker pass before the actors exist
    // — markerUpdate recomputes the alive counters from shipMarkers.
    ctx.planeRecordedView = originalView.value;
    // No 0x27 camera-mode stream → the segment cannot be named; the marker
    // pass infers the lens ride from proximity instead (null).
    ctx.planeLensRide =
      props.cameraModes.length > 0 ? inPlaneCameraMode.value : null;
    watch(originalView, (on) => {
      ctx.planeRecordedView = on;
      // Entering/leaving the recorded view starts from the stream's own
      // framing again (the wheel dolly is a per-view adjustment).
      recordedDolly = 0;
      endRecordedLook();
      lensHeadingSmooth = null;
      if (ctx.shipMarkers.length > 0) updateMarkersAt(ctx, current.value);
      api.value?.requestRender();
    });
    // The lens ride is only valid inside a recorded PLANE-camera segment
    // (0x27) — recompute it per playhead tick like the view flag.
    watch(inPlaneCameraMode, (on) => {
      ctx.planeLensRide = props.cameraModes.length > 0 ? on : null;
      if (ctx.shipMarkers.length > 0) updateMarkersAt(ctx, current.value);
      api.value?.requestRender();
    });
    // The component is reused across replays: switching from a replay
    // WITHOUT a 0x27 stream (tri-state null) to one that has it must not
    // leave the stale null behind until the first plane-camera segment.
    watch(
      () => props.cameraModes,
      () => {
        ctx.planeLensRide =
          props.cameraModes.length > 0 ? inPlaneCameraMode.value : null;
        if (ctx.shipMarkers.length > 0) updateMarkersAt(ctx, current.value);
        api.value?.requestRender();
      },
    );
    // ── Plane-follow pill card (HoloPlaneFollowCard, bottom-left) ──────
    /** E27 squadron-state streams (HP fractions / throttle boosts /
     *  consumable windows) for THIS replay, fetched once per path — the
     *  decoder side-command read_replay_squadron_states. Null until the
     *  load settles and permanently null on streams-less replays; the card
     *  then simply keeps its pre-E27 look (hp/boost/consumables hidden). */
    const squadronStates = ref<SquadronStateEvents | null>(null);
    watch(
      () => props.replayPath,
      async (path) => {
        if (!path) {
          squadronStates.value = null;
          ctx.squadronStates = null;
          return;
        }
        squadronStates.value = await loadSquadronStates(path);
        // The aircraft surface (markerUpdate's live flying count / HP label)
        // reads the streams off the shared context — same load, one owner.
        ctx.squadronStates = squadronStates.value;
      },
      { immediate: true },
    );
    /** Snapshot of the chased carrier's air state for the pill card; null
     *  whenever follow mode is not on a carrier AIRCRAFT (the parent then
     *  hides the card). Derived from the same trail tables followSelected
     *  answers the camera from, so the card can never disagree with what
     *  the camera actually chases. */
    const planeCardState = ref<HoloPlaneFollowState | null>(null);
    // Light gate: the hudCurrent shadow clock (10 Hz, seeks sync it) plus
    // the follow intent — NOT the per-frame `current`, which would
    // re-derive 165×/s for a seconds-resolution pill (see hudCurrent's
    // rationale). shipLabels rides along so a name resolving late after a
    // seek still lands on the card.
    watch(
      [hudCurrent, selectedEntityId, followAircraft, shipLabels, squadronStates],
      ([t, carrierId, aircraft]) => {
        if (carrierId == null || !aircraft) {
          planeCardState.value = null;
          return;
        }
        const label = shipLabels.value.find((l) => l.entityId === carrierId);
        if (!label) {
          // The roster settles a beat after a seek; hide until it does.
          planeCardState.value = null;
          return;
        }
        const planeId = activeSquadronOf(
          ctx.planeTrails,
          ctx.planeCarrierOf,
          ctx.minimapTrailEnd,
          carrierId,
          t,
        );
        if (planeId == null) {
          // No formation up at t: the card says so. While following aircraft
          // the CAMERA holds the last aircraft pose (lastAircraftHold) —
          // only the card shows the muted no-airborne line here.
          planeCardState.value = {
            carrierName: label.name,
            shipName: label.shipName,
            alive: 0,
            total: 0,
            attacking: false,
            airborne: false,
            // Follow-aircraft hold: the camera parks on the last aircraft
            // pose instead of the hull, and the card must SAY that instead of
            // the hull line.
            holding: followAircraft.value && lastAircraftHold != null,
          };
          return;
        }
        // Card strength is the authoritative E27 digit count when the
        // replay streams one — the minimap merge keeps the ANCHOR alive
        // through sparse-3D stretches while wingman trails expire on
        // their own samples, and the per-trail count would then read
        // "1/N" exactly while the squadron flies (see chaseStrength).
        const strength =
          chaseStrength(
            ctx.planeTrails,
            ctx.planeFormations,
            squadronStates.value?.planesHealth,
            ctx.minimapTrailEnd,
            planeId,
            t,
          ) ?? {
            alive: 0,
            total: 0,
          };
        // SCOUT / CONSUMABLE-FIGHTER squadrons are not attack wings: away from
        // the chase they carry no plaque (their EFFECT — spotting / air cover
        // — belongs to the hull label's status row, the same place a
        // repair-party window shows). While the camera IS riding the aircraft
        // the user explicitly asked for that wing's readout, so the chase
        // keeps its card whatever the airframe family (2026-11-12 review: a
        // followed fighter wing showed NO plane HP anywhere, and the 45% of
        // airframes in these two families hit the same hole).
        const family = ctx.planeTypesById.get(planeId * 16) ?? "attack";
        if (!chaseCardVisible(family, followAircraft.value)) {
          planeCardState.value = null;
          return;
        }
        // A deactivated squadron (recalled / wiped / out of fuel) keeps no
        // health readout — the strength still on the trails after that
        // point is a landing count, not combat state (user request). The
        // reason byte is unnamed, so the UI states the fact, not the cause.
        const recalled = lastSquadronEventAt(
          squadronStates.value?.deactivations,
          planeId,
          t,
        );
        planeCardState.value = {
          carrierName: label.name,
          shipName: label.shipName,
          alive: strength.alive,
          total: strength.total,
          attacking: squadronAttacking(squadronSamplesAt(ctx.planeTrails, planeId, t)),
          airborne: true,
          combat: recalled == null,
          // E27 live readouts off the decoded state streams: total-HP
          // fraction, engine-boost flag, open consumable windows. Absent
          // streams (older replay / load failure) leave them undefined and
          // the card degrades to the strength-only look.
          ...(squadronStates.value
            ? planeCardExtras(squadronStates.value, planeId, t)
            : {}),
        };
      },
      { immediate: true },
    );
    // The aircraft-follow carrier id, mirrored onto the shared context: the
    // label pass reads it to drop every OTHER wing's floating card while the
    // camera rides one formation (user request).
    watch(
      [followAircraft, selectedEntityId],
      ([aircraft, id]) => {
        ctx.followAircraftId = aircraft && id != null ? id : null;
      },
      { immediate: true },
    );
    /** Squadron panel state (bottom-left, above the hull plaque): the
     *  chased formation's per-group / per-plane HP bands plus the engine
     *  row. Derived on the same 10 Hz clock as the pill card so the two can
     *  never disagree; null whenever no attack wing is up (or the wing is
     *  a scout / consumable fighter, which carries no panel at all). */
    const squadronPanelState = ref<HoloSquadronPanelState | null>(null);
    watch(
      [hudCurrent, selectedEntityId, followAircraft, shipLabels, squadronStates],
      ([t, carrierId, aircraft]) => {
        if (carrierId == null || !aircraft) {
          squadronPanelState.value = null;
          return;
        }
        const label = shipLabels.value.find((l) => l.entityId === carrierId);
        const planeId = label
          ? activeSquadronOf(
              ctx.planeTrails,
              ctx.planeCarrierOf,
              ctx.minimapTrailEnd,
              carrierId,
              t,
            )
          : null;
        if (planeId == null || !label) {
          squadronPanelState.value = null;
          return;
        }
        // Same rule as the pill card (chaseCardVisible): the panel is the
        // chased wing's own readout, so a scout/fighter squadron keeps it
        // while it is actually being followed.
        const family = ctx.planeTypesById.get(planeId * 16) ?? "attack";
        if (!chaseCardVisible(family, followAircraft.value)) {
          squadronPanelState.value = null;
          return;
        }
        const strength =
          chaseStrength(
            ctx.planeTrails,
            ctx.planeFormations,
            squadronStates.value?.planesHealth,
            ctx.minimapTrailEnd,
            planeId,
            t,
          ) ?? { alive: 0, total: 0 };
        const formation = ctx.planeFormations.get(planeId);
        const packed = lastSquadronEventAt(
          squadronStates.value?.planesHealth,
          planeId,
          t,
        )?.packed;
        const bands = packed != null ? unpackSquadronBands(packed) : [];
        const extras = squadronStates.value
          ? planeCardExtras(squadronStates.value, planeId, t)
          : null;
        const forsage = consumableWindowFrac(
          squadronStates.value?.consumables,
          planeId,
          "healForsage",
          t,
        );
        squadronPanelState.value = {
          carrierName: label.name,
          shipName: label.shipName,
          // Fine-grained ammo/role family for the panel's type label.
          planeRole: formation?.role,
          groups: squadronSlotGroups(
            bands,
            formation?.groupSize ?? 1,
            strength.total,
          ),
          alive: strength.alive,
          total: strength.total,
          boost: extras?.boost ?? false,
          slow: extras?.slow ?? false,
          consumables: (extras?.consumables ?? []).map((sem) => {
            const rawId = unknownConsumableId(sem);
            const text = i18nT(consumableLabelKey(sem));
            return rawId == null ? text : text + " " + rawId;
          }),
          forsage: forsage == null ? null : Math.round(forsage * 20) / 20,
        };
      },
      { immediate: true },
    );

    // ── Enlarged 2D map hover tooltips ──────────────────────────────────
    // The "2D view" overlay gets a hover card for every entity on the map.
    // The picker (minimapPick.ts) mirrors the painter's projection +
    // world-frame rotation exactly; this block only snapshots the shared
    // MapInternals state into its plain-data input and owns the card's
    // cursor anchor. Positions come from the SAME shared helpers the painter
    // uses (planeSmoothPosAt / torpedoPosAt / activeWards and the identical
    // smoke dissipation math), so a marker and its tooltip can never drift.
    /** Picked entity under the cursor (null = no card). The card itself is
     *  Teleported to <body>; only the cursor anchor (client px) + the
     *  display snapshot live here. */
    const hoverTip = ref<{ x: number; y: number; target: MinimapHoverTarget } | null>(null);
    /** Last pointer position over the 2D stage (client px) — the anchor the
     *  ~5 Hz live re-pick runs from while the replay plays. */
    let hoverClientX = 0;
    let hoverClientY = 0;
    /** True between the first pointer move and pointer leave. */
    let hoverActive = false;
    /** performance.now() of the last live re-pick (5 Hz gate). */
    let hoverRefreshedAt = 0;
    const HOVER_REFRESH_MS = 200;
    /** Content signature of the card currently on screen — pointer moves that
     *  stay on the same entity (and move the cursor by less than a couple of
     *  px) only jog the card a hair, so re-rendering the whole map HUD for
     *  them would be wasted work. */
    let hoverShownSig = "";
    /** Cursor anchor written with the current card (client px). */
    let hoverShownX = Number.NaN;
    let hoverShownY = Number.NaN;
    /** Cursor travel (px) that still re-anchors an unchanged card. */
    const HOVER_MOVE_EPS_PX = 2;

    /** Drop the card (pointer left, view closed, edit mode, replay switch). */
    function hideHoverTip(): void {
      hoverActive = false;
      hoverShownSig = "";
      hoverShownX = Number.NaN;
      hoverShownY = Number.NaN;
      if (hoverTip.value !== null) hoverTip.value = null;
    }

    /** Cheap content signature: during playback a target that did not change
     *  must not re-render the card five times a second. */
    function hoverSignature(target: MinimapHoverTarget): string {
      switch (target.kind) {
        case "ship":
          return `s:${target.entityId}:${Math.round(target.hp ?? -1)}:${target.dead ? 1 : 0}:${target.unspotted ? 1 : 0}`;
        case "plane":
          // The decoded strength fields tick at the streams' cadence — key
          // the signature on them so the card re-places as 在飞/出击/血量
          // change, not only when the anchor pose or carrier moves.
          return `p:${target.planeId}:${target.role}:${target.flying ?? -1}/${target.launched ?? -1}:${target.hp != null ? Math.round(target.hp * 100) : -1}:${target.carrierLabel ?? ""}`;
        case "torpedo":
          return `t:${target.role}:${target.ownerLabel}:${Math.round(target.ageS * 10)}:${Math.round(target.remainingS)}`;
        case "smoke":
          return `m:${Math.round(target.remainingS)}`;
        case "cap":
          return `c:${target.letter}:${target.owner}:${Math.round(target.etaS ?? -1)}`;
        case "ward":
          return `w:${target.role}:${Math.round(target.radiusWorld)}:${target.ownerLabel ?? ""}`;
      }
    }

    /** Display label for an entity: the actor-built label table carries the
     *  authoritative roster join (player nickname, scripted-NPC ship name);
     *  fall back to the same vehicle label the tactical board uses. */
    function hoverLabelOf(entityId: number): string {
      const lbl = ctx.shipLabels.value.find((l) => l.entityId === entityId);
      if (lbl && lbl.name) return lbl.name;
      const entry = ctx.rosterAssignments.get(entityId) ?? null;
      return vehicleLabelOf(entry?.id ?? entityId);
    }

    /** Snapshot every hoverable entity at the current playhead through the
     *  painter's own view window (world rect + rotation). Null while the 2D
     *  view is hidden or the tactical annotation mode owns the surface. */
    function buildMinimapPickInput(): MinimapPickInput | null {
      if (!minimapZoom.value || tacticalOn.value) return null;
      const full = computeFullMapBounds(ctx);
      if (!full) return null;
      const view = computeViewBounds(ctx, full);
      if (!(view.maxX > view.minX) || !(view.maxZ > view.minZ)) return null;
      const t = current.value;
      const pickView: MinimapPickView = {
        minX: view.minX,
        maxX: view.maxX,
        minZ: view.minZ,
        maxZ: view.maxZ,
        rotationDeg: mmRotationDeg.value,
      };

      // Ships: pose from the marker the painter draws (dead ships freeze at
      // their last pose), metadata from the actor-built label table + the
      // roster join. Unobserved ships sit out exactly like the painter's
      // enemy/ghost rules (t < firstT).
      const ships: MinimapPickShip[] = [];
      // owner entity id → role, reused by the torpedo pass below (the
      // painter's own tint table).
      const roleOf = new Map<number, TeamRole>();
      for (const m of ctx.shipMarkers) {
        const role = m.userData.role as TeamRole | undefined;
        if (!role) continue;
        const entityId = m.userData.entityId as number;
        roleOf.set(entityId, role);
        const firstT = m.userData.firstT as number | undefined;
        if (t < (firstT ?? Infinity)) continue;
        const traj = ctx.trajById.get(entityId);
        const pose = traj ? sampleAt(traj, t) : undefined;
        if (!pose) continue;
        const deathTime = m.userData.deathTime as number | null;
        const dead = deathTime != null && t >= deathTime;
        // The frozen pose's anchor time is the last observed sample — an
        // enemy dark past the unseen gap is showing its last-known position.
        const unspotted = role === "enemy" && !dead && t - pose.time > UNSEEN_GAP_S;
        const entry = ctx.rosterAssignments.get(entityId) ?? null;
        const roster = entry ? rosterState.value.get(entry.id) : undefined;
        const lbl = ctx.shipLabels.value.find((l) => l.entityId === entityId);
        ships.push({
          entityId,
          role,
          x: m.position.x,
          // Scene z = -worldZ; the picker/tooltip speak world coordinates.
          z: -m.position.z,
          // The label table resolves the authoritative roster join (player
          // nickname; scripted NPCs fall back to their ship name).
          label: lbl?.name || vehicleLabelOf(entry?.id ?? entityId),
          shipName: lbl?.shipName || entry?.shipName || "",
          shipType: (m.userData.type as string | null | undefined) ?? lbl?.type ?? null,
          hp: hpAtTime(traj?.hpSamples, t) ?? lbl?.hp ?? null,
          maxHp: roster?.maxHp ?? lbl?.maxHp ?? null,
          dead,
          unspotted,
        });
      }

      // Aircraft: one candidate per FORMATION anchor trail (id % 16 === 0),
      // smoothed by the same per-trail easing state the painter advances.
      // The tooltip's 在飞/出击/血量 rows ride the DECODED E27 streams (the
      // GameParams group count is the attack-group size and misled); a
      // trail-derived fallback covers pre-E27 replays and the window
      // between the stream load settling and this snapshot.
      const states = squadronStates.value;
      const launchedOf = new Map<number, number>();
      for (const c of props.squadronCreates) {
        const n = c.numPlanes ?? c.totalNumPlanes ?? 0;
        const prev = launchedOf.get(c.planeId) ?? 0;
        if (n > prev) launchedOf.set(c.planeId, n);
      }
      const planes: MinimapPickPlane[] = [];
      const seenPlanes = new Set<number>();
      for (const trail of ctx.planeTrails) {
        if (trail.id % 16 !== 0) continue;
        const planeId = Math.floor(trail.id / 16);
        if (seenPlanes.has(planeId)) continue;
        const samples = trail.samples;
        if (samples.length === 0) continue;
        // Same visibility window as the painter: the shared plane trail
        // expiry (grace capped by the minimap remove event).
        if (t < samples[0].time || t > planeTrailExpiry(
          samples[samples.length - 1].time,
          ctx.minimapTrailEnd.get(planeId),
        )) continue;
        const pose = planeSmoothPosAt(trail.id, samples, t, ctx.planeSmoothState);
        if (!pose) continue;
        // The painter hides proven-returning wings, so the hover pick must
        // not hit them either (a tooltip over empty water names nothing).
        if (planeReturningAt(ctx, trail, t)) continue;
        seenPlanes.add(planeId);
        const labelId = ctx.planeLabelOfPlane.get(planeId);
        const carrierId = labelId != null ? ctx.planeLabelCarriers.get(labelId) : undefined;
        const strength = squadronStrength(ctx.planeTrails, planeId, ctx.minimapTrailEnd, t);
        planes.push({
          planeId,
          planeType: ctx.planeTypesById.get(trail.id) ?? "attack",
          role: (ctx.planeRoleById.get(planeId) as TeamRole | undefined) ?? "enemy",
          count: ctx.planeFormations.get(planeId)?.count ?? 0,
          launched:
            launchedOf.get(planeId) ?? strength?.total ?? null,
          flying:
            (states ? squadronFlyingAt(states.planesHealth, planeId, t) : null) ??
            strength?.alive ??
            null,
          hp: states ? squadronHpAt(states.health, planeId, t) : null,
          carrierLabel: carrierId != null ? hoverLabelOf(carrierId) : null,
          x: pose.x,
          z: pose.z,
        });
      }

      // Torpedoes: the 3D run state (base/dir/t0, already re-anchored by the
      // homing passes) projected exactly like the painter's triangles.
      const torpedoes: MinimapPickTorpedo[] = [];
      const mapRect = sceneMapRect(ctx);
      for (const tm of ctx.torpedoMeshes) {
        if (!tm.mesh.visible) continue;
        const age = t - tm.t0;
        if (age < 0 || t > tm.endT) continue;
        const scene = torpedoPosAt({ base: tm.base, dir: tm.dir }, age, mapRect);
        const ownerTraj = ctx.trajById.get(tm.ownerId);
        torpedoes.push({
          x: scene.x,
          // torpedoPosAt answers SCENE coords; the picker speaks world.
          z: -scene.z,
          ownerLabel: hoverLabelOf(tm.ownerId),
          role: roleOf.get(tm.ownerId) ?? (ownerTraj ? resolveRoleQuick(ctx, ownerTraj) : "enemy"),
          ageS: age,
          remainingS: tm.endT - t,
        });
      }

      // Smoke screens: the painter's dissipation rule (after the last puff
      // lands, the marker sinks back toward the cluster's start pose).
      const smokes: MinimapPickSmoke[] = [];
      for (const cl of ctx.smokeClusters) {
        if (t < cl.t0 || t > cl.endT) continue;
        let cur = t;
        if (t > cl.lastT) {
          const span = Math.max(1, cl.lastT - cl.t0);
          cur = cl.t0 + ((t - cl.lastT) * span) / Math.max(1, cl.endT - cl.lastT);
          if (cur > cl.lastT) cur = cl.lastT;
        }
        const pose = sampleAt(cl.traj, cur);
        if (!pose) continue;
        smokes.push({ x: pose.x, z: -pose.z, remainingS: cl.endT - t });
      }

      // Capture points: live zones only (unborn operation points sit out),
      // painted at their true world radius.
      const caps: MinimapPickCap[] = [];
      const capDisplayNow = ctx.capDisplay.value;
      ctx.capZones.value.forEach((zone, i) => {
        const state = capDisplayNow[i];
        if (state?.live === false) return;
        const ownerRaw = state?.owner ?? 0;
        caps.push({
          x: zone.kind?.initialX ?? 0,
          z: zone.kind?.initialZ ?? 0,
          letter: capLetter(zone, i),
          owner: ownerRaw === 1 ? 1 : ownerRaw === 2 ? 2 : 0,
          etaS: state?.etaSeconds ?? null,
          radiusWorld: zone.kind?.radius ?? 0,
        });
      });

      // Fighter-patrol wards: alive window from the shared helper (add → the
      // first later remove), owner role resolved like actorBuild's rings.
      const wards: MinimapPickWard[] = [];
      for (const w of activeWards(props.wards, props.wardRemoves, t)) {
        const ownerTraj =
          ctx.trajById.get(w.ownerId) ??
          props.trajectories.find((tr) => tr.entityId === w.ownerId);
        wards.push({
          x: w.x,
          z: w.z,
          role: ownerTraj ? resolveRoleQuick(ctx, ownerTraj) : "enemy",
          radiusWorld: Math.max(60, w.radius || 0),
          ownerLabel: ownerTraj ? hoverLabelOf(w.ownerId) : null,
        });
      }

      return { view: pickView, ships, planes, torpedoes, smokes, caps, wards };
    }

    /** Client px → the enlarged canvas's 760-unit logical space (null while
     *  the canvas is detached or has no layout box). */
    function minimapLogicalAt(
      clientX: number,
      clientY: number,
    ): { lx: number; ly: number } | null {
      const cvs = zoomCanvas.value;
      if (!cvs) return null;
      const rect = cvs.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return {
        lx: ((clientX - rect.left) / rect.width) * TACTICAL_SIZE,
        ly: ((clientY - rect.top) / rect.height) * TACTICAL_SIZE,
      };
    }

    /** Pick and show/hide the card for one pointer position. */
    function updateHoverTipAt(clientX: number, clientY: number): void {
      const p = minimapLogicalAt(clientX, clientY);
      if (!p || p.lx < 0 || p.ly < 0 || p.lx > TACTICAL_SIZE || p.ly > TACTICAL_SIZE) {
        hideHoverTip();
        return;
      }
      const input = buildMinimapPickInput();
      if (!input) {
        hideHoverTip();
        return;
      }
      const target = pickMinimapTarget(input, p.lx, p.ly);
      if (!target) {
        hideHoverTip();
        return;
      }
      // Same entity within a couple of px: the card is already there and
      // current — only nudge it when the cursor actually travelled.
      const sig = hoverSignature(target);
      if (
        sig === hoverShownSig &&
        Math.abs(clientX - hoverShownX) < HOVER_MOVE_EPS_PX &&
        Math.abs(clientY - hoverShownY) < HOVER_MOVE_EPS_PX
      ) {
        return;
      }
      hoverShownSig = sig;
      hoverShownX = clientX;
      hoverShownY = clientY;
      hoverTip.value = { x: clientX, y: clientY, target };
    }

    /** Capture-phase pointerdown listener, spread into the stage's JSX. Vue's
     *  runtime-dom supports the `.capture` event modifier spelled
     *  `onPointerdownCapture`, but @vue/runtime-dom's JSX attribute types
     *  omit the modifier variants — the spread keeps the listener typed
     *  without an `as any`. Capture phase is required because the tactical
     *  board's canvas stops pointerdown propagation (a bubble listener on the
     *  stage would never see it). */
    const hoverStageCapture = { onPointerdownCapture: hideHoverTip };

    /** Pointer move over the 2D stage. The event bubbles up from the
     *  tactical board's own canvas; a held button means pan/draw, not hover. */
    function onMinimapStagePointerMove(e: PointerEvent): void {
      if (!minimapZoom.value || tacticalOn.value) return;
      if (e.buttons !== 0) {
        hideHoverTip();
        return;
      }
      hoverClientX = e.clientX;
      hoverClientY = e.clientY;
      hoverActive = true;
      updateHoverTipAt(e.clientX, e.clientY);
    }

    /** ~5 Hz live re-pick while the replay plays under a stationary cursor:
     *  a moving torpedo / plane / smoke cluster keeps its card numbers
     *  current. Called from the minimap redraw block (16 Hz canvas cadence). */
    function refreshMinimapHoverTip(): void {
      if (!playing.value || !hoverActive || hoverTip.value === null) return;
      const now = performance.now();
      if (now - hoverRefreshedAt < HOVER_REFRESH_MS) return;
      hoverRefreshedAt = now;
      const input = buildMinimapPickInput();
      if (!input) {
        hideHoverTip();
        return;
      }
      const p = minimapLogicalAt(hoverClientX, hoverClientY);
      if (!p) return;
      const target = pickMinimapTarget(input, p.lx, p.ly);
      if (!target) {
        hideHoverTip();
        return;
      }
      // Same entity and same numbers → leave the card (and its DOM) alone.
      const sig = hoverSignature(target);
      if (sig === hoverSignature(hoverTip.value.target)) return;
      hoverShownSig = sig;
      hoverShownX = hoverClientX;
      hoverShownY = hoverClientY;
      hoverTip.value = { x: hoverClientX, y: hoverClientY, target };
    }

    // The card belongs to the enlarged 2D view: hide it when that view
    // closes or the tactical annotation mode takes the surface over.
    watch([minimapZoom, tacticalOn], () => {
      hideHoverTip();
    });

    // Combat-range indicators: the recorder's stock ranges resolve once the
    // roster lands (self shipId) and rebuild with the actors; the 3D ring
    // pool follows the playhead via updateMarkersAt. The prefs singleton is
    // persisted on change and re-applied live (visibility only — geometry
    // never depends on the toggles).
    const rangeMenuOpen = ref(false);
    const selfRingsView = ref<RangeRingDef[]>([]);
    armRangeRingPrefsPersist();
    /** The replay's client branch: the host's rail identity first, the
     *  container extension as the fallback, WG when nothing identifies it. */
    const dataBranch = computed<ShipDataBranch>(() => {
      if (props.branch === "wg" || props.branch === "lesta") return props.branch;
      return branchOfReplay(props.replayPath);
    });
    watch(shipLabels, () => {
      const self = shipLabels.value.find((l) => l.role === "self");
      ctx.selfRings = resolveSelfRings(self?.shipId, dataBranch.value);
      selfRingsView.value = ctx.selfRings;
      buildRangeRings(ctx, ctx.selfRings);
      updateRangeRings(ctx, current.value);
      api.value?.requestRender();
    });
    watch(rangeRingPrefs, () => {
      updateRangeRings(ctx, current.value);
      api.value?.requestRender();
    }, { deep: true });

    /** Weather restriction at the playhead — the top-right badge snapshot
     *  (null while the sky is clear with nothing announced). */
    const weatherView = computed<WeatherView | null>(() =>
      weatherStateAt(props.weatherTransitions, props.weatherNotifications, hudCurrent.value),
    );

    // ── score panel data (E18) ───────────────────────────────────────────
    /** A fresh debug report lands asynchronously (cold calls take seconds):
     *  while paused no playhead watcher will re-run the marker sync, so the
     *  3D arrows are re-synced + repainted right here. */
    watch(debugReport, (r) => {
      if (!r) return;
      syncMoveAdvisories(ctx);
      api.value?.requestRender();
    });
    /** Layer off (button, panel close, replay switch, capability disarm):
     *  collapse the 3D arrow pool in place + repaint once. */
    watch(aiAnalysisOn, (on) => {
      if (on) return;
      syncMoveAdvisories(ctx);
      api.value?.requestRender();
    });
    /** First-person camera: keep the selected target centered, camera
     *  trailing behind it along its heading. Called every render frame. The
     *  target is the hull marker, or in aircraft mode the carrier's current
     *  squadron — both resolve into one position + yaw for the chase solver.
     *
     *  The marker's model points along local +Z and carries rotation.y =
     *  PI - yaw, so its world forward is (sin(yaw), 0, -cos(yaw)) in
     *  three.js space (north = -Z). The camera sits behind that: minus the
     *  forward vector. */
    const _followPos = new THREE.Vector3();
    function followSelected() {
      const id = selectedEntityId.value;
      if (id == null) return;
      const ctrl = api.value?.controls;
      const cam = api.value?.camera;
      if (!ctrl || !cam) return;
      // Aircraft target: chase the carrier's current squadron formation.
      // Fallback chain: rendered GLB centroid → Points cloud slot (the
      // synthetic patrol centre the dots are drawn at, with its tangent
      // heading) → recorded anchor sample (model pack missing / still
      // loading) → carrier hull (its last recorded pose when the marker is
      // hidden or the hull is sunk).
      let aircraft: { x: number; y: number; z: number; yaw: number } | null = null;
      if (followAircraft.value) {
        const planeId = activeSquadronOf(
          ctx.planeTrails,
          ctx.planeCarrierOf,
          ctx.minimapTrailEnd,
          id,
          current.value,
        );
        if (planeId != null) {
          const pool = ctx.planeMeshes.get(planeId);
          aircraft = formationFollowPose(pool);
          if (aircraft == null && pool == null) {
            // Points fallback: the dots are drawn at the synthetic patrol
            // center (markerUpdate), not at the recorded anchor sample — use
            // that exact slot so the chase camera follows what is on screen.
            const slot = ctx.planeCloudSlots.get(planeId);
            const cloudAttr = ctx.planeCloud?.geometry.getAttribute("position");
            if (slot != null && cloudAttr && slot < cloudAttr.count) {
              const y = cloudAttr.getY(slot);
              // Parked slots sink below the seabed; keep the anchor fallback
              // for those instead of following a place no camera can see.
              if (y > -1000) {
                // Heading = the patrol-circle tangent the dots actually move
                // along (markerUpdate.ts's formation orbit, R=50,
                // ang = t*0.22 + planeId-seed): a dot cloud has no per-plane
                // heading of its own, and the recorded anchor yaw would point
                // the chase camera sideways against the visible motion.
                const ang = current.value * 0.22 + (planeId % 7) * 0.9;
                aircraft = {
                  x: cloudAttr.getX(slot),
                  y,
                  z: cloudAttr.getZ(slot),
                  yaw: Math.atan2(-Math.sin(ang), Math.cos(ang)),
                };
              }
            }
          }
          if (aircraft == null) {
            aircraft = anchorFollowPose(ctx.planeTrails, planeId, current.value);
          }
        }
      }
      let pos: THREE.Vector3;
      let yaw: number;
      if (aircraft) {
        // Remember the pose so a dead/recalled sortie can HOLD the view
        // (see the hold branch below).
        lastAircraftHold = aircraft;
        _followPos.set(aircraft.x, aircraft.y, aircraft.z);
        pos = _followPos;
        yaw = aircraft.yaw;
      } else if (followAircraft.value && lastAircraftHold) {
        // Squadron returned home / wiped out: HOLD the camera on the last
        // known aircraft pose instead of snapping back to the carrier hull —
        // the view returns to a launch only when the carrier puts the next
        // sortie in the air (activeSquadronOf resumes above; user request).
        _followPos.set(lastAircraftHold.x, lastAircraftHold.y, lastAircraftHold.z);
        pos = _followPos;
        yaw = lastAircraftHold.yaw;
      } else {
        const marker = ctx.shipMarkers.find((m) => m.userData.entityId === id);
        if (marker && marker.visible) {
          pos = marker.position;
          // Markers carry three.js rotation.y = π − yaw and the real heading
          // in userData.yaw (markerUpdate). The chase solver wants the REAL
          // yaw — feeding it rotation.y parks the camera in front of the hull.
          const storedYaw = marker.userData.yaw;
          yaw = typeof storedYaw === "number" ? storedYaw : Math.PI - marker.rotation.y;
        } else {
          // Sunk/unobserved hull with no aircraft up (an AI jump onto a dead
          // carrier): the marker is hidden, but the trajectory still has the
          // last recorded pose — follow that instead of freezing the camera.
          const traj = ctx.trajById.get(id);
          const idx = traj ? samplesUpTo(traj.samples, current.value) - 1 : -1;
          const sample = traj && idx >= 0 ? traj.samples[idx] : undefined;
          if (!sample) return;
          // Planar hull sample (y ≈ 0): scene z is mirrored.
          _followPos.set(sample.x, sample.y, -sample.z);
          pos = _followPos;
          yaw = sample.yaw;
        }
      }
      // RMB orbits in follow mode (the hold-to-free-look gesture); the mode
      // watcher restores the stock pan mapping when follow is left. Applied
      // per-frame so a mode flip before scene readiness still lands.
      ctrl.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
      // Swap the map's orbit radius clamp for the chase range so the wheel
      // (and pinch) dolly stays live while following; the map bounds come
      // back when the mode watcher leaves follow. Re-capture when anything
      // else clobbered them meanwhile (a replay switch re-fits the camera —
      // restoring the old map's range would mis-size the new one's).
      if (
        !followStockDist ||
        ctrl.minDistance !== FOLLOW_DIST_MIN ||
        ctrl.maxDistance !== FOLLOW_DIST_MAX
      ) {
        followStockDist = { min: ctrl.minDistance, max: ctrl.maxDistance };
      }
      ctrl.minDistance = FOLLOW_DIST_MIN;
      ctrl.maxDistance = FOLLOW_DIST_MAX;
      // Adopt wheel/pinch dolly once per flag: the radius right after a
      // dolly carries at most one frame of the target's own motion (a few
      // units even at 8× playback — invisible against a ≥5% wheel notch).
      // Every other frame keeps the remembered distance, so the chase zoom
      // can never ride the target's wake.
      if (dollySeen) {
        dollySeen = false;
        // A wheel/pinch zoom is the user's own framing: it supersedes a
        // pending AI/aircraft preset (the helper keeps the kind memory).
        followFraming = followFramingZoomed(
          followFraming,
          cam.position.distanceTo(pos),
        );
      }
      // Held-RMB free look: keep the orbit pivot glued to the (moving) target
      // and hand the camera pose to OrbitControls until the button releases.
      // No extra controls.update() here — the tick loop already runs one per
      // frame, and doubling it would decay the damping inertia twice as fast.
      if (freeLook.value) {
        ctrl.target.copy(pos);
        return;
      }
      // Damped chase: ease the pivot + yaw toward the raw pose (frame-rate-
      // independent α, keyed on the playhead — see smoothChasePose). The raw
      // aircraft pose steps between squadron update packets and the direct
      // stamp made every plane chase jitter; only the pivot and yaw are
      // smoothed — the zoom distance below stays the user's own. Scrubs,
      // seeks and target picks snap (dt <= 0 / big jumps / a null state).
      // The free-look path above stays unsmoothed: it glues the pivot to the
      // raw pose by contract.
      const smoothed = smoothChasePose(
        chaseSmooth,
        { x: pos.x, y: pos.y, z: pos.z, yaw },
        current.value,
      );
      chaseSmooth = smoothed.state;
      // Re-seat the scratch on the smoothed pose: the dolly readback above
      // already measured the raw radius, and `pos` is either _followPos or
      // the live marker position (which must never be written to).
      _followPos.set(smoothed.x, smoothed.y, smoothed.z);
      // Chase pose at the current distance (the solver bakes the stock
      // 22-up-per-55-back pitch into the axis, so zooming never flattens
      // onto the horizon); the pivot stays glued to the target.
      // Aircraft targets use the steeper rise so the camera always looks DOWN
      // at the formation instead of up at the sky (对天望 fix).
      applyFollowPose(
        cam,
        _followPos,
        smoothed.yaw,
        followFraming.dist,
        followAircraft.value ? PLANE_CHASE_RISE_RATIO : undefined,
      );
      ctrl.target.copy(_followPos);
    }

    /** Replay the recorder's original camera when the original-view toggle is
     *  on: pick the camera frame at the playhead, apply pose + fov, and
     *  disable OrbitControls so the user can't fight the replay. */
    function applyOriginalCamera(t: number) {
      const cam = api.value?.camera;
      const ctrl = api.value?.controls;
      if (!cam || !ctrl) return;
      if (props.cameraFrames.length === 0) {
        originalView.value = false;
        ctrl.enabled = true;
        return;
      }
      ctrl.enabled = false;
      // Interpolated pose (recordedCameraAt): the decoded 0x25 stream is
      // ~10 samples/s while the map renders at display rate, so applying
      // the raw last sample stuttered the whole view — and read as
      // twitching whenever the followed aircraft rolled. Position/fov
      // lerp, rotation slerps; before the FIRST frame this clamps to
      // frame 0 (a pre-start playhead used to jump to the end-of-match
      // pose), and past the end it clamps to the final frame.
      let pose = cameraPoseAt(props.cameraFrames, t);
      if (pose) {
        // Inside a recorded PLANE-camera segment the view is locked to the
        // aircraft's own heading (markerUpdate publishes it): the recorder's
        // camera could be looking sideways, so it did not reliably face where
        // the squadron was flying (user report). Pitch/roll stay recorded.
        if (ctx.planeLensActive && ctx.planeLensHeading != null) {
          // The published heading steps at the marker cadence (and jumps
          // wholesale when the picked formation changes) — easing it here
          // per frame keeps the camera from twitching on every step
          // (user report: 偶发抽搐). Shortest-arc approach each frame.
          if (lensHeadingSmooth == null) lensHeadingSmooth = ctx.planeLensHeading;
          else {
            let d = ctx.planeLensHeading - lensHeadingSmooth;
            d = Math.atan2(Math.sin(d), Math.cos(d));
            // A wholesale jump (picked-formation handover, up to 180°) must
            // snap, not swing: the wedge is already placed on the raw heading,
            // so easing a large delta would leave the formation off-axis for
            // ~0.3 s. Marker-cadence twitch deltas are a few degrees.
            lensHeadingSmooth += Math.abs(d) > 0.6 ? d : d * 0.18;
          }
          pose = alignPoseHeading(pose, lensHeadingSmooth);
        } else {
          lensHeadingSmooth = null;
        }
        // Plane view looks DOWN at the squadron (the raised seat alone left
        // the formation hugging the bottom edge). The lens placement stays
        // LEVEL, so the wedge keeps its recorded altitude and lands a few
        // degrees below the tilted view axis instead of at the top edge.
        if (ctx.planeLensActive) {
          pose = withLookOffset(pose, 0, PLANE_VIEW_PITCH);
        }
        // Held-RMB free look on top; releasing snaps back to the recorded pose.
        if (recordedLookYaw || recordedLookPitch) {
          pose = withLookOffset(pose, recordedLookYaw, recordedLookPitch);
        }
        applyRecordedCamera(cam, pose, recordedDolly);
        // The recorded plane camera sometimes flies INTO the terrain, and the
        // user wants the aircraft view to look DOWN at the squadron. Keep at
        // least PLANE_VIEW_ABOVE above the formation (and clear of the sea) —
        // the pose's orientation is unchanged, so the view still faces the
        // aircraft's heading, only from a higher seat.
        if (ctx.planeLensActive && ctx.planeLensY != null) {
          const minY = ctx.planeLensY + PLANE_VIEW_ABOVE;
          // Ease toward the floor instead of snapping: a hard clamp twitched
          // every time the recorded altitude crossed the threshold. The
          // sea-level part stays HARD — the original complaint was the camera
          // under the terrain, and a dive must never sit underwater while the
          // ease converges.
          const floor = Math.max(minY, 8);
          const eased = cam.position.y + (minY - cam.position.y) * 0.25;
          cam.position.y = Math.max(eased, Math.min(cam.position.y, floor), 8);
        } else {
          lensHeadingSmooth = null;
        }
      }
    }

    /** Shared follow-target switch used by marker clicks, the camera menu
     *  and the AI report's programmatic focus. `aircraft` chases the
     *  carrier's squadron instead of its hull; `distance` overrides the
     *  remembered chase range (the AI jump's wide framing). Clicking empty
     *  space (null) clears the selection and returns to free orbit. */
    function applyFollowTarget(
      entityId: number | null,
      opts: { aircraft?: boolean; distance?: number } = {},
    ) {
      const prevId = selectedEntityId.value;
      const prevAircraft = followAircraft.value;
      selectedEntityId.value = entityId;
      followAircraft.value = entityId != null && opts.aircraft === true;
      // Clicking a target switches to chase mode; clicking empty space
      // returns to the free orbit camera.
      cameraMode.value = entityId != null ? "follow" : "free";
      if (entityId != null) {
        followFraming = followFramingFor(
          followFraming,
          followAircraft.value ? "aircraft" : "ship",
          opts.distance,
        );
        dollySeen = false;
      } else {
        // Clearing the target must not leave an AI/aircraft preset behind for
        // the next manual pick.
        followFraming = followFramingCleared(followFraming);
      }
      // A different target (or a hull↔aircraft intent flip on the same hull)
      // teleports the chase pivot: drop the smoother so the first stamped
      // frame of the new chase lands on the raw pose instead of gliding
      // across the map from the old one.
      if (entityId !== prevId || followAircraft.value !== prevAircraft) {
        chaseSmooth = null;
        // A stale hold from the PREVIOUS target must never satisfy this
        // target's hold branch (carrier A's last pose parking carrier B's
        // camera) — the hold is per-carrier by construction.
        lastAircraftHold = null;
      }
      // Following a real target hands RMB to the free-look orbit (the
      // per-frame assignment in followSelected re-asserts it; this covers the
      // first frames before that runs).
      const ctrl = api.value?.controls;
      if (ctrl) ctrl.mouseButtons.RIGHT = entityId != null ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    }

    /** Select a ship by clicking either its 3D marker or its label. Labels
     *  have pointer-events: none (so they can't break OrbitControls drag), so
     *  clicks reach the canvas and pick the nearest visible marker. */
    function selectShip(entityId: number | null) {
      applyFollowTarget(entityId);
    }

    /** Chase a carrier's currently airborne squadron (camera-menu air row). */
    function selectAircraft(carrierId: number) {
      // No explicit distance: the hull→aircraft kind switch already starts at
      // PLANE_FOLLOW_DIST_DEFAULT, and repeated aircraft picks keep the user's
      // wheel zoom instead of resetting it every time.
      applyFollowTarget(carrierId, { aircraft: true });
    }

    /** Camera-menu pick: aircraft rows carry the PLANE_CARD_LABEL_ID_BASE
     *  namespace; everything else is a ship entity id. */
    function pickCameraTarget(id: number) {
      if (id >= PLANE_CARD_LABEL_ID_BASE) selectAircraft(id - PLANE_CARD_LABEL_ID_BASE);
      else selectShip(id);
    }

    /** Ship type for an entity: the rebuilt label first, then the roster +
     *  encyclopedia join (a focus can arrive while the labels are still
     *  settling after a seek). */
    function shipTypeOf(entityId: number): string | null {
      const label = shipLabels.value.find((l) => l.entityId === entityId);
      if (label?.type) return label.type;
      const vehicle = props.vehicles.find((v) => v.id === entityId);
      return (vehicle ? props.encyclopedia.get(vehicle.shipId)?.type : null) ?? null;
    }
    /** External camera focus (the AI report's keyframe jump): put the chase
     *  camera on one ship, preferring its airborne squadron when the analyzed
     *  perspective is an aircraft carrier, and start from the wide AI framing
     *  so the jump lands on readable context instead of a hull close-up.
     *  Null returns to the free orbit. */
    function focusEntity(entityId: number | null, options: HoloFocusOptions = {}): void {
      // Match the clock seekBattleTime will actually land on: a keyframe past
      // the decoded horizon clamps there, and the aircraft decision must use
      // the same second the camera will show.
      const requested = options.time ?? current.value;
      const t = duration.value > 0 ? Math.min(requested, duration.value) : requested;
      let aircraft = false;
      if (entityId != null && options.preferAircraft === true) {
        const type = shipTypeOf(entityId);
        const airborne = activeSquadronOf(
          ctx.planeTrails,
          ctx.planeCarrierOf,
          ctx.minimapTrailEnd,
          entityId,
          t,
        ) != null;
        // A carrier perspective is an aircraft INTENT even when no squadron
        // is observable yet (formation tables/models may still be settling
        // after the seek): followSelected resolves the actual squadron every
        // frame and falls back to the hull. Unknown ship types only qualify
        // while a squadron is really airborne, so a random untyped hull's
        // catapult fighter never hijacks the jump.
        aircraft = /^AirCarrier/i.test(type ?? "") || (type == null && airborne);
      }
      applyFollowTarget(entityId, {
        aircraft,
        distance: options.distance ?? (aircraft ? AI_FOCUS_PLANE_DIST : AI_FOCUS_SHIP_DIST),
      });
      api.value?.requestRender();
    }

    /** Canvas click → raycast the nearest visible ship marker (within a
     *  generous screen distance) or clear the selection. */
    function onCanvasClick(e: MouseEvent) {
      speedMenuOpen.value = false;
      cameraMenuOpen.value = false;
      const cam = api.value?.camera;
      const rnd = api.value?.renderer;
      const canvas = rnd?.domElement;
      if (!cam || !canvas || ctx.shipMarkers.length === 0) {
        selectShip(null);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      // Pick the marker whose world position projects nearest to the click —
      // raycasting the small marker meshes is fragile; a screen-space
      // distance test against their projected anchors is stable.
      let bestId: number | null = null;
      let bestD = Infinity;
      for (const m of ctx.shipMarkers) {
        if (!m.visible) continue;
        ctx._projVec.copy(m.position);
        ctx._projVec.project(cam);
        if (ctx._projVec.z >= 1) continue;
        const sx = (ctx._projVec.x * rect.width) / 2 + rect.width / 2;
        const sy = (-ctx._projVec.y * rect.height) / 2 + rect.height / 2;
        const d = Math.hypot(sx - e.clientX + rect.left, sy - e.clientY + rect.top);
        if (d < bestD && d < 60) {
          bestD = d;
          bestId = m.userData.entityId as number;
        }
      }
      selectShip(bestId);
    }

    // Playback clock, driven by the render tick's dt (see the onFrame
    // callback above). dt there already spans real time across the loop's
    // 60 fps cap, and the render loop pauses with the page — the clamp
    // keeps a tab-hidden span from fast-forwarding the match on return.
    const MAX_PLAYBACK_TICK_SECONDS = 0.5;
    /** Shadow-clock cadence for the HUD derivations (see hudCurrent). */
    const HUD_TICK_S = 0.1;
    let hudAccum = 0;
    function advancePlayback(dt: number) {
      if (!playing.value) return;
      const step = Math.min(dt, MAX_PLAYBACK_TICK_SECONDS);
      current.value += step * playbackSpeed.value; // playback multiplier (0.5–10×)
      // 10 Hz shadow clock for the heavy HUD computeds (see hudCurrent).
      hudAccum += step;
      if (hudAccum >= HUD_TICK_S) {
        hudAccum = 0;
        hudCurrent.value = current.value;
      }
      if (current.value >= duration.value) {
        current.value = duration.value;
        playing.value = false;
        hudCurrent.value = current.value;
      }
    }
    function togglePlay() {
      playing.value = !playing.value;
      if (playing.value && current.value >= duration.value) {
        current.value = 0;
        hudCurrent.value = 0;
      }
      api.value?.requestRender();
    }

    // Reset playback when switching replays.
    watch(
      () => props.replayPath,
      () => {
        // Roster stats belong to ONE replay — drop them so the next open
        // re-arms the batch (and stale in-flight answers are gated out).
        nameStatsLoadedFor = "";
        nameStats.value = new Map();
        // The follow menu's per-entity career blurbs belong to ONE replay
        // too — entity ids repeat across replays, so a same-realm switch
        // would otherwise serve the previous replay's players' numbers
        // (the realm watch above only covers the realm-change subset).
        statsSeq += 1;
        followStats.value = new Map();
        tipVehicleId.value = null;
        tipAnchorEl.value = null;
        tipIconHover.value = false;
        tipCardHover.value = false;
        if (tipHideTimer != null) {
          window.clearTimeout(tipHideTimer);
          tipHideTimer = null;
        }
        // A 2D-map hover describes the PREVIOUS replay's entity stream.
        hideHoverTip();
        // The chase target belongs to ONE replay too (entity ids repeat):
        // drop the follow, the aircraft intent and any one-shot framing
        // instead of carrying a stale target into the next battle.
        selectedEntityId.value = null;
        followAircraft.value = false;
        lastAircraftHold = null;
        followFraming = followFramingCleared(followFraming);
        // A new replay is a new world — the damped pivot must not glide
        // from the previous battle's last pose onto this one's.
        chaseSmooth = null;
        if (cameraMode.value === "follow") cameraMode.value = "free";
        if (ready.value) {
          current.value = 0;
          hudCurrent.value = 0;
          playing.value = false;
          duration.value = 0;
          // The enlarged 2D view belongs to ONE replay — close it on switch
          // (clearActors no longer resets it so a deep-link ?mm=1 open and
          // mid-session rebuilds keep the overlay alive).
          minimapZoom.value = false;
          mmView.value = { cx: 0, cz: 0, scale: 1 };
          mmViewTween = null;
          // Suggestions belong to the previous replay's entity stream.
          resetDecisionLayer();
          resetMoveAdviceLayer();
          clearActors(ctx);
          shipLabels.value = [];
          ctx.bounds = null;
          // The follow camera's captured orbit bounds belong to the previous
          // replay's map too: drop them so exiting follow (possibly without a
          // single stamped frame on the new map) keeps the fresh fitCamera
          // clamp instead of restoring the old capture.
          followStockDist = null;
        }
      },
    );

    // Recompute + rebuild whenever trajectories change.
    watch(
      () => props.trajectories,
      (trajs) => {
        if (trajs.length === 0) {
          current.value = 0;
          hudCurrent.value = 0;
          playing.value = false;
          return;
        }
        recomputeBoundsAndCamera();
        scheduleRebuild();
        // One-shot deep-link seek: ?t=<seconds> jumps playback on load.
        if (props.initialTime > 0 && current.value === 0) {
          current.value = Math.min(props.initialTime, duration.value);
          hudCurrent.value = current.value;
        }
      },
      { deep: false },
    );

    // Rebuild when the roster arrives/changes (team roles + shipId resolution)
    // or when the encyclopedia finishes loading (enables tier-based fallback
    // models). Both are needed because they resolve independently of the
    // trajectory stream. A replay open fires several of these watchers in
    // quick succession (trajectories + roster + encyclopedia + scene-ready)
    // and each rebuildActors disposed and re-created the whole actor set —
    // coalesce them into ONE rebuild per microtask instead.
    let rebuildScheduled = false;
    let mapTornDown = false;
    function scheduleRebuild(): void {
      if (rebuildScheduled || mapTornDown) return;
      rebuildScheduled = true;
      void Promise.resolve().then(() => {
        rebuildScheduled = false;
        if (mapTornDown || !ready.value || props.trajectories.length === 0) return;
        rebuildActors(ctx);
        updateMarkersAt(ctx, current.value);
      });
    }
    watch(
      () => props.vehicles,
      () => {
        if (ready.value) scheduleRebuild();
      },
      { deep: false },
    );
    watch(
      () => props.encyclopedia.size,
      (s) => {
        if (ready.value && s > 0) scheduleRebuild();
      },
      { immediate: true },
    );

    // Recompute markers whenever the scrubber moves. The decision layer
    // rides the same playhead path (throttled internally; covers RAF
    // playback advances and scrub seeks alike). While PAUSED every change
    // is a user seek — bypass the label-content throttle so hp/status rows
    // land on the exact frame the thumb stops on.
    watch(current, (t) => {
      if (!playing.value) ctx.labelContentAt = -Infinity;
      updateMarkersAt(ctx, t);
      maybeFetchDecisions();
      maybeFetchDebugReport();
    });

    // Keep the range input's DOM value in lockstep with the playback clock.
    // Relying on the reactive `value`/`max` props alone let the thumb drift
    // from `current` (the pill's duration grows in steps while the replay
    // streams in, and patch props only fire on vnode diffs, never on live
    // DOM drift) — at 0:00 the thumb sat visibly inside the track. Post
    // flush = after each render's own patch, so this is the final word.
    const scrubEl = ref<HTMLInputElement | null>(null);
    watch(
      [current, duration],
      () => {
        const el = scrubEl.value;
        if (!el) return;
        const max = duration.value || 0;
        const val = Math.min(current.value, max);
        if (el.max !== String(max)) el.max = String(max);
        if (el.value !== String(val)) el.value = String(val);
      },
      { flush: "post" },
    );

    // Deep link ?play=1: start playback once the trajectories are in —
    // headless render checks exercise the NATURAL playback path (the
    // render tick advancing current), not just seeks.
    if (new URLSearchParams(location.search).get("play") === "1") {
      watch(
        () => props.trajectories.length,
        (n) => {
          if (n > 0 && current.value === 0 && !playing.value) {
            playing.value = true;
          }
        },
        { immediate: true },
      );
    }

    // Once the scene is ready, build actors for any trajectories already set
    // and attempt to load the terrain model.
    watch(ready, (r) => {
      if (r) {
        ensureWaterFloor(ctx);
        loadMinimapBase(ctx);
        recomputeBoundsAndCamera();
        rebuildActors(ctx);
        updateMarkersAt(ctx, current.value);
        void tryLoadMapModel(ctx);
      }
    });

    // Reload terrain when the map changes (e.g. switching replays).
    watch(() => props.mapId, () => {
      if (ready.value) {
        loadMinimapBase(ctx);
        void tryLoadMapModel(ctx);
      }
    });

    // Resource-health context: hand the current map + roster to the session
    // diagnostic (the dev stats HUD's 资源 tab). setReplayResourceContext
    // also arms the automatic run for a view that opens with a ship-model
    // failure already logged this session, so the silent-empty-scene case
    // reports itself without anyone opening the HUD.
    watch(
      [() => props.mapId, () => props.replayPath, () => props.vehicles] as const,
      ([mapId, replayPath, vehicles]) => {
        setReplayResourceContext({
          mapId: mapId ?? "",
          replayPath: replayPath ?? "",
          ships: (vehicles ?? []).map((vehicle) => ({
            shipId: vehicle.shipId ?? null,
            name: vehicle.shipName || vehicle.name,
            fallbackName: vehicle.shipName ?? null,
          })),
        });
      },
      { immediate: true },
    );

    onBeforeUnmount(() => {
      mapTornDown = true;
      clearReplayResourceContext();
      endFreeLook();
      endRecordedLook();
      stopWaterThemeWatch();
      if (tipHideTimer != null) {
        window.clearTimeout(tipHideTimer);
        tipHideTimer = null;
      }
      clearActors(ctx);
      clearMapModel(ctx);
      ctx.osd?.dispose();
      ctx.osd = null;
      if (ctx.waterFloor) {
        api.value?.scene.remove(ctx.waterFloor);
        ctx.waterFloor.geometry.dispose();
        (ctx.waterFloor.material as THREE.Material).dispose();
        ctx.waterFloor = null;
      }
      if (ctx.seaSurface) {
        api.value?.scene.remove(ctx.seaSurface);
        ctx.seaSurface.geometry.dispose();
        (ctx.seaSurface.material as THREE.Material).dispose();
        ctx.seaSurface = null;
      }
      disposeStormZone(ctx);
      clearShipMarkerCache();
      clearPropMarkerCache();
    });

    // ── Replay playback export (video / GIF, offline fast render) ────────
    // The reference clip this feature mirrors: a chrome-less, fast-forward
    // 2D map playback wearing the game's own HUD — score/caps header,
    // team HP columns, recorder damage, chat log, per-ship labels — plus
    // the fixed WoWSP share-shot footer the share images carry. The
    // render owns the playhead for its whole run (seek per frame, restore
    // on finish). Progress rides the shell's standard toast CARD (the
    // ToastCardBase family the download passes use): the phase label, a
    // bar that is determinate only while frames advance, and the cancel
    // pill — top-right, continuous for the whole take, PRE-RENDER stages
    // included. While it runs the play/scrub controls are disabled, since
    // the render owns the playhead.
    const toast = useToast();
    const exportOpen = ref(false);
    const exporting = ref(false);
    const exportProgress = ref({ done: 0, total: 0 });
    const exportCancel = { cancelled: false };
    const exportCard = ref<ToastCardBaseInstance | null>(null);
    /** 3D hull-drain progress for the models phase (loaded/total scene
     *  markers + how many loads are still in flight); null outside it. */
    const exportModels = ref<ShipModelProgress | null>(null);
    /** Coarse phase: feed → models (3D) → frames → encoder/muxer flush →
     *  file write. The pre-render stages and the two post-render ones
     *  report no percentage (mediabunny gives none; the feed has none), so
     *  the card goes indeterminate there instead of freezing at 0% · 0/N
     *  through the feed (the 2026-11-22 report) or at 100% while a long
     *  take is muxed (the 2026-11-20 report). */
    const exportPhase = ref<ExportCardPhase>("feed");
    /** The leave-fold snapshot: when the take ends, the card folds out
     *  showing the last live values instead of snapping to empty. */
    const exportCardHeld = ref<{ meta: string; progress: number | null }>({
      meta: "",
      progress: 0,
    });
    function exportCardLive(): { meta: string; progress: number | null } {
      return exportCardReadout(exportPhase.value, exportProgress.value, exportModels.value);
    }
    watch(
      () => exporting.value,
      (run) => {
        if (run) {
          exportCard.value?.show();
          return;
        }
        exportCardHeld.value = exportCardLive();
        exportCard.value?.dismiss();
      },
      // Sync: the fold snapshot must sample the still-live counts before
      // anything resets them.
      { flush: "sync" },
    );
    /** Survives between passes (same contract as the tactical wizard's). */
    /** Replay path the export range was last seeded for (the modal's open
     *  watcher re-seeds when this changes). */
    let seedRangeForPath = "";
    const exportSettings = reactive<PlaybackExportSettings>({
      format: "video",
      // The map layer: the tactical painting (the clip's original look) by
      // default; the 上帝俯瞰 3D view is one pill away.
      view: "2d",
      // Filled in when the modal opens (playhead → end); normalized again
      // against the replay in the job.
      from: 0,
      to: 0,
      fps: 30,
      speed: 5,
      // 2K default: the map text is the whole point, and 1080's 720px map
      // square reads soft on every report so far.
      size: 1920,
      footer: true,
      // The clip's stats default follows the LIVE surface: with every stat
      // column removed (or PR off and nothing else configured) the roster
      // paints none, so the clip starts with the band off too. No dedicated
      // "show stats" pref exists in statsPrefs; the column list IS the
      // user's live preference.
      stats: rosterColumns().length > 0,
    });
    /** The shell-persisted export folder (null on hosts without the
     *  native surface — the row hides and the save dialog handles it). */
    const exportDir = ref<string | null>(null);
    async function loadExportDir(): Promise<void> {
      try {
        const cfg = await rpcApi.exportDirGet();
        exportDir.value = cfg?.dir ?? null;
      } catch {
        exportDir.value = null;
      }
    }
    watch(
      () => exportOpen.value,
      (open) => {
        if (!open) return;
        void loadExportDir();
        // Warm the medal feed in the background so starting the take does
        // not pay the composition lookup on a cold cache.
        void warmExportMedalFeed().catch(() => {});
        // Seed the range window: keep a still-valid window on THIS replay,
        // else default to [playhead, end] (the old "从现在开始" reading). The
        // seeding is tracked per replay path so switching matches never
        // inherits the previous span.
        const dur = duration.value;
        const path = props.replayPath ?? "";
        const stale =
          path !== seedRangeForPath ||
          !Number.isFinite(exportSettings.from) ||
          !Number.isFinite(exportSettings.to) ||
          exportSettings.to <= exportSettings.from ||
          exportSettings.to > dur ||
          exportSettings.from < 0;
        if (stale) {
          seedRangeForPath = path;
          exportSettings.from = Math.min(current.value, Math.max(0, dur - 1));
          exportSettings.to = dur;
        }
      },
    );
    let lastProgressTick = 0;
    /** Feed the transport strip — throttled to ~10 Hz; the bar itself is
     *  continuous, the counts don't need 30 Hz Vue renders. */
    function markExportProgress(done: number, total: number): void {
      const now = performance.now();
      if (now - lastProgressTick < 100 && done !== total) return;
      lastProgressTick = now;
      exportProgress.value = { done, total };
    }

    function cancelPlaybackExport(): void {
      exportCancel.cancelled = true;
    }
    // Leaving the map mid-render must not strand the loop against a
    // disposed scene: the token breaks it at the next frame boundary and
    // the finally below still restores the (harmless by then) playhead.
    onBeforeUnmount(() => {
      exportCancel.cancelled = true;
    });

    /** Render the LIVE three.js scene into the clip's map square for one
     *  frame — the 3D export's map layer (2D keeps paintEnlargedMap).
     *  Returns false when nothing could be rendered (no scene yet, lost
     *  context, an over-limit square); the caller then paints the 2D map so
     *  a clip is never a blank square.
     *
     *  The composer hands `g` ALREADY translated to the square's top-left
     *  and clipped to it (playbackExport.composePlaybackFrame): every paint
     *  below stays in that space — the identity transform would land the
     *  frame at the composition origin.
     *
     *  The live renderer is resized to the square's device edge, the scene
     *  renders ONCE through the fixed export camera, the WebGL canvas is
     *  copied into the frame canvas, and the renderer's EXACT pixel ratio +
     *  size are restored in a finally (cancellation and encoder failures
     *  land there too).
     *
     *  The live camera OBJECT is never mutated — the export pose is a
     *  separate PerspectiveCamera. Only the scene slot (`api.camera`, which
     *  the HUD's screen-space sizing reads) points at it for this
     *  synchronous block, and the finally points it back: the render loop
     *  holds its own camera reference, so no async frame can see the swap.
     *  Everything here must stay synchronous for that guarantee. */
    function paintExportScene3d(
      g: CanvasRenderingContext2D,
      mapSizePx: number,
      pose: ExportGodCameraPose,
      camera: THREE.PerspectiveCamera,
    ): boolean {
      const size = Math.max(2, Math.round(mapSizePx));
      g.save();
      try {
        const a = api.value;
        const scene = a?.scene;
        const renderer = a?.renderer;
        const liveCamera = a?.camera;
        g.fillStyle =
          scene?.background instanceof THREE.Color
            ? "#" + scene.background.getHexString()
            : "#0b1220";
        g.fillRect(0, 0, EXPORT_LOGICAL, EXPORT_LOGICAL);
        if (!a || !scene || !renderer || !liveCamera) return false;
        const gl = renderer.getContext();
        if (!gl || gl.isContextLost()) return false;
        // The default framebuffer is the limit for THIS render target (a
        // texture-unit limit can be the wrong ceiling); accept the smaller.
        const maxSide = Math.min(
          renderer.capabilities.maxTextureSize,
          Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) ||
            renderer.capabilities.maxTextureSize,
        );
        if (size > maxSide) return false;
        camera.position.set(pose.position.x, pose.position.y, pose.position.z);
        camera.lookAt(pose.lookAt.x, pose.lookAt.y, pose.lookAt.z);
        const prevRatio = renderer.getPixelRatio();
        const prevSize = renderer.getSize(new THREE.Vector2());
        try {
          renderer.setPixelRatio(1);
          renderer.setSize(size, size, false);
          // Screen-space HUD (cap letters, smoke timers, ring line widths)
          // is sized from the SCENE camera and the LIVE viewport height.
          // Install the export camera for this sync block, then scale the
          // sprites from the live height to the square's render height so
          // the frame does not depend on the user's window or zoom.
          a.camera = camera;
          updateOverlayScale(ctx);
          const hudK = size / Math.max(1, container.value?.clientHeight || 600);
          if (hudK !== 1) {
            for (const sprite of ctx.capLetterSprites) sprite.scale.multiplyScalar(hudK);
            for (const cluster of ctx.smokeClusters) {
              cluster.timeSprite?.scale.multiplyScalar(hudK);
            }
          }
          for (const mat of ctx.overlayLineMats) mat.resolution.set(size, size);
          renderer.render(scene, camera);
          // Same task as the render: the drawing buffer is valid until the
          // compositor takes it, so this never copies a cleared canvas.
          g.drawImage(renderer.domElement, 0, 0, EXPORT_LOGICAL, EXPORT_LOGICAL);
          return true;
        } finally {
          a.camera = liveCamera;
          // Restore the logical size first (cheap at ratio 1), then the
          // pixel ratio — setPixelRatio re-applies the final live buffer, so
          // the expensive allocation happens exactly once.
          renderer.setSize(prevSize.x, prevSize.y, false);
          renderer.setPixelRatio(prevRatio);
          // Re-tune the HUD for the live camera/viewport (the export scales
          // above must not leak into the running view).
          updateOverlayScale(ctx);
          // setSize clears the drawing buffer: repaint the LIVE camera at
          // its own size immediately, or the visible map would blank until
          // the next rAF tick (a take spans hundreds of frames). It shows
          // this frame's seek, exactly like the 2D path.
          if (!gl.isContextLost()) renderer.render(scene, liveCamera);
          api.value?.requestRender();
        }
      } finally {
        g.restore();
      }
    }

    /** Read the scene's hull state for the models phase. rebuildActors
     *  creates one marker per vessel up-front and each flips
     *  `modelLoaded` when its GLB (or a same-role pooled stand-in) is
     *  installed, so loaded/total is an honest pair. Only markers still
     *  IN FLIGHT count as pending: the ones already parked in
     *  `modelWaiters` failed (or had no candidate URL) and can only be
     *  rescued by another hull's load — waiting on them would stall every
     *  take for a user with no model pack installed. */
    function shipModelProgress(): ShipModelProgress {
      const waiting = new Set(ctx.modelWaiters.map((w) => w.marker));
      const markers = ctx.shipMarkers;
      let loaded = 0;
      let pending = 0;
      for (const marker of markers) {
        if (marker.userData.modelLoaded === true) loaded++;
        else if (!waiting.has(marker)) pending++;
      }
      return { loaded, total: markers.length, pending };
    }

    /** Wait (bounded) for the 3D take's in-flight hulls while publishing the
     *  live count to the card. Cancellation is honoured within one poll; the
     *  wait also ends when nothing has ARRIVED for a while (a failed/hung
     *  load) or at the total cap — either way the take proceeds, and a
     *  missing hull renders as the scene's own cone/stand-in, which the live
     *  3D view already does. */
    async function waitForShipModels(): Promise<void> {
      const deadline = performance.now() + EXPORT_MODEL_WAIT_MS;
      let lastLoaded = -1;
      let lastArrival = performance.now();
      for (;;) {
        const progress = shipModelProgress();
        exportModels.value = progress;
        if (exportCancel.cancelled || progress.pending === 0) return;
        const now = performance.now();
        if (progress.loaded !== lastLoaded) {
          lastLoaded = progress.loaded;
          lastArrival = now;
        }
        if (now - lastArrival >= EXPORT_MODEL_STALL_MS) return;
        if (now >= deadline) return;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, EXPORT_MODEL_POLL_MS);
        });
      }
    }
    /** The ALIVE hulls to card in the 3D take at battle time `t`: the same
     *  markers/labels the 2D label pass reads, minus every SUNK hull (the
     *  user's rule — 「阵亡的才不显示」) and every hull not observed yet (a
     *  card would announce an unspotted enemy). Ghost hulls (spotted once,
     *  dark now) keep their card at the last-known spot, exactly like the 2D
     *  pass's labels. */
    function collectExportShipCards(t: number): ShipLabelSpriteInput[] {
      const out: ShipLabelSpriteInput[] = [];
      const labels = ctx.shipLabels.value;
      for (let i = 0; i < ctx.shipMarkers.length; i++) {
        const marker = ctx.shipMarkers[i];
        const label = labels[i];
        if (!marker || !label || label.kind === "plane") continue;
        if (
          !exportShipCardVisible({
            t,
            firstT: marker.userData.firstT as number | undefined,
            deathTime: marker.userData.deathTime as number | null,
            dead: label.dead,
            hp: label.hp,
          })
        ) {
          // SUNK (or never-spotted) hull: no card at all — the sunk case is
          // the user's explicit rule (markerUpdate drops the DOM card too).
          continue;
        }
        out.push({
          entityId: label.entityId,
          x: marker.position.x,
          y: marker.position.y,
          z: marker.position.z,
          data: {
            name: label.scripted ? "" : label.name,
            clan: nameStats.value.get(label.name)?.clanTag ?? null,
            tier: tierRoman(label.tier),
            shipName: label.shipName,
            role:
              label.role === "enemy"
                ? "enemy"
                : label.role === "self"
                  ? "self"
                  : "ally",
            hp: label.hp,
            maxHp: label.maxHp,
            recoverableFrac: label.hpRecoverableFrac ?? null,
          },
        });
      }
      return out;
    }

    async function runPlaybackExportJob(): Promise<void> {
      const full = computeFullMapBounds(ctx);
      if (!full || duration.value <= 0 || exporting.value) return;
      const s = clampExportSettings(exportSettings);
      const range = normalizeExportRange(
        s.from,
        s.to,
        duration.value,
        s.format,
        s.fps,
        s.speed,
      );
      const from = range.from;
      const times = frameTimesAtSpeed(range.from, range.to, s.fps, s.speed);
      if (times.length < 2) {
        toast.info(i18nT("replay.export.toastEmpty"));
        return;
      }
      // 3D view: ONE fixed god-camera pose for the whole take, fitted to the
      // full map bounds (deterministic per replay — no orbit, no follow, no
      // recorded pose). The camera itself is a SEPARATE instance, so the
      // user's live camera/controls are never swapped or restored.
      const godPose = s.view === "3d" ? exportGodCamera(full) : null;
      const godCamera = godPose
        ? new THREE.PerspectiveCamera(
            EXPORT_GOD_FOV_DEG,
            1,
            0.1,
            // The fit distance scales with the map: keep the far plane
            // beyond it instead of trusting a fixed 20k for unknown bounds.
            Math.max(20000, godPose.distance * 4),
          )
        : null;
      // The take's in-scene label cards live on their OWN layer: only the
      // export camera ever enables it, so the live view's per-frame repaint
      // (the export's restore path) can never show them.
      godCamera?.layers.enable(EXPORT_LABEL_LAYER);
      // 3D-render bail-out notice (at most one per take): a missing scene or
      // a lost context switches the take to the 2D painting, never a blank
      // square — say so once instead of silently mixing modes.
      let export3dFallbackNoticed = false;
      // In-scene ship-label sprites (3D take only): created before the encode
      // loop and disposed in the finally below.
      let shipLabelSprites: ShipLabelSpriteLayer | null = null;
      let exportFrame = 0;
      const wasPlaying = playing.value;
      const resumeAt = current.value;
      playing.value = false;
      exportProgress.value = { done: 0, total: times.length };
      // The feed below (roster batch, medal compositions, the ledger and the
      // decoded art) is real work with no percentage. Say so on the card
      // instead of leaving it at 0% · 0/N for the whole assembly — the
      // 2026-11-22 「一直卡着不导出」 report.
      exportPhase.value = "feed";
      exportModels.value = null;
      exporting.value = true;
      exportCancel.cancelled = false;
      try {
        // The team columns (clan tags, seals, the stat cells and the header
        // averages) ride the lazily-armed roster-stats batch. AWAIT the real
        // promise — the old 5 s poll raced the batch and froze every row
        // dashed on a cold replay view (the 2026-11-21 「战绩没加载出来」
        // report); the latch made it permanent. The wait is bounded so a
        // hung provider can never strand the take before its first frame;
        // on timeout/rejection the clip keeps the honest dashes. Cancelling
        // stops the wait immediately, not just at the next frame.
        const statsOn = s.stats !== false;
        if (statsOn) {
          const settled = await awaitExportStep(
            ensureRosterStats(),
            exportCancel,
            EXPORT_STATS_WAIT_MS,
          );
          if (settled === "cancelled") return;
        }
        // Chat senders tint by roster side — the side lookup is per replay,
        // built once here (vehicles never change mid-export).
        const sideOfVehicle = new Map<number, "ally" | "enemy">();
        for (const v of rosterSides.value.allies) sideOfVehicle.set(v.id, "ally");
        for (const v of rosterSides.value.enemies) sideOfVehicle.set(v.id, "enemy");
        // Theme-following palette + the footer's bundled art resolve once,
        // before the first frame — inside the try so even a surprise throw
        // cannot strand `exporting`. The scorebar strip's HUD icons
        // preload too: the same SVG class art the DOM scorebar renders,
        // decoded once so drawImage never paints a half-decoded image.
        // The clip always renders on the DARK ramp: the theme-following
        // capture produced pale panels with unreadable text on light theme.
        const palette = darkPalette();
        const footerStrings = shareFooterStrings();
        let logo: HTMLImageElement | null = null;
        if (s.footer) logo = await loadImage(LOGO_URL);
        const shipIconMap = new Map<string, HTMLImageElement>();
        const iconVariants = ["ally", "enemy", "sunk", "sunk-enemy"] as const;
        const iconClasses = [
          "battleship",
          "cruiser",
          "destroyer",
          "aircarrier",
          "submarine",
          "auxiliary",
        ] as const;
        await Promise.all(
          iconVariants.flatMap((variant) =>
            iconClasses.map(async (cls) => {
              const url = shipIconUrl(cls, variant);
              if (!url) return;
              try {
                const img = await loadImage(url);
                if (img) shipIconMap.set(`${variant}:${cls}`, img);
              } catch {
                // A missing face just skips its slot (drawSlot's null rule).
              }
            }),
          ),
        );
        const shipIconFor = (
          shipType: string | null,
          variant: PlaybackIconVariant,
        ): HTMLImageElement | null =>
          // Unknown WG types fall back to the battleship face — the same
          // fallback the holo registry applies, so the clip never drops a
          // slot the live HUD would draw.
          shipIconMap.get(`${variant}:${shipTypeClass(shipType) || "battleship"}`) ?? null;
        // ── Team-column feed: the live roster full mode's medals ────────
        // The medal feed (compositions) warms when the export modal opens;
        // this await is then a no-op re-read of a warm cache. With the
        // stats toggle off there are no seals to grade (every seal verdict
        // is stats-derived), so the lookup is skipped entirely. The warm
        // call returns immediately when the modal's own warm-up is still in
        // flight (it is idempotent), so the cap only ever bites a COLD
        // lookup started here — a cancel stops waiting on it right away.
        if (statsOn) {
          const settled = await awaitExportStep(
            warmExportMedalFeed(),
            exportCancel,
            EXPORT_FEED_WAIT_MS,
          );
          if (settled === "cancelled") return;
        }
        // Freeze the roster feed for the take: the players, their stats,
        // medals and the header columns cannot change inside one export,
        // so they resolve ONCE here; only the HP fraction and the dead
        // flag (playhead-derived) are re-read per frame. With the stats
        // toggle OFF the whole column/aggregate pipeline is skipped — no
        // rosterColumns()/aggregateTeamStats work, no stat cells.
        const frozenRows = new Map<
          number,
          Omit<PlaybackTeamRow, "hpFrac" | "dead">
        >();
        for (const r of [...shipRows.value.allies, ...shipRows.value.enemies]) {
          frozenRows.set(r.vehicle.id, playbackRowBase(r, statsOn));
        }
        const frozenColumns = statsOn
          ? {
              allies: playbackHeaderColumns(shipRows.value.allies),
              enemies: playbackHeaderColumns(shipRows.value.enemies),
            }
          : { allies: [], enemies: [] };
        const sideOf = (
          entries: ShipRowEntry[],
          columns: readonly PlaybackTeamStatColumn[],
          t: number,
        ): PlaybackTeamSide => ({
          columns,
          // Alive first, dead last - the vertical HUD order (the icon
          // strip's dead-at-outer-edge sort reads wrong top-down).
          rows: [...entries]
            .sort((a, b) => Number(a.dead) - Number(b.dead))
            .map((r) => {
              // Repair Party's grey recoverable segment (repairPool.ts):
              // PLAYHEAD-DERIVED like hp/dead, never part of the frozen
              // per-take row base — the pool shrinks as the repair's heal
              // ticks land, so it must be re-read at every frame's t.
              // null = no repair-party activation for this hull in the
              // replay (feature off, bar unchanged); 0 = pool exhausted.
              const state = rosterState.value.get(r.vehicle.id);
              const traj = state?.traj ?? null;
              const hullMaxHp = state?.maxHp ?? r.maxHp;
              return {
                ...(frozenRows.get(r.vehicle.id) ?? playbackRowBase(r)),
                hpFrac:
                  r.hp != null && r.maxHp
                    ? Math.max(0, Math.min(1, r.hp / r.maxHp))
                    : null,
                // Only a hull with a decoded trajectory can carry a pool: a
                // roster row whose stream never resolved keeps the plain bar
                // (null), never "some other hull's" windows.
                hpRecoverableFrac:
                  r.dead || !traj
                    ? null
                    : repairRecoverableFracAt(
                        props.consumableUses,
                        traj.hpSamples,
                        hullMaxHp,
                        t,
                        traj.entityId,
                        // The hull's BAKED per-charge capacity fraction
                        // (repairPool.ts), keyed by the roster's shipParamsId
                        // — else the documented flat 0.5.
                        repairCoefficientFor(r.vehicle.shipId, hullMaxHp),
                        // The flat per-damage share (regeneratedHPPart
                        // typical): the replay has no section attribution.
                        REPAIR_PARTY_DAMAGE_SHARE,
                      ),
                dead: r.dead,
              };
            }),
        });
        // ── Header corners (the 2026-11-21 request) ─────────────────
        // LEFT: map display name · localized battle mode, then the replay's
        // real-world start time. RIGHT: the replay's total in-game duration
        // and the post-battle winner verdict. Every word is the app's own
        // (displayMapName / modeLabelOfKey / i18n); a missing source drops
        // its line rather than printing a guess.
        const rosterNames = props.vehicles.map((v) => v.name);
        const modeText = modeLabelOfKey(
          modeKey(
            props.matchGroup,
            undefined,
            undefined,
            rosterNames.filter((n) => AI_NAME.test(n)).length,
            rosterNames.filter((n) => isScriptedUnitName(n)).length,
            hasSingleTeamRoster(props.vehicles),
          ),
        );
        const mapText = displayMapName(props.mapName || props.mapId, dataLanguage.value);
        const startText = replayStampLabel(recordedStamp.value);
        // Winner: the post-battle payload's `commonList[3]` is the winning
        // SIDE (0/1) — the exact field the local battle ledger reads
        // (api/modules/localBattles.ts:33). parsePostBattle does not expose
        // commonList, so read that one field off the raw document; the
        // recorder's own side comes from their playersPublicInfo row. A
        // draw / undecodable layout answers null and the line is omitted
        // rather than guessed.
        let winnerTeam: 0 | 1 | null = null;
        try {
          const common = (
            JSON.parse(props.battleResults ?? "null") as {
              commonList?: unknown[];
            } | null
          )?.commonList;
          const w = Array.isArray(common) ? common[3] : null;
          if (w === 0 || w === 1) winnerTeam = w;
        } catch {
          // Undecodable payload — no verdict line.
        }
        const pb = pbData.value;
        const selfTeam =
          pb?.selfId != null
            ? (pb.players.find((p) => p.accountId === pb.selfId)?.team ?? null)
            : null;
        const winnerText =
          winnerTeam != null && selfTeam != null
            ? i18nT(
                winnerTeam === selfTeam
                  ? "replay.export.allyVictory"
                  : "replay.export.enemyVictory",
              )
            : null;
        const infoLines = [
          [mapText, modeText].filter((part) => part !== "").join(" · "),
          startText ?? "",
        ].filter((line) => line !== "");
        const outcomeLines = [
          `${i18nT("replay.export.duration")} ${formatBattleClock(duration.value).slice(2)}`,
          winnerText ?? "",
        ].filter((line) => line !== "");
        // ── Recorder panel feed (frozen once per take) ────────────────
        // The ribbon strip is the recorder's settlement counters — the same
        // list the post-battle report paints (parsePostBattle's RIBBON_SOURCES
        // over CLIENT_PUBLIC_RESULTS) — and the two source columns come from
        // the hit stream's per-counterparty damage attribution. Both are
        // time-invariant lookups over immutable streams, resolved ONCE here;
        // only the per-frame fold at the playhead runs inside the feed.
        const recorderPb = pbData.value;
        const recorderSelfRow =
          recorderPb?.selfId != null
            ? (recorderPb.players.find((p) => p.accountId === recorderPb.selfId) ?? null)
            : null;
        const recorderRibbons: PlaybackRecorderRibbon[] = (
          recorderSelfRow?.ribbons ?? []
        ).map((r) => ({ key: r.key, value: r.value }));
        // Counterparty names: the arena's entity→name map first (it also
        // names operation-wave NPCs), then the roster assignment join. An id
        // in neither falls back to "#<id>" (recorderSourceLabel).
        const arenaNameByEntity = new Map<number, string>();
        for (const ap of props.arenaPlayers) {
          if (ap.name) arenaNameByEntity.set(ap.entityId, ap.name);
        }
        const counterpartyName = (id: number): string | null =>
          arenaNameByEntity.get(id) ?? ctx.rosterAssignments.get(id)?.name ?? null;
        const recorderSelfEntityId = selfShotBook.value?.selfTraj.entityId ?? null;
        // Teammates: their hulls never appear under 造成伤害 (their shells
        // still dilute the claim partitions), mirroring the live ledger.
        const recorderAllyIds = props.arenaPlayers
          .filter(
            (ap) =>
              ap.entityId !== recorderSelfEntityId &&
              ap.teamId === props.arenaPlayers.find((p) => p.entityId === recorderSelfEntityId)?.teamId,
          )
          .map((ap) => ap.entityId);
        const recorderSourceHits =
          recorderSelfEntityId != null
            ? buildRecorderSourceHits({
                shotKills: props.shotKills,
                trajectories: props.trajectories,
                selfEntityId: recorderSelfEntityId,
                allyIds: recorderAllyIds,
              })
            : [];
        // The recorder panel's timestamped fold source, frozen once per take:
        // the server damage-stat updates, the kill instants credited to the
        // recorder (the shot ledger's per-event frag counts flattened to one
        // entry per kill) and the hull's HP samples. recorder(t) folds THIS
        // to each frame's playhead — never the live HUD snapshot, whose key
        // is the mutable hudCurrent shadow clock.
        const recorderKillTimes: number[] = [];
        const recorderLedger = selfShotBook.value?.ledger;
        if (recorderLedger) {
          for (let i = 0; i < recorderLedger.times.length; i++) {
            const gained =
              recorderLedger.frags[i] - (i > 0 ? recorderLedger.frags[i - 1] : 0);
            for (let k = 0; k < gained; k++) recorderKillTimes.push(recorderLedger.times[i]);
          }
        }
        const recorderTimeline: PlaybackRecorderTimeline = {
          damageStats: props.damageStats,
          killTimes: recorderKillTimes,
          hpSamples: selfShotBook.value?.selfTraj.hpSamples ?? null,
        };
        // Ribbon art: the bundled settlement icons (the post-battle shot's own
        // source), decoded once so drawImage never paints a half-decoded face.
        const ribbonIconMap = new Map<string, HTMLImageElement>();
        await Promise.all(
          recorderRibbons.map(async (r) => {
            const url = bundledRibbonUrl(r.key);
            if (!url) return;
            try {
              const img = await loadImage(url);
              if (img) ribbonIconMap.set(r.key, img);
            } catch {
              // A missing face leaves the cell's plain count (no plate).
            }
          }),
        );
        const ribbonIconFor = (key: string): HTMLImageElement | null =>
          ribbonIconMap.get(key) ?? null;
        // A cancel during the feed stops here — the encode loop never starts,
        // and the finally below still restores the playhead/card.
        if (exportCancel.cancelled) return;
        // 3D take only: the in-scene label cards for every ALIVE hull (the
        // user's rule 「阵亡的才不显示」). They read the same post-seek
        // markers/labels the 2D pass reads, so both views agree.
        if (s.view === "3d") {
          shipLabelSprites = new ShipLabelSpriteLayer(api.value?.scene ?? null);
          exportFrame = 0;
        }
        // 3D view only: the scene's hulls load lazily (rebuildActors installs
        // a placeholder cone and swaps the GLB in when it lands), so a take
        // started right after opening the map would bake cones into every
        // frame. Drain them here — bounded, and only when any are pending;
        // the encode loop starts either way (a hull that never resolves
        // renders as the scene's own stand-in, like the live view).
        const hulls = s.view === "3d" ? shipModelProgress() : null;
        if (exportPhaseAfterFeed(s.view, hulls) === "models") {
          exportPhase.value = "models";
          await waitForShipModels();
          if (exportCancel.cancelled) return;
        }
        // Frames start here; only this phase reports a percentage.
        exportPhase.value = "render";
        const result = await renderPlaybackExport({
          format: s.format,
          fps: s.fps,
          times,
          targetWidth: s.size,
          footer: s.footer,
          showStats: statsOn,
          palette,
          footerStrings,
          logo,
          panelLabels: {
            teamAlly: i18nT("replay.export.teamAlly"),
            teamEnemy: i18nT("replay.export.teamEnemy"),
            teamAvg: i18nT("replay.export.teamAvg"),
            noStats: i18nT("replay.export.noStats"),
            damage: i18nT("replay.export.damageTitle"),
            dmgFrags: i18nT("replay.export.dmgFrags"),
            dmgTaken: i18nT("replay.export.dmgTaken"),
            ribbonsTitle: i18nT("replay.export.ribbonsTitle"),
            dmgDealtSources: i18nT("replay.export.dmgDealtSources"),
            dmgTakenSources: i18nT("replay.export.dmgTakenSources"),
            chat: i18nT("replay.export.chatTitle"),
          },
          header: (t) => {
            // The app's own scorebar state (the same computed the live HUD
            // renders) read AFTER the seek — the clip's top strip is the
            // scorebar replicated, so the data path is shared verbatim.
            const sb = scorebarState.value;
            return {
              clock: formatBattleClock(t).slice(2),
              scoreAlly: sb.scoreAlly ?? null,
              scoreEnemy: sb.scoreEnemy ?? null,
              caps: sb.caps.map((c) => ({
                letter: c.letter,
                owner: c.owner,
                progress: c.progress ?? 0,
                capturing: !!c.capturing,
                contested: !!c.contested,
                captureSide: c.captureSide ?? undefined,
              })),
              ships: sb.ships.map((sh) => ({
                role: sh.role === "enemy" ? ("enemy" as const) : ("ally" as const),
                shipType: sh.shipType ?? null,
                dead: sh.dead,
                hpFrac:
                  !sh.dead && sh.hp != null && sh.maxHp
                    ? Math.max(0, Math.min(1, sh.hp / sh.maxHp))
                    : null,
              })),
              // Time-invariant corner blocks (built once above).
              infoLines,
              outcomeLines,
            };
          },
          shipIconFor,
          // Each side carries its own header columns (the team averages
          // are per side) plus the full-mode entries; the icon strip's
          // dead-at-outer-edge sort reads wrong in a vertical HUD, so the
          // rows stay put (alive first, dead last — inside the builder).
          team: (t) => {
            const rows = shipRows.value;
            return {
              allies: sideOf(rows.allies, frozenColumns.allies, t),
              enemies: sideOf(rows.enemies, frozenColumns.enemies, t),
            };
          },
          recorder: (t) => {
            // Fold the TIMESTAMPED timeline to THIS frame's playhead. The
            // headline therefore never reads a final/cumulative figure: at
            // 04:33 it is the fold at 04:33 (the strip's own semantics), not
            // the end-of-battle totals. The reactive selfStats snapshot is
            // keyed on hudCurrent — the live HUD shadow clock — so it must
            // not be the clip's source.
            const book = selfShotBook.value;
            if (!book && props.damageStats.length === 0) return null;
            const folded = foldPlaybackRecorderStats(recorderTimeline, t);
            // Dealt family: the server-exact fold when the stream carries it;
            // otherwise the shot ledger's HP-drop estimate at the same t (the
            // strip's own fallback).
            const estimate = book ? querySelfShotLedger(book.ledger, t) : null;
            const damage = props.damageStats.length
              ? folded.damage
              : (estimate?.damage ?? 0);
            return {
              damage,
              frags: folded.frags,
              taken: folded.taken,
              ribbons: recorderRibbons,
              // Cumulative per counterparty, descending, top 5 — the DISPLAY
              // clamp only (the ledger keeps every ship / attacker).
              dealTargets: foldRecorderSources(
                recorderSourceHits,
                t,
                "dealt",
                counterpartyName,
              ),
              takeSources: foldRecorderSources(
                recorderSourceHits,
                t,
                "taken",
                counterpartyName,
              ),
            };
          },
          ribbonIconFor,
          chat: (t) =>
            props.chatMessages
              // System rows (playerId <= 0) are client-ignored noise —
              // every other chat consumer drops them (ReplayView/markerUpdate).
              .filter((c) => c.time <= t && c.playerId > 0)
              .slice(-9)
              .map((c) => ({
                sender:
                  props.vehicles.find((v) => v.id === c.playerId)?.name ??
                  `#${c.playerId}`,
                side: sideOfVehicle.get(c.playerId) ?? "ally",
                text: c.message,
                time: c.time,
              })),
          paintMap: (t, g, mapSizePx) => {
            // Seek first: markers, caps, scores and the eased plane state
            // all update synchronously for this battle time. BOTH views
            // share this one seek — the 3D scene and the 2D painter read the
            // same post-seek state.
            seekBattleTime(t);
            if (godPose && godCamera) {
              // In-scene label cards: one pass per frame, from the SAME
              // post-seek data the 2D painter reads (no second clock).
              shipLabelSprites?.update(
                godCamera,
                collectExportShipCards(t),
                exportFrame++,
              );
              if (paintExportScene3d(g, mapSizePx, godPose, godCamera)) return;
              if (!export3dFallbackNoticed) {
                export3dFallbackNoticed = true;
                toast.warning(i18nT("replay.export.view3dFallback"));
              }
            }
            paintEnlargedMap(g, ctx, {
              t,
              full,
              view: full,
              logical: EXPORT_LOGICAL,
              rotation: 0,
              shipLabels: true,
              // The clip is a clean tactical view — no travelled-path
              // lines (the 2026-11-20 report).
              trails: false,
              clanOf: (name) => nameStats.value.get(name)?.clanTag ?? null,
              romanTier: tierRoman,
            });
          },
          onProgress: markExportProgress,
          onPhase: (phase) => {
            exportPhase.value = phase;
          },
          cancelToken: exportCancel,
        });
        if (!result) {
          toast.error(i18nT("replay.export.unsupported"));
        } else if (result.cancelled && result.blob.size === 0) {
          // Cancelled before anything encoded — stay quiet.
        } else if (result.blob.size > 0) {
          const tag = (props.mapName || props.mapId || "map").replace(/[^\w-]+/g, "_");
          const clock = formatBattleClock(from).slice(2).replace(":", "");
          // The picked folder has no overwrite prompt (the legacy dialog
          // did) — the wall-clock stamp keeps repeated exports from
          // silently clobbering each other.
          const now = new Date();
          const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()]
            .map((n) => String(n).padStart(2, "0"))
            .join("");
          const name = `wowsp-replay-${tag}-${clock}-${stamp}.${result.ext}`;
          // The file write is its own phase: a multi-hundred-MB clip
          // takes a while to land, and the card must say so.
          exportPhase.value = "save";
          let saved = exportDir.value
            ? await saveExportBlobTo(result.blob, exportDir.value, name)
            : null;
          if (!saved) {
            // No remembered folder (or the host refused the write) — the
            // native save dialog keeps its old fallback.
            saved = await saveExportBlob(
              result.blob,
              name,
              result.ext === "gif" ? "Image" : "Video",
              result.ext,
            );
          }
          if (saved) {
            // The clip's chat hand-off: a natively saved file rides the
            // clipboard as an HDROP entry, so the next 粘贴 in QQ/微信/
            // Discord attaches it. A fallback download (non-native) or a
            // refused copy keeps the plain saved toast — never an error.
            let copied = false;
            if (saved.native) {
              copied = await rpcApi
                .copyFileToClipboard(saved.path)
                .then(() => true)
                .catch(() => false);
            }
            toast.info(
              i18nT(
                copied ? "replay.export.savedCopied" : "replay.export.saved",
                { path: saved.path },
              ),
            );
          }
        } else {
          toast.info(i18nT("replay.export.toastEmpty"));
        }
      } catch (e) {
        toast.error(String((e as Error)?.message ?? e));
      } finally {
        // Take end: every card's canvas/texture/material is released before
        // the live view is repainted (the sprites live on an export-only
        // layer, but their resources must not outlive the take).
        shipLabelSprites?.dispose();
        shipLabelSprites = null;
        exporting.value = false;
        seekBattleTime(resumeAt);
        if (wasPlaying) playing.value = true;
        api.value?.requestRender();
      }
    }

    // Public playback surface (see HoloMapHandle) — read by the replay view's
    // chat-log panel for its playhead + dot seeks, and by the AI report's
    // keyframe jump for the replay seek + chase-camera focus. NOTE: this must
    // go through the setup context's `expose` — the `defineExpose` import
    // from "vue" is a <script setup> compiler macro whose runtime stub is a
    // silent no-op, which is exactly what it did when called from this JSX
    // component.
    expose({ current, duration, playing, seek: seekBattleTime, focusEntity });

    return () => {
      // Shared playhead-derived kill board (tooltip + Tab scoreboard read
      // the same numbers in the same frame). Computed only while one of
      // them is on screen — otherwise it'd run every playback frame.
      // Narrow once: the JSX below reads the card snapshot several times.
      const hoveredTip = hoverTip.value;
      const killsNow =
        tipVehicleId.value != null || showRoster.value
          ? killsByPlayerAt(hudCurrent.value)
          : EMPTY_KILLS;
      const tipVehicle =
        tipVehicleId.value != null
          ? props.vehicles.find((v) => v.id === tipVehicleId.value) ?? null
          : null;
      return (
      <div class="holo-map">
        <div
          ref={container}
          class="holo-map__canvas"
          onPointerdown={(e: PointerEvent) => {
            if (
              e.button === 2 &&
              cameraMode.value === "follow" &&
              selectedEntityId.value != null
            ) {
              // Hold-RMB free look around the followed ship; the window
              // pointerup listener (registered here) snaps the chase view
              // back even when the button releases off-canvas.
              freeLook.value = true;
              window.addEventListener("pointerup", onFreeLookUp);
              window.addEventListener("pointercancel", onFreeLookUp);
              window.addEventListener("blur", onFreeLookUp);
              return;
            }
            if (e.button === 2 && cameraMode.value === "original") {
              // Hold-RMB free look INSIDE the recorded camera (the pose is
              // re-stamped from the 0x25 stream when the button releases).
              recordedLookPrev = { x: e.clientX, y: e.clientY };
              window.addEventListener("pointermove", onRecordedLookMove);
              window.addEventListener("pointerup", onRecordedLookUp);
              window.addEventListener("pointercancel", onRecordedLookUp);
              window.addEventListener("blur", onRecordedLookUp);
              return;
            }
            if (e.button === 0) _downPt = { x: e.clientX, y: e.clientY };
          }}
          onClick={(e) => {
            if (_downPt && Math.hypot(e.clientX - _downPt.x, e.clientY - _downPt.y) > 6) {
              // This was a drag, not a click — clear any selection so the
              // camera isn't held by followSelected, then return.
              selectShip(null);
              return;
            }
            onCanvasClick(e);
          }}
        />
        {/* ── Floating ship labels (projected 3D→2D onto the canvas) ──.
            Each label/status pair sits in a 0×0 SLOT div the render loop
            positions imperatively (labelOverlay.applySlot): per-frame
            x/y churn stays out of Vue, and only the low-frequency content
            below (name/hp/tone/status) re-renders — see markerUpdate's
            label-content throttle. */}
        <div
          class={[
            "holo-map__labels",
            // The enlarged 2D map IS the view: floating 3D name/status cards
            // painted over it would read as map labels from another layer.
            showLabels.value && !minimapZoom.value ? "" : "holo-map__labels--hidden",
          ].filter(Boolean).join(" ")}
          aria-hidden="true"
        >
          {shipLabels.value.map((lbl) => {
            // Local player markers (玩家标记): nickname-first match, the
            // resolved account id sharpens it when the stats batch landed.
            const st = nameStats.value.get(lbl.name);
            return (
            <div
              key={lbl.entityId}
              class="holo-map__label-slot"
              ref={(el) => { ctx.labelSlotEls.set("l" + lbl.entityId, el as HTMLDivElement | null); }}
            >
              <HoloLabel
                hostPositioned
                deadText={i18nT("replay.legend.dead")}
                label={{
                  key: lbl.entityId,
                  x: 0,
                  y: 0,
                  role: lbl.role,
                  // Scripted NPCs have no player name — the label's ship slot
                  // already carries their identity.
                  name: lbl.scripted ? "" : lbl.name,
                  shipName: lbl.shipName,
                  tier: lbl.tier,
                  iconUrl:
                    lbl.kind === "plane"
                      ? (planeIcon(lbl.planeType ?? "attack")?.src ?? null)
                      : lbl.type
                        ? (shipIconUrl(lbl.type, lbl.role === "enemy" ? "enemy" : "ally") ?? null)
                        : null,
                  hp: lbl.hp,
                  maxHp: lbl.maxHp,
                  // Repair Party's grey recoverable segment: null (feature
                  // off / no repair data / sunk / aircraft) leaves the bar's
                  // historical two-layer look untouched.
                  hpRecoverableFrac: lbl.hpRecoverableFrac ?? null,
                  // Aircraft: boost readouts as thin bars under the HP bar —
                  // blue = engine boost (throttle mode 1), white = the one-shot
                  // temporary boost window (healForsage). They can be on
                  // together, hence two bars; when NEITHER runs the row is
                  // omitted entirely instead of leaving an empty dark track
                  // (user report).
                  extraBars:
                    lbl.kind === "plane" &&
                    (lbl.planeBoost || lbl.planeForsageFrac != null)
                      ? [
                          ...(lbl.planeBoost
                            ? [{ key: "boost", color: "#4aa3ff", frac: 1 }]
                            : []),
                          ...(lbl.planeForsageFrac != null
                            ? [
                                {
                                  key: "forsage",
                                  color: "#f4f8ff",
                                  frac: lbl.planeForsageFrac,
                                },
                              ]
                            : []),
                        ]
                      : undefined,
                  depthMeters: lbl.depthMeters,
                  planeAlive: lbl.planeAlive ?? null,
                  dead: lbl.dead,
                  ghostText: lbl.ghostText,
                  visible: true,
                  selected: selectedEntityId.value === lbl.entityId,
                  tone: lbl.tone,
                  markerColor: markers.colorOf(lbl.scripted ? null : lbl.name, st?.accountId),
                }}
              />
            </div>
            );
          })}
          {/* Below-hull combat status rows (close-range only — the gate
              lives in labelOverlay's projection pass). Aircraft get their
              own below-formation row: alive/HP ride the card above, the
              consumables + engine boost run underneath the squadron. */}
          {shipLabels.value.map((lbl) =>
            lbl.kind === "plane" ? (
              <div
                key={lbl.entityId}
                class="holo-map__label-slot"
                ref={(el) => { ctx.labelSlotEls.set("s" + lbl.entityId, el as HTMLDivElement | null); }}
              >
                <div class="holo-plane-status" aria-hidden="true">
                  {lbl.planeBoost ? (
                    <span class="holo-plane-status__chip holo-plane-status__chip--boost">
                      {i18nT("replay.planeCard.boost")}
                    </span>
                  ) : null}
                  {lbl.planeSlow ? (
                    <span class="holo-plane-status__chip holo-plane-status__chip--slow">
                      {i18nT("replay.planeCard.slow")}
                    </span>
                  ) : null}
                  {(lbl.planeConsumables ?? []).map((sem, i) => (
                    <span key={i} class="holo-plane-status__chip">
                      {i18nT(consumableLabelKey(sem))}
                      {typeof sem === "object" && "unknown" in sem
                        ? ` #${sem.unknown}`
                        : ""}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <div
                key={lbl.entityId}
                class="holo-map__label-slot"
                ref={(el) => { ctx.labelSlotEls.set("s" + lbl.entityId, el as HTMLDivElement | null); }}
              >
                <HoloShipStatus hostPositioned label={lbl} />
              </div>
            ),
          )}
        </div>
        {!ready.value ? (
          <div class="holo-map__hint">
            <LoadingNote text="Initializing holographic scene" />
          </div>
        ) : null}
        {/* Follow-mode free look: centered mode banner while RMB is held. */}
        {freeLook.value ? <div class="holo-map__freelook">{i18nT("replay.camera.freeLook")}</div> : null}
        {/* Original-view playback inside a recorded aircraft-camera segment
            (the recorder was chasing planes — see cameraModes). */}
        {inPlaneCameraMode.value ? <div class="holo-map__cam-badge">{i18nT("replay.camera.planeCamera")}</div> : null}
        {props.replayPath ? (
          <>
          <div class="holo-map__scorebar-wrap">
            <HoloScorebar
              state={scorebarState.value}
              onShipEnter={onShipEnter}
              onShipLeave={onShipLeave}
            />
          </div>
          </>
        ) : null}
        {/* Top-right weather-restriction badge: cyclone/storm approach
            countdown + the live spotting cap while it ramps. */}
        {props.replayPath && weatherView.value ? (
          <HoloWeatherBadge view={weatherView.value} />
        ) : null}
        {/* E22 AI heatmap strip: right-edge timeline of every ship's instant
            score across the whole battle. Only while the AI layer is on. */}
        {props.replayPath && aiAnalysisOn.value && debugReport.value ? (
          <HoloHeatStrip
            report={debugReport.value}
            playhead={hudCurrent.value}
            duration={duration.value || 0}
          />
        ) : null}
        {/* Top-left combat-range indicator settings (button → modal). */}
        {props.replayPath ? (
          <HoloRangeMenu
            open={rangeMenuOpen.value}
            rings={selfRingsView.value}
            onToggle={() => { rangeMenuOpen.value = !rangeMenuOpen.value; }}
          />
        ) : null}
        {/* Bottom-left event feed — sink notifications + player chat +
            achievement awards, newest first. Kill cards keep the 3-column
            layout (killer | "击沉了" | victim); chat and achievement cards
            are single rows with the sender's side tint. */}
        <HoloEventFeed entries={feed.value} />
        <canvas
          ref={minimapCanvas}
          class="holo-map__minimap"
          width={160}
          height={160}
          onClick={() => { minimapZoom.value = true; }}
          style={{
            // Phone (≤767px): the playback bar wraps to two lines, so the
            // thumb shrinks and lifts above them — the transport line
            // would otherwise sit on top of a 160px thumb (controls are
            // z-4 over the z-3 canvas). Desktop keeps 160px at the corner.
            width: isMobile.value ? "112px" : "160px",
            height: isMobile.value ? "112px" : "160px",
            position: "absolute",
            right: "8px",
            bottom: isMobile.value ? "100px" : "8px",
            zIndex: "3",
            borderRadius: "4px",
            pointerEvents: "auto",
            cursor: "zoom-in",
          }}
        />
        {/* Enlarged minimap overlay: trails + class glyphs, closeable */}
        {minimapZoom.value ? (
          <div
            class={[
              "holo-map__mmzoom",
              tacticalOn.value ? "holo-map__mmzoom--tac-space" : "",
            ]}
            onClick={() => { minimapZoom.value = false; }}
          >
            {/* The pill is chrome, not scrim — clicking its labels must not
                close the view (only the scrim around the map does). Icon
                toggles light up (primary) while active; tooltips name them. */}
            <div class="holo-map__mmzoom-head" onClick={(e: MouseEvent) => e.stopPropagation()}>
              <HkTooltip text={i18nT("replay.minimap.rotateCcw")} placement="bottom">
                <HkIconButton size={24} variant="ghost" onClick={() => rotateMap(-1)}>
                  <RotateCcw size={13} />
                </HkIconButton>
              </HkTooltip>
              <span class="holo-map__mmzoom-head-title">{i18nT("replay.minimap.zoom")}</span>
              <span class="holo-map__mmzoom-head-toggles">
                <HkTooltip text={i18nT("replay.minimap.trails")} placement="bottom">
                  <HkIconButton
                    size={24}
                    variant={minimapShowTrails.value ? "primary" : "ghost"}
                    onClick={() => { minimapShowTrails.value = !minimapShowTrails.value; }}
                  >
                    <Spline size={13} />
                  </HkIconButton>
                </HkTooltip>
                <HkTooltip text={i18nT("replay.minimap.grid")} placement="bottom">
                  <HkIconButton
                    size={24}
                    variant={minimapShowGrid.value ? "primary" : "ghost"}
                    onClick={() => { minimapShowGrid.value = !minimapShowGrid.value; }}
                  >
                    <Grid3x3 size={13} />
                  </HkIconButton>
                </HkTooltip>
                <HkTooltip text={i18nT("replay.tactical.toggle")} placement="bottom">
                  <HkIconButton
                    size={24}
                    variant={tacticalOn.value ? "primary" : "ghost"}
                    onClick={() => { tacticalOn.value = !tacticalOn.value; }}
                  >
                    <PenLine size={13} />
                  </HkIconButton>
                </HkTooltip>
                
                
              </span>
              <HkTooltip text={i18nT("replay.minimap.rotateCw")} placement="bottom">
                <HkIconButton size={24} variant="ghost" onClick={() => rotateMap(1)}>
                  <RotateCw size={13} />
                </HkIconButton>
              </HkTooltip>
              {capabilities.loaded && !capabilities.aiInference ? (
                <span class="holo-map__mmzoom-badge">
                  {i18nT("replay.decisions.portableBadge")}
                </span>
              ) : null}
              {/* Fixture-model badge: the numbers are placeholder demos, not
                  trained-model output — keep it visible while the layer is
                  on and served by the embedded fixture. */}

              {/* Movement-advice layer badges: the cold build takes seconds
                  (say so), and experiment-default models are not the packed
                  product models (name their provenance). */}


            </div>
            {/* Stage: base map canvas + tactical annotation layer. The map
                keeps its full size in tactical mode — the board docks INSIDE
                it (timeline + toolbar at the bottom edge). Clicks on the map
                no longer close the overlay (drawing/selection needs them);
                the scrim around it still does. */}
            <div
              class="holo-map__mmzoom-stage"
              {...hoverStageCapture}
              onClick={(e: MouseEvent) => e.stopPropagation()}
              onPointermove={(e: PointerEvent) => onMinimapStagePointerMove(e)}
              onPointerleave={hideHoverTip}
            >
              <canvas
                ref={zoomCanvas}
                width={TACTICAL_SIZE}
                height={TACTICAL_SIZE}
                class="holo-map__mmzoom-canvas"
              />
              <TacticalBoard
                replayPath={props.replayPath}
                mapTag={(props.mapName || props.mapId || "map").replace(/[^\w-]+/g, "_")}
                rotationDeg={mmRotationDeg.value}
                editMode={tacticalOn.value}
                getBounds={() => computeTacticalBounds()}
                viewApi={viewApi}
                getTime={() => current.value}
                getDuration={() => duration.value}
                getPlaying={() => playing.value}
                play={() => { if (!playing.value) togglePlay(); }}
                pause={() => { if (playing.value) togglePlay(); }}
                seekTo={seekBattleTime}
                trajectories={() => props.trajectories}
                actions={shipActions.value}
                labelOf={vehicleLabelOf}
                pickShipAt={pickShipAt}
                baseCanvas={() => zoomCanvas.value}
                overlayCanvas={() => minimapCanvas.value}
              />
              {/* Hover card for the entity under the cursor — Teleported to
                  <body> by the component, so it never inherits the stage's
                  stacking/clip context. */}
              {hoveredTip ? (
                <MinimapHoverTip
                  target={hoveredTip.target}
                  x={hoveredTip.x}
                  y={hoveredTip.y}
                />
              ) : null}
            </div>
          </div>
        ) : null}
        {props.replayPath ? (
          <>
          <div class="holo-map__transport">
          <div class="holo-map__controls">
          {/* Tactical dock: the toolbar + timeline teleport here when the
              board is on — the playback bar's "tall form", with the map
              sliding up via the mmzoom --tac-space padding. */}
          {minimapZoom.value && tacticalOn.value ? (
            <div
              class="holo-map__tac-dock"
              id="holo-map-tac-dock"
              onClick={(e: MouseEvent) => e.stopPropagation()}
            />
          ) : null}
          {/* Bottom-left HUD COLUMN: the chased wing's panel sits directly
              above the hull card, laid out by FLOW so the two can never
              overlap whatever the plaque row measures (see the stacking
              contract on __hudcolumn). In the 2D enlarged view the plaque +
              stats duplicate what the 3D view shows, so the whole block
              hides and the map owns the screen. */}
          {!minimapZoom.value && (selfCard.value || squadronPanelState.value) ? (
            <div class="holo-map__hudcolumn">
              {/* Squadron panel: the chased wing's per-group / per-plane HP
                  bands + engine row (user request: aircraft state belongs in
                  the bottom-left HUD, not floating over the map). */}
              {squadronPanelState.value ? (
                <HoloSquadronPanel state={squadronPanelState.value} />
              ) : null}
              {selfCard.value ? (
                <HoloSelfCard
                  card={selfCard.value}
                  stats={selfStats.value}
                  depth={selfDepth.value}
                />
              ) : null}
            </div>
          ) : null}
          {/* Plane-follow pill: rides beside the hull plaque (same band,
              right-aligned to the row's cap — see HoloPlaneFollowCard.scss)
              and only while the chase is on a carrier AIRCRAFT; the hull
              fallback state renders the muted hull line instead. */}
          {!minimapZoom.value && planeCardState.value ? (
            <HoloPlaneFollowCard state={planeCardState.value} />
          ) : null}
          {/* Phone-only scoreboard chip: the Tab HOLD that reveals the
              desktop scoreboard has no touch equivalent — this toggles
              the same overlay (the roster's phone close bar plays the
              Tab-keyup half; the chip itself sits under the overlay
              while it is open). */}
          {isMobile.value ? (
            <button
              class={[
                "holo-map__lbltoggle",
                "holo-map__roster-toggle",
                showRoster.value ? "holo-map__lbltoggle--on" : "",
              ].filter(Boolean).join(" ")}
              onClick={() => {
                showRoster.value = !showRoster.value;
                if (showRoster.value) ensureRosterStats();
              }}
              data-hint={i18nT("replay.roster.toggle")}
              aria-label={i18nT("replay.roster.toggle")}
              aria-expanded={showRoster.value}
            >
              <Users size={14} />
            </button>
          ) : null}
          <button
              class="holo-map__lbltoggle"
              onClick={() => { showLabels.value = !showLabels.value; }}
              data-hint={showLabels.value ? i18nT("replay.labels.hide") : i18nT("replay.labels.show")}
              aria-label={showLabels.value ? i18nT("replay.labels.hide") : i18nT("replay.labels.show")}
            >
              {showLabels.value ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>
            {/* AI analysis toggle: one button, one state — fire suggestions
                on the 2D map + movement advice arrows (2D/3D) + entity
                confidence badges + the hold-Tab roster's four AI score
                columns + the timeline heatmap strip. Cold build takes
                seconds (full replay decode + model pass); the loading badge
                says so. */}
            <button
              class={["holo-map__lbltoggle", aiAnalysisOn.value ? "holo-map__lbltoggle--on" : ""].filter(Boolean).join(" ")}
              onClick={() => {
                if (!capabilities.aiInference) return;
                aiAnalysisOn.value = !aiAnalysisOn.value;
                if (aiAnalysisOn.value) {
                  resetDecisionLayer();
                  resetMoveAdviceLayer();
                  maybeFetchDecisions();
                  maybeFetchDebugReport();
                }
              }}
              disabled={!capabilities.aiInference}
              data-hint={
                !capabilities.loaded
                  ? i18nT("settings.resourcesAiChecking")
                  : capabilities.aiInference
                    ? i18nT("replay.aiAnalysis.toggle")
                    : i18nT("replay.aiAnalysis.portableUnavailable")
              }
              aria-label={i18nT("replay.aiAnalysis.toggle")}
            >
              <Brain size={14} />
              {aiAnalysisOn.value && debugLoading.value ? (
                <span class="holo-map__ai-loading" />
              ) : null}
            </button>
            {props.cameraFrames.length > 0 || cameraMode.value !== "free" ? (
              <HoloCameraMenu
                mode={cameraMode.value}
                open={cameraMenuOpen.value}
                hasOriginalFrames={props.cameraFrames.length > 0}
                recordedMode={
                  props.cameraFrames.length > 0 ? recordedCameraModeNow.value : null
                }
                hasPlaneCameraWindow={hasPlaneCameraWindow.value}
                groups={cameraMenuOpen.value ? cameraShipGroups.value : []}
                followStats={followStats.value}
                selectedId={cameraMenuOpen.value ? selectedMenuId.value : null}
                onToggleMenu={() => { cameraMenuOpen.value = !cameraMenuOpen.value; }}
                onPickMode={(m) => { cameraMode.value = m; cameraMenuOpen.value = false; }}
                onJumpPlaneCamera={jumpToPlaneCamera}
                onPickShip={(id) => { pickCameraTarget(id); cameraMenuOpen.value = false; }}
              />
            ) : null}
            {/* The render owns the playhead while an export runs — the
                transport is disabled for the whole take (误操作防护). */}
            <button class="holo-map__play" onClick={togglePlay} disabled={exporting.value}>
              {playing.value ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <input
              ref={scrubEl}
              class="holo-map__scrub"
              type="range"
              min={0}
              max={duration.value || 0}
              step={0.1}
              value={hudCurrent.value}
              disabled={exporting.value}
              style={{ "--scrub-pct": `${duration.value ? (hudCurrent.value / duration.value) * 100 : 0}%` }}
              onInput={(e) => {
                playing.value = false;
                current.value = Number((e.target as HTMLInputElement).value);
                // Scrubbing must move the HUD (scorebar clock, roster strip,
                // self stats) with the thumb — no 10 Hz lag on drag.
                hudCurrent.value = current.value;
              }}
            />
            <span class="holo-map__time">{displayTime()}</span>
            {/* Playback-speed menu — one hikari surface (HkPopover card +
                HkMenuPanel/HkMenuActionItem rows), see HoloSpeedMenu. */}
            <HoloSpeedMenu
              speed={playbackSpeed.value}
              open={speedMenuOpen.value}
              onToggleMenu={() => { speedMenuOpen.value = !speedMenuOpen.value; }}
              onPickSpeed={(sp: number) => {
                playbackSpeed.value = sp;
                speedMenuOpen.value = false;
              }}
            />
            {/* Replay-clip export: opens the settings modal (video / GIF,
                offline fast render with the share-shot footer). */}
            <button
              class={[
                "holo-map__lbltoggle",
                "holo-map__export-btn",
                exporting.value ? "holo-map__lbltoggle--on" : "",
              ].filter(Boolean).join(" ")}
              onClick={() => { exportOpen.value = true; }}
              disabled={exporting.value}
              data-hint={i18nT("replay.export.toggle")}
              aria-label={i18nT("replay.export.toggle")}
            >
              <Clapperboard size={14} />
            </button>
          </div>
          </div>
          {/* Export progress: the shell's standard toast CARD (the download
              passes' ToastCardBase family) — the meta readout is the phase
              label (feed / models / finalize / save) or, once frames run,
              the percentage + frame counts; the bar is determinate only
              while frames advance and indeterminate through the pre-render
              stages and the mux/write tail. The cancel pill stays up the
              whole time; the card teleports to the top-right toast column. */}
          <ToastCardBase
            ref={exportCard}
            tone="info"
            rootClass="playback-export-toast"
            message={i18nT("replay.export.title")}
            meta={exporting.value ? exportCardLive().meta : exportCardHeld.value.meta}
            actions={
              exporting.value
                ? [
                    {
                      label: i18nT("replay.export.cancelRun"),
                      kind: "quiet",
                      onClick: cancelPlaybackExport,
                    },
                  ]
                : []
            }
          >
            {{
              icon: () => <Clapperboard size={14} />,
              progress: () => {
                const pct = exporting.value
                  ? exportCardLive().progress
                  : exportCardHeld.value.progress;
                return (
                  <div class="toast-card__track">
                    <div
                      class={[
                        "toast-card__fill",
                        pct == null ? "toast-card__fill--indeterminate" : "",
                      ].filter(Boolean).join(" ")}
                      style={pct == null ? undefined : { width: `${pct}%` }}
                    />
                  </div>
                );
              },
            }}
          </ToastCardBase>
          <HoloExportModal
            modelValue={exportOpen.value}
            onUpdate:modelValue={(v: boolean) => { exportOpen.value = v; }}
            settings={exportSettings}
            duration={duration.value}
            current={current.value}
            exportDir={exportDir.value}
            onDirChange={(dir: string) => {
              // Typed path: display-only this session. The PICKER persists
              // (native dialog = the user's consent, see export_config.rs);
              // an arbitrarily typed folder has no write grant and the save
              // falls back to the dialog.
              exportDir.value = dir;
            }}
            onStart={() => { void runPlaybackExportJob(); }}
          />
          </>
        ) : null}
        {showRoster.value ? (
          <HoloRosterOverlay
            vehicles={props.vehicles}
            operation={props.operation}
            time={hudCurrent.value}
            rosterState={rosterState.value}
            kills={killsNow}
            showKills={killerRosterIdOf.value != null}
            stats={nameStats.value}
            encyclopedia={props.encyclopedia}
            shipStatus={ctx.shipStatus}
            shipNameOrder={props.shipNameOrder}
            prebattle={prebattleByPlayer.value}
            aiOn={aiAnalysisOn.value}
            scoreReport={debugReport.value?.scores ?? null}
            scoreLoading={debugLoading.value}
            onClose={isMobile.value ? () => { showRoster.value = false; } : undefined}
          />
        ) : null}
        {tipVehicle && tipAnchorEl.value ? (
          <HoloShipTooltip
            vehicle={tipVehicle}
            anchorEl={tipAnchorEl.value}
            time={hudCurrent.value}
            state={rosterState.value.get(tipVehicle.id) ?? null}
            kills={killsNow.get(tipVehicle.id) ?? 0}
            showKills={killerRosterIdOf.value != null}
            stats={nameStats.value}
            statsLoading={nameStatsLoading.value}
            statsMode={props.statsMode}
            encyclopedia={props.encyclopedia}
            onCardHover={(b: boolean) => {
              tipCardHover.value = b;
            }}
          />
        ) : null}
      </div>
      );
    };
  },
});
