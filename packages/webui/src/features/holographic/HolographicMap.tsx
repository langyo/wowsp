import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as THREE from "three";

import { useThreeScene } from "./useThreeScene";
import {
  resolveMapModelUrl,
  resolveMapMinimapUrl,
  resolveShipModelForEntry,
  resolveShipModelByShipId,
  shipNameFromModelDb,
  loadGlbModel,
  loadMapBounds,
  type MapBounds,
  type ShipModelSpec,
} from "./modelLoader";
import { makeHoloContourMaterial } from "./holoContourShader";
import { buildShipMarker, disposeMarker, clearShipMarkerCache } from "./shipMarker";
import { TEAM_COLOR, roleFromRelation, holoColorsFor, type TeamRole } from "./teamColors";
import type { EntityTrajectory, ShipInfo, VehicleEntry, HpSample } from "@/api";
import { tierToRoman } from "@/utils/tierRoman";
import ShipTypeIcon from "@/components/base/ShipTypeIcon";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
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
    /** Roster from the replay header — used to map trajectories to teams and
     *  resolve each ship's model. */
    vehicles: { type: Array as () => VehicleEntry[], default: () => [] },
    /** Ship encyclopedia (shipId → ShipInfo). Used to resolve tier/nation/type
     *  for per-ship model loading + tier-based fallback when a model is missing. */
    encyclopedia: { type: Object as () => Map<number, ShipInfo>, default: () => new Map() },
    /** Map space id (e.g. "15_NE_north") — used to load the terrain GLB. */
    mapId: { type: String, default: "" },
  },
  setup(props) {
    const container = ref<HTMLElement | null>(null);
    const { ready, api } = useThreeScene(container, (_dt) => {
      updateLabelPositions();
      drawMinimap();
    });

    // Playback state.
    const duration = ref(0);
    const current = ref(0);
    const playing = ref(false);
    let playRaf = 0;
    let lastTick = 0;

    // Time display toggle: 0=elapsed, 1=remaining, 2=total
    const timeMode = ref(0);
    const showRoster = ref(false);

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
    // Cap zone status (A=0, B=1, C=2) — 0=neutral, 1=team1, 2=team2
    const capStatus = ref([0, 0, 0]);

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
      /** Screen-space left/top in px (relative to the canvas). Updated per-frame. */
      x: number;
      y: number;
      visible: boolean;
      dead: boolean;
    }
    const shipLabels = ref<ShipLabel[]>([]);
    const _projVec = new THREE.Vector3();

    // Minimap canvas. The base layer is the game's own minimap art (water +
    // land composite, extracted by `extract_minimaps.py`); positions use the
    // map's world bounds from `minimaps.json` so ship dots sit on the same
    // spots as the in-battle minimap. Without art/bounds for this map we fall
    // back to the plain dark base + trajectory-derived bounds.
    const minimapCanvas = ref<HTMLCanvasElement | null>(null);
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
      const b: MapBounds | null =
        minimapBounds ??
        (bounds
          ? { minX: bounds.minX, maxX: bounds.maxX, minZ: -bounds.maxZ, maxZ: -bounds.minZ }
          : null);
      if (!b) return;
      const cvs = minimapCanvas.value;
      if (!cvs) return;
      if (!_mmCtx) _mmCtx = cvs.getContext("2d");
      const ctx = _mmCtx!;
      const w = MINIMAP_SIZE;
      const h = MINIMAP_SIZE;
      if (cvs.width !== w) cvs.width = w;
      if (cvs.height !== h) cvs.height = h;

      const mapW = b.maxX - b.minX;
      const mapH = b.maxZ - b.minZ;

      // Markers/camera live in three.js space (z = -worldZ); convert back to
      // world coordinates for the map projection. North (+worldZ) is up on
      // the game's minimap (world_to_minimap flips z).
      function wx(x: number) { return ((x - b.minX) / (mapW || 1)) * w; }
      function wz(zScene: number) { return ((b.maxZ + zScene) / (mapH || 1)) * h; }

      ctx.clearRect(0, 0, w, h);
      if (minimapImage) {
        ctx.drawImage(minimapImage, 0, 0, w, h);
      } else {
        ctx.fillStyle = "rgba(5, 8, 15, 0.85)";
        ctx.fillRect(0, 0, w, h);
      }
      ctx.strokeStyle = "rgba(0, 170, 255, 0.3)";
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

      // Ship dots.
      for (const m of shipMarkers) {
        if (!m.visible) continue;
        const role = m.userData.role as TeamRole | undefined;
        const color = role ? TEAM_COLOR[role] : 0x888888;
        const cx = wx(m.position.x);
        const cz = wz(m.position.z);
        ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
        ctx.beginPath();
        ctx.arc(cx, cz, 2.5, 0, Math.PI * 2);
        ctx.fill();
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

    /** Tokens used to cancel in-flight async marker loads when actors are
     *  rebuilt/unmounted before a GLB resolves. Each rebuild bumps the epoch;
     *  stale loads compare against the live epoch before mutating the scene. */
    let markerEpoch = 0;

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
      allyAlive.value = allyTotal.value;
      enemyAlive.value = enemyTotal.value;
      capStatus.value = [0, 0, 0];
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
    function ensureWaterFloor() {
      const scene = api.value?.scene;
      if (!scene || waterFloor) return;
      const mat = new THREE.MeshBasicMaterial({ color: 0x0f2c54 });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(24000, 24000), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = -40;
      mesh.renderOrder = -1;
      mesh.raycast = () => {}; // never intercept picks
      scene.add(mesh);
      waterFloor = mesh;
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
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const t of props.trajectories) {
        for (const s of t.samples) {
          if (s.time < minT) minT = s.time;
          if (s.time > maxT) maxT = s.time;
          if (s.x < minX) minX = s.x;
          if (s.x > maxX) maxX = s.x;
          if (-s.z < minZ) minZ = -s.z;
          if (-s.z > maxZ) maxZ = -s.z;
        }
      }
      if (Number.isFinite(minT)) {
        duration.value = Math.max(maxT - minT, 0.1);
        if (current.value > duration.value) current.value = duration.value;
        bounds = { minX, maxX, minZ, maxZ };
        fitCamera(bounds);
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
      ctrl.maxDistance = diagonal * 0.9; // farthest: ~80% map in viewport
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
        for (const traj of shipTrajs) {
          const a = assignments.get(traj.entityId);
          if (!a) continue;
          const s = spawnOf(traj);
          if (a.relation <= 1) { ax += s.x; az += s.z; an++; }
          else { ex += s.x; ez += s.z; en++; }
        }
        for (const { traj, entries } of ambiguous) {
          let pick: VehicleEntry | null = null;
          if (an > 0 && en > 0) {
            const s = spawnOf(traj);
            const dAlly = (s.x - ax / an) ** 2 + (s.z - az / an) ** 2;
            const dEnemy = (s.x - ex / en) ** 2 + (s.z - ez / en) ** 2;
            const wantAlly = dAlly < dEnemy;
            pick =
              entries.find((e) => (wantAlly ? e.relation <= 1 : e.relation > 1)) ??
              entries[0];
          } else {
            pick = entries[0];
          }
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

      // Ships = EntityCreate type 2 with a healthy number of position samples
      // (transient entities like planes/torpedoes have far fewer). Sorted by
      // entity id — the client spawns team A before team B, so this order is
      // the fallback team-split heuristic when a roster join fails.
      const shipTrajs = props.trajectories.filter(
        (t) => t.kind?.entityType === 2 && t.samples.length >= 80,
      );
      const shipEntityIds = shipTrajs.map((t) => t.entityId).sort((a, b) => a - b);
      const assignments = resolveRosterAssignments(shipTrajs);

      const newLabels: ShipLabel[] = [];

      for (const traj of props.trajectories) {
        if (traj.samples.length < 2) continue;
        // Only render ships (EntityCreate type 2 with many samples); skip
        // zones/avatars/planes/torpedoes.
        if (traj.kind?.entityType !== 2 || traj.samples.length < 80) continue;

        const { role, shipInfo, entry: rosterEntry } = resolveMarkerContext(
          traj,
          shipEntityIds,
          assignments,
        );
        const color = TEAM_COLOR[role];

        // Trajectory line on the XZ plane (y=0.5 to hover above the grid).
        // World z (north+) is negated into three.js space — the baked map
        // GLBs use the same right-handed convention (wowsunpack exports
        // z' = -z), so ships line up with islands instead of mirroring.
        const pts = traj.samples.map((s) => new THREE.Vector3(s.x, 0.5, -s.z));
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 });
        const line = new THREE.Line(geom, mat);
        scene.add(line);
        trajectoryLines.push(line);

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
        marker.userData.modelLoaded = false;
        marker.userData.isDot = true;
        marker.userData.deathTime = traj.deathTime ?? null;
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
              marker.visible = true;
              initMarkerPosition(marker, traj, current.value);
              updateLabelPositions();
            })
            .catch((e) => {
              console.warn(`[HolographicMap] failed to load marker model for entity ${traj.entityId}:`, e);
            });
        }

        const name = rosterEntry?.name ?? `#${traj.entityId}`;
        const encStore = useEncyclopediaStore();
        const shipName =
          (shipInfo ? encStore.shipDisplayName(shipInfo) : null) ??
          rosterEntry?.shipName ??
          shipInfo?.name ??
          shipNameFromModelDb(rosterEntry?.shipId ?? traj.kind?.shipId) ??
          "?";
        // Max HP: the peak of the entity's own HP stream — authoritative for
        // the battle's actual scaling (event/asymmetric modes cut bot HP to a
        // fraction of the encyclopedia hull value; upgraded hulls raise it).
        // Without an HP stream we show no HP line at all: rendering the
        // encyclopedia's stock hull value as if it were live battle HP would
        // fabricate data.
        const streamMax =
          traj.hpSamples && traj.hpSamples.length > 0
            ? Math.max(...traj.hpSamples.map((s) => s.value))
            : null;
        const maxHp = streamMax;
        newLabels.push({
          entityId: traj.entityId,
          role,
          name,
          shipName,
          tier: shipInfo?.tier ?? null,
          type: shipInfo?.type ?? null,
          hp: maxHp,
          maxHp,
          x: 0, y: 0,
          visible: false,
          dead: false,
        });
      }
      shipLabels.value = newLabels;

      // Capture zones: entityType 14 circles on the XZ plane.
      // Capture zones are static and may have no position samples; use the
      // initial position from EntityCreate metadata.
      const capKinds = props.trajectories
        .filter((t) => t.kind?.entityType === 14)
        .map((t) => ({ x: t.kind!.initialX, z: t.kind!.initialZ }));
      if (capKinds.length === 0) {
        console.warn("[HolographicMap] no capture zone data found in trajectory kinds");
      }
      const capZoneNames = ["A", "B", "C", "D"];
      for (let i = 0; i < capKinds.length && i < 4; i++) {
        const { x: cx, z: cz } = capKinds[i];
        const ringGeom = new THREE.TorusGeometry(60, 1.2, 8, 48);
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
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.font = "bold 48px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(capZoneNames[i], 32, 32);
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

    /** Position + orient each ship marker at the current playback time.
     *  Ships whose model hasn't loaded yet are skipped; ships that have been
     *  destroyed (time ≥ deathTime) are frozen at their last position and
     *  their materials desaturated to a faint grey tint. */
    function updateMarkersAt(t: number) {
      const labels = shipLabels.value;
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
        // After death, freeze at the last sample position (no more interpolation).
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
        marker.visible = true;
        marker.position.set(s.x, 0, -s.z);
        marker.rotation.y = Math.PI - s.yaw;
        if (label) {
          const currentHp = hpAtTime(traj.hpSamples, tEff);
          if (currentHp != null) label.hp = currentHp;
          label.maxHp ??= currentHp ?? label.maxHp;
        }
        if (dead && !marker.userData._countedDead) {
          marker.userData._countedDead = true;
          const role = marker.userData.role as TeamRole;
          if (role === "ally") allyAlive.value = Math.max(0, allyAlive.value - 1);
          else if (role === "enemy") enemyAlive.value = Math.max(0, enemyAlive.value - 1);
        }

        // Grey out dead ships: desaturate every child material toward a faint
        // grey while keeping a hint of the role colour so teams remain readable.
        if (dead) {
          const role = marker.userData.role as TeamRole;
          const { baseColor, fresnelColor } = holoColorsFor(role);
          // Blend role colours with grey, reduce opacity.
          const deadBase = new THREE.Color(baseColor).lerp(new THREE.Color(0x444444), 0.75);
          const deadFresnel = new THREE.Color(fresnelColor).lerp(new THREE.Color(0x666666), 0.65);
          marker.traverse((o) => {
            const m = o as THREE.Mesh;
            const mat = m.material as THREE.ShaderMaterial | THREE.MeshBasicMaterial | null;
            if (!mat) return;
            if ((mat as THREE.ShaderMaterial).uniforms) {
              const u = (mat as THREE.ShaderMaterial).uniforms;
              if (u.baseColor) {
                (u.baseColor.value as THREE.Color).set(deadBase);
              }
              if (u.fresnelColor) {
                (u.fresnelColor.value as THREE.Color).set(deadFresnel);
              }
              mat.opacity = 0.35;
            } else if (mat instanceof THREE.MeshBasicMaterial) {
              mat.color.set(0x444444);
              mat.opacity = 0.35;
            }
          });
        }
      }
      // Update screen-space positions of floating labels from marker world positions.
      updateLabelPositions();
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
    }

    /** Interpolate a sample at time t (linear between neighbors). */
    function sampleAt(traj: EntityTrajectory, t: number) {
      const ss = traj.samples;
      if (t <= ss[0].time) return ss[0];
      if (t >= ss[ss.length - 1].time) return ss[ss.length - 1];
      for (let i = 1; i < ss.length; i++) {
        if (ss[i].time >= t) {
          const a = ss[i - 1];
          const b = ss[i];
          const f = (t - a.time) / (b.time - a.time || 1);
          return {
            ...a,
            x: a.x + (b.x - a.x) * f,
            z: a.z + (b.z - a.z) * f,
            yaw: a.yaw + angleDiff(a.yaw, b.yaw) * f,
          };
        }
      }
      return ss[ss.length - 1];
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
      current.value += dt * 8; // 8× playback speed by default
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
      clearShipMarkerCache();
    });

    return () => (
      <div class="holo-map">
        <div ref={container} class="holo-map__canvas" />
        {/* ── Floating ship labels (projected 3D→2D onto the canvas) ── */}
        <div class="holo-map__labels" aria-hidden="true">
          {shipLabels.value.map((lbl) => (
            <div
              key={lbl.entityId}
              class={[
                "holo-label",
                `holo-label--${lbl.role}`,
                lbl.dead ? "holo-label--dead" : "",
                lbl.visible ? "" : "holo-label--hidden",
              ]}
              style={{
                left: `${lbl.x}px`,
                top: `${lbl.y}px`,
                borderColor: `#${TEAM_COLOR[lbl.role].toString(16).padStart(6, "0")}`,
              }}
            >
              <span class="holo-label__name" title={lbl.name}>{lbl.name}</span>
              <span class="holo-label__ship">
                {lbl.type ? <ShipTypeIcon type={lbl.type} size={10} /> : null}
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
                          background: `#${TEAM_COLOR[lbl.role].toString(16).padStart(6, "0")}`,
                        }}
                      />
                    </span>
                  ) : null}
                  <span class="holo-label__hp-text">
                    {lbl.hp.toLocaleString()}
                    {lbl.maxHp != null ? ` / ${lbl.maxHp.toLocaleString()}` : ""}
                  </span>
                  {lbl.maxHp != null && lbl.hp < lbl.maxHp ? (
                    <span class="holo-label__hp-delta">
                      (−{(lbl.maxHp - lbl.hp).toLocaleString()})
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
              {allyAlive.value}/{allyTotal.value}
            </span>
            <span class="holo-map__score-caps">
              {["A","B","C"].map((l,i) => (
                <span class={["holo-map__cap", capStatus.value[i] === 1 ? "holo-map__cap--ally" : capStatus.value[i] === 2 ? "holo-map__cap--enemy" : ""]}>{l}</span>
              ))}
            </span>
            <span class="holo-map__score-team holo-map__score--enemy">
              {enemyAlive.value}/{enemyTotal.value}
              <span class="holo-map__score-dot" style="background:#cc3333" />
            </span>
          </div>
        ) : null}
        <canvas
          ref={minimapCanvas}
          class="holo-map__minimap"
          width={160}
          height={160}
          style={{
            width: "160px",
            height: "160px",
            position: "absolute",
            right: "8px",
            bottom: "8px",
            zIndex: "3",
            borderRadius: "4px",
            pointerEvents: "none",
          }}
        />
        {props.replayPath ? (
          <div class="holo-map__controls">
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
                    <td>{v.shipName ?? shipNameFromModelDb(v.shipId) ?? ""}</td>
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
                    <td>{v.shipName ?? shipNameFromModelDb(v.shipId) ?? ""}</td>
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
