import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as THREE from "three";
import { Eye, EyeOff, Grid3x3, Pause, PenLine, Play, RotateCcw, RotateCw, Spline } from "@lucide/vue";
import { extractActions } from "./tactical/actions";
import { useBreakpoint } from "@celestia-island/hikari";

import { useThreeScene } from "./useThreeScene";
import { useTheme } from "@/theme";
import {
  shipModelStem,
  shipSilhouetteUrl,
  shipOfflineEntry,
  loadSilhouettes,
  type MapBounds,
} from "./modelLoader";
import { clearShipMarkerCache } from "./shipMarker";
import { clearPropMarkerCache } from "./propMarker";
import { sampleAt, hpAtTime } from "./trajectoryMath";
import { shouldReserveTabKey } from "./tabKeyGate";
import { arenaIdentities, resolveRosterAssignments } from "./rosterRoles";
import HoloShipTooltip from "./HoloShipTooltip";
import {
  clearActors,
  computeFullMapBounds,
  computeViewBounds,
  createMapInternals,
  fitCamera,
  loadMinimapBase,
  resolveRoleQuick,
} from "./mapInternals";
import { rebuildActors } from "./actorBuild";
import { updateMarkersAt } from "./markerUpdate";
import { updateLabelPositions, updateOverlayScale } from "./labelOverlay";
import { clearMapModel, ensureWaterFloor, reapplyWaterTheme, tryLoadMapModel } from "./mapTerrain";
import { drawMinimap } from "./minimapPainter";
import { isCaptureZone, type CapZoneState } from "./capZones";
import type { ShipLabel } from "./shipLabel";
import HoloEventFeed, { type FeedEntry } from "./HoloEventFeed";
import HoloCameraMenu from "./HoloCameraMenu";
import HoloRosterOverlay from "./HoloRosterOverlay";
import HoloSelfCard from "./HoloSelfCard";
import HoloShipStatus from "./HoloShipStatus";
import HoloWeatherBadge from "./HoloWeatherBadge";
import HoloRangeMenu from "./HoloRangeMenu";
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
  DamageStatSample,
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
  SquadronCreate,
  SquadronPlane,
  TorpedoLaunch,
  TorpedoSteer,
  VehicleEntry,
  WeaponLockEvent,
} from "@/api";
import { foldDamageStats } from "@/api";
import { parsePostBattle } from "@/features/replay/postBattle";
import { AI_NAME, fetchRosterStatsByNames, type RosterStat } from "@/composables/useRosterStats";
import type { ResolvedStatsMode } from "@/utils/statView";
import planeIcon from "./planeIcons";
import { shipIconUrl } from "./shipIcons";
import {
  HoloScorebar, HoloLabel, registerHoloShipIcons,
  type HoloCapZone, type HoloHudState, type HoloShip, type HoloShipCardData,
} from "@wowsp/holo";

// The shared scorebar renders the game's own HUD icons — register the
// bundled URLs once (same PNGs the minimap canvas uses).
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
import { useAccountStore } from "@/stores/account";
import { HkIconButton, HkTooltip } from "@celestia-island/hikari";
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
 *  message without HolographicMap lifting its clock out. */
export interface HoloMapHandle {
  current: number;
  duration: number;
  playing: boolean;
  seek: (t: number) => void;
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
    /** Global-weather timeline (BattleLogic state.weather.globalWeather) —
     *  cyclone/storm approach warnings + interpolation windows. */
    weatherTransitions: { type: Array as () => WeatherTransition[], default: () => [] },
    /** Announced upcoming weather changes (the in-game warning banners). */
    weatherNotifications: { type: Array as () => WeatherNotification[], default: () => [] },
    /** The arena's initial player state (onArenaStateReceived) — the
     *  authoritative ship-entity → team/player join for markers, minimap
     *  and the scorebar. */
    arenaPlayers: { type: Array as () => ArenaPlayer[], default: () => [] },
    /** Roster from the replay header — used to map trajectories to teams and
     *  resolve each ship's model. */
    vehicles: { type: Array as () => VehicleEntry[], default: () => [] },
    /** Operation scenario (行动): the roster's relation values follow
     *  scenario team slots, so every ship renders on the ally tint and the
     *  scorebar/roster show a single team — same semantic as the replay
     *  views (see utils/modeColors' isOperationBattle). */
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
    /** Resolved stats-source battle scope for the tooltip's stat numbers
     *  (the same mode the post-battle panels show). */
    statsMode: { type: String as () => ResolvedStatsMode, default: "random" },
  },
  setup(props, { expose }) {
    const container = ref<HTMLElement | null>(null);
    const { ready, api } = useThreeScene(container, (_dt) => {
      advanceMmViewTween();
      updateLabelPositions(ctx);
      drawMinimap(ctx);
      // Range-ring radius ease steps on the RAF clock (not the playhead)
      // so spotter/smoke transitions keep breathing while paused.
      updateRangeRings(ctx, current.value);
      if (originalView.value) applyOriginalCamera(current.value);
      else followSelected();
      // After the camera updates so the overlay scale reflects THIS frame's
      // distance/fov (the original replay camera changes fov per frame).
      updateOverlayScale(ctx);
    });

    // Playback state.
    const duration = ref(0);
    const current = ref(0);
    const playing = ref(false);
    /** Playback speed multiplier; the dropdown sits next to the clock. */
    const playbackSpeed = ref(2);
    const speedMenuOpen = ref(false);
    const PLAYBACK_SPEEDS = [0.5, 1, 2, 3, 5, 10] as const;
    let playRaf = 0;
    let lastTick = 0;

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
    });

    // Camera mode dropdown (upward-opening, replaces the old original-view
    // toggle): "free" (orbit), "original" (recorder camera) or "follow"
    // (chase a specific ship, picked from the grouped roster list). The
    // original-view bit is derived from the mode so the per-frame camera
    // dispatch (`applyOriginalCamera` vs `followSelected`) stays untouched.
    const cameraMenuOpen = ref(false);
    const cameraMode = ref<"free" | "original" | "follow">("free");
    // Either HUD pop-up open → the phone sheet scrim shows (computed reads
    // both refs lazily, so declaring it here after the second ref is fine).
    const hudSheetOpen = computed(() => speedMenuOpen.value || cameraMenuOpen.value);
    watch(cameraMode, (m) => {
      originalView.value = m === "original";
      if (m !== "follow") {
        endFreeLook();
        // Free/original modes keep the stock right-drag pan; only following
        // an actual ship repurposes RMB as the free-look orbit (selectShip
        // flips the mapping once a target exists).
        const ctrl = api.value?.controls;
        if (ctrl) ctrl.mouseButtons.RIGHT = THREE.MOUSE.PAN;
        selectedEntityId.value = null;
      }
    });
    /** Player stats shown in the follow menu (entityId → "WR% · battles").
     *  Resolved lazily when the menu opens; missing/failed lookups render "—". */
    const followStats = ref<Map<number, string>>(new Map());
    let statsSeq = 0;
    async function loadFollowStats() {
      const realm = useAccountStore().activeAccount?.realm;
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
    // Hold-RMB free look inside follow mode: while held, followSelected
    // keeps only the orbit TARGET pinned to the ship (so rotating / zooming
    // stays anchored to it) and stops hard-setting the camera pose; on
    // release the chase view snaps back immediately.
    const freeLook = ref(false);
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
      return v?.shipName ?? v?.name ?? String(entityId);
    };
    /** Enlarged-2D-map viewport: world-space center + zoom (1 = full map,
     *  clamped 12×). Owned here because drawMinimap paints through it; the
     *  tactical board pans/zooms via the `viewApi` prop. */
    const mmView = ref<TacticalView>({ cx: 0, cz: 0, scale: 1 });
    /** In-flight camera tween for step flyovers (eased in the scene RAF). */
    let mmViewTween: { from: TacticalView; to: TacticalView; startedAt: number; durMs: number } | null = null;
    function formatTime(sec: number): string {
      const s = Math.max(0, Math.round(sec));
      const m = Math.floor(s / 60);
      return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    }
    /** Fixed "elapsed / total" readout. */
    function displayTime(): string {
      const d = duration.value || 0;
      const c = current.value;
      return `${formatTime(c)} / ${formatTime(d)}`;
    }

    // Score bar data. The ally count keeps the relation split in
    // operations (行动) too — their rosters carry real side semantics
    // (allied escort waves ≤ 1, enemy warships > 1); only the enemy total
    // reads 0 there (the scripted enemy fleet is nobody's scoreboard).
    const allyTotal = computed(() =>
      props.vehicles.filter(v => v.relation <= 1).length,
    );
    const enemyTotal = computed(() =>
      props.operation ? 0 : props.vehicles.filter(v => v.relation > 1).length,
    );
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
      const assignments =
        ctx?.rosterAssignments.size
          ? ctx.rosterAssignments
          : resolveRosterAssignments(
              shipTrajs,
              props.vehicles,
              props.operation,
              arenaIdentities(props.arenaPlayers),
            );
      const trajById = new Map(shipTrajs.map((tr) => [tr.entityId, tr]));
      const byPlayer = new Map<number, RosterShipState>();
      for (const [entityId, v] of assignments) {
        if (!v || byPlayer.has(v.id)) continue;
        const traj = trajById.get(entityId) ?? null;
        let maxHp: number | null = null;
        for (const s of traj?.hpSamples ?? []) {
          if (maxHp == null || s.value > maxHp) maxHp = s.value;
        }
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
        const dead = d != null && d <= current.value;
        const info = props.encyclopedia.get(v.shipId) as ShipInfo | undefined;
        const offline = shipOfflineEntry(v.shipId);
        const hp = !dead && st?.traj ? hpAtTime(st.traj.hpSamples, current.value) : null;
        return {
          key: v.id,
          vehicle: v,
          type: info?.type ?? offline?.type ?? null,
          dead,
          hp,
          maxHp: st?.maxHp ?? null,
        };
      };
      const allies = props.vehicles.filter((v) => v.relation <= 1).map(mk);
      const enemies = (
        props.operation ? [] : props.vehicles.filter((v) => v.relation > 1)
      ).map(mk);
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
    const selfStats = computed(() => {
      // Server-authoritative totals (receiveDamageStat) — exact per-weapon
      // damage incl. aircraft weapons, folded to the playhead. When present
      // they override the heuristic damage/hits below (the HP-delta estimate
      // over-counts multi-hit salvos and misses out-of-view DoT).
      const folded = props.damageStats.length
        ? foldDamageStats(props.damageStats, current.value)
        : null;
      const selfTraj = props.trajectories.find(
        (tr) => tr.kind?.entityType === 2 && resolveRoleQuick(ctx, tr) === "self",
      );
      if (!selfTraj || selfTraj.samples.length === 0) {
        // No trajectory join (very early battle): the authoritative stream is
        // still the recorder's own and usable on its own.
        return folded ? { ...folded, frags: 0, taken: 0 } : null;
      }
      let hits = 0;
      let damage = 0;
      let frags = 0;
      // Damage taken: every point of HP the self ship lost up to the
      // playhead (the in-game "承受伤害" readout beside the HP plaque).
      let taken = 0;
      const hps = selfTraj.hpSamples ?? [];
      for (let i = 1; i < hps.length; i++) {
        if (hps[i].time > current.value) break;
        const drop = hps[i - 1].value - hps[i].value;
        if (drop > 0) taken += drop;
      }
      for (const e of props.shotKills) {
        if (e.ownerId !== selfTraj.entityId) continue;
        if (e.time > current.value) continue; // not time-sorted in all dumps
        hits++;
        // Damage: HP drop of ships near the impact (500 m window).
        for (const tr of props.trajectories) {
          if (tr.kind?.entityType !== 2 || tr.entityId === selfTraj.entityId) continue;
          const at = sampleAt(tr, e.time);
          if (!at) continue;
          if (Math.hypot(at.x - e.x, at.z - e.z) > 500) continue;
          const hpBefore = hpAtTime(tr.hpSamples, e.time - 0.4);
          const hpAfter = hpAtTime(tr.hpSamples, e.time + 0.6);
          if (hpBefore != null && hpAfter != null && hpBefore - hpAfter > 50) {
            damage += hpBefore - hpAfter;
          }
          const death = tr.deathTime;
          if (death != null && Math.abs(death - e.time) < 1.2) {
            frags++;
          }
        }
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
    /** Career stats for the strip tooltip and the Tab scoreboard's clan
     *  tags — one WG batch per replay, armed lazily by the first strip
     *  hover or Tab hold (nobody pays for stats they never look at). */
    const nameStats = ref<Map<string, RosterStat>>(new Map());
    const nameStatsLoading = ref(false);
    let nameStatsLoadedFor = "";
    function ensureRosterStats(): void {
      if (nameStatsLoadedFor === props.replayPath) return;
      const names = [...new Set(props.vehicles.map((v) => v.name))].filter(
        (n) => !AI_NAME.test(n),
      );
      if (names.length === 0 || !props.realm) return;
      const path = props.replayPath;
      nameStatsLoadedFor = path;
      nameStatsLoading.value = true;
      fetchRosterStatsByNames(names, props.realm)
        .then((m) => {
          if (nameStatsLoadedFor === path) nameStats.value = m;
        })
        .finally(() => {
          if (nameStatsLoadedFor === path) nameStatsLoading.value = false;
        });
    }
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
        if (t.kind?.entityType !== 14) return false;
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
        name: l.shipName,
        hp: l.hp,
        maxHp: l.maxHp,
        dead: l.dead,
        // Repairable pool approximated as 60% of damage taken until the
        // replay stream carries the real value.
        repairableHp: l.hp != null && l.maxHp != null ? (l.maxHp - l.hp) * 0.6 : null,
      };
    });

    onMounted(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Tab") {
          // Claim Tab for the roster overlay ONLY when the keystroke did
          // not land inside a form control — otherwise let focus move.
          if (shouldReserveTabKey(e.target)) {
            e.preventDefault();
            showRoster.value = true;
            // The scoreboard's game-faithful order leans on clan tags —
            // arm the one-shot roster stats batch on first hold too.
            ensureRosterStats();
          }
        }
        if (e.key === "Alt") showCapEta.value = true;
      };
      const onKeyUp = (e: KeyboardEvent) => {
        if (e.key === "Tab") showRoster.value = false;
        if (e.key === "Alt") showCapEta.value = false;
      };
      window.addEventListener("keydown", onKey);
      window.addEventListener("keyup", onKeyUp);
      onBeforeUnmount(() => {
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("keyup", onKeyUp);
      });
    });

    const shipLabels = ref<ShipLabel[]>([]);
    /** Follow-menu roster grouped by allegiance: self alone, then allies,
     *  then enemies (roster order within each group). Plane entities are
     *  excluded — only ships can be followed. */
    const cameraShipGroups = computed(() => {
      const groups: { key: string; title: string; items: ShipLabel[] }[] = [];
      const self: ShipLabel[] = [];
      const ally: ShipLabel[] = [];
      const enemy: ShipLabel[] = [];
      for (const l of shipLabels.value) {
        if (l.kind === "plane" || !l.shipName) continue;
        if (l.role === "self") self.push(l);
        else if (l.role === "ally") ally.push(l);
        else enemy.push(l);
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
            label: vehicle?.shipName ?? vehicle?.name ?? String(entityId),
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
      updateMarkersAt(ctx, clamped);
      drawMinimap(ctx);
    }

    /** Effective view window for the tactical layer (null before bounds). */
    function computeTacticalBounds(): MapBounds | null {
      const full = computeFullMapBounds(ctx);
      return full ? computeViewBounds(ctx, full) : null;
    }

    function advanceMmViewTween(): void {
      const tw = mmViewTween;
      if (!tw) return;
      const p = Math.min(1, (performance.now() - tw.startedAt) / tw.durMs);
      if (p >= 1) {
        // Land exactly on the captured view (no 1-ulp float drift).
        mmView.value = { ...tw.to };
        mmViewTween = null;
        return;
      }
      const e = 1 - Math.pow(1 - p, 3); // ease-out cubic
      mmView.value = {
        cx: tw.from.cx + (tw.to.cx - tw.from.cx) * e,
        cz: tw.from.cz + (tw.to.cz - tw.from.cz) * e,
        scale: tw.from.scale + (tw.to.scale - tw.from.scale) * e,
      };
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
    // (scene background + grid are handled inside useThreeScene).
    const { effectiveMode: sceneMode } = useTheme();
    watch(sceneMode, () => reapplyWaterTheme(ctx));

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
        } else if (t.kind?.entityType === 14) {
          eat(t.kind.initialX, -t.kind.initialZ);
        }
      }
      if (Number.isFinite(minT)) {
        duration.value = Math.max(maxT - minT, 0.1);
        if (current.value > duration.value) current.value = duration.value;
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
     *  the @wowsp/holo contract (same component the marketing site uses). */
    const scorebarState = computed<HoloHudState>(() => {
      const caps: HoloCapZone[] = capDisplay.value.map((c) => ({
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
        scoreAlly: allyScore.value,
        scoreEnemy: enemyScore.value,
        aliveAlly: 0, aliveEnemy: 0,
        time: current.value,
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

    // Combat-range indicators: the recorder's stock ranges resolve once the
    // roster lands (self shipId) and rebuild with the actors; the 3D ring
    // pool follows the playhead via updateMarkersAt. The prefs singleton is
    // persisted on change and re-applied live (visibility only — geometry
    // never depends on the toggles).
    const rangeMenuOpen = ref(false);
    const selfRingsView = ref<RangeRingDef[]>([]);
    armRangeRingPrefsPersist();
    watch(shipLabels, () => {
      const self = shipLabels.value.find((l) => l.role === "self");
      ctx.selfRings = resolveSelfRings(self?.shipId);
      selfRingsView.value = ctx.selfRings;
      buildRangeRings(ctx, ctx.selfRings);
      updateRangeRings(ctx, current.value);
    });
    watch(rangeRingPrefs, () => updateRangeRings(ctx, current.value), { deep: true });

    /** Weather restriction at the playhead — the top-right badge snapshot
     *  (null while the sky is clear with nothing announced). */
    const weatherView = computed<WeatherView | null>(() =>
      weatherStateAt(props.weatherTransitions, props.weatherNotifications, current.value),
    );

    /** First-person camera: keep the selected ship centered, camera trailing
     *  behind it along its heading. Called every render frame.
     *
     *  The marker's model points along local +Z and carries rotation.y =
     *  PI - yaw, so its world forward is (sin(yaw), 0, -cos(yaw)) in
     *  three.js space (north = -Z). The camera sits behind that: minus the
     *  forward vector. */
    function followSelected() {
      const id = selectedEntityId.value;
      if (id == null) return;
      const ctrl = api.value?.controls;
      const cam = api.value?.camera;
      if (!ctrl || !cam) return;
      const marker = ctx.shipMarkers.find((m) => m.userData.entityId === id);
      if (!marker || !marker.visible) return;
      // RMB orbits in follow mode (the hold-to-free-look gesture); the mode
      // watcher restores the stock pan mapping when follow is left. Applied
      // per-frame so a mode flip before scene readiness still lands.
      ctrl.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
      const pos = marker.position;
      // Held-RMB free look: keep the orbit pivot glued to the (moving) ship
      // and hand the camera pose to OrbitControls until the button releases.
      // No extra controls.update() here — the tick loop already runs one per
      // frame, and doubling it would decay the damping inertia twice as fast.
      if (freeLook.value) {
        ctrl.target.copy(pos);
        return;
      }
      const yaw = marker.rotation.y;
      // Framing tracks the true hull scale (≈1.1 ship lengths behind, half a
      // length up) so a followed BB fills the view about like in-game.
      const dist = 55;
      const behind = new THREE.Vector3(
        pos.x - Math.sin(yaw) * dist,
        22,
        pos.z + Math.cos(yaw) * dist,
      );
      cam.position.copy(behind);
      ctrl.target.copy(pos);
      ctrl.update();
    }

    /** Replay the recorder's original camera when the original-view toggle is
     *  on: pick the camera frame at the playhead, apply pose + fov, and
     *  disable OrbitControls so the user can't fight the replay. */
    function applyOriginalCamera(t: number) {
      const cam = api.value?.camera;
      const ctrl = api.value?.controls;
      if (!cam || !ctrl) return;
      const frames = props.cameraFrames;
      if (frames.length === 0) {
        originalView.value = false;
        ctrl.enabled = true;
        return;
      }
      ctrl.enabled = false;
      let frame = frames[frames.length - 1];
      for (const f of frames) {
        if (f.time > t) break;
        frame = f;
      }
      // Scene z is mirrored (z' = -z), so the camera z mirrors too.
      cam.position.set(frame.x, frame.y, -frame.z);
      cam.quaternion.set(frame.rotX, frame.rotY, frame.rotZ, frame.rotW);
      cam.fov = (frame.fov * 180) / Math.PI;
      cam.updateProjectionMatrix();
    }

    /** Select a ship by clicking either its 3D marker or its label. Clicking
     *  the empty scene clears the selection. Labels have pointer-events: none
     *  (so they can't break OrbitControls drag), so clicks reach the canvas
     *  and pick the nearest visible marker via raycast. */
    function selectShip(entityId: number | null) {
      selectedEntityId.value = entityId;
      // Clicking a ship switches to chase mode; clicking empty space returns
      // to the free orbit camera.
      cameraMode.value = entityId != null ? "follow" : "free";
      // Following a real ship hands RMB to the free-look orbit (the per-frame
      // assignment in followSelected re-asserts it; this covers the first
      // frames before that runs).
      const ctrl = api.value?.controls;
      if (ctrl) ctrl.mouseButtons.RIGHT = entityId != null ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
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

    // Playback loop. rAF is paused while the page is hidden, so the first
    // tick after resuming sees the whole hidden span as dt — clamp it so
    // playback never fast-forwards through the match on return.
    const MAX_PLAYBACK_TICK_SECONDS = 0.5;
    function playTick(now: number) {
      if (!playing.value) return;
      if (lastTick === 0) lastTick = now;
      const dt = Math.min((now - lastTick) / 1000, MAX_PLAYBACK_TICK_SECONDS);
      lastTick = now;
      current.value += dt * playbackSpeed.value; // playback multiplier (0.5–10×)
      if (current.value >= duration.value) {
        current.value = duration.value;
        playing.value = false;
      }
      playRaf = requestAnimationFrame(playTick);
    }
    function togglePlay() {
      playing.value = !playing.value;
      if (playing.value) {
        lastTick = 0;
        if (current.value >= duration.value) current.value = 0;
        playRaf = requestAnimationFrame(playTick);
      }
    }

    // Reset playback when switching replays.
    watch(
      () => props.replayPath,
      () => {
        // Roster stats belong to ONE replay — drop them so the next open
        // re-arms the batch (and stale in-flight answers are gated out).
        nameStatsLoadedFor = "";
        nameStats.value = new Map();
        tipVehicleId.value = null;
        tipAnchorEl.value = null;
        tipIconHover.value = false;
        tipCardHover.value = false;
        if (tipHideTimer != null) {
          window.clearTimeout(tipHideTimer);
          tipHideTimer = null;
        }
        if (ready.value) {
          current.value = 0;
          playing.value = false;
          duration.value = 0;
          // The enlarged 2D view belongs to ONE replay — close it on switch
          // (clearActors no longer resets it so a deep-link ?mm=1 open and
          // mid-session rebuilds keep the overlay alive).
          minimapZoom.value = false;
          mmView.value = { cx: 0, cz: 0, scale: 1 };
          mmViewTween = null;
          clearActors(ctx);
          shipLabels.value = [];
          ctx.bounds = null;
        }
      },
    );

    // Recompute + rebuild whenever trajectories change.
    watch(
      () => props.trajectories,
      (trajs) => {
        if (trajs.length === 0) {
          current.value = 0;
          playing.value = false;
          return;
        }
        recomputeBoundsAndCamera();
        rebuildActors(ctx);
        // One-shot deep-link seek: ?t=<seconds> jumps playback on load.
        if (props.initialTime > 0 && current.value === 0) {
          current.value = Math.min(props.initialTime, duration.value);
        }
        updateMarkersAt(ctx, current.value);
      },
      { deep: false },
    );

    // Rebuild when the roster arrives/changes (team roles + shipId resolution)
    // or when the encyclopedia finishes loading (enables tier-based fallback
    // models). Both are needed because they resolve independently of the
    // trajectory stream.
    watch(
      () => props.vehicles,
      () => {
        if (ready.value) {
          rebuildActors(ctx);
          updateMarkersAt(ctx, current.value);
        }
      },
      { deep: false },
    );
    watch(
      () => props.encyclopedia.size,
      (s) => {
        if (ready.value && s > 0) {
          rebuildActors(ctx);
          updateMarkersAt(ctx, current.value);
        }
      },
      { immediate: true },
    );

    // Recompute markers whenever the scrubber moves.
    watch(current, (t) => updateMarkersAt(ctx, t));

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
    // headless render checks exercise the NATURAL playback path (the RAF
    // loop advancing current), not just seeks.
    if (new URLSearchParams(location.search).get("play") === "1") {
      watch(
        () => props.trajectories.length,
        (n) => {
          if (n > 0 && current.value === 0 && !playing.value) {
            playing.value = true;
            lastTick = 0;
            playRaf = requestAnimationFrame(playTick);
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

    onBeforeUnmount(() => {
      cancelAnimationFrame(playRaf);
      endFreeLook();
      if (tipHideTimer != null) {
        window.clearTimeout(tipHideTimer);
        tipHideTimer = null;
      }
      clearActors(ctx);
      clearMapModel(ctx);
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
      clearShipMarkerCache();
      clearPropMarkerCache();
    });

    // Public playback surface (see HoloMapHandle) — read by the replay view's
    // chat-log panel for its playhead + dot seeks. NOTE: this must go through
    // the setup context's `expose` — the `defineExpose` import from "vue" is
    // a <script setup> compiler macro whose runtime stub is a silent no-op,
    // which is exactly what it did when called from this JSX component.
    expose({ current, duration, playing, seek: seekBattleTime });

    return () => {
      // Shared playhead-derived kill board (tooltip + Tab scoreboard read
      // the same numbers in the same frame). Computed only while one of
      // them is on screen — otherwise it'd run every playback frame.
      const killsNow =
        tipVehicleId.value != null || showRoster.value
          ? killsByPlayerAt(current.value)
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
        {/* ── Floating ship labels (projected 3D→2D onto the canvas) ── */}
        <div class={["holo-map__labels", showLabels.value ? "" : "holo-map__labels--hidden"]} aria-hidden="true">
          {shipLabels.value.map((lbl) => (
            <HoloLabel
              key={lbl.entityId}
              deadText={i18nT("replay.legend.dead")}
              label={{
                key: lbl.entityId,
                x: lbl.x,
                y: lbl.y,
                role: lbl.role,
                name: lbl.name,
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
                dead: lbl.dead,
                ghostText: lbl.ghostText,
                visible: lbl.visible,
                selected: selectedEntityId.value === lbl.entityId,
              }}
            />
          ))}
          {/* Below-hull combat status rows (close-range only — the gate
              lives in labelOverlay's projection pass). */}
          {shipLabels.value.map((lbl) =>
            lbl.kind === "plane" ? null : (
              <HoloShipStatus key={lbl.entityId} label={lbl} />
            ),
          )}
        </div>
        {!ready.value ? <div class="holo-map__hint">Initializing holographic scene…</div> : null}
        {/* Follow-mode free look: centered mode banner while RMB is held. */}
        {freeLook.value ? <div class="holo-map__freelook">{i18nT("replay.camera.freeLook")}</div> : null}
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
            width: "160px",
            height: "160px",
            position: "absolute",
            right: "8px",
            bottom: "8px",
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
            </div>
            {/* Stage: base map canvas + tactical annotation layer. The map
                keeps its full size in tactical mode — the board docks INSIDE
                it (timeline + toolbar at the bottom edge). Clicks on the map
                no longer close the overlay (drawing/selection needs them);
                the scrim around it still does. */}
            <div class="holo-map__mmzoom-stage" onClick={(e: MouseEvent) => e.stopPropagation()}>
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
            </div>
          </div>
        ) : null}
        {props.replayPath ? (
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
          {/* Phone sheet scrim: while a HUD pop-up menu is docked as a
              bottom sheet (≤767px only — the CSS docks the panels), taps on
              the scrim dismiss both menus, mirroring the hikari sheet
              family's closeOnBackdrop. Desktop never renders it. */}
          {isMobile.value && hudSheetOpen.value ? (
            <div
              class="holo-map__sheet-scrim"
              onClick={() => {
                speedMenuOpen.value = false;
                cameraMenuOpen.value = false;
              }}
            />
          ) : null}
          {/* In the 2D enlarged view the plaque + stats duplicate what the 3D
              view shows — hide them so the 2D map owns the screen. */}
          {!minimapZoom.value && selfCard.value ? (
            <HoloSelfCard card={selfCard.value} stats={selfStats.value} />
          ) : null}
          <button
              class="holo-map__lbltoggle"
              onClick={() => { showLabels.value = !showLabels.value; }}
              data-hint={showLabels.value ? i18nT("replay.labels.hide") : i18nT("replay.labels.show")}
              aria-label={showLabels.value ? i18nT("replay.labels.hide") : i18nT("replay.labels.show")}
            >
              {showLabels.value ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>
            {props.cameraFrames.length > 0 || cameraMode.value !== "free" ? (
              <HoloCameraMenu
                mode={cameraMode.value}
                open={cameraMenuOpen.value}
                hasOriginalFrames={props.cameraFrames.length > 0}
                groups={cameraShipGroups.value}
                followStats={followStats.value}
                selectedId={selectedEntityId.value}
                onToggleMenu={() => { cameraMenuOpen.value = !cameraMenuOpen.value; }}
                onPickMode={(m) => { cameraMode.value = m; cameraMenuOpen.value = false; }}
                onPickShip={(id) => { selectShip(id); cameraMenuOpen.value = false; }}
              />
            ) : null}
            <button class="holo-map__play" onClick={togglePlay}>
              {playing.value ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <input
              ref={scrubEl}
              class="holo-map__scrub"
              type="range"
              min={0}
              max={duration.value || 0}
              step={0.1}
              value={current.value}
              style={{ "--scrub-pct": `${duration.value ? (current.value / duration.value) * 100 : 0}%` }}
              onInput={(e) => {
                playing.value = false;
                current.value = Number((e.target as HTMLInputElement).value);
              }}
            />
            <span class="holo-map__time">{displayTime()}</span>            <div class="holo-map__speed">
              <button
                class="holo-map__speed-btn"
                onClick={(e) => { e.stopPropagation(); speedMenuOpen.value = !speedMenuOpen.value; }}
                data-hint={i18nT("replay.playbackSpeed")}
              >
                {playbackSpeed.value}×
              </button>
              {speedMenuOpen.value ? (
                <div class="holo-map__speed-menu" onClick={(e) => e.stopPropagation()}>
                  {PLAYBACK_SPEEDS.map((sp) => (
                    <button
                      key={sp}
                      class={["holo-map__speed-opt", sp === playbackSpeed.value ? "holo-map__speed-opt--on" : ""]}
                      onClick={() => {
                        playbackSpeed.value = sp;
                        speedMenuOpen.value = false;
                      }}
                    >
                      {sp}×
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {showRoster.value ? (
          <HoloRosterOverlay
            vehicles={props.vehicles}
            operation={props.operation}
            time={current.value}
            rosterState={rosterState.value}
            kills={killsNow}
            showKills={killerRosterIdOf.value != null}
            stats={nameStats.value}
            encyclopedia={props.encyclopedia}
          />
        ) : null}
        {tipVehicle && tipAnchorEl.value ? (
          <HoloShipTooltip
            vehicle={tipVehicle}
            anchorEl={tipAnchorEl.value}
            time={current.value}
            state={rosterState.value.get(tipVehicle.id) ?? null}
            kills={killsNow.get(tipVehicle.id) ?? 0}
            showKills={killerRosterIdOf.value != null}
            stats={nameStats.value}
            statsLoading={nameStatsLoading.value}
            statsMode={props.statsMode}
            operation={props.operation}
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
