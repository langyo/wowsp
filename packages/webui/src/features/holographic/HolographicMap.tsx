import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as THREE from "three";
import planeTypesRaw from "../../data/plane_types.json";
import shellTypesRaw from "../../data/shell_types.json";

import { useThreeScene } from "./useThreeScene";
import {
  resolveMapModelUrl,
  resolveMapMinimapUrl,
  resolveShipModelForEntry,
  resolveShipModelByShipId,
  resolvePlaneModelUrl,
  resolvePropModelUrl,
  shipNameFromModelDb,
  shipNameFromOfflineDb,
  shipOfflineEntry,
  loadGlbModel,
  loadMapBounds,
  type MapBounds,
  type ShipModelSpec,
} from "./modelLoader";
import { makeHoloContourMaterial } from "./holoContourShader";
import { buildShipMarker, disposeMarker, clearShipMarkerCache } from "./shipMarker";
import { buildPropMarker, clearPropMarkerCache } from "./propMarker";
import { TEAM_COLOR, roleFromRelation, type TeamRole } from "./teamColors";
import type {
  CameraSample,
  EntityTrajectory,
  ExplosionEvent,
  HpSample,
  NetStatsSample,
  ShipInfo,
  SquadronCreate,
  SquadronPlane,
  TorpedoLaunch,
  VehicleEntry,
  WeaponLockEvent,
} from "@/api";
import planeIcon from "./planeIcons";
import { shipIcon } from "./shipIcons";

/** paramsId → plane metadata (index/name/type/count) baked from GameParams by
 *  `scripts/model_convert/extract_planes.py` — the type drives which in-game
 *  aircraft icon the minimap uses; `count` is the full squadron size. */
const PLANE_TYPES = planeTypesRaw as Record<
  string,
  { index: string; name: string; type: string; count?: number }
>;
/** Shell encyclopedia (paramsId → ammo/tint) baked from GameParams by
 *  `scripts/model_convert/extract_shells.py`. */
const SHELL_TYPES = shellTypesRaw as Record<
  string,
  { name: string; ammo: string; tint: number[] | null }
>;
/** Shell-flight colors per ammo type: HE yellow, AP silver, SAP grey. */
const SHELL_COLORS: Record<string, number> = {
  HE: 0xffcc33,
  AP: 0xc8d0e0,
  SAP: 0x9aa0a8,
  CS: 0xffa07a,
};

/** Resolve a shell's ammo family (+ color) from its GameParams id. SAP shells
 *  are stored as AP in the game data — detect them by name. */
function shellAmmoOf(paramsId?: number): { ammo: string; color: number } {
  if (paramsId == null) return { ammo: "unknown", color: 0xffe08a };
  const info = SHELL_TYPES[String(paramsId)];
  if (!info) return { ammo: "unknown", color: 0xffe08a };
  const ammo =
    info.ammo === "AP" && info.name.toUpperCase().includes("SAP")
      ? "SAP"
      : info.ammo;
  const color = SHELL_COLORS[ammo] ?? 0xffe08a;
  return { ammo, color };
}
import { tierToRoman } from "@/utils/tierRoman";
import BattleIcon from "@/components/base/BattleIcon";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useLanguage } from "@/i18n/useLanguage";
import SCheckbox from "@/components/base/SCheckbox";
import { t } from "@/i18n";
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
export default defineComponent({
  name: "HolographicMap",
  props: {
    replayPath: { type: String, default: "" },
    trajectories: { type: Array as () => EntityTrajectory[], default: () => [] },
    /** World-space shell impacts (receiveExplosions on the avatar). */
    explosions: { type: Array as () => ExplosionEvent[], default: () => [] },
    /** Torpedo launches (shootTorpedo on firing vehicles). */
    torpedoes: { type: Array as () => TorpedoLaunch[], default: () => [] },
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
    /** Roster from the replay header — used to map trajectories to teams and
     *  resolve each ship's model. */
    vehicles: { type: Array as () => VehicleEntry[], default: () => [] },
    /** Ship encyclopedia (shipId → ShipInfo). Used to resolve tier/nation/type
     *  for per-ship model loading + tier-based fallback when a model is missing. */
    encyclopedia: { type: Object as () => Map<number, ShipInfo>, default: () => new Map() },
    /** Map space id (e.g. "15_NE_north") — used to load the terrain GLB. */
    mapId: { type: String, default: "" },
    /** Match group from the replay descriptor (pvp/ranked/clan/brawl/...). */
    matchGroup: { type: String, default: "" },
    /** Map space id, for applying per-map domination scoring overrides. */
    mapName: { type: String, default: "" },
  },
  setup(props) {
    const container = ref<HTMLElement | null>(null);
    const { ready, api } = useThreeScene(container, (_dt) => {
      updateLabelPositions();
      drawMinimap();
      if (originalView.value) applyOriginalCamera(current.value);
      else followSelected();
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
    /** Battle-opening phase: like the game, enemy ships aren't visible until
     *  the opening countdown ends (~15s); allies and the recorder are. */
    const OPENING_HIDE_T = 15;

    // Time display toggle: 0=elapsed, 1=remaining, 2=total
    const timeMode = ref(0);
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

    // First-person follow: the entity id whose marker the camera tracks
    // (null = free orbit). Set by clicking a ship marker/label.
    const selectedEntityId = ref<number | null>(null);
    // 2D minimap enlarged overlay state.
    const minimapZoom = ref(false);
    const minimapShowTrails = ref(true);

    function toggleTimeMode() {
      timeMode.value = (timeMode.value + 1) % 3;
    }
    function formatTime(sec: number): string {
      const s = Math.max(0, Math.round(sec));
      const m = Math.floor(s / 60);
      return `${m}:${String(s % 60).padStart(2, "0")}`;
    }
    function displayTime(): string {
      const d = duration.value || 0;
      const c = current.value;
      if (timeMode.value === 0) return formatTime(c);
      if (timeMode.value === 1) return "-" + formatTime(d - c);
      return formatTime(d);
    }

    // Score bar data
    const allyTotal = computed(() => props.vehicles.filter(v => v.relation <= 1).length);
    const enemyTotal = computed(() => props.vehicles.filter(v => v.relation > 1).length);
    // Ships alive = total - sunk count at current time
    const allyAlive = ref(allyTotal.value);
    const enemyAlive = ref(enemyTotal.value);
    // Cap zone status (A=0, B=1, C=2) — 0=neutral, 1=ally, 2=enemy
    const capStatus = ref([0, 0, 0]);
    // Estimated match score: kills (1 pt) + fully-held cap points (3 pts each).
    // WoWS doesn't stream score packets into replays, so this is a close
    // approximation of the domination scoring shown in the top bar.
    const allyScore = ref(0);
    const enemyScore = ref(0);
    // Transient "X sunk" feed, newest first; entries expire after a few seconds.
    interface KillEvent {
      id: number;
      text: string;
      role: TeamRole;
    }
    const killFeed = ref<KillEvent[]>([]);
    let killSeq = 0;
    // Entity ids already reported as sunk (avoid double-counting on scrub).
    const reportedSinks = new Set<number>();
    // The capture-zone entities + their ownership timelines. InteractiveZone
    // (type 14) covers ALL interactive areas — capture points, strike zones,
    // event regions. The AUTHORITATIVE discriminator is the create packet's
    // `controlPoint` component (`controlPointIndex`): only real domination
    // points carry it, and it ships with the EntityCreate itself, so the rule
    // holds even for replays that record no ownership/progress updates after
    // the zone spawns. The ownership/progress-stream checks below are kept
    // only as a fallback for very old replays predating the component.
    const capZones = computed(() => {
      const zones = props.trajectories.filter((t) => {
        if (t.kind?.entityType !== 14) return false;
        if (t.kind.controlPointIndex != null) return true;
        if ((t.capSamples?.length ?? 0) > 0) return true;
        // 0x23 progress streams that START SMALL (≤200) are real capture
        // progress (17–50 unit ticks from zero); strike targets first appear
        // at 741–1446 and drop to zero once destroyed.
        const cp = t.capProgress ?? [];
        return cp.length > 0 && cp[0].value > 0 && cp[0].value <= 200;
      });
      // Order letters by the game's own point index (0 = A) so the scorebar
      // matches the in-match callouts.
      zones.sort(
        (a, b) =>
          (a.kind?.controlPointIndex ?? 999) - (b.kind?.controlPointIndex ?? 999),
      );
      return zones;
    });

    onMounted(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Tab") {
          e.preventDefault();
          showRoster.value = true;
        }
      };
      const onKeyUp = (e: KeyboardEvent) => {
        if (e.key === "Tab") showRoster.value = false;
      };
      window.addEventListener("keydown", onKey);
      window.addEventListener("keyup", onKeyUp);
      onBeforeUnmount(() => {
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("keyup", onKeyUp);
      });
    });

    // Three.js objects we own (to dispose on change/unmount).
    let trajectoryLines: THREE.Line[] = [];
    let shipMarkers: THREE.Group[] = [];
    /** Smoke-screen puffs (entityType 4 = SmokeScreen). One cylinder per
     *  smoke entity, positioned at its expanding point each frame. */
    let smokeMeshes: { mesh: THREE.Mesh; traj: EntityTrajectory; endT: number }[] = [];
    /** Reconstructed shell flights: a curved trace from a nearby ship that
     *  was aimed at the impact when it exploded. */
    let shellTraces: {
      line: THREE.Line;
      dots: THREE.Points;
      flash: THREE.Mesh;
      halo: THREE.Mesh;
      /** In-flight projectile visual — a cone until the real shell GLB swaps
       *  in, then a wrapped model group (driven identically). */
      shell: THREE.Object3D;
      /** Ammo tint (kept so the async GLB swap can re-tint the model). */
      color: number;
      t0: number;
      t1: number;
      from: () => THREE.Vector3 | null;
      to: THREE.Vector3;
      h: number;
    }[] = [];
    /** In-flight torpedoes: straight capsules from the launch point along
     *  the launch direction (swapped for the real torpedo GLB once loaded). */
    let torpedoMeshes: {
      mesh: THREE.Object3D;
      wake: THREE.Line;
      t0: number;
      life: number;
      base: THREE.Vector3;
      dir: THREE.Vector3;
    }[] = [];
    /** Transient explosion rings (splash hits). */
    let explosionFx: { ring: THREE.Mesh; born: number }[] = [];
    const _shellUp = new THREE.Vector3(0, 1, 0);
    const _shellDir = new THREE.Vector3();
    /** Recorder aim line to the currently locked target (SetWeaponLock). */
    let lockLine: THREE.Mesh | null = null;
    /** Big ring over the locked target (same render path as splash rings). */
    let lockRing: THREE.Mesh | null = null;
    /** Aircraft formation cloud (one point per plane, from the avatar's
     *  receive_updateSquadron stream) — fallback for planes without a baked
     *  model; modeled planes render as GLB meshes in `planeMeshes`. */
    let planeCloud: THREE.Points | null = null;
    /** Per-plane sample lists grouped by plane id, sorted by time. */
    let planeTrails: { id: number; samples: SquadronPlane[] }[] = [];
    /** planeId*16+index → aircraft type (fighter/dive/torpedo/...). */
    const planeTypesById = new Map<number, string>();
    /** planeId*16+index → GameParams index (for the baked model GLB). */
    const planeIndexById = new Map<number, string>();
    /** Squadron label id → controlling ship's entity id (for name/HP sync). */
    const planeLabelCarriers = new Map<number, number | null>();
    /** planeId → team role of the controlling ship (drives marker colour:
     *  ally green, enemy red, like the battle HUD). */
    const planeRoleById = new Map<number, string>();
    /** planeId → the carrier card label id that shows it. */
    const planeLabelOfPlane = new Map<number, number>();
    /** planeId → formation render state: the GameParams squadron size and the
     *  per-plane model instances (one per slot in the wedge formation). */
    const planeFormations = new Map<number, { count: number; meshes: THREE.Object3D[] }>();
    /** planeId → 3D aircraft model pool (one per formation slot). */
    const planeMeshes = new Map<number, THREE.Object3D[]>();
    /** Capture-zone ring meshes (repainted per frame by cap state). */
    let capRings: THREE.Mesh[] = [];
    let mapModel: THREE.Group | null = null;
    let bounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;

    /** Per-marker display info for the floating HTML labels. Rebuilt alongside
     *  the markers; positions are updated each frame by projecting the marker's
     *  world position into screen space. */
    interface ShipLabel {
      entityId: number;
      role: TeamRole;
      name: string;
      shipName: string;
      tier: number | null;
      type: string | null;
      hp: number | null;
      maxHp: number | null;
      /** "plane" renders the aircraft icon + carrier name instead of the ship glyph. */
      kind?: "ship" | "plane";
      /** Aircraft type name (fighter/dive/...) for plane labels. */
      planeType?: string | null;
      /** Screen-space left/top in px (relative to the canvas). Updated per-frame. */
      x: number;
      y: number;
      visible: boolean;
      dead: boolean;
    }
    const shipLabels = ref<ShipLabel[]>([]);
    const _projVec = new THREE.Vector3();
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
    let _mmCtx: CanvasRenderingContext2D | null = null;
    const MINIMAP_SIZE = 160;
    let minimapImage: HTMLImageElement | null = null;
    let minimapBounds: MapBounds | null = null;
    /** Cancels stale minimap-base loads when the map switches mid-flight. */
    let minimapEpoch = 0;

    /** (Re)load the base art + bounds for the current mapId. */
    function loadMinimapBase() {
      const epoch = ++minimapEpoch;
      minimapImage = null;
      minimapBounds = null;
      const url = resolveMapMinimapUrl(props.mapId);
      if (url) {
        const img = new Image();
        img.onload = () => { if (epoch === minimapEpoch) minimapImage = img; };
        img.src = url;
      }
      void loadMapBounds().then((all) => {
        if (epoch !== minimapEpoch) return;
        const key = props.mapId.replace(/^spaces\//, "");
        minimapBounds =
          all.get(key) ??
          all.get(key.toLowerCase()) ??
          [...all.entries()].find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1] ??
          null;
      });
    }

    function drawMinimap() {
      // Effective bounds in WORLD coordinates: the map's minimap bounds when
      // known (matches the base art), else the trajectory bounds converted
      // back from scene space (scene z = -world z) so the dots at least fit
      // the canvas.
      const full: MapBounds | null =
        minimapBounds ??
        (bounds
          ? { minX: bounds.minX, maxX: bounds.maxX, minZ: -bounds.maxZ, maxZ: -bounds.minZ }
          : null);
      if (!full) return;
      // Crop to the active battle area when the match plays out in a small
      // region of the map (brawls/events with a restricted border): the
      // in-game minimap shows only that region, and a full-map view would
      // compress every ship dot into one corner. `bounds` already holds the
      // active area in scene coords (z mirrored back to world here).
      let db = full;
      if (minimapBounds && bounds) {
        const active: MapBounds = {
          minX: bounds.minX,
          maxX: bounds.maxX,
          minZ: -bounds.maxZ,
          maxZ: -bounds.minZ,
        };
        const mapArea = (full.maxX - full.minX) * (full.maxZ - full.minZ);
        const activeArea =
          (active.maxX - active.minX) * (active.maxZ - active.minZ);
        if (activeArea > 0 && activeArea < 0.7 * mapArea) {
          db = {
            minX: Math.max(active.minX, full.minX),
            maxX: Math.min(active.maxX, full.maxX),
            minZ: Math.max(active.minZ, full.minZ),
            maxZ: Math.min(active.maxZ, full.maxZ),
          };
        }
      }
      const cvs = minimapCanvas.value;
      if (!cvs) return;
      if (!_mmCtx) _mmCtx = cvs.getContext("2d");
      const ctx = _mmCtx!;
      const w = MINIMAP_SIZE;
      const h = MINIMAP_SIZE;
      if (cvs.width !== w) cvs.width = w;
      if (cvs.height !== h) cvs.height = h;

      const dbW = db.maxX - db.minX;
      const dbH = db.maxZ - db.minZ;

      // Markers/camera live in three.js space (z = -worldZ); convert back to
      // world coordinates for the map projection. North (+worldZ) is up on
      // the game's minimap (world_to_minimap flips z).
      function wx(x: number) { return ((x - db.minX) / (dbW || 1)) * w; }
      function wz(zScene: number) { return ((db.maxZ + zScene) / (dbH || 1)) * h; }

      ctx.clearRect(0, 0, w, h);
      if (minimapImage) {
        if (db === full) {
          ctx.drawImage(minimapImage, 0, 0, w, h);
        } else {
          // Cropped: draw only the active-area slice of the art, scaled up.
          const img = minimapImage;
          const fullW = full.maxX - full.minX;
          const fullH = full.maxZ - full.minZ;
          const sx = ((db.minX - full.minX) / (fullW || 1)) * img.width;
          const sw = ((db.maxX - db.minX) / (fullW || 1)) * img.width;
          const sy = ((full.maxZ - db.maxZ) / (fullH || 1)) * img.height;
          const sh = ((db.maxZ - db.minZ) / (fullH || 1)) * img.height;
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
        }
      } else {
        ctx.fillStyle = "rgba(5, 8, 15, 0.85)";
        ctx.fillRect(0, 0, w, h);
      }
      ctx.strokeStyle = "rgba(0, 170, 255, 0.3)";
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

      // Capture zones: small rings tinted by current owner, letter inside.
      capZones.value.forEach((z, i) => {
        const cx = wx(z.kind!.initialX);
        const cz = wz(-z.kind!.initialZ);
        const owner = capDisplay.value[i]?.owner ?? 0;
        ctx.strokeStyle =
          owner === 1 ? "rgba(74, 222, 128, 0.8)" : owner === 2 ? "rgba(204, 51, 51, 0.8)" : "rgba(255, 255, 255, 0.5)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(cx, cz, 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.font = "bold 8px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String.fromCharCode(65 + i), cx, cz + 0.5);
      });

      // Ship markers: the game's own HUD class icons, tinted by team via the
      // variant (ally/enemy/sunk). Falls back to a plain dot until the icon
      // image decodes.
      const t = current.value;
      for (const m of shipMarkers) {
        const role = m.userData.role as TeamRole | undefined;
        // Opening phase: enemies are off the map like in the game — but their
        // SPAWN positions are known (EntityCreate), so draw a ghost at the
        // spawn point as a coordinate reference.
        if (role === "enemy" && t < OPENING_HIDE_T) {
          const gx = wx(m.userData.spawnX as number);
          const gz = wz(-(m.userData.spawnZ as number));
          const gicon = shipIcon(m.userData.type as string | undefined, "enemy");
          if (gicon && gicon.complete && gicon.naturalWidth > 0) {
            const gsz = 13;
            ctx.save();
            ctx.globalAlpha = 0.35;
            ctx.translate(gx, gz);
            ctx.rotate((m.userData.yaw as number ?? 0) - Math.PI / 2);
            ctx.drawImage(gicon, -gsz / 2, -gsz / 2, gsz, gsz);
            ctx.restore();
          }
          continue;
        }
        const dead =
          (m.userData.deathTime as number | null) != null &&
          t >= (m.userData.deathTime as number);
        const cx = wx(m.position.x);
        const cz = wz(m.position.z);
        const icon = shipIcon(
          m.userData.type as string | undefined,
          dead ? "sunk" : role === "self" || role === "ally" ? "ally" : role === "enemy" ? "enemy" : "white",
        );
        if (icon && icon.complete && icon.naturalWidth > 0) {
          const sz = 15;
          // Rotate the icon to the ship's heading. The HUD art's pointy end
          // faces RIGHT (+x = east; unrotated icons all pointed right, as
          // seen before rotation was added). yaw is clockwise from north
          // (canvas up), so the heading maps to rotate(yaw - PI/2) — the 3D
          // marker's bow points along (sin yaw, 0, -cos yaw) in world space,
          // which projects to the same direction on the canvas.
          ctx.save();
          ctx.translate(cx, cz);
          ctx.rotate((m.userData.yaw as number ?? 0) - Math.PI / 2);
          ctx.drawImage(icon, -sz / 2, -sz / 2, sz, sz);
          ctx.restore();
          continue;
        }
        if (dead) {
          ctx.fillStyle = "rgba(150, 150, 150, 0.7)";
          ctx.beginPath();
          ctx.arc(cx, cz, 1.8, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        const color = role ? TEAM_COLOR[role] : 0x888888;
        drawShipGlyph(ctx, m.userData.type as string | undefined, cx, cz, 5, color);
      }

      // Smoke screens (entityType 4) — translucent grey puffs.
      ctx.fillStyle = "rgba(150, 160, 180, 0.45)";
      for (const tr of props.trajectories) {
        if (tr.kind?.entityType !== 4 || tr.samples.length < 2) continue;
        const s = sampleAt(tr, t);
        ctx.beginPath();
        ctx.arc(wx(s.x), wz(-s.z), 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      // Aircraft — one in-game type icon per FORMATION (squadron centre),
      // not per plane: a full 8-plane group reads as a single moving marker.
      {
        const drawn = new Set<number>();
        for (const trail of planeTrails) {
          const planeId = Math.floor(trail.id / 16);
          if (trail.id % 16 !== 0 || drawn.has(planeId)) continue;
          const samples = trail.samples;
          let s: SquadronPlane | null = null;
          for (const sp of samples) {
            if (sp.time > t) break;
            s = sp;
          }
          if (s == null) continue;
          if (t < samples[0].time || t > samples[samples.length - 1].time + 120) continue;
          drawn.add(planeId);
          const icon = planeIcon(planeTypesById.get(trail.id) ?? "attack");
          if (icon && icon.complete && icon.naturalWidth > 0) {
            const sz = 10;
            ctx.save();
            ctx.translate(wx(s.x), wz(-s.z));
            ctx.rotate(s.yaw);
            ctx.drawImage(icon, -sz / 2, -sz / 2, sz, sz);
            ctx.restore();
          } else {
            ctx.fillStyle = "rgba(120, 210, 255, 0.95)";
            ctx.beginPath();
            ctx.arc(wx(s.x), wz(-s.z), 1.4, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // Camera frustum.
      const cam = api.value?.camera;
      if (cam) {
        const corners = frustumCorners(cam);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(wx(corners[0].x), wz(corners[0].z));
        for (let i = 1; i < 4; i++) ctx.lineTo(wx(corners[i].x), wz(corners[i].z));
        ctx.closePath();
        ctx.stroke();
      }

      // Enlarged minimap overlay: full-map view with ship trails + glyphs.
      const zc = zoomCanvas.value;
      if (zc) {
        const zctx = zc.getContext("2d");
        if (zctx) {
          const zw = 640;
          zctx.clearRect(0, 0, zw, zw);
          if (minimapImage) {
            zctx.drawImage(minimapImage, 0, 0, zw, zw);
          } else {
            zctx.fillStyle = "rgba(5, 8, 15, 0.9)";
            zctx.fillRect(0, 0, zw, zw);
          }
          const zwx = (x: number) => ((x - full.minX) / (full.maxX - full.minX || 1)) * zw;
          const zwz = (zScene: number) => ((full.maxZ + zScene) / (full.maxZ - full.minZ || 1)) * zw;
          if (minimapShowTrails.value) {
            for (const tr of props.trajectories) {
              if (tr.kind?.entityType !== 2 || tr.samples.length < 8) continue;
              const role = resolveRoleQuick(tr);
              zctx.strokeStyle =
                role === "enemy"
                  ? "rgba(204, 51, 51, 0.5)"
                  : role === "self"
                    ? "rgba(255, 255, 255, 0.6)"
                    : "rgba(60, 180, 120, 0.5)";
              zctx.lineWidth = 1.5;
              zctx.beginPath();
              tr.samples.forEach((s, i) => {
                const px = zwx(s.x);
                const py = zwz(-s.z);
                if (i === 0) zctx.moveTo(px, py);
                else zctx.lineTo(px, py);
              });
              zctx.stroke();
            }
          }
          for (const m of shipMarkers) {
            const role = m.userData.role as TeamRole | undefined;
            // Opening phase: ghost at the enemy spawn point (see base map).
            if (role === "enemy" && t < OPENING_HIDE_T) {
              const gx = zwx(m.userData.spawnX as number);
              const gz = zwz(-(m.userData.spawnZ as number));
              const gicon = shipIcon(m.userData.type as string | undefined, "enemy");
              if (gicon && gicon.complete && gicon.naturalWidth > 0) {
                const gsz = 22;
                zctx.save();
                zctx.globalAlpha = 0.35;
                zctx.translate(gx, gz);
                zctx.rotate((m.userData.yaw as number ?? 0) - Math.PI / 2);
                zctx.drawImage(gicon, -gsz / 2, -gsz / 2, gsz, gsz);
                zctx.restore();
              }
              continue;
            }
            const dead =
              (m.userData.deathTime as number | null) != null &&
              t >= (m.userData.deathTime as number);
            const cx = zwx(m.position.x);
            const cz = zwz(m.position.z);
            const icon = shipIcon(
              m.userData.type as string | undefined,
              dead ? "sunk" : role === "self" || role === "ally" ? "ally" : role === "enemy" ? "enemy" : "white",
            );
            if (icon && icon.complete && icon.naturalWidth > 0) {
              const sz = 26;
              zctx.save();
              zctx.translate(cx, cz);
              zctx.rotate((m.userData.yaw as number ?? 0) - Math.PI / 2);
              zctx.drawImage(icon, -sz / 2, -sz / 2, sz, sz);
              zctx.restore();
              continue;
            }
            if (dead) {
              zctx.fillStyle = "rgba(150,150,150,0.7)";
              zctx.beginPath();
              zctx.arc(cx, cz, 5, 0, Math.PI * 2);
              zctx.fill();
              continue;
            }
            const color = role ? TEAM_COLOR[role] : 0x888888;
            drawShipGlyph(zctx, m.userData.type as string | undefined, cx, cz, 14, color);
          }
          // Smoke screens — translucent grey puffs on the enlarged map.
          zctx.fillStyle = "rgba(150, 160, 180, 0.5)";
          for (const tr of props.trajectories) {
            if (tr.kind?.entityType !== 4 || tr.samples.length < 2) continue;
            const s = sampleAt(tr, t);
            zctx.beginPath();
            zctx.arc(zwx(s.x), zwz(-s.z), 6, 0, Math.PI * 2);
            zctx.fill();
          }
          // Aircraft — one icon per formation (squadron centre).
          {
            const drawn = new Set<number>();
            for (const trail of planeTrails) {
              const planeId = Math.floor(trail.id / 16);
              if (trail.id % 16 !== 0 || drawn.has(planeId)) continue;
              const samples = trail.samples;
              let s: SquadronPlane | null = null;
              for (const sp of samples) {
                if (sp.time > t) break;
                s = sp;
              }
              if (s == null) continue;
              if (t < samples[0].time || t > samples[samples.length - 1].time + 120) continue;
              drawn.add(planeId);
              const icon = planeIcon(planeTypesById.get(trail.id) ?? "attack");
              if (icon && icon.complete && icon.naturalWidth > 0) {
                const sz = 22;
                zctx.save();
                zctx.translate(zwx(s.x), zwz(-s.z));
                zctx.rotate(s.yaw);
                zctx.drawImage(icon, -sz / 2, -sz / 2, sz, sz);
                zctx.restore();
              } else {
                zctx.fillStyle = "rgba(120, 210, 255, 0.95)";
                zctx.beginPath();
                zctx.arc(zwx(s.x), zwz(-s.z), 3.5, 0, Math.PI * 2);
                zctx.fill();
              }
            }
          }
        }
      }
    }

    /** Quick team-role lookup for the zoomed minimap trails (by shipId join,
     *  same fallbacks as the markers but without the roster-assignment pass). */
    function resolveRoleQuick(tr: EntityTrajectory): TeamRole {
      const sid = tr.kind?.shipId;
      if (sid != null) {
        const entries = props.vehicles.filter((v) => v.shipId === sid);
        if (entries.length === 1) return roleFromRelation(entries[0].relation);
      }
      // Fallback: entity-id spawn order (first half of ships = allies).
      const ids = props.trajectories
        .filter(
          (x) =>
            x.kind?.entityType === 2 &&
            (x.samples.length >= 80 ||
              (x.kind?.shipId != null && x.samples.length > 0)),
        )
        .map((x) => x.entityId)
        .sort((a, b) => a - b);
      const idx = ids.indexOf(tr.entityId);
      return idx >= 0 && idx < ids.length / 2 ? "ally" : "enemy";
    }

    function frustumCorners(cam: THREE.PerspectiveCamera): THREE.Vector3[] {
      const hw = 0.5;
      const hh = hw / cam.aspect;
      const corners: THREE.Vector3[] = [];
      for (let i = 0; i < 4; i++) {
        const sx = i === 0 || i === 3 ? -hw : hw;
        const sy = i < 2 ? -hh : hh;
        const pt = new THREE.Vector3(sx, sy, 1).unproject(cam);
        const ray = pt.clone().sub(cam.position).normalize();
        const t = -(cam.position.y) / ray.y;
        corners.push(cam.position.clone().add(ray.multiplyScalar(t)));
      }
      return corners;
    }

    /** Draw one of the five WoWS class glyphs on a canvas context, centered at
     *  (x, y), `size` px tall, in the given color. Same geometry as the
     *  ShipTypeIcon component (27×27 atlas), normalized to the requested size. */
    function drawShipGlyph(
      ctx: CanvasRenderingContext2D,
      type: string | undefined,
      x: number,
      y: number,
      size: number,
      color: number,
    ) {
      const s = size / 27;
      const P = (pts: [number, number][]) => {
        ctx.beginPath();
        ctx.moveTo(x + pts[0][0] * s, y + pts[0][1] * s);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(x + pts[i][0] * s, y + pts[i][1] * s);
        ctx.closePath();
        ctx.fill();
      };
      ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
      const t = type?.toLowerCase() ?? "";
      if (t.includes("destroyer")) {
        P([[4.5, 8.5], [23, 13], [4.5, 17.5]]);
      } else if (t.includes("battleship")) {
        P([[4.5, 8], [19, 8], [23, 13], [19, 18], [4.5, 18]]);
        // two parallel diagonals (drawn thinner, darker)
        ctx.strokeStyle = ctx.fillStyle;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = Math.max(1, s);
        ctx.beginPath();
        ctx.moveTo(x + 13.5 * s, y + 8.5 * s);
        ctx.lineTo(x + 8.5 * s, y + 17.5 * s);
        ctx.moveTo(x + 17 * s, y + 8.5 * s);
        ctx.lineTo(x + 12.5 * s, y + 17.5 * s);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (t.includes("aircarrier") || t.includes("aircar")) {
        P([[4.5, 8], [14.5, 8], [16, 8], [23, 13], [16, 18], [14.5, 18], [4.5, 18]]);
        ctx.strokeStyle = ctx.fillStyle;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = Math.max(1, s);
        ctx.beginPath();
        ctx.moveTo(x + 4.5 * s, y + 13 * s);
        ctx.lineTo(x + 14.5 * s, y + 13 * s);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (t.includes("submarine")) {
        P([[4, 8.5], [5.5, 8.5], [5.5, 17.5], [4, 17.5]]);
        P([[8.5, 9], [23, 13], [8.5, 17]]);
      } else {
        // cruiser (default) — pentagon + one diagonal
        P([[4.5, 8], [19, 8], [23, 13], [19, 18], [4.5, 18]]);
        ctx.strokeStyle = ctx.fillStyle;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = Math.max(1, s);
        ctx.beginPath();
        ctx.moveTo(x + 14.5 * s, y + 8.5 * s);
        ctx.lineTo(x + 9.5 * s, y + 17.5 * s);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    /** Tokens used to cancel in-flight async marker loads when actors are
     *  rebuilt/unmounted before a GLB resolves. Each rebuild bumps the epoch;
     *  stale loads compare against the live epoch before mutating the scene. */
    let markerEpoch = 0;

    /** Dispose an Object3D generically — primitive mesh or wrapped GLB group.
     *  Materials are always disposed (per-instance). Geometry is disposed too,
     *  EXCEPT for GLB-derived groups (userData.sharedGeometry): their buffers
     *  are shared with the decode cache and must survive until the cache is
     *  cleared on unmount. */
    function disposeAny(obj: THREE.Object3D): void {
      const shared = obj.userData.sharedGeometry === true;
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (!shared) mesh.geometry?.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (!mat) return;
        for (const m of Array.isArray(mat) ? mat : [mat]) m.dispose();
      });
    }

    function clearActors() {
      markerEpoch++;
      const scene = api.value?.scene;
      if (!scene) return;
      for (const l of trajectoryLines) {
        scene.remove(l);
        l.geometry.dispose();
        (l.material as THREE.Material).dispose();
      }
      for (const m of shipMarkers) {
        scene.remove(m);
        const ghost = m.userData.ghost as THREE.Mesh | undefined;
        if (ghost) {
          scene.remove(ghost);
          ghost.geometry.dispose();
          (ghost.material as THREE.Material).dispose();
        }
        if (m.userData.isDot) {
          m.traverse((o) => {
            if (o instanceof THREE.Mesh) {
              o.geometry.dispose();
              (o.material as THREE.Material).dispose();
            }
          });
        } else {
          disposeMarker(m);
        }
      }
      trajectoryLines = [];
      shipMarkers = [];
      capRings = [];
      capSim.clear();      for (const sm of smokeMeshes) {
        scene.remove(sm.mesh);
        sm.mesh.geometry.dispose();
        (sm.mesh.material as THREE.Material).dispose();
      }
      smokeMeshes = [];
      for (const st of shellTraces) {
        scene.remove(st.line);
        st.line.geometry.dispose();
        (st.line.material as THREE.Material).dispose();
        scene.remove(st.dots);
        st.dots.geometry.dispose();
        (st.dots.material as THREE.Material).dispose();
        // st.shell may be a primitive mesh or a wrapped GLB group (after the
        // model swap) — dispose generically.
        scene.remove(st.shell);
        disposeAny(st.shell);
        scene.remove(st.flash);
        st.flash.geometry.dispose();
        (st.flash.material as THREE.Material).dispose();
        scene.remove(st.halo);
        st.halo.geometry.dispose();
        (st.halo.material as THREE.Material).dispose();
      }
      shellTraces = [];
      for (const tm of torpedoMeshes) {
        scene.remove(tm.mesh);
        disposeAny(tm.mesh);
        scene.remove(tm.wake);
        tm.wake.geometry.dispose();
        (tm.wake.material as THREE.Material).dispose();
      }
      torpedoMeshes = [];
      for (const pool of planeMeshes.values()) {
        for (const g of pool) {
          scene.remove(g);
          disposeAny(g);
        }
      }
      planeMeshes.clear();
      planeFormations.clear();
      for (const fx of explosionFx) {
        scene.remove(fx.ring);
        fx.ring.geometry.dispose();
        (fx.ring.material as THREE.Material).dispose();
      }
      explosionFx = [];
      if (lockLine) {
        scene.remove(lockLine);
        lockLine.geometry.dispose();
        (lockLine.material as THREE.Material).dispose();
        lockLine = null;
      }
      if (lockRing) {
        scene.remove(lockRing);
        lockRing.geometry.dispose();
        (lockRing.material as THREE.Material).dispose();
        lockRing = null;
      }
      if (planeCloud) {
        scene.remove(planeCloud);
        planeCloud.geometry.dispose();
        (planeCloud.material as THREE.Material).dispose();
        planeCloud = null;
      }
      planeTrails = [];
      allyAlive.value = allyTotal.value;
      enemyAlive.value = enemyTotal.value;
      capStatus.value = [0, 0, 0];
      capDisplay.value = [];
      allyScore.value = 0;
      enemyScore.value = 0;
      killFeed.value = [];
      reportedSinks.clear();
      minimapZoom.value = false;
      selectedEntityId.value = null;
    }

    /** Remove a previously-loaded map terrain model. */
    function clearMapModel() {
      if (mapModel) {
        api.value?.scene.remove(mapModel);
        mapModel.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose();
            (o.material as THREE.Material).dispose();
          }
        });
        mapModel = null;
      }
    }

    /** Deep-sea floor plane stretching far past the playable area. Without
     *  it the terrain mesh (bounded by the space's chunk rect) ends in a hard
     *  edge against the void, which reads as a bright square patch around the
     *  map's center. The plane sits just below the deepest seabed and uses
     *  the same deep-water color as the contour shader's trench zone, so the
     *  terrain edge blends into open sea instead of clipping. Opaque on
     *  purpose — no blend-order interaction with the transparent terrain. */
    let waterFloor: THREE.Mesh | null = null;
    let seaSurface: THREE.Mesh | null = null;
    function ensureWaterFloor() {
      const scene = api.value?.scene;
      if (!scene || waterFloor) return;
      const mat = new THREE.MeshBasicMaterial({ color: 0x05121f });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(24000, 24000), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = -40;
      mesh.renderOrder = -1;
      mesh.raycast = () => {}; // never intercept picks
      scene.add(mesh);
      waterFloor = mesh;
      // Translucent sea surface at y≈0: hides the seabed tint behind it and
      // lets islands poke through, while keeping ship wake depth readable.
      const seaMat = new THREE.MeshBasicMaterial({
        color: 0x071827,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      });
      const sea = new THREE.Mesh(new THREE.PlaneGeometry(24000, 24000), seaMat);
      sea.rotation.x = -Math.PI / 2;
      sea.position.y = 0.6;
      sea.renderOrder = 5;
      sea.raycast = () => {};
      scene.add(sea);
      seaSurface = sea;
    }

    /** Attempt to load the terrain GLB for the current mapId and restyle it as
     *  a holographic island mesh (same cyan scanline/fresnel shader as the ship
     *  viewer). If no converted GLB exists, the scene keeps its GridHelper
     *  fallback. Contour-line terrain is a planned feature — for now the map is
     *  the low-poly island geometry in holo style. */
    async function tryLoadMapModel() {
      clearMapModel();
      const scene = api.value?.scene;
      if (!scene || !props.mapId) return;
      const url = resolveMapModelUrl(props.mapId);
      if (!url) return; // no converted model — use grid fallback
      try {
        const model = await loadGlbModel(url);
        // Baked GLBs drop POSITION accessor min/max — recompute per-geometry so
        // bounds-dependent logic (future fit/clip) still works.
        model.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (mesh.geometry?.attributes.position) {
            mesh.geometry.computeBoundingBox();
            mesh.geometry.computeBoundingSphere();
          }
        });
        // Restyle meshes by role. The converted map GLB is a multi-mesh file
        // whose nodes are named `Terrain` (the elevation height-field, incl.
        // sea-floor bathymetry/trenches) and `Islands` (simplified land). The
        // terrain gets the contour shader (topographic + bathymetric bands);
        // islands get the plain holographic shader. Both share the same
        // time/scanOffset uniforms so one onFrame tick animates everything.
        const contourMat = makeHoloContourMaterial();
        const wireMat = new THREE.MeshBasicMaterial({
          color: 0x2a8fb5,
          wireframe: true,
          transparent: true,
          opacity: 0.08,
          depthWrite: false,
        });
        const meshes: THREE.Mesh[] = [];
        model.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
        });
        for (const mesh of meshes) {
          let isTerrain = mesh.name === "Terrain";
          let p: THREE.Object3D | null = mesh.parent;
          while (!isTerrain && p && p !== model) {
            if (p.name === "Terrain") isTerrain = true;
            p = p.parent;
          }
          if (isTerrain) {
            mesh.material = contourMat;
          } else {
            mesh.visible = false;
          }
          const wire = new THREE.Mesh(mesh.geometry, wireMat);
          wire.raycast = () => {}; // overlay shouldn't intercept picks
          mesh.add(wire);
        }
        mapModel = model;
        scene.add(model);
      } catch (e) {
        // Model load failed (corrupt GLB?) — silently fall back to grid.
        console.warn("[HolographicMap] map model load failed:", e);
      }
    }

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
          bounds = { minX: minX - mx, maxX: maxX + mx, minZ: minZ - mz, maxZ: maxZ + mz };
          fitCamera(bounds);
        }
      }
    }

    function fitCamera(b: { minX: number; maxX: number; minZ: number; maxZ: number }) {
      const ctrl = api.value?.controls;
      const cam = api.value?.camera;
      if (!ctrl || !cam) return;
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      const w = b.maxX - b.minX;
      const d = b.maxZ - b.minZ;
      const span = Math.max(w, d, 200);
      const diagonal = Math.sqrt(w * w + d * d);
      ctrl.target.set(cx, 0, cz);
      ctrl.minDistance = span * 0.08;    // closest: see ship silhouettes
      ctrl.maxDistance = diagonal * 1.6; // farthest: whole map fits viewport
      ctrl.maxPolarAngle = Math.PI / 2.1;
      // Start closer — roughly half the default distance so islands fill
      // more of the viewport on open.
      cam.position.set(cx, span * 0.5, cz + span * 0.5);
      cam.lookAt(cx, 0, cz);
      ctrl.update();
    }

    /** Assign each ship trajectory its roster entry via the EntityCreate
     *  `shipId` (recovered from the state stream by the backend). Most shipIds
     *  are unique per match; when two players sail the same ship (mirror
     *  picks, bots), the collision is broken by spawn-side: centroids are
     *  computed from the unambiguous joins, and each ambiguous entity takes
     *  the same-side roster entry. Entities with no roster hit get `null` and
     *  fall back to the spawn-order team heuristic in `resolveMarkerContext`. */
    function resolveRosterAssignments(
      shipTrajs: EntityTrajectory[],
    ): Map<number, VehicleEntry | null> {
      const byShipId = new Map<number, VehicleEntry[]>();
      for (const v of props.vehicles) {
        const arr = byShipId.get(v.shipId) ?? [];
        arr.push(v);
        byShipId.set(v.shipId, arr);
      }
      const spawnOf = (t: EntityTrajectory) => ({
        x: t.kind?.initialX ?? t.samples[0]?.x ?? 0,
        z: t.kind?.initialZ ?? t.samples[0]?.z ?? 0,
      });
      const assignments = new Map<number, VehicleEntry | null>();
      const ambiguous: { traj: EntityTrajectory; entries: VehicleEntry[] }[] = [];
      for (const traj of shipTrajs) {
        const sid = traj.kind?.shipId;
        const entries = sid != null ? byShipId.get(sid) : undefined;
        if (entries && entries.length === 1) {
          assignments.set(traj.entityId, entries[0]);
        } else if (entries && entries.length > 1) {
          ambiguous.push({ traj, entries });
        } else {
          assignments.set(traj.entityId, null);
        }
      }
      if (ambiguous.length > 0) {
        let ax = 0, az = 0, an = 0, ex = 0, ez = 0, en = 0;
        // Roster entries already taken by unique joins — ambiguous picks must
        // not steal them, and two ambiguous entities must not share an entry.
        const claimed = new Set<VehicleEntry>();
        for (const traj of shipTrajs) {
          const a = assignments.get(traj.entityId);
          if (!a) continue;
          claimed.add(a);
          const s = spawnOf(traj);
          if (a.relation <= 1) { ax += s.x; az += s.z; an++; }
          else { ex += s.x; ez += s.z; en++; }
        }
        for (const { traj, entries } of ambiguous) {
          const unclaimed = entries.filter((e) => !claimed.has(e));
          let pick: VehicleEntry;
          if (an > 0 && en > 0) {
            const s = spawnOf(traj);
            const dAlly = (s.x - ax / an) ** 2 + (s.z - az / an) ** 2;
            const dEnemy = (s.x - ex / en) ** 2 + (s.z - ez / en) ** 2;
            const wantAlly = dAlly < dEnemy;
            pick =
              unclaimed.find((e) => (wantAlly ? e.relation <= 1 : e.relation > 1)) ??
              unclaimed[0] ??
              entries[0];
          } else {
            pick = unclaimed[0] ?? entries[0];
          }
          claimed.add(pick);
          assignments.set(traj.entityId, pick);
        }
      }
      return assignments;
    }

    /** Map each ship trajectory to its roster entry (for team role + ship
     *  model) via the precomputed roster assignments. When a trajectory has
     *  no matching roster entry (older replay, decode gap), the role falls
     *  back to the entity-id spawn-order heuristic: the client spawns team A
     *  before team B, so the first half of ships (by entity id) are treated
     *  as allies. Unresolved ships never claim the "self" role, so the
     *  recorder's own marker stays uniquely white. */
    function resolveMarkerContext(
      traj: EntityTrajectory,
      shipEntityIds: number[],
      assignments: Map<number, VehicleEntry | null>,
    ): { role: TeamRole; shipInfo: ShipInfo | null; entry: VehicleEntry | null } {
      const entry = assignments.get(traj.entityId) ?? null;
      let role: TeamRole;
      let shipInfo: ShipInfo | null;
      if (entry) {
        role = roleFromRelation(entry.relation);
        shipInfo = props.encyclopedia.get(entry.shipId) ?? null;
      } else {
        // Fallback: entity-id spawn order (team A spawns before team B).
        // Never "self" — only the exact match earns the recorder tint.
        const idx = shipEntityIds.indexOf(traj.entityId);
        const isAlly = idx >= 0 && idx < shipEntityIds.length / 2;
        role = isAlly ? "ally" : "enemy";
        shipInfo = null;
      }
      return { role, shipInfo, entry };
    }

    /** Build the trajectory lines + ship markers from the decoded data.
     *
     *  Each ship gets a colored trajectory line (team-tinted) and a marker.
     *  The marker starts as a small cone (instant, correct color), then an
     *  async GLB load swaps in the actual ship model (or a tier/nation/type
     *  fallback) tinted to the team color. If the model fails to load, the
     *  cone stays.
     *
     *  Also populates `shipLabels` — per-ship display data for the floating
     *  HTML labels overlaid on the canvas. Labels track player name, ship
     *  name, tier, type icon, role colour, and death state. */
    function rebuildActors() {
      clearActors();
      const scene = api.value?.scene;
      if (!scene || props.trajectories.length === 0) { shipLabels.value = []; return; }
      const epoch = markerEpoch;

      // Encyclopedia as the fallback pool for tier/nation/type resolution.
      const encSpecs: ShipModelSpec[] = [...props.encyclopedia.values()];

      // Ships = EntityCreate type 2 with a roster shipId (the reliable
      // marker), or enough position samples to be a real vessel rather than a
      // transient (planes/torpedoes have far fewer). Ships that sank early may
      // carry very few samples — the shipId join keeps them rendered and
      // counted in the scoreboard. Entities with zero position samples are
      // re-creation duplicates (leave+re-enter) with no usable data; skipping
      // them also prevents double-counting their player in the alive counter.
      // Sorted by entity id — the client spawns team A before team B, so this
      // order is the fallback team-split heuristic when a roster join fails.
      const isShip = (t: EntityTrajectory) =>
        t.kind?.entityType === 2 &&
        (t.samples.length >= 80 ||
          (t.kind?.shipId != null && t.samples.length > 0));
      const shipTrajs = props.trajectories.filter(isShip);
      const shipEntityIds = shipTrajs.map((t) => t.entityId).sort((a, b) => a - b);
      const assignments = resolveRosterAssignments(shipTrajs);

      // Smoke screens (entityType 4 = SmokeScreen): a translucent grey
      // cylinder at the smoke's current expanding point. WoWS smoke lasts
      // ~90s; without a destroy packet we hide each puff 90s after its last
      // recorded position update.
      const smokeTrajs = props.trajectories.filter(
        (t) => t.kind?.entityType === 4 && t.samples.length >= 2,
      );
      const smokeGeom = new THREE.CylinderGeometry(30, 30, 10, 16, 1);
      const smokeMat = new THREE.MeshBasicMaterial({
        color: 0x8b93a3,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      });
      for (const tr of smokeTrajs) {
        const mesh = new THREE.Mesh(smokeGeom, smokeMat);
        mesh.position.y = 2.5;
        mesh.visible = false;
        scene.add(mesh);
        // Exact expiry when the entity left the observed area (EntityLeave
        // 0x04); otherwise fall back to ~90s after the last recorded update.
        const leaveT = props.leavesMap[tr.entityId];
        smokeMeshes.push({
          mesh,
          traj: tr,
          endT: leaveT != null ? leaveT : tr.samples[tr.samples.length - 1].time + 90,
        });
      }

      // Shell flights reconstructed between a launch and its impact: for
      // every explosion find the nearest ship that was alive, within 15 km,
      // and pointed within ~25° of the impact at the estimated launch time;
      // draw a ballistic arc from its position to the impact point. Launch
      // time is estimated from distance with a ~800 m/s muzzle velocity.
      const shipForImpact = (e: ExplosionEvent) => {
        let best: { tr: EntityTrajectory; score: number; t0: number; h: number } | null = null;
        for (const tr of props.trajectories) {
          if (tr.kind?.entityType !== 2 || tr.samples.length < 8) continue;
          const s = sampleAt(tr, e.time);
          if (!s) continue;
          const dist = Math.hypot(s.x - e.x, s.z - e.z);
          if (dist > 15000) continue;
          const flightT = Math.min(8, Math.max(0.8, dist / 800));
          const t0 = e.time - flightT;
          const s0 = sampleAt(tr, t0);
          if (!s0) continue;
          const dx = e.x - s0.x;
          const dz = e.z - s0.z;
          const aim = Math.atan2(dx, dz);
          let dYaw = Math.abs(aim - s0.yaw);
          if (dYaw > Math.PI) dYaw = 2 * Math.PI - dYaw;
          if (dYaw > 0.45) continue; // ~25°
          const score = dist + dYaw * 4000;
          if (!best || score < best.score) {
            best = { tr, score, t0, h: Math.min(320, dist * 0.12) };
          }
        }
        return best;
      };
      const flashGeom = new THREE.SphereGeometry(20, 10, 10);
      const flashMat = new THREE.MeshBasicMaterial({
        color: 0xffe08a,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      });
      const flashHaloGeom = new THREE.SphereGeometry(46, 10, 10);
      const flashHaloMat = new THREE.MeshBasicMaterial({
        color: 0xffb347,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      });
      const curvePts = new Float32Array(28 * 3);
      // Shared cone geometry for in-flight shells (tip pointing +Y; oriented
      // along the trajectory tangent each frame for a smooth補间).
      const shellGeom = new THREE.ConeGeometry(3, 12, 8);
      // The enemy ship nearest the impact point at impact time, INSIDE the
      // launch-direction cone — arcs end at the TARGET SHIP (not the bare
      // water splash) so they read as fire against the opposing fleet. The
      // cone keeps the endpoint on the shell's actual heading: a nearby enemy
      // that is off to the side must not bend the arc sideways.
      const targetShipAt = (e: ExplosionEvent, from: { x: number; z: number }) => {
        let best: { x: number; z: number } | null = null;
        let bestD = 500;
        const baseAim = Math.atan2(e.x - from.x, e.z - from.z);
        for (const tr of props.trajectories) {
          if (tr.kind?.entityType !== 2 || resolveRoleQuick(tr) !== "enemy") continue;
          const s = sampleAt(tr, e.time);
          if (!s) continue;
          const d = Math.hypot(s.x - e.x, s.z - e.z);
          if (d > bestD) continue;
          const aim = Math.atan2(s.x - from.x, s.z - from.z);
          let dAim = Math.abs(aim - baseAim);
          if (dAim > Math.PI) dAim = 2 * Math.PI - dAim;
          if (dAim > 0.35) continue; // ~20° cone around the launch heading
          bestD = d;
          best = { x: s.x, z: s.z };
        }
        return best;
      };
      for (const e of props.explosions) {
        const match = shipForImpact(e);
        if (!match) continue;
        // Per-ammo colors: HE yellow, AP silver, SAP grey.
        const ammo = shellAmmoOf(e.paramsId);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(curvePts, 3));
        // Manual BufferGeometry has no bounding sphere; without computing one
        // (or disabling culling) the frustum culler skips these lines.
        geom.computeBoundingSphere();
        const mat = new THREE.LineBasicMaterial({
          color: ammo.color,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        });
        const line = new THREE.Line(geom, mat);
        line.visible = false;
        scene.add(line);
        // Same curve rendered as fixed-pixel points so the flight reads even
        // at full-map zoom (a 1px line vanishes at that distance).
        const dotGeo = new THREE.BufferGeometry();
        dotGeo.setAttribute("position", new THREE.BufferAttribute(curvePts, 3));
        dotGeo.computeBoundingSphere();
        const dotMat = new THREE.PointsMaterial({
          color: ammo.color,
          size: 3.5,
          sizeAttenuation: false,
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
        });
        const dots = new THREE.Points(dotGeo, dotMat);
        dots.visible = false;
        scene.add(dots);
        // In-flight shell: a pointed cone sliding along the arc (interpolated
        // every frame so playback looks smooth).
        const shellMat = new THREE.MeshBasicMaterial({
          color: ammo.color,
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
        });
        const shell = new THREE.Mesh(shellGeom, shellMat);
        shell.visible = false;
        scene.add(shell);
        const flash = new THREE.Mesh(flashGeom, flashMat);
        flash.position.set(e.x, 1, -e.z);
        flash.visible = false;
        scene.add(flash);
        const flashHalo = new THREE.Mesh(flashHaloGeom, flashHaloMat);
        flashHalo.position.set(e.x, 1, -e.z);
        flashHalo.visible = false;
        scene.add(flashHalo);
        const target = targetShipAt(e, {
          x: sampleAt(match.tr, match.t0)?.x ?? e.x,
          z: sampleAt(match.tr, match.t0)?.z ?? e.z,
        });
        shellTraces.push({
          line,
          dots,
          flash,
          halo: flashHalo,
          shell,
          color: ammo.color,
          t0: match.t0,
          t1: e.time,
          // Launch point is fixed at the firing ship's position at t0 — using
          // the live playhead position would drag the whole arc (and the
          // shell) across the map as playback moves on.
          from: () => {
            const s = sampleAt(match.tr, match.t0);
            return s ? new THREE.Vector3(s.x, 0, -s.z) : null;
          },
          to: new THREE.Vector3(target?.x ?? e.x, 0, -(target?.z ?? e.z)),
          h: match.h,
        });
      }
      trajectoryLines.push(...shellTraces.map((st) => st.line));

      // Torpedoes: straight white capsules from the firing ship's position at
      // launch time along the launch direction. Speed ~33 m/s (60 knots);
      // visible until 8 km of travel (or match end). Each torpedo carries a
      // long white wake line so it reads at full-map zoom.
      const torpedoGeom = new THREE.CapsuleGeometry(3, 12, 2, 8);
      const torpedoMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      });
      const wakeGeom = new THREE.BufferGeometry();
      wakeGeom.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(6), 3),
      );
      const wakeMat = new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      });
      for (const tp of props.torpedoes) {
        const traj = props.trajectories.find((tr) => tr.entityId === tp.entityId);
        const s = traj ? sampleAt(traj, tp.time) : null;
        if (!s) continue;
        const mesh = new THREE.Mesh(torpedoGeom, torpedoMat);
        const wake = new THREE.Line(wakeGeom, wakeMat);
        mesh.visible = false;
        wake.visible = false;
        scene.add(mesh);
        scene.add(wake);
        torpedoMeshes.push({
          mesh,
          wake,
          t0: tp.time,
          life: 240,
          base: new THREE.Vector3(s.x, 0, -s.z),
          dir: new THREE.Vector3(tp.dirX, 0, -tp.dirZ).normalize(),
        });
      }

      // Swap the primitive placeholders for the real game models (baked GLBs
      // from scripts/model_convert/bake_planes.py). Each swap keeps driving
      // the replacement exactly like the primitive it replaces.
      const shellPropUrl = resolvePropModelUrl("shell");
      if (shellPropUrl) {
        for (const st of shellTraces) {
          buildPropMarker({ url: shellPropUrl, color: st.color, axis: "y", targetLen: 9 })
            .then((g) => {
              if (epoch !== markerEpoch || !api.value?.scene) return;
              g.visible = st.shell.visible;
              g.position.copy(st.shell.position);
              g.quaternion.copy(st.shell.quaternion);
              scene.add(g);
              scene.remove(st.shell);
              st.shell = g;
            })
            .catch(() => { /* keep the cone fallback */ });
        }
      }
      const torpedoPropUrl = resolvePropModelUrl("torpedo");
      if (torpedoPropUrl) {
        for (const tm of torpedoMeshes) {
          buildPropMarker({ url: torpedoPropUrl, color: 0xffffff, axis: "y", targetLen: 14, opacity: 1 })
            .then((g) => {
              if (epoch !== markerEpoch || !api.value?.scene) return;
              g.visible = tm.mesh.visible;
              g.position.copy(tm.mesh.position);
              g.quaternion.copy(tm.mesh.quaternion);
              scene.add(g);
              scene.remove(tm.mesh);
              tm.mesh = g;
            })
            .catch(() => { /* keep the capsule fallback */ });
        }
      }

      // Reusable explosion rings for shell impacts / splashes.
      const ringGeomFx = new THREE.RingGeometry(0.35, 1, 24);
      const ringMatFx = new THREE.MeshBasicMaterial({
        color: 0xffe08a,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      for (let i = 0; i < 20; i++) {
        const ring = new THREE.Mesh(ringGeomFx, ringMatFx);
        ring.visible = false;
        ring.rotation.x = -Math.PI / 2;
        scene.add(ring);
        explosionFx.push({ ring, born: -1 });
      }

      // Recorder aim line: thin line from the own ship to the locked target
      // entity (SetWeaponLock 0x30 timeline), updated per frame. Same render
      // path as shell traces (line + bounding sphere) which is known-good.
      if (props.weaponLocks.length > 0) {
        const lockGeom = new THREE.BufferGeometry();
        lockGeom.setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(6), 3),
        );
        lockGeom.computeBoundingSphere();
        const lockMat = new THREE.LineBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.8,
          depthWrite: false,
        });
        const line = new THREE.Line(lockGeom, lockMat);
        line.visible = false;
        scene.add(line);
        // Big ring over the locked target so the lock reads at full-map zoom.
        // RingGeometry + scale (same render path as the splash rings, which
        // are known to render; plain torus meshes don't show in this scene).
        const ringGeom = new THREE.RingGeometry(0.35, 1, 32);
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xffcc33,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const ring = new THREE.Mesh(ringGeom, ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.visible = false;
        scene.add(ring);
        lockRing = ring;
        lockLine = line as unknown as THREE.Mesh;
      }

      // Aircraft squadrons: one model per plane, positions come from the
      // avatar's receive_updateSquadron stream. Each update packet carries
      // one sample per aircraft (index 0..count-1), so (planeId, index)
      // uniquely identifies a single plane — a squadron of N planes becomes
      // N trails instead of one.
      const byPlane = new Map<number, SquadronPlane[]>();
      for (const sp of props.squadronPlanes) {
        const key = sp.planeId * 16 + (sp.index ?? 0);
        let list = byPlane.get(key);
        if (!list) {
          list = [];
          byPlane.set(key, list);
        }
        list.push(sp);
      }
      planeTrails = [...byPlane.entries()].map(([id, samples]) => ({
        id,
        samples: samples.sort((a, b) => a.time - b.time),
      }));
      // (planeId, index) → aircraft type (via the squadron create's
      // paramsId). Trails keyed by planeId*16+index, so every formation
      // member maps to its squadron's type.
      planeTypesById.clear();
      for (const c of props.squadronCreates) {
        const type = PLANE_TYPES[String(c.paramsId)]?.type ?? "attack";
        const index = PLANE_TYPES[String(c.paramsId)]?.index;
        for (let i = 0; i < 16; i++) {
          planeTypesById.set(c.planeId * 16 + i, type);
          if (index) planeIndexById.set(c.planeId * 16 + i, index);
        }
      }
      if (planeTrails.length > 0) {
        const colors = new Float32Array(planeTrails.length * 3);
        for (let i = 0; i < planeTrails.length; i++) {
          // Team colour (ally green / enemy red) instead of per-type tint —
          // the HUD paints aircraft by allegiance, not by airframe.
          const planeId = Math.floor(planeTrails[i].id / 16);
          const role = planeRoleById.get(planeId) ?? "enemy";
          const c = new THREE.Color(TEAM_COLOR[role as TeamRole] ?? 0x78d2ff);
          colors[i * 3] = c.r;
          colors[i * 3 + 1] = c.g;
          colors[i * 3 + 2] = c.b;
        }
        const pg = new THREE.BufferGeometry();
        pg.setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(planeTrails.length * 3), 3),
        );
        pg.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        pg.computeBoundingSphere();
        const pm = new THREE.PointsMaterial({
          size: 5,
          sizeAttenuation: false,
          vertexColors: true,
        });
        const points = new THREE.Points(pg, pm);
        points.visible = false;
        scene.add(points);
        planeCloud = points;
      }

      // Real aircraft models: per FORMATION (one GLB clone per squadron slot —
      // the GameParams squadron size, e.g. 8), arranged in a wedge each frame.
      // Trails whose model fails/misses keep the Points fallback.
      planeMeshes.clear();
      planeFormations.clear();
      {
        // Group trails by planeId first.
        const byPlane = new Map<number, { idx: string; role: string; count: number; trail: EntityTrajectory }[]>();
        for (const trail of planeTrails) {
          const planeId = Math.floor(trail.id / 16);
          const idx = planeIndexById.get(trail.id);
          if (!idx) continue;
          const role = planeRoleById.get(planeId) ?? "enemy";
          let list = byPlane.get(planeId);
          if (!list) {
            list = [];
            byPlane.set(planeId, list);
          }
          const typeKey = PLANE_TYPES[String(
            props.squadronCreates.find((c) => c.planeId === planeId)?.paramsId,
          )];
          const count = (typeKey?.count ?? 3);
          if (list.length === 0) {
            planeFormations.set(planeId, { count, meshes: [] });
          }
          list.push({ idx, role, count, trail });
        }
        const seenKey = new Set<string>();
        for (const [planeId, entries] of byPlane) {
          const first = entries[0];
          const url = resolvePlaneModelUrl(first.idx);
          if (!url) continue;
          const seen = `${first.idx}:${first.role}`;
          const build = seenKey.has(seen)
            ? null
            : buildPropMarker({
                url,
                color: TEAM_COLOR[first.role as TeamRole] ?? 0x78d2ff,
                axis: "z",
                targetLen: 7,
                opacity: 0.95,
              }).catch(() => null);
          seenKey.add(seen);
          if (!build) continue;
          const formation = planeFormations.get(planeId)!;
          build.then((proto) => {
            if (epoch !== markerEpoch || !api.value?.scene || !proto) return;
            if (planeMeshes.has(planeId)) return;
            const pool: THREE.Object3D[] = [];
            for (let i = 0; i < formation.count; i++) {
              const inst = proto.clone(true);
              inst.userData.sharedGeometry = true;
              inst.visible = false;
              scene.add(inst);
              pool.push(inst);
            }
            planeMeshes.set(planeId, pool);
          });
        }
      }

      const newLabels: ShipLabel[] = [];

      for (const traj of props.trajectories) {
        if (traj.samples.length < 2) continue;
        // Only render ships (EntityCreate type 2 with many samples); skip
        // zones/avatars/planes/torpedoes.
        if (!isShip(traj)) continue;

        const { role, shipInfo, entry: rosterEntry } = resolveMarkerContext(
          traj,
          shipEntityIds,
          assignments,
        );
        const color = TEAM_COLOR[role];
        const offline = shipOfflineEntry(rosterEntry?.shipId ?? traj.kind?.shipId);
        const shipType = shipInfo?.type ?? offline?.type ?? null;

        // Marker: small cone + sphere so the heading is visible even before
        // the ship model loads. Cone points +Z (forward) at yaw 0.
        const marker = new THREE.Group();
        const coneGeom = new THREE.ConeGeometry(7, 18, 6);
        const coneMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7 });
        const cone = new THREE.Mesh(coneGeom, coneMat);
        cone.rotation.x = Math.PI / 2; // cone tip along +Z
        cone.position.z = 6; // shift forward so sphere is behind the tip
        marker.add(cone);
        const dotGeom = new THREE.SphereGeometry(8, 10, 6);
        const dotMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5 });
        const dot = new THREE.Mesh(dotGeom, dotMat);
        dot.position.z = 0;
        marker.add(dot);
        marker.userData.entityId = traj.entityId;
        marker.userData.role = role;
        marker.userData.type = shipType;
        marker.userData.modelLoaded = false;
        marker.userData.isDot = true;
        marker.userData.deathTime = traj.deathTime ?? null;
        marker.userData.spawnX = traj.kind?.initialX ?? 0;
        marker.userData.spawnZ = traj.kind?.initialZ ?? 0;
        // Opening-phase ghost: a thin team-coloured ring at the enemy's spawn
        // point (the game briefly lights spawns up at start), removed from
        // the scene after the countdown.
        if (role === "enemy") {
          const ghostMat = new THREE.MeshBasicMaterial({
            color: 0xcc3333,
            transparent: true,
            opacity: 0.45,
            depthWrite: false,
            side: THREE.DoubleSide,
          });
          const ghost = new THREE.Mesh(new THREE.RingGeometry(26, 34, 28), ghostMat);
          ghost.rotation.x = -Math.PI / 2;
          ghost.position.set(traj.kind?.initialX ?? 0, 3, -(traj.kind?.initialZ ?? 0));
          ghost.visible = false;
          scene.add(ghost);
          marker.userData.ghost = ghost;
        }
        marker.visible = false;
        scene.add(marker);
        shipMarkers.push(marker);

        const modelUrl =
          resolveShipModelForEntry(shipInfo, encSpecs) ??
          (rosterEntry?.shipId != null
            ? resolveShipModelByShipId(rosterEntry.shipId)
            : null);
        if (!modelUrl) {
          console.warn(`[HolographicMap] no model URL for entity ${traj.entityId}`
            + ` (ship: ${shipInfo?.name ?? "?"}, shipId: ${rosterEntry?.shipId}, encyclopedia: ${encSpecs.length} entries)`);
        }
        if (modelUrl) {
          buildShipMarker({ url: modelUrl, role })
            .then((shipModel) => {
              if (epoch !== markerEpoch || !api.value?.scene) return;
              for (const child of [...marker.children]) {
                marker.remove(child);
                child.traverse((o) => {
                  if (o instanceof THREE.Mesh) {
                    o.geometry.dispose();
                    (o.material as THREE.Material).dispose();
                  }
                });
              }
              marker.add(shipModel);
              marker.userData.modelLoaded = true;
              marker.userData.isDot = false;
              // Re-run the per-frame visibility rules (opening-phase enemy
              // hiding, creation time) instead of forcing the marker on.
              updateMarkersAt(current.value);
              initMarkerPosition(marker, traj, current.value);
              updateLabelPositions();
            })
            .catch((e) => {
              console.warn(`[HolographicMap] failed to load marker model for entity ${traj.entityId}:`, e);
            });
        }

        const name = rosterEntry?.name ?? `#${traj.entityId}`;
        const encStore = useEncyclopediaStore();
        const dataLang = useLanguage().dataLanguage.value;
        // Name/tier/type: the WG encyclopedia when it knows the ship, else the
        // complete offline DB (GameParams + game gettext catalogs — covers
        // event/clone ships), else the baked model DB's English base name.
        const shipName =
          (shipInfo ? encStore.shipDisplayName(shipInfo) : null) ??
          shipNameFromOfflineDb(rosterEntry?.shipId ?? traj.kind?.shipId, dataLang) ??
          rosterEntry?.shipName ??
          shipInfo?.name ??
          shipNameFromModelDb(rosterEntry?.shipId ?? traj.kind?.shipId) ??
          "?";
        // Max HP: the peak of the entity's own HP stream — authoritative for
        // the battle's actual scaling (event/asymmetric modes cut bot HP to a
        // fraction of the encyclopedia hull value; upgraded hulls raise it).
        // Ships without any HP stream fall back to the encyclopedia hull value
        // so their label still shows a (static) health line.
        const streamMax =
          traj.hpSamples && traj.hpSamples.length > 0
            ? Math.max(...traj.hpSamples.map((s) => s.value))
            : null;
        const dp = shipInfo?.defaultProfile as
          | Record<string, Record<string, unknown>>
          | undefined;
        const encHealth =
          dp?.hull?.health != null && typeof dp.hull.health === "number"
            ? dp.hull.health
            : null;
        // Fallback chain: battle stream (authoritative) → encyclopedia hull →
        // offline DB hull HP (GameParams) → none (label hides the HP row).
        const maxHp = streamMax ?? encHealth ?? offline?.hp ?? null;
        newLabels.push({
          entityId: traj.entityId,
          role,
          name,
          shipName,
          tier: shipInfo?.tier ?? offline?.tier ?? null,
          type: shipInfo?.type ?? offline?.type ?? null,
          hp: maxHp,
          maxHp,
          x: 0, y: 0,
          visible: false,
          dead: false,
        });
      }
      // Aircraft labels: ONE card per controlling carrier (aircraft squadrons
      // re-launch constantly — 100+ sorties in a carrier match — so per-
      // squadron cards would explode the UI). The card shows the carrier's
      // name + HP with the plane-type icon. A squadron's carrier is the ship
      // nearest its FIRST create position (the create fires on the deck at
      // launch; later creates are mid-air sortie positions).
      planeLabelCarriers.clear();
      planeRoleById.clear();
      const planeCarrierOf = new Map<number, number | null>();
      const createFirst = new Map<number, { x: number; z: number; time: number; paramsId: number }>();
      for (const c of props.squadronCreates) {
        if (!createFirst.has(c.planeId)) {
          createFirst.set(c.planeId, { x: c.x, z: c.z, time: c.time, paramsId: c.paramsId });
        }
      }
      for (const [planeId, first] of createFirst) {
        // Match against the ship's position AT LAUNCH TIME (ships move — the
        // current playhead position would pair a sortie with the wrong ship).
        let carrierId: number | null = null;
        let bestD = 1500;
        for (const m of shipMarkers) {
          const tr = props.trajectories.find((t) => t.entityId === m.userData.entityId);
          if (!tr) continue;
          const s = sampleAt(tr, first.time);
          if (!s) continue;
          const dx = s.x - first.x;
          const dz = s.z - first.z;
          const d = Math.hypot(dx, dz);
          if (d < bestD) {
            bestD = d;
            carrierId = m.userData.entityId as number;
          }
        }
        planeCarrierOf.set(planeId, carrierId);
        const carrierMarker = carrierId == null
          ? null
          : shipMarkers.find((m) => m.userData.entityId === carrierId);
        planeRoleById.set(planeId, carrierMarker?.userData.role ?? "enemy");
        const firstCreate = props.squadronCreates.find((c) => c.planeId === planeId);
        const planeIdx = PLANE_TYPES[String(firstCreate?.paramsId)]?.index;
        if (planeIdx) planeIndexById.set(planeId * 16, planeIdx);
      }
      // One label per carrier that controls any aircraft.
      const carriersOfPlanes = new Map<number, { paramsId: number }>();
      for (const [planeId, carrierId] of planeCarrierOf) {
        if (carrierId == null) continue;
        const first = createFirst.get(planeId)!;
        const acc = carriersOfPlanes.get(carrierId) ?? { paramsId: first.paramsId };
        carriersOfPlanes.set(carrierId, acc);
      }
      for (const [carrierId, info] of carriersOfPlanes) {
        const planeType = PLANE_TYPES[String(info.paramsId)]?.type ?? "attack";
        newLabels.push({
          entityId: 2_000_000_000 + Number(carrierId),
          role: "self",
          name: "",
          shipName: "",
          tier: null,
          type: null,
          kind: "plane",
          planeType,
          hp: null,
          maxHp: null,
          x: 0, y: 0,
          visible: false,
          dead: false,
        });
        planeLabelCarriers.set(2_000_000_000 + Number(carrierId), carrierId);
      }
      // Keep a per-plane → labelId map for the per-frame position update.
      planeLabelOfPlane.clear();
      for (const [planeId, carrierId] of planeCarrierOf) {
        if (carrierId != null) {
          planeLabelOfPlane.set(planeId, 2_000_000_000 + Number(carrierId));
        }
      }
      shipLabels.value = newLabels;

      // Capture zones: entityType 14 circles on the XZ plane.
      // Capture zones are static and may have no position samples; use the
      // initial position from EntityCreate metadata. Points that share the
      // same center (concentric inner/outer-ring layouts, e.g. two cap zones
      // on one spot) are merged visually: their rings are pushed side by side
      // with tiered radii so both letters stay readable instead of stacking
      // on top of each other. The number of points is data-driven (PvE
      // scenarios create new points mid-battle).
      // Only real domination points (those with an ownership/progress stream)
      // get 3D rings + letters — non-capture InteractiveZones are filtered by
      // capZones. The number of points is data-driven (PvE scenarios create
      // new points mid-battle).
      const capEntries = capZones.value.map((t, idx) => ({
        x: t.kind!.initialX,
        z: t.kind!.initialZ,
        radius: t.kind!.radius ?? 60,
        order: idx,
      }));
      if (capEntries.length === 0) {
        console.warn("[HolographicMap] no capture zone data found in trajectory kinds");
      }
      // Group by shared center (within 30 m).
      const groups: { x: number; z: number; members: { x: number; z: number; radius: number; order: number }[] }[] = [];
      for (const e of capEntries) {
        const g = groups.find(
          (gr) => Math.abs(gr.x - e.x) < 30 && Math.abs(gr.z - e.z) < 30,
        );
        if (g) g.members.push(e);
        else groups.push({ x: e.x, z: e.z, members: [e] });
      }
      groups.sort((a, b) => a.members[0].order - b.members[0].order);
      let letterIdx = 0;
      for (const g of groups) {
        const n = g.members.length;
        for (let k = 0; k < n; k++) {
          // Concentric group: offset each member along x, outer ring larger.
          const spread = n > 1 ? 55 * (k - (n - 1) / 2) : 0;
          const radius = n > 1 ? 52 - k * 14 : g.members[k].radius;
          const cx = g.x + spread;
          const cz = g.z;
          const ringGeom = new THREE.TorusGeometry(radius, 1.2, 8, 48);
          const ringMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.35,
            depthWrite: false,
          });
          const ring = new THREE.Mesh(ringGeom, ringMat);
          ring.rotation.x = Math.PI / 2;
          ring.position.set(cx, 0.6, -cz);
          scene.add(ring);
          trajectoryLines.push(ring as unknown as THREE.Line);
          capRings.push(ring);
          const canvas = document.createElement("canvas");
          canvas.width = 64;
          canvas.height = 64;
          const ctx = canvas.getContext("2d")!;
          ctx.fillStyle = "rgba(255,255,255,0.8)";
          ctx.font = "bold 48px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String.fromCharCode(65 + letterIdx++), 32, 32);
          const tex = new THREE.CanvasTexture(canvas);
          const spriteMat = new THREE.SpriteMaterial({
            map: tex,
            transparent: true,
            depthWrite: false,
          });
          const sprite = new THREE.Sprite(spriteMat);
          sprite.position.set(cx, 30, -cz);
          sprite.scale.set(40, 40, 1);
          scene.add(sprite);
          trajectoryLines.push(sprite as unknown as THREE.Line);
        }
      }
    }

    /** Set a freshly-loaded marker to the correct world position at the current
     *  playback time so it snaps to the right spot immediately. */
    function initMarkerPosition(
      marker: THREE.Group,
      traj: EntityTrajectory,
      t: number,
    ) {
      const s = sampleAt(traj, t);
      if (s) {
        marker.position.set(s.x, 0, -s.z);
        // WoWS yaw: 0=north(+worldZ), clockwise. three.js north is -z, so the
        // yaw maps to rotation.y = PI - yaw on the mirrored coordinate frame.
        marker.rotation.y = Math.PI - s.yaw;
        marker.userData.yaw = s.yaw;
      }
    }

    /** Find the last HP value at or before time t. */
    function hpAtTime(samples: HpSample[] | undefined, t: number): number | null {
      if (!samples || samples.length === 0) return null;
      let last: number = samples[0].value;
      for (const s of samples) {
        if (s.time > t) break;
        last = s.value;
      }
      return last;
    }

    /** Linear-interpolated capture progress (0..1000) at time t. */
    function progressAtTime(samples: HpSample[] | undefined, t: number): number | null {
      if (!samples || samples.length === 0) return null;
      if (t <= samples[0].time) return samples[0].value;
      for (let i = 0; i < samples.length - 1; i++) {
        const a = samples[i];
        const b = samples[i + 1];
        if (t >= a.time && t <= b.time) {
          const k = b.time === a.time ? 0 : (t - a.time) / (b.time - a.time);
          return a.value + (b.value - a.value) * k;
        }
      }
      return samples[samples.length - 1].value;
    }

    /** Position + orient each ship marker at the current playback time.
     *  Ships whose model hasn't loaded yet are skipped; ships that have been
     *  destroyed (time ≥ deathTime) are frozen at their last position and
     *  their materials desaturated to a faint grey tint. */
    function updateMarkersAt(t: number) {
      const labels = shipLabels.value;
      // Alive counts are recomputed every frame from the markers' death times
      // (not incremented) so scrubbing backward restores sunk ships.
      let allyAliveNow = 0;
      let enemyAliveNow = 0;
      for (const m of shipMarkers) {
        const dt = m.userData.deathTime as number | null;
        if (dt == null || t < dt) {
          const role = m.userData.role as TeamRole;
          if (role === "ally" || role === "self") allyAliveNow++;
          else if (role === "enemy") enemyAliveNow++;
        }
      }
      allyAlive.value = allyAliveNow;
      enemyAlive.value = enemyAliveNow;
      for (let i = 0; i < shipMarkers.length; i++) {
        const marker = shipMarkers[i];
        const label = labels[i];
        const entityId = marker.userData.entityId as number;
        const traj = props.trajectories.find((tr) => tr.entityId === entityId);
        if (!traj || traj.samples.length === 0) {
          marker.visible = false;
          if (label) label.visible = false;
          continue;
        }
        // Opening phase: enemies are not yet visible — but their SPAWN
        // positions are known from EntityCreate (the game briefly lights them
        // up at start). Show a ghost marker at the spawn point so the opener
        // still has a coordinate reference; the ghost hides after the
        // countdown.
        const role = marker.userData.role as TeamRole;
        if (role === "enemy" && t < OPENING_HIDE_T) {
          const ghost = marker.userData.ghost as THREE.Mesh | undefined;
          if (ghost) {
            ghost.visible = true;
            ghost.position.set(traj.kind?.initialX ?? 0, 3, -(traj.kind?.initialZ ?? 0));
          }
          marker.visible = false;
          if (label) label.visible = false;
          continue;
        }
        // Past the opening phase, ghost rings never show again.
        const ghost = marker.userData.ghost as THREE.Mesh | undefined;
        if (ghost) ghost.visible = false;
        // Hide entities that haven't been created yet at this time. Entities
        // re-created mid-match (leaving/re-entering the observed area) may
        // carry a later creationTime than their first sample — trust the
        // samples in that case.
        const created = traj.kind?.creationTime ?? -1;
        const firstT = traj.samples[0]?.time ?? Infinity;
        if (created >= 0 && t < created && t < firstT) {
          marker.visible = false;
          if (label) label.visible = false;
          continue;
        }
        // After death the ship is gone from the water: hide the marker and
        // label entirely (the minimap still shows a grey dot).
        const deathTime = marker.userData.deathTime as number | null;
        const dead = deathTime != null && t >= deathTime;
        if (label) label.dead = dead;
        const tEff = dead ? deathTime! : t;
        const s = sampleAt(traj, tEff);
        if (!s) {
          marker.visible = false;
          if (label) label.visible = false;
          continue;
        }
        // Show the dot marker even before the ship model loads; hide only
        // when model is missing entirely (not dot, not loaded).
        const hasModel = marker.userData.modelLoaded as boolean;
        const hasDot = marker.userData.isDot as boolean;
        if (!hasModel && !hasDot) continue;
        if (dead) {
          // Sunk: remove from the 3D scene.
          marker.visible = false;
          if (label) label.visible = false;
          if (!marker.userData._countedDead) {
            marker.userData._countedDead = true;
            const role = marker.userData.role as TeamRole;
            // Kill feed + score tick. The killer is unknown from the replay
            // stream, so the feed names the victim only.
            if (!reportedSinks.has(entityId)) {
              reportedSinks.add(entityId);
              const who = label?.name ?? `#${entityId}`;
              const victimRole = role === "ally" ? "enemy" : "ally";
              const feedId = ++killSeq;
              killFeed.value.unshift({
                id: feedId,
                text: who,
                role: victimRole,
              });
              if (killFeed.value.length > 4) killFeed.value.pop();
              window.setTimeout(() => {
                killFeed.value = killFeed.value.filter((k) => k.id !== feedId);
              }, 4000);
            }
          }
          continue;
        }
        marker.visible = true;
        marker.position.set(s.x, 0, -s.z);
        marker.rotation.y = Math.PI - s.yaw;
        if (label) {
          const currentHp = hpAtTime(traj.hpSamples, tEff);
          if (currentHp != null) label.hp = currentHp;
          label.maxHp ??= currentHp ?? label.maxHp;
        }
      }
      // Capture-zone ownership + estimated score at this instant.
      updateCapsAndScore(t);
      // Repaint the 3D cap rings by live state (owner color, capture pulse).
      capDisplay.value.forEach((c, i) => {
        const ring = capRings[i];
        if (!ring) return;
        const mat = ring.material as THREE.MeshBasicMaterial;
        if (c.owner === 1) mat.color.set(0x4ade80);
        else if (c.owner === 2) mat.color.set(0xcc3333);
        else mat.color.set(0xffffff);
        mat.opacity = c.capturing ? 0.7 : c.contested ? 0.5 : 0.35;
      });
      // Smoke screens at their current expanding point (visible for 90s
      // after the last recorded update).
      for (const sm of smokeMeshes) {
        const s = sampleAt(sm.traj, t);
        const created = (sm.traj.kind?.creationTime ?? -1) >= 0 ? t >= sm.traj.kind!.creationTime : true;
        const alive = s != null && created && t <= sm.endT;
        sm.mesh.visible = alive;
        if (alive && s) sm.mesh.position.set(s.x, 2.5, -s.z);
      }
      // Aircraft formations: full squadrons (GameParams size, e.g. 8 planes)
      // arranged in a wedge and slowly circling. Modeled formations drive
      // their GLB pool; the rest fall back to Points.
      {
        const attr = planeCloud
          ? (planeCloud.geometry.getAttribute("position") as THREE.BufferAttribute)
          : null;
        const arr = attr ? (attr.array as Float32Array) : null;
        let anyPoints = false;
        // Sample helper: last sample at or before t.
        const sampleOf = (samples: SquadronPlane[]): SquadronPlane | null => {
          let s: SquadronPlane | null = null;
          for (const sp of samples) {
            if (sp.time > t) break;
            s = sp;
          }
          return s;
        };
        // Formation anchors: index-0 trail of each planeId (position + yaw),
        // alive between its first update and ~2 min after the last one.
        const formationAnchor = new Map<number, { s: SquadronPlane; born: number; expiry: number }>();
        for (const trail of planeTrails) {
          const planeId = Math.floor(trail.id / 16);
          if (trail.id % 16 !== 0) continue;
          const s = sampleOf(trail.samples);
          if (!s) continue;
          const born = trail.samples[0].time;
          const expiry = trail.samples[trail.samples.length - 1].time + 120;
          if (t >= born && t <= expiry) {
            formationAnchor.set(planeId, { s, born, expiry });
          }
        }
        for (const [planeId, anchor] of formationAnchor) {
          const pool = planeMeshes.get(planeId);
          const formation = planeFormations.get(planeId);
          const count = formation?.count ?? 3;
          // Slow circle so airborne squadrons visibly hold a patrol orbit.
          const ang = t * 0.22 + (planeId % 7) * 0.9;
          const R = 50;
          const cx = anchor.s.x + Math.cos(ang) * R;
          const cz = anchor.s.z + Math.sin(ang) * R;
          const yaw = anchor.s.yaw;
          const fwd = { x: Math.sin(yaw), z: -Math.cos(yaw) };
          const right = { x: Math.cos(yaw), z: Math.sin(yaw) };
          const yBase = Math.max(60, anchor.s.y);
          if (pool && pool.length >= count) {
            for (let i = 0; i < count; i++) {
              const mesh = pool[i];
              mesh.visible = true;
              // Wedge (梯形): leader ahead, pairs stepping back on both sides.
              let ox = 0, oz = 0;
              if (i > 0) {
                const row = Math.ceil(i / 2);
                const side = i % 2 === 1 ? -1 : 1;
                const spacing = 26;
                const depth = 22;
                ox = side * row * spacing * right.x - row * depth * fwd.x;
                oz = side * row * spacing * right.z - row * depth * fwd.z;
              }
              mesh.position.set(cx + ox, yBase + (i % 2) * 2, -cz + oz);
              mesh.rotation.y = Math.PI - yaw;
            }
          } else {
            // No model pool (yet): fall back to a point at the anchor.
            if (arr) {
              arr[(planeId % 16) * 3] = cx;
              arr[(planeId % 16) * 3 + 1] = yBase;
              arr[(planeId % 16) * 3 + 2] = -cz;
              anyPoints = true;
            }
          }
        }
        // Hide pools of formations currently not anchored.
        for (const [planeId, pool] of planeMeshes) {
          if (formationAnchor.has(planeId)) continue;
          for (const m of pool) m.visible = false;
        }
        if (planeCloud && attr) {
          planeCloud.visible = anyPoints;
          attr.needsUpdate = true;
        }
      }
      // Shell traces: ballistic arc from the firing ship (updated live) to
      // the impact point, shown during [t0, t1]; the impact flash lingers
      // 1s past the impact. The in-flight shell cone is interpolated along
      // the arc every frame (smooth補间 during playback).
      // Elements outside the fitted battle bounds are stray data — hidden so
      // they can't flash out in empty space.
      const inBounds = (x: number, z: number) =>
        !bounds || (x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ);
      for (const st of shellTraces) {
        const inFlight = t >= st.t0 && t <= st.t1;
        const flashOn = t >= st.t1 && t <= st.t1 + 1;
        // Traces whose impact point lies outside the fitted battle bounds are
        // stray data — hide the whole trace so it can't flash out in space.
        const impactIn = inBounds(st.to.x, st.to.z);
        st.flash.visible = flashOn && impactIn;
        st.halo.visible = flashOn && impactIn;
        st.line.visible = inFlight && impactIn;
        st.dots.visible = inFlight && impactIn;
        st.shell.visible = inFlight && impactIn;
        if (inFlight) {
          const from = st.from();
          if (from) {
            const attr = st.line.geometry.getAttribute("position") as THREE.BufferAttribute;
            const arr = attr.array as Float32Array;
            for (let i = 0; i < 28; i++) {
              const k = i / 27;
              const kx = k * 2 - 1;
              const px = from.x + (st.to.x - from.x) * k;
              const pz = from.z + (st.to.z - from.z) * k;
              const py = Math.max(0, st.h * (1 - kx * kx));
              arr[i * 3] = px;
              arr[i * 3 + 1] = py;
              arr[i * 3 + 2] = pz;
            }
            attr.needsUpdate = true;
            const dotAttr = st.dots.geometry.getAttribute("position") as THREE.BufferAttribute;
            dotAttr.needsUpdate = true;
            // Shell position + orientation: interpolate k across the flight,
            // tip pointing along the local tangent.
            const k = Math.min(1, Math.max(0, (t - st.t0) / (st.t1 - st.t0)));
            const kx = k * 2 - 1;
            const px = from.x + (st.to.x - from.x) * k;
            const py = Math.max(0, st.h * (1 - kx * kx));
            const pz = from.z + (st.to.z - from.z) * k;
            st.shell.position.set(px, py, pz);
            const k2 = Math.min(1, k + 0.03);
            const kx2 = k2 * 2 - 1;
            const tx = from.x + (st.to.x - from.x) * k2 - px;
            const ty = Math.max(0, st.h * (1 - kx2 * kx2)) - py;
            const tz = from.z + (st.to.z - from.z) * k2 - pz;
            const len = Math.hypot(tx, ty, tz) || 1;
            _shellDir.set(tx / len, ty / len, tz / len);
            st.shell.quaternion.setFromUnitVectors(_shellUp, _shellDir);
          } else {
            st.line.visible = false;
            st.dots.visible = false;
            st.shell.visible = false;
          }
        }
      }
      // Torpedoes: advance straight along the launch direction. The capsule
      // geometry runs along +Y, so orient it flat along the travel direction
      // (a plain rotation.y would leave it standing upright).
      for (const tm of torpedoMeshes) {
        const age = t - tm.t0;
        const on = age >= 0 && age <= tm.life;
        tm.mesh.visible = on;
        tm.wake.visible = on;
        if (on) {
          const p = tm.base.clone().add(tm.dir.clone().multiplyScalar(33 * age));
          tm.mesh.position.set(p.x, 1.2, p.z);
          tm.mesh.quaternion.setFromUnitVectors(_shellUp, tm.dir);
          const wakeAttr = tm.wake.geometry.getAttribute("position") as THREE.BufferAttribute;
          const tail = tm.dir.clone().multiplyScalar(160);
          wakeAttr.setXYZ(0, p.x - tail.x, 0.4, p.z - tail.z);
          wakeAttr.setXYZ(1, p.x, 0.4, p.z);
          wakeAttr.needsUpdate = true;
        }
      }
      // Explosion rings: spawn on impacts, expand + fade over ~1.2s. Impacts
      // outside the fitted battle bounds are skipped so stray data points
      // don't flash rings out in empty space.
      let nextFx = explosionFx.find((f) => !f.ring.visible);
      for (const e of props.explosions) {
        if (e.time > t || t - e.time > 1.2) continue;
        if (!inBounds(e.x, -e.z)) continue;
        if (!nextFx) break;
        nextFx.ring.visible = true;
        nextFx.ring.position.set(e.x, 1, -e.z);
        nextFx.born = e.time;
        nextFx = explosionFx.find((f) => !f.ring.visible);
      }
      for (const fx of explosionFx) {
        if (!fx.ring.visible) continue;
        const age = t - fx.born;
        if (age > 1.2) {
          fx.ring.visible = false;
          continue;
        }
        const k = age / 1.2;
        fx.ring.scale.setScalar(40 + k * 240);
        (fx.ring.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - k);
      }
      // Recorder aim line: from the own ship to the currently locked target.
      if (lockLine) {
        const cur = props.weaponLocks.filter((l) => l.time <= t);
        const last = cur.length > 0 ? cur[cur.length - 1] : null;
        const selfMarker = shipMarkers.find((m) => m.userData.role === "self");
        const targetMarker = last
          ? shipMarkers.find((m) => m.userData.entityId === last.targetId)
          : null;
        const on =
          last != null &&
          last.lockType === 3 &&
          selfMarker != null &&
          targetMarker != null;
        lockLine.visible = on;
        if (lockRing) lockRing.visible = on;
        if (on && selfMarker && targetMarker) {
          const a = selfMarker.position;
          const b = targetMarker.position;
          const attr = lockLine.geometry.getAttribute("position") as THREE.BufferAttribute;
          attr.setXYZ(0, a.x, 30, a.z);
          attr.setXYZ(1, b.x, 30, b.z);
          attr.needsUpdate = true;
          if (lockRing) {
            lockRing.position.set(b.x, 60, b.z);
            lockRing.scale.setScalar(90 * (1 + 0.12 * Math.sin(t * 4)));
          }
        }
      }
      // Aircraft labels (one per carrier): sync name/HP from the carrier and
      // show while any of its squadrons is in the air (visible window =
      // first update .. last update + 2 min).
      {
        const labels = shipLabels.value;
        for (const [labelId, carrierId] of planeLabelCarriers) {
          const label = labels.find((l) => l.entityId === labelId);
          if (!label) continue;
          const carrierIdx = carrierId == null ? -1 : shipMarkers.findIndex(
            (m) => m.userData.entityId === carrierId,
          );
          const carrierLabel = carrierIdx >= 0 ? labels[carrierIdx] : null;
          if (carrierLabel) {
            label.name = carrierLabel.name;
            label.shipName = carrierLabel.shipName;
            label.tier = carrierLabel.tier;
            label.hp = carrierLabel.hp;
            label.maxHp = carrierLabel.maxHp;
            label.dead = carrierLabel.dead;
          }
          // Any of this carrier's squadrons airborne?
          let visible = false;
          for (const [planeId, labelOf] of planeLabelOfPlane) {
            if (labelOf !== labelId) continue;
            const trail = planeTrails.find((tr) => Math.floor(tr.id / 16) === planeId);
            if (!trail || trail.samples.length === 0) continue;
            const first = trail.samples[0].time;
            const last = trail.samples[trail.samples.length - 1].time;
            if (t >= first && t <= last + 120) {
              visible = true;
              break;
            }
          }
          label.visible = visible;
        }
      }
      // Update screen-space positions of floating labels from marker world positions.
      updateLabelPositions();
    }

    // ── Scoring rules (official: wiki.worldofwarships.com/Ship:Game_Modes) ──
    // Domination Random/Co-op: 3 areas → start 300, +3 per completed capture,
    // +3 every 5s per controlled area; 4 areas → start 200, +4, +4 every 9s.
    // Capture duration 60s (1 ship) / 40s (2+ ships); contested by both teams
    // freezes progress; being hit halves the accrued progress.
    // Eight maps override everything: start 150, kills +40, deaths -25.
    const SPECIAL_CAP_MAPS = new Set([
      "13_OC_new_dawn",
      "17_NA_fault_line",
      "23_Shards",
      "41_Conquest",
      "42_Neighbors",
      "52_Britain",
      "53_Shoreside",
      "54_Faroe",
    ]);
    // Kill/death points by ship class (Random & Co-op).
    const KILL_PTS: Record<string, { kill: number; death: number }> = {
      Submarine: { kill: 25, death: -40 },
      Destroyer: { kill: 30, death: -45 },
      Cruiser: { kill: 35, death: -50 },
      Battleship: { kill: 40, death: -60 },
      AirCarrier: { kill: 45, death: -65 },
    };

    interface CapZoneState {
      letter: string;
      owner: number; // 0 neutral, 1 ally, 2 enemy
      /** 0..1 progress of the current capture towards the capturing team. */
      progress: number;
      /** Ships of each side inside the point right now. */
      alliesIn: number;
      enemiesIn: number;
      /** true when both teams are inside (progress frozen). */
      contested: boolean;
      /** true when a capture is actively progressing. */
      capturing: boolean;
      /** Capturing team's progress speed: 1/60 or 1/40 per second. */
      speed: number;
      /** Capturing team (1/2) when capturing. */
      captureTeam: number;
    }
    const capDisplay = ref<CapZoneState[]>([]);

    /** Per-zone incremental capture simulator state. `progress` is simulated
     *  forward in ~0.5s steps while the playhead advances; scrubbing backward
     *  resets and replays from the last ownership change. Hits inside the
     *  zone (ship HP dropping) halve the accrued progress, matching the game. */
    const capSim = new Map<
      number,
      {
        lastT: number;
        progress: number;
        owner: number;
        prevHp: Map<number, number>;
        /** Seconds the point has been controlled without contest (accrual). */
        accrualT: number;
        /** Score accumulated from this point (completion + accrual). */
        scoreAlly: number;
        scoreEnemy: number;
      }
    >();

    /** Ships inside a capture point at time t (within the zone radius) with
     *  their HP snapshots for hit-rollback detection. */
    function shipsInZone(zone: EntityTrajectory, t: number): { ally: number; enemy: number } {
      const cx = zone.kind!.initialX;
      const cz = zone.kind!.initialZ;
      const R = zone.kind!.radius ?? 60; // recovered from the EntityCreate state
      let ally = 0;
      let enemy = 0;
      for (const m of shipMarkers) {
        const traj = props.trajectories.find((tr) => tr.entityId === m.userData.entityId);
        if (!traj || traj.samples.length === 0) continue;
        const s = sampleAt(traj, t);
        if (!s) continue;
        const d = (s.x - cx) ** 2 + (s.z - cz) ** 2;
        if (d > R * R) continue;
        const role = m.userData.role as TeamRole;
        if (role === "ally" || role === "self") ally++;
        else if (role === "enemy") enemy++;
      }
      return { ally, enemy };
    }

    /** Advance a zone's capture simulation from lastSimT to t in 0.5s steps.
     *  Ownership always follows the recorded prop0 stream; the simulation
     *  drives the visible progress ring (speed by ships inside, frozen when
     *  contested, halved when an inside ship takes a hit) AND the point's
     *  score: +capComplete on every ownership change (except a pre-placed
     *  starting zone), plus accrual points only while the point is controlled
     *  with no enemy ship inside (the game pauses accrual while contested). */
    function simulateZone(
      zone: EntityTrajectory,
      eid: number,
      t: number,
      samples: { time: number; value: number }[],
      capCompletePts: number,
      accrualEvery: number,
      accrualPts: number,
    ) {
      const st = capSim.get(eid);
      if (!st) return;
      // The game's own progress stream (0x23) beats position simulation.
      const realProgress =
        zone.capProgress != null && zone.capProgress.length >= 2;
      let simT = st.lastT;
      // Ownership changes are applied step-by-step as the sim crosses their
      // timestamps (applying them up front would give the owner early
      // accrual for the whole [0, changeTime) stretch).
      let si = 0;
      while (si < samples.length && samples[si].time <= simT) si++;
      const step = 0.5;
      while (simT < t) {
        const nxt = Math.min(simT + step, t);
        const mid = (simT + nxt) / 2;
        while (si < samples.length && samples[si].time < nxt) {
          const s = samples[si];
          if (s.time > simT) {
            const changed = s.value !== st.owner;
            st.owner = s.value;
            st.progress = 0;
            st.prevHp = new Map();
            st.accrualT = 0;
            // A completed capture (any non-neutral change) scores
            // +capComplete; a starting zone placed at battle start (first
            // sample, t < 5) is not a capture event.
            if (changed && s.value !== 0 && s.time > 5) {
              if (s.value === 1) st.scoreAlly += capCompletePts;
              else st.scoreEnemy += capCompletePts;
            }
          }
          si++;
        }
        const cx = zone.kind!.initialX;
        const cz = zone.kind!.initialZ;
        const R = zone.kind!.radius ?? 60;
        let ally = 0;
        let enemy = 0;
        for (const m of shipMarkers) {
          const traj = props.trajectories.find((tr) => tr.entityId === m.userData.entityId);
          if (!traj || traj.samples.length === 0) continue;
          const s = sampleAt(traj, mid);
          if (!s) continue;
          if ((s.x - cx) ** 2 + (s.z - cz) ** 2 > R * R) continue;
          const role = m.userData.role as TeamRole;
          if (role === "ally" || role === "self") ally++;
          else if (role === "enemy") enemy++;
          // Hit rollback: HP dropped inside the zone → progress halves.
          if (traj.hpSamples && traj.hpSamples.length > 0) {
            const hp = hpAtTime(traj.hpSamples, mid);
            const prev = st.prevHp.get(traj.entityId) ?? hp;
            if (prev != null && hp != null && hp < prev - 50) {
              st.progress *= 0.5;
            }
            st.prevHp.set(traj.entityId, hp ?? prev);
          }
        }
        if (st.owner === 0) {
          // Neutral: a single team present starts capturing it.
          if ((ally > 0) !== (enemy > 0)) {
            st.progress += step / (Math.max(ally, enemy) >= 2 ? 40 : 60);
            if (st.progress > 1) st.progress = 1;
          }
        } else if (enemy > 0) {
          // An enemy is inside: accrual pauses (game rule). If allies are
          // also inside the point is contested (progress frozen); otherwise
          // the enemy is re-capturing (ring visual only — the actual flip
          // comes from the prop0 stream).
          if (ally === 0) {
            st.progress += step / (enemy >= 2 ? 40 : 60);
            if (st.progress > 1) st.progress = 1;
          }
        } else {
          // No enemy inside: the owner scores accrual points; allied ships
          // inside (or nobody) keep it ticking.
          if (accrualEvery > 0) {
            st.accrualT += step;
            while (st.accrualT >= accrualEvery) {
              st.accrualT -= accrualEvery;
              if (st.owner === 1) st.scoreAlly += accrualPts;
              else st.scoreEnemy += accrualPts;
            }
          }
        }
        // Override the simulated progress with the game's own stream when the
        // replay carries it (NestedPropertyUpdate 0x23): far more accurate
        // than inferring from ship positions.
        if (realProgress) {
          const cp = progressAtTime(zone.capProgress, nxt);
          if (cp != null) {
            st.progress = Math.min(1, cp / 1000);
            st.prevHp.clear();
          }
        }
        simT = nxt;
      }
      st.lastT = t;
    }

    /** Recompute cap zone states + score at playback time t. Fully derived
     *  from the replay stream (capSamples ownership changes, ship positions,
     *  HP streams) so scrubbing reproduces the same result. */
    function updateCapsAndScore(t: number) {
      const zones = capZones.value;
      // Scoring parameters by mode + map.
      const isRanked = props.matchGroup === "ranked" || props.matchGroup === "clan";
      const special = SPECIAL_CAP_MAPS.has(props.mapName);
      const nAreas = zones.length;
      const startPts = special ? 150 : isRanked ? 300 : nAreas >= 4 ? 200 : 300;
      const capCompletePts = special ? 40 : isRanked ? (nAreas >= 4 ? 2 : 9) : nAreas >= 4 ? 4 : 3;
      // Accrual: (every N seconds, +P per controlled area).
      let accrualEvery = 0;
      let accrualPts = 0;
      if (!special) {
        if (isRanked) {
          accrualEvery = nAreas >= 4 ? 0 : nAreas === 2 ? 10 : 3;
          accrualPts = nAreas >= 4 ? 0 : nAreas === 2 ? 9 : 2;
        } else {
          accrualEvery = nAreas >= 4 ? 9 : 5;
          accrualPts = nAreas >= 4 ? 4 : 3;
        }
      }

      let allyScoreNow = startPts;
      let enemyScoreNow = startPts;

      // Kill / death points by ship class (classic tables; special maps
      // override with flat +40/-25).
      for (const m of shipMarkers) {
        const dt = m.userData.deathTime as number | null;
        if (dt == null || t < dt) continue;
        const role = m.userData.role as TeamRole;
        const killer = role === "ally" || role === "self" ? "enemy" : "ally";
        const type = (m.userData.type as string | undefined) ?? "";
        let kill = 0;
        let death = 0;
        if (special) {
          kill = 40;
          death = -25;
        } else {
          const cls =
            type.includes("Destroyer") ? "Destroyer"
            : type.includes("Battleship") ? "Battleship"
            : type.includes("AirCarrier") || type.includes("AirCar") ? "AirCarrier"
            : type.includes("Submarine") ? "Submarine"
            : "Cruiser";
          kill = KILL_PTS[cls].kill;
          death = KILL_PTS[cls].death;
        }
        if (killer === "ally") allyScoreNow += kill;
        else enemyScoreNow += kill;
        if (role === "ally" || role === "self") allyScoreNow += death;
        else enemyScoreNow += death;
      }

      // Cap completion + accrual come from the per-zone simulation (which
      // pauses accrual while a point is contested), plus per-zone live capture
      // state for the UI.
      const display: CapZoneState[] = [];
      for (let i = 0; i < zones.length; i++) {
        const zone = zones[i];
        const eid = zone.entityId;
        const samples = (zone.capSamples ?? []).map((s) => ({ time: s.time, value: s.value }));
        // Capture simulation: replay from scratch on scrub-back, else advance.
        let st = capSim.get(eid);
        if (!st || st.lastT > t) {
          st = {
            lastT: 0,
            progress: 0,
            owner: ownerAt(samples, 0),
            prevHp: new Map(),
            accrualT: 0,
            scoreAlly: 0,
            scoreEnemy: 0,
          };
          capSim.set(eid, st);
        }
        simulateZone(zone, eid, t, samples, capCompletePts, accrualEvery, accrualPts);
        allyScoreNow += st.scoreAlly;
        enemyScoreNow += st.scoreEnemy;
        const { ally, enemy } = shipsInZone(zone, t);
        const capturing =
          st.owner === 0
            ? st.progress > 0.001 && st.progress < 1
            : st.progress > 0.001 && st.progress < 1 && ally + enemy > 0;
        display.push({
          letter: String.fromCharCode(65 + i),
          owner: st.owner,
          progress: st.progress,
          alliesIn: ally,
          enemiesIn: enemy,
          contested: ally > 0 && enemy > 0,
          capturing,
          speed: 1 / (Math.max(ally, enemy) >= 2 ? 40 : 60),
          captureTeam: st.owner === 0 ? (ally > enemy ? 1 : enemy > ally ? 2 : 0) : st.owner,
        });
      }
      capDisplay.value = display;
      allyScore.value = allyScoreNow;
      enemyScore.value = enemyScoreNow;
    }

    /** Owner at time t from the raw capSamples stream. */
    function ownerAt(samples: { time: number; value: number }[], t: number): number {
      let o = 0;
      for (const s of samples) {
        if (s.time <= t) o = s.value;
        else break;
      }
      return o;
    }

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
      const marker = shipMarkers.find((m) => m.userData.entityId === id);
      if (!marker || !marker.visible) return;
      const pos = marker.position;
      const yaw = marker.rotation.y;
      const dist = 90;
      const behind = new THREE.Vector3(
        pos.x - Math.sin(yaw) * dist,
        35,
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
    }

    /** Canvas click → raycast the nearest visible ship marker (within a
     *  generous screen distance) or clear the selection. */
    function onCanvasClick(e: MouseEvent) {
      speedMenuOpen.value = false;
      const cam = api.value?.camera;
      const rnd = api.value?.renderer;
      const canvas = rnd?.domElement;
      if (!cam || !canvas || shipMarkers.length === 0) {
        selectShip(null);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      // Pick the marker whose world position projects nearest to the click —
      // raycasting the small marker meshes is fragile; a screen-space
      // distance test against their projected anchors is stable.
      let bestId: number | null = null;
      let bestD = Infinity;
      for (const m of shipMarkers) {
        if (!m.visible) continue;
        _projVec.copy(m.position);
        _projVec.project(cam);
        if (_projVec.z >= 1) continue;
        const sx = (_projVec.x * rect.width) / 2 + rect.width / 2;
        const sy = (-_projVec.y * rect.height) / 2 + rect.height / 2;
        const d = Math.hypot(sx - e.clientX + rect.left, sy - e.clientY + rect.top);
        if (d < bestD && d < 60) {
          bestD = d;
          bestId = m.userData.entityId as number;
        }
      }
      selectShip(bestId);
    }

    /** Project every visible marker's world position into screen pixels and
     *  write them into `shipLabels` so the overlay <div>s track the ships. */
    function updateLabelPositions() {
      const cam = api.value?.camera;
      const rnd = api.value?.renderer;
      const el = container.value;
      const canvas = rnd?.domElement;
      if (!cam || !rnd || !el || !canvas) return;
      const labels = shipLabels.value;
      const hw = canvas.clientWidth / 2;
      const hh = canvas.clientHeight / 2;
      for (let i = 0; i < shipMarkers.length; i++) {
        const label = labels[i];
        if (!label) continue;
        const marker = shipMarkers[i];
        if (!marker.visible) { label.visible = false; continue; }
        // Project the marker's world position (offset 20 units upward so the
        // label sits above the ship silhouette, not buried inside it).
        _projVec.copy(marker.position);
        _projVec.y += 20;
        _projVec.project(cam);
        // NDC → pixel within the canvas rect.
        label.x = (_projVec.x * hw) + hw;
        label.y = (-_projVec.y * hh) + hh;
        label.visible = _projVec.z < 1;
      }
      // Aircraft labels project above the carrier's currently airborne
      // squadrons (the newest sample of the newest sortie).
      for (const [labelId] of planeLabelCarriers) {
        const label = labels.find((l) => l.entityId === labelId);
        if (!label || !label.visible) continue;
        let anchor: SquadronPlane | null = null;
        for (const [planeId, labelOf] of planeLabelOfPlane) {
          if (labelOf !== labelId) continue;
          const trail = planeTrails.find((tr) => Math.floor(tr.id / 16) === planeId);
          if (!trail || trail.samples.length === 0) continue;
          const sp = trail.samples[trail.samples.length - 1];
          if (!anchor || sp.time > anchor.time) anchor = sp;
        }
        if (!anchor) { label.visible = false; continue; }
        _projVec.set(anchor.x, Math.max(60, anchor.y) + 30, -anchor.z);
        _projVec.project(cam);
        label.x = (_projVec.x * hw) + hw;
        label.y = (-_projVec.y * hh) + hh;
        if (_projVec.z >= 1) label.visible = false;
      }
    }

    /** Interpolate a sample at time t (linear between neighbors). */
    function sampleAt(traj: EntityTrajectory, t: number) {
      const ss = traj.samples;
      if (t <= ss[0].time) return ss[0];
      if (t >= ss[ss.length - 1].time) return ss[ss.length - 1];
      // Binary search: called per frame from the capture simulation and the
      // aircraft cloud, so keep it O(log n).
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
        ...a,
        x: a.x + (b.x - a.x) * f,
        z: a.z + (b.z - a.z) * f,
        yaw: a.yaw + angleDiff(a.yaw, b.yaw) * f,
      };
    }

    function angleDiff(a: number, b: number): number {
      let d = b - a;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return d;
    }

    // Playback loop.
    function playTick(now: number) {
      if (!playing.value) return;
      if (lastTick === 0) lastTick = now;
      const dt = (now - lastTick) / 1000;
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
        if (ready.value) {
          current.value = 0;
          playing.value = false;
          duration.value = 0;
          clearActors();
          shipLabels.value = [];
          bounds = null;
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
        rebuildActors();
        updateMarkersAt(current.value);
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
          rebuildActors();
          updateMarkersAt(current.value);
        }
      },
      { deep: false },
    );
    watch(
      () => props.encyclopedia.size,
      (s) => {
        if (ready.value && s > 0) {
          rebuildActors();
          updateMarkersAt(current.value);
        }
      },
      { immediate: true },
    );

    // Recompute markers whenever the scrubber moves.
    watch(current, (t) => updateMarkersAt(t));

    // Once the scene is ready, build actors for any trajectories already set
    // and attempt to load the terrain model.
    watch(ready, (r) => {
      if (r) {
        ensureWaterFloor();
        loadMinimapBase();
        recomputeBoundsAndCamera();
        rebuildActors();
        updateMarkersAt(current.value);
        void tryLoadMapModel();
      }
    });

    // Reload terrain when the map changes (e.g. switching replays).
    watch(() => props.mapId, () => {
      if (ready.value) {
        loadMinimapBase();
        void tryLoadMapModel();
      }
    });

    onBeforeUnmount(() => {
      cancelAnimationFrame(playRaf);
      clearActors();
      clearMapModel();
      if (waterFloor) {
        api.value?.scene.remove(waterFloor);
        waterFloor.geometry.dispose();
        (waterFloor.material as THREE.Material).dispose();
        waterFloor = null;
      }
      if (seaSurface) {
        api.value?.scene.remove(seaSurface);
        seaSurface.geometry.dispose();
        (seaSurface.material as THREE.Material).dispose();
        seaSurface = null;
      }
      clearShipMarkerCache();
      clearPropMarkerCache();
    });

    return () => (
      <div class="holo-map">
        <div
          ref={container}
          class="holo-map__canvas"
          onPointerDown={(e) => { _downPt = { x: e.clientX, y: e.clientY }; }}
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
            <div
              key={lbl.entityId}
              class={[
                "holo-label",
                `holo-label--${lbl.role}`,
                lbl.dead ? "holo-label--dead" : "",
                lbl.visible ? "" : "holo-label--hidden",
                selectedEntityId.value === lbl.entityId ? "holo-label--selected" : "",
              ]}
              style={{
                left: `${lbl.x}px`,
                top: `${lbl.y}px`,
                borderColor: `#${TEAM_COLOR[lbl.role].toString(16).padStart(6, "0")}`,
              }}
            >
              <span class="holo-label__name" title={lbl.name}>{lbl.name}</span>
              <span class="holo-label__ship">
                {lbl.kind === "plane" ? (
                  <BattleIcon kind="plane" type={lbl.planeType ?? "attack"} size={11} />
                ) : lbl.type ? (
                  <BattleIcon
                    kind="ship"
                    type={lbl.type}
                    variant={lbl.role === "self" || lbl.role === "ally" ? "ally" : lbl.role === "enemy" ? "enemy" : "plain"}
                    size={11}
                  />
                ) : null}
                {lbl.tier != null ? (
                  <span class="holo-label__tier">{tierToRoman(lbl.tier)}</span>
                ) : null}
                {lbl.shipName}
              </span>
              {lbl.hp != null ? (
                <span class="holo-label__hp">
                  {lbl.maxHp != null ? (
                    <span class="holo-label__hp-bar">
                      <span
                        class="holo-label__hp-fill"
                        style={{
                          width: `${Math.max(0, Math.min(100, (lbl.hp / lbl.maxHp) * 100))}%`,
                          background: `#${(
                            lbl.role === "self" ? 0x4ade80 : TEAM_COLOR[lbl.role]
                          ).toString(16).padStart(6, "0")}`,
                        }}
                      />
                      <span class="holo-label__hp-text">
                        {lbl.hp.toLocaleString()}
                        {lbl.maxHp != null ? ` / ${lbl.maxHp.toLocaleString()}` : ""}
                      </span>
                    </span>
                  ) : null}
                </span>
              ) : null}
              {lbl.dead ? <span class="holo-label__dead-tag">{t("replay.legend.dead")}</span> : null}
            </div>
          ))}
        </div>
        {!ready.value ? <div class="holo-map__hint">Initializing holographic scene…</div> : null}
        {props.replayPath ? (
          <div class="holo-map__scorebar">
            <span class="holo-map__score-team holo-map__score--ally">
              <span class="holo-map__score-dot" style="background:#3cb478" />
              <strong class="holo-map__score-num">{allyScore.value}</strong>
            </span>
            <span class="holo-map__score-caps">
              {capDisplay.value.map((c) => {
                const ownerColor =
                  c.owner === 1 ? "#4ade80" : c.owner === 2 ? "#cc3333" : "rgba(255,255,255,0.6)";
                const capColor = c.captureTeam === 1 ? "#4ade80" : c.captureTeam === 2 ? "#cc3333" : "#ffffff";
                const active = c.capturing || c.contested;
                return (
                  <span
                    class={[
                      "holo-map__cap",
                      c.owner === 1 ? "holo-map__cap--ally" : c.owner === 2 ? "holo-map__cap--enemy" : "",
                      active ? "holo-map__cap--active" : "",
                      c.contested ? "holo-map__cap--contested" : "",
                    ]}
                    title={
                      c.contested
                        ? `${c.letter} 双方压点，进度暂停`
                        : c.capturing
                          ? `${c.letter} 占领中（${c.alliesIn} vs ${c.enemiesIn} 船）`
                          : c.owner === 0
                            ? `${c.letter} 中立`
                            : c.owner === 1
                              ? `${c.letter} 我方控制`
                              : `${c.letter} 敌方控制`
                    }
                  >
                    <svg width="30" height="30" viewBox="0 0 30 30">
                      {active ? (
                        <g>
                          {/* capturing: the box rotates 45° into a diamond and
                              gains a progress ring — like the in-game cap UI */}
                          <rect x="9" y="9" width="12" height="12" fill="none"
                            stroke={c.owner === 0 ? "rgba(255,255,255,0.35)" : ownerColor}
                            stroke-width="1.6"
                            transform="rotate(45 15 15)" />
                          <circle r="11" cx="15" cy="15" fill="none"
                            stroke={capColor} stroke-width="2.2" stroke-linecap="round"
                            stroke-dasharray={`${Math.max(0.5, c.progress * 69.1)} 69.1`}
                            transform="rotate(-90 15 15)" />
                        </g>
                      ) : (
                        <rect x="9" y="9" width="12" height="12"
                          fill={c.owner === 0 ? "rgba(255,255,255,0.05)" : ownerColor}
                          stroke={ownerColor} stroke-width="1.6" />
                      )}
                      <text x="15" y="19.5" text-anchor="middle" font-size="13"
                        font-weight="800" fill="#fff"
                        style={{ textShadow: "0 1px 2px rgba(0,0,0,0.9)" }}>
                        {c.letter}
                      </text>
                    </svg>
                  </span>
                );
              })}
            </span>
            <span class="holo-map__score-team holo-map__score--enemy">
              <strong class="holo-map__score-num">{enemyScore.value}</strong>
              <span class="holo-map__score-dot" style="background:#cc3333" />
            </span>
          </div>
        ) : null}
        {/* Kill feed (sink notifications) */}
        {killFeed.value.length > 0 ? (
          <div class="holo-map__killfeed">
            {killFeed.value.map((k) => (
              <div key={k.id} class={["holo-map__kill", `holo-map__kill--${k.role}`]}>
                <span class="holo-map__kill-cross">✕</span>
                <span class="holo-map__kill-name">{k.text}</span>
                <span class="holo-map__kill-pts">+1</span>
              </div>
            ))}
          </div>
        ) : null}
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
          <div class="holo-map__mmzoom" onClick={() => { minimapZoom.value = false; }}>
            <div class="holo-map__mmzoom-head">
              <span>{t("replay.minimap.zoom")}</span>
              <SCheckbox
                modelValue={minimapShowTrails.value}
                variant="switch"
                onClick={(e) => e.stopPropagation()}
                onUpdate:modelValue={(v: boolean) => { minimapShowTrails.value = v; }}
              >
                {t("replay.minimap.trails")}
              </SCheckbox>
            </div>
            <canvas ref={zoomCanvas} width={640} height={640} class="holo-map__mmzoom-canvas" />
          </div>
        ) : null}
        {props.replayPath ? (
          <div class="holo-map__controls">
            <button
              class="holo-map__lbltoggle"
              onClick={() => { showLabels.value = !showLabels.value; }}
              title={showLabels.value ? t("replay.labels.hide") : t("replay.labels.show")}
            >
              {showLabels.value ? "◉" : "◎"}
            </button>
            {props.cameraFrames.length > 0 ? (
              <button
                class={["holo-map__lbltoggle", originalView.value ? "holo-map__lbltoggle--on" : ""]}
                onClick={() => { originalView.value = !originalView.value; }}
                title={originalView.value ? t("replay.origview.off") : t("replay.origview.on")}
              >
                {originalView.value ? "🎥" : "⛶"}
              </button>
            ) : null}
            <button class="holo-map__play" onClick={togglePlay}>
              {playing.value ? "❚❚" : "▶"}
            </button>
            <input
              class="holo-map__scrub"
              type="range"
              min={0}
              max={duration.value || 0}
              step={0.1}
              value={current.value}
              onInput={(e) => {
                playing.value = false;
                current.value = Number((e.target as HTMLInputElement).value);
              }}
            />
            <span class="holo-map__time" onClick={toggleTimeMode} title="Click to toggle elapsed / remaining / total">
              {displayTime()}
            </span>
            <div class="holo-map__speed">
              <button
                class="holo-map__speed-btn"
                onClick={(e) => { e.stopPropagation(); speedMenuOpen.value = !speedMenuOpen.value; }}
                title="播放速度"
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
          <div class="holo-map__roster-overlay">
            <table>
              <thead>
                <tr><th colspan="3">{t("replay.roster.allies")}</th></tr>
              </thead>
              <tbody>
                {props.vehicles.filter(v => v.relation <= 1).map(v => (
                  <tr key={v.id}>
                    <td style={{color: v.relation === 0 ? "#fff" : "#3cb478"}}>{v.name}</td>
                    <td>{v.shipName ?? shipNameFromOfflineDb(v.shipId, useLanguage().dataLanguage.value) ?? shipNameFromModelDb(v.shipId) ?? ""}</td>
                    <td></td>
                  </tr>
                ))}
              </tbody>
              <thead>
                <tr><th colspan="3">{t("replay.roster.enemies")}</th></tr>
              </thead>
              <tbody>
                {props.vehicles.filter(v => v.relation > 1).map(v => (
                  <tr key={v.id}>
                    <td style={{color: "#cc3333"}}>{v.name}</td>
                    <td>{v.shipName ?? shipNameFromOfflineDb(v.shipId, useLanguage().dataLanguage.value) ?? shipNameFromModelDb(v.shipId) ?? ""}</td>
                    <td></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    );
  },
});
