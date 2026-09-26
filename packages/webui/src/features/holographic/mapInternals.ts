/**
 * The holographic map's shared internals: one explicit context object that
 * owns every mutable holder (GPU pools, slot tables, epochs, caches, scratch
 * vectors) the big map functions — rebuildActors, updateMarkersAt,
 * drawMinimap and their helper clusters — read and write. It was extracted
 * from HolographicMap.tsx's setup closure so those functions can live in
 * focused modules (actorBuild / markerUpdate / minimapPainter / …) without
 * duplicating state or threading a dozen loose variables.
 *
 * Ownership model: HolographicMap.tsx creates exactly one context per
 * component instance in setup (createMapInternals) and passes it to every
 * extracted function. Reactive pieces (props + the refs/computeds the
 * extracted code touches) are handed in as dependencies and stay reactive —
 * the context is deliberately NOT reactive itself.
 */
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { ComputedRef, Ref } from "vue";
import type {
  AchievementEvent,
  CameraSample,
  ChatEvent,
  EntityTrajectory,
  ExplosionEvent,
  MinimapSquadronAdd,
  MinimapSquadronMove,
  MinimapSquadronRemove,
  ShellLaunchEvent,
  ShipInfo,
  SquadronCreate,
  SquadronPlane,
  ShotKillEvent,
  TorpedoLaunch,
  TorpedoSteer,
  VehicleEntry,
  WardEvent,
  WardRemoveEvent,
  WeaponLockEvent,
} from "@/api";
import type { PostBattleData } from "@/features/replay/postBattle";
import type { ThreeScene } from "./useThreeScene";
import { disposeMarker } from "./shipMarker";
import { disposeAny } from "./sceneUtils";
import { roleFromRelation } from "./teamColors";
import { resolveMapMinimapUrl, loadMapBounds, type MapBounds } from "./modelLoader";
import { viewWindow } from "./tactical/render";
import type { CapZoneState } from "./capZones";
import type { TeamRole } from "./teamColors";
import type { ShipLabel } from "./shipLabel";
import type { FeedEntry } from "./HoloEventFeed";
import type { TacticalView } from "./tactical/render";

/** The subset of HolographicMap's props the extracted map modules read.
 *  Structurally satisfied by the component's reactive props object. */
export interface HoloMapDataProps {
  trajectories: EntityTrajectory[];
  /** Artillery launches (receiveArtilleryShots on the avatar). */
  shellLaunches: ShellLaunchEvent[];
  /** World-space shell impacts (receiveExplosions on the avatar). */
  explosions: ExplosionEvent[];
  /** Torpedo launches (receiveTorpedoes on the avatar). */
  torpedoes: TorpedoLaunch[];
  /** Homing-torpedo guidance updates (receiveTorpedoDirection). */
  torpedoSteers: TorpedoSteer[];
  /** Recorder weapon-lock timeline (SetWeaponLock 0x30). */
  weaponLocks: WeaponLockEvent[];
  /** Raw post-battle statistics JSON (BattleResults 0x22). */
  battleResults: string;
  /** Map space id (e.g. "15_NE_north"). */
  mapId: string;
  /** Match group from the replay descriptor (pvp/ranked/clan/brawl/...). */
  matchGroup: string;
  /** Map space id, for applying per-map domination scoring overrides. */
  mapName: string;
  /** Aircraft squadrons (avatar receive_addSquadron / updateSquadron). */
  squadronCreates: SquadronCreate[];
  squadronPlanes: SquadronPlane[];
  /** Minimap squadron markers (receive_add/update/removeMinimapSquadron). */
  minimapSquadronAdds: MinimapSquadronAdd[];
  minimapSquadronMoves: MinimapSquadronMove[];
  minimapSquadronRemoves: MinimapSquadronRemove[];
  /** Fighter-patrol wards (receive_wardAdded) — static patrol circles. */
  wards: WardEvent[];
  wardRemoves: WardRemoveEvent[];
  /** Projectile kills (receiveShotKills). */
  shotKills: ShotKillEvent[];
  /** Entity id → last leave time (EntityLeave 0x04). */
  leavesMap: Record<string, number>;
  /** Recorder camera timeline (Camera 0x25). */
  cameraFrames: CameraSample[];
  /** Battle chat timeline (avatar onChatMessage). */
  chatMessages: ChatEvent[];
  /** In-battle achievement awards (avatar onAchievementEarned). */
  achievements: AchievementEvent[];
  /** Roster from the replay header. */
  vehicles: VehicleEntry[];
  /** Ship encyclopedia (shipId → ShipInfo). */
  encyclopedia: Map<number, ShipInfo>;
}

/** Rectangular XZ rect in scene coordinates (z = -worldZ). */
export interface SceneBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** One shell flight, as plain data — launch/impact window, arc height and
 *  colors. GPU objects are NOT per shell: matches carry 10k+ shells but only
 *  a few dozen are airborne at once, so the renderer draws them from a fixed
 *  pool of [`ShellTraceSlot`]s assigned per frame. */
export interface ShellTraceState {
  t0: number;
  t1: number;
  h: number;
  /** Launch point (three.js coords; null when the firing ship is unknown). */
  from: THREE.Vector3 | null;
  to: THREE.Vector3;
  color: number;
  /** Firing vehicle + per-barrel shot id — the join key into shotKills.
   *  `shotId` is null for legacy explosion-derived traces (no join). */
  ownerId: number;
  shotId: number | null;
  /** True when a receiveShotKills entry snapped this shell onto a victim —
   *  its endpoint and flight end are server-confirmed. */
  joined: boolean;
}

/** A pooled trace's GPU objects; tinted per assignment. A shell trace is
 *  just the arc + the in-flight shell (cone or GLB) — no impact markers. */
export interface ShellTraceSlot {
  line: THREE.Line;
  lineMat: THREE.LineBasicMaterial;
  dots: THREE.Points;
  dotMat: THREE.PointsMaterial;
  shell: THREE.Object3D;
}

/** One smoke-screen cluster (entityType 4 = SmokeScreen). Each cluster
 *  holds a start ring + end ring (white circles) and a remaining-time
 *  sprite. Puffs spawned within 300 m of each other merge into one
 *  cluster — the one with the longest lifetime wins. */
export interface SmokeClusterState {
  traj: EntityTrajectory;
  t0: number;
  lastT: number;
  endT: number;
  sx: number;
  sz: number;
  rings: THREE.Mesh[];
  timeSprite: THREE.Sprite | null;
}

/** Fighter-patrol ward: one flat ring + area fill per receive_wardAdded,
 *  alive from its add time until the matching remove (or match end). */
export interface WardRingState {
  ring: THREE.Mesh;
  fill: THREE.Mesh;
  t0: number;
  t1: number | null;
}

/** One in-flight torpedo: straight capsule from the launch point along
 *  the launch direction (swapped for the real torpedo GLB once loaded).
 *  Homing fish re-anchor at each receiveTorpedoDirection guidance
 *  update (position + heading), bending the otherwise straight run. */
export interface TorpedoMeshState {
  mesh: THREE.Object3D;
  wake: THREE.Line;
  t0: number;
  base: THREE.Vector3;
  dir: THREE.Vector3;
  /** Guidance updates for this fish (owner+shot keyed), time-sorted. */
  steers: TorpedoSteer[];
  steerIdx: number;
  /** Join keys into shotKills (owner + shot). */
  ownerId: number;
  shotId: number;
  /** Launch anchor — steering rebases from here when the playhead
   *  scrubs backwards past applied guidance updates. */
  launchT0: number;
  launchBase: THREE.Vector3;
  launchDir: THREE.Vector3;
  /** Absolute battle time at which the fish disappears (launch + 240 s,
   *  or its detonation instant when a shotKill joins). Absolute — not a
   *  relative life — because steering rebases t0 forward. */
  endT: number;
}

/** planeId → formation render state: the GameParams squadron size, the
 *  inferred group layout and the per-plane model instances. */
export interface PlaneFormationState {
  count: number;
  groupSize: number;
  groupCount: number;
  meshes: THREE.Object3D[];
}

/** Per-zone incremental capture simulator state (see capSimulator.ts). */
export interface CapSimState {
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

/** Reactive inputs threaded from HolographicMap's setup. The extracted
 *  modules read them exactly like the old closure variables did. */
export interface MapInternalsDeps {
  props: HoloMapDataProps;
  api: Ref<ThreeScene | null>;
  container: Ref<HTMLElement | null>;
  /** Playback clock (seconds). */
  current: Ref<number>;
  /** Per-ship display data for the floating HTML labels. */
  shipLabels: Ref<ShipLabel[]>;
  /** Player stats shown in the follow menu (entityId → "WR% · battles"). */
  followStats: Ref<Map<number, string>>;
  /** Entity id whose marker the camera follows (null = free orbit). */
  selectedEntityId: Ref<number | null>;
  /** The small minimap thumbnail canvas (template ref). */
  minimapCanvas: Ref<HTMLCanvasElement | null>;
  /** The enlarged 2D overlay canvas (template ref). */
  zoomCanvas: Ref<HTMLCanvasElement | null>;
  /** Enlarged-2D-map viewport: world-space center + zoom (1 = full map). */
  mmView: Ref<TacticalView>;
  /** 2D minimap enlarged overlay state. */
  minimapZoom: Ref<boolean>;
  minimapShowTrails: Ref<boolean>;
  minimapShowGrid: Ref<boolean>;
  /** Alt held → show in-game point timers on the cap letters. */
  showCapEta: Ref<boolean>;
  /** Cap zone status (A=0, B=1, C=2) — 0=neutral, 1=ally, 2=enemy. */
  capStatus: Ref<number[]>;
  /** Ships alive per side, recomputed every frame from death times. */
  allyAlive: Ref<number>;
  enemyAlive: Ref<number>;
  /** Roster totals per side (clearActors restores alive counts to them). */
  allyTotal: ComputedRef<number>;
  enemyTotal: ComputedRef<number>;
  /** Live per-zone capture state the rings/scorebar/minimap render. */
  capDisplay: Ref<CapZoneState[]>;
  /** Estimated match score (kills + cap points). */
  allyScore: Ref<number>;
  enemyScore: Ref<number>;
  /** Unified bottom-left event feed (sinks + chat + achievements). */
  feed: Ref<FeedEntry[]>;
  /** Real capture-point trajectories, ordered A→C. */
  capZones: ComputedRef<EntityTrajectory[]>;
  /** Zones that actually score: same set as the visible capture points —
   *  strike/event zones never reach this list. */
  scoringZones: ComputedRef<EntityTrajectory[]>;
  /** The recorder's own 0/1 side from the post-battle payload. */
  selfTeam: ComputedRef<number | null>;
}

/** The shared context handed to every extracted map function. Field-for-
 *  field these are the setup-closure holders HolographicMap.tsx used to
 *  keep as loose `let`/`const` variables. */
export interface MapInternals extends MapInternalsDeps {
  // ── GPU pools & scene actors ─────────────────────────────────────────
  /** Trajectory line objects (plus overlay rings/sprites cast to Line). */
  trajectoryLines: THREE.Line[];
  /** Ship marker groups (one per vessel, incl. per-marker userData). */
  shipMarkers: THREE.Group[];
  /** Successfully loaded ship models, one per marker build — cloned as
   *  substitute hulls for ships whose own GLB is missing or failed to
   *  load (a same-team stand-in beats a bare cone). */
  loadedModelPool: { model: THREE.Group; role: TeamRole }[];
  /** Markers still waiting for a model (no URL or load failure); filled
   *  from `loadedModelPool` as soon as any model finishes loading. */
  modelWaiters: { marker: THREE.Group; traj: EntityTrajectory }[];
  /** Smoke-screen clusters (entityType 4 = SmokeScreen). */
  smokeClusters: SmokeClusterState[];
  /** Shell flight states (see ShellTraceState). */
  shellStates: ShellTraceState[];
  /** Fixed pool of trace GPU objects, assigned to airborne shells each
   *  frame — bounded cost regardless of how many shells a match carries. */
  shellTraceSlots: ShellTraceSlot[];
  /** Fighter-patrol ward rings. */
  wardRings: WardRingState[];
  /** In-flight torpedo meshes + wakes (see TorpedoMeshState). */
  torpedoMeshes: TorpedoMeshState[];
  /** Scratch orientation basis for in-flight shells/torpedoes. */
  _shellUp: THREE.Vector3;
  _shellDir: THREE.Vector3;
  /** Recorder aim line to the currently locked target (SetWeaponLock). */
  lockLine: THREE.Mesh | null;
  /** Aircraft formation cloud (one point per plane) — fallback for planes
   *  without a baked model; modeled planes render as GLB meshes instead. */
  planeCloud: THREE.Points | null;
  /** Live colour buffer of the plane cloud (rebuilt with the cloud). */
  colorsCloud: Float32Array;
  /** Per-plane sample lists grouped by plane id, sorted by time. */
  planeTrails: { id: number; samples: SquadronPlane[] }[];
  /** Real aircraft models: planeId → 3D model pool (one per slot). */
  planeMeshes: Map<number, THREE.Object3D[]>;
  /** planeId → formation render state. */
  planeFormations: Map<number, PlaneFormationState>;
  /** Capture-zone ring meshes (repainted per frame by cap state). */
  capRings: THREE.Mesh[];
  /** Cap-letter sprites (redrawn with the point ETA while Alt is held). */
  capLetterSprites: THREE.Sprite[];
  /** Line materials of every screen-space overlay ring (cap / smoke /
   *  ward). Their viewport resolution uniform is refreshed each frame. */
  overlayLineMats: LineMaterial[];
  /** The loaded map terrain GLB group (null → GridHelper fallback). */
  mapModel: THREE.Group | null;
  /** Deep-sea floor + translucent sea surface planes (see mapTerrain.ts). */
  waterFloor: THREE.Mesh | null;
  seaSurface: THREE.Mesh | null;

  // ── World geometry & roster join state ───────────────────────────────
  /** Fitted battle bounds in scene coordinates (z mirrored). */
  bounds: SceneBounds | null;
  /** Roster assignment per ship entity — THE single source of truth for
   *  team roles, shared by 3D markers, minimap trails, shell-arc targets
   *  and self-stats. Rebuilt in rebuildActors; empty before first build. */
  rosterAssignments: Map<number, VehicleEntry | null>;
  /** Sorted ship entity ids — the spawn-order fallback for roleless ships
   *  (the game client spawns team A before team B). */
  shipEntityIds: number[];

  // ── Plane / squadron lookup tables (keyed by planeId or planeId*16+i) ─
  /** squadron id → slot index in the planeCloud position buffer. */
  planeCloudSlots: Map<number, number>;
  /** planeId → squadron remove time — caps trail lifetimes. */
  minimapTrailEnd: Map<number, number>;
  /** planeId*16+index → aircraft type (fighter/dive/torpedo/...). */
  planeTypesById: Map<number, string>;
  /** planeId*16+index → GameParams index (for the baked model GLB). */
  planeIndexById: Map<number, string>;
  /** Squadron label id → controlling ship's entity id. */
  planeLabelCarriers: Map<number, number | null>;
  /** planeId → team role of the controlling ship (drives marker colour). */
  planeRoleById: Map<number, string>;
  /** planeId → the carrier card label id that shows it. */
  planeLabelOfPlane: Map<number, number>;

  // ── Minimap base art (see loadMinimapBase) ────────────────────────────
  minimapImage: HTMLImageElement | null;
  minimapBounds: MapBounds | null;
  /** Cancels stale minimap-base loads when the map switches mid-flight. */
  minimapEpoch: number;
  /** Lazily acquired 2D context of the small minimap canvas. */
  _mmCtx: CanvasRenderingContext2D | null;

  // ── Async-load invalidation & caches ──────────────────────────────────
  /** Tokens used to cancel in-flight async marker loads when actors are
   *  rebuilt/unmounted before a GLB resolves. Each rebuild bumps the epoch;
   *  stale loads compare against the live epoch before mutating the scene. */
  markerEpoch: number;
  /** Lazily parsed post-battle payload (killer resolution + self team). */
  pbCache: PostBattleData | null;

  // ── Event feed + cap simulator scratch ────────────────────────────────
  feedSeq: number;
  /** Per-stream cursors into the time-ordered chat/achievement events. */
  chatPtr: number;
  achPtr: number;
  /** Entity ids already reported as sunk (avoid double-counting). */
  reportedSinks: Set<number>;
  /** Per-zone capture simulator state (see capSimulator.ts). */
  capSim: Map<number, CapSimState>;

  /** Shared projection scratch vector (label projection / canvas picking). */
  _projVec: THREE.Vector3;
}

/** Create the per-instance context. Called exactly once from
 *  HolographicMap's setup; the deps are the reactive pieces created there. */
export function createMapInternals(deps: MapInternalsDeps): MapInternals {
  return {
    ...deps,

    trajectoryLines: [],
    shipMarkers: [],
    loadedModelPool: [],
    modelWaiters: [],
    smokeClusters: [],
    shellStates: [],
    shellTraceSlots: [],
    wardRings: [],
    torpedoMeshes: [],
    _shellUp: new THREE.Vector3(0, 1, 0),
    _shellDir: new THREE.Vector3(),
    lockLine: null,
    planeCloud: null,
    colorsCloud: new Float32Array(0),
    planeTrails: [],
    planeMeshes: new Map(),
    planeFormations: new Map(),
    capRings: [],
    capLetterSprites: [],
    overlayLineMats: [],
    mapModel: null,
    waterFloor: null,
    seaSurface: null,

    bounds: null,
    rosterAssignments: new Map(),
    shipEntityIds: [],

    planeCloudSlots: new Map(),
    minimapTrailEnd: new Map(),
    planeTypesById: new Map(),
    planeIndexById: new Map(),
    planeLabelCarriers: new Map(),
    planeRoleById: new Map(),
    planeLabelOfPlane: new Map(),

    minimapImage: null,
    minimapBounds: null,
    minimapEpoch: 0,
    _mmCtx: null,

    markerEpoch: 0,
    pbCache: null,

    feedSeq: 0,
    chatPtr: 0,
    achPtr: 0,
    reportedSinks: new Set(),
    capSim: new Map(),

    _projVec: new THREE.Vector3(),
  };
}

// ── Pool disposal ──────────────────────────────────────────────────────
export function clearActors(ctx: MapInternals) {
  ctx.markerEpoch++;
  const scene = ctx.api.value?.scene;
  if (!scene) return;
  for (const l of ctx.trajectoryLines) {
    scene.remove(l);
    l.geometry.dispose();
    (l.material as THREE.Material).dispose();
  }
  for (const m of ctx.shipMarkers) {
    scene.remove(m);
    const ghost = m.userData.ghost as THREE.Mesh | undefined;
    if (ghost) {
      scene.remove(ghost);
      ghost.geometry.dispose();
      (ghost.material as THREE.Material).dispose();
    }
    // Hull outline (LineLoop child — not a Mesh, so the mesh traversal
    // below would leak its buffers).
    const hull = m.userData.hull as THREE.LineLoop | undefined;
    if (hull) {
      hull.geometry.dispose();
      (hull.material as THREE.Material).dispose();
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
  ctx.trajectoryLines = [];
  ctx.shipMarkers = [];
  ctx.loadedModelPool = [];
  ctx.modelWaiters = [];
  ctx.capRings = [];
  // SpriteMaterial.dispose() does not release its map — free the canvas
  // textures explicitly (256²/256x128 each after the hi-res bump).
  for (const s of ctx.capLetterSprites) {
    (s.material as THREE.SpriteMaterial).map?.dispose();
  }
  ctx.capLetterSprites = [];
  ctx.overlayLineMats = [];
  ctx.capSim.clear();
  for (const cl of ctx.smokeClusters) {
    for (const ring of cl.rings) {
      scene.remove(ring);
      ring.geometry.dispose();
      (ring.material as THREE.Material).dispose();
    }
    if (cl.timeSprite) {
      scene.remove(cl.timeSprite);
      const mat = cl.timeSprite.material as THREE.SpriteMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
  }
  ctx.smokeClusters = [];
  for (const slot of ctx.shellTraceSlots) {
    scene.remove(slot.line);
    slot.line.geometry.dispose();
    slot.lineMat.dispose();
    scene.remove(slot.dots);
    slot.dots.geometry.dispose();
    slot.dotMat.dispose();
    // slot.shell may be a primitive mesh or a wrapped GLB group (after the
    // model swap) — dispose generically.
    scene.remove(slot.shell);
    disposeAny(slot.shell);
  }
  ctx.shellTraceSlots = [];
  ctx.shellStates = [];
  for (const w of ctx.wardRings) {
    scene.remove(w.ring);
    w.ring.geometry.dispose();
    (w.ring.material as THREE.Material).dispose();
    scene.remove(w.fill);
    w.fill.geometry.dispose();
    (w.fill.material as THREE.Material).dispose();
  }
  ctx.wardRings = [];
  for (const tm of ctx.torpedoMeshes) {
    scene.remove(tm.mesh);
    disposeAny(tm.mesh);
    scene.remove(tm.wake);
    tm.wake.geometry.dispose();
    (tm.wake.material as THREE.Material).dispose();
  }
  ctx.torpedoMeshes = [];
  for (const pool of ctx.planeMeshes.values()) {
    for (const g of pool) {
      scene.remove(g);
      disposeAny(g);
    }
  }
  ctx.planeMeshes.clear();
  ctx.planeFormations.clear();
  if (ctx.lockLine) {
    scene.remove(ctx.lockLine);
    ctx.lockLine.geometry.dispose();
    (ctx.lockLine.material as THREE.Material).dispose();
    ctx.lockLine = null;
  }
  if (ctx.planeCloud) {
    scene.remove(ctx.planeCloud);
    ctx.planeCloud.geometry.dispose();
    (ctx.planeCloud.material as THREE.Material).dispose();
    ctx.planeCloud = null;
  }
  ctx.planeTrails = [];
  ctx.allyAlive.value = ctx.allyTotal.value;
  ctx.enemyAlive.value = ctx.enemyTotal.value;
  ctx.capStatus.value = [0, 0, 0];
  ctx.capDisplay.value = [];
  ctx.allyScore.value = 0;
  ctx.enemyScore.value = 0;
  ctx.reportedSinks.clear();
  ctx.feed.value = [];
  ctx.chatPtr = 0;
  ctx.achPtr = 0;
  ctx.selectedEntityId.value = null;
  ctx.rosterAssignments = new Map();
  ctx.shipEntityIds = [];
}

/** Quick team-role lookup for the minimap trails, shell-arc targets and
 *  self-stats — reads the SAME roster assignments the 3D markers use
 *  (computed in rebuildActors), so trails and markers can never disagree.
 *  Ships without an assignment (older replays, decode gaps) fall back to
 *  the entity-id spawn-order heuristic: the client spawns team A first. */
export function resolveRoleQuick(ctx: MapInternals, tr: EntityTrajectory): TeamRole {
  const entry = ctx.rosterAssignments.get(tr.entityId);
  if (entry) return roleFromRelation(entry.relation);
  const idx = ctx.shipEntityIds.indexOf(tr.entityId);
  return idx >= 0 && idx < ctx.shipEntityIds.length / 2 ? "ally" : "enemy";
}

// ── Minimap base art + shared world-rect helpers ──────────────────────
/** (Re)load the base art + bounds for the current mapId. */
export function loadMinimapBase(ctx: MapInternals) {
  const epoch = ++ctx.minimapEpoch;
  ctx.minimapImage = null;
  ctx.minimapBounds = null;
  const url = resolveMapMinimapUrl(ctx.props.mapId);
  if (url) {
    const img = new Image();
    img.onload = () => { if (epoch === ctx.minimapEpoch) ctx.minimapImage = img; };
    img.src = url;
  }
  void loadMapBounds().then((all) => {
    if (epoch !== ctx.minimapEpoch) return;
    const key = ctx.props.mapId.replace(/^spaces\//, "");
    ctx.minimapBounds =
      all.get(key) ??
      all.get(key.toLowerCase()) ??
      [...all.entries()].find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1] ??
      null;
  });
}

/** True playable-map rectangle in SCENE coordinates (x, z = -worldZ).
 *  Projectile paths (shell arcs, torpedo runs) are clamped to it so they
 *  can never streak across the endless sea plane beyond the map edge.
 *  `minimaps.json` bounds are authoritative when loaded; until then (or
 *  for unknown maps) the fitted battle bounds stand in — projectiles then
 *  only leave the ships' active area, never empty space. */
export function sceneMapRect(ctx: MapInternals): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} | null {
  if (ctx.minimapBounds) {
    // World bounds are NOT z-mirrored; the scene is.
    return {
      minX: ctx.minimapBounds.minX,
      maxX: ctx.minimapBounds.maxX,
      minZ: -ctx.minimapBounds.maxZ,
      maxZ: -ctx.minimapBounds.minZ,
    };
  }
  return ctx.bounds;
}

/** Effective bounds in WORLD coordinates: the map's minimap bounds when
 *  known (matches the base art), else the trajectory bounds converted
 *  back from scene space (scene z = -world z) so the dots at least fit
 *  the canvas. Shared by drawMinimap and the tactical board layer so
 *  annotations and map art can never drift apart. */
export function computeFullMapBounds(ctx: MapInternals): MapBounds | null {
  return (
    ctx.minimapBounds ??
    (ctx.bounds
      ? { minX: ctx.bounds.minX, maxX: ctx.bounds.maxX, minZ: -ctx.bounds.maxZ, maxZ: -ctx.bounds.minZ }
      : null)
  );
}

/** ── Enlarged-2D viewport (pan / zoom / camera tweens) ─────────────
 *  The window keeps the map's aspect (square), never leaves `full`, and
 *  at scale 1 snaps back to the full map. `drawMinimap` paints the zoom
 *  canvas through it; the tactical board's projection uses the SAME
 *  window so annotations track the camera exactly. */
export function computeViewBounds(ctx: MapInternals, full: MapBounds): MapBounds {
  return viewWindow(ctx.mmView.value, full);
}

/** Auto-fit the orbit camera to a scene-space rect (shared by the bounds
 *  recomputation and the opening-view defaults). */
export function fitCamera(
  ctx: MapInternals,
  b: { minX: number; maxX: number; minZ: number; maxZ: number },
) {
  const ctrl = ctx.api.value?.controls;
  const cam = ctx.api.value?.camera;
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
