import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as THREE from "three";

import { useThreeScene } from "./useThreeScene";
import {
  resolveMapModelUrl,
  resolveMapMinimapUrl,
  resolveShipModelForEntry,
  resolveShipModelByShipId,
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
import { TEAM_COLOR, roleFromRelation, type TeamRole } from "./teamColors";
import type { EntityTrajectory, ShipInfo, VehicleEntry, HpSample } from "@/api";
import { tierToRoman } from "@/utils/tierRoman";
import ShipTypeIcon from "@/components/base/ShipTypeIcon";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useLanguage } from "@/i18n/useLanguage";
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
      followSelected();
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
    // The capture-zone entities + their ownership timelines.
    const capZones = computed(() =>
      props.trajectories.filter((t) => t.kind?.entityType === 14),
    );

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
    let planeCloud: THREE.Points | null = null;
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

      // Ship dots: the game's own class glyphs (same shapes as the label
      // icons), tinted by team. Sunk ships render as small grey dots.
      const t = current.value;
      for (const m of shipMarkers) {
        const role = m.userData.role as TeamRole | undefined;
        const dead =
          (m.userData.deathTime as number | null) != null &&
          t >= (m.userData.deathTime as number);
        const cx = wx(m.position.x);
        const cz = wz(m.position.z);
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

      // Aircraft (entityType 4) — small cyan dots at their interpolated spot.
      ctx.fillStyle = "rgba(120, 210, 255, 0.85)";
      for (const tr of props.trajectories) {
        if (tr.kind?.entityType !== 4 || tr.samples.length < 2) continue;
        const s = sampleAt(tr, t);
        ctx.beginPath();
        ctx.arc(wx(s.x), wz(-s.z), 1.6, 0, Math.PI * 2);
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
            const dead =
              (m.userData.deathTime as number | null) != null &&
              t >= (m.userData.deathTime as number);
            const cx = zwx(m.position.x);
            const cz = zwz(m.position.z);
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
          // Aircraft dots + patrol paths (thin cyan lines).
          zctx.fillStyle = "rgba(120, 210, 255, 0.85)";
          for (const tr of props.trajectories) {
            if (tr.kind?.entityType !== 4 || tr.samples.length < 2) continue;
            const s = sampleAt(tr, t);
            zctx.beginPath();
            zctx.arc(zwx(s.x), zwz(-s.z), 4, 0, Math.PI * 2);
            zctx.fill();
            // patrol path: polyline of the aircraft's route
            zctx.strokeStyle = "rgba(120, 210, 255, 0.35)";
            zctx.lineWidth = 1;
            zctx.beginPath();
            tr.samples.forEach((ss, i) => {
              const px = zwx(ss.x);
              const py = zwz(-ss.z);
              if (i === 0) zctx.moveTo(px, py);
              else zctx.lineTo(px, py);
            });
            zctx.stroke();
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
      const idx = props.trajectories
        .filter((x) => x.kind?.entityType === 2 && x.samples.length >= 80)
        .map((x) => x.entityId)
        .sort((a, b) => a - b)
        .indexOf(tr.entityId);
      return idx >= 0 && idx < 8 ? "ally" : "enemy";
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
      if (planeCloud) {
        scene.remove(planeCloud);
        planeCloud.geometry.dispose();
        (planeCloud.material as THREE.Material).dispose();
        planeCloud = null;
      }
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
          for (const s of t.samples) eat(s.x, -s.z);
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

      // Ships = EntityCreate type 2 with a healthy number of position samples
      // (transient entities like planes/torpedoes have far fewer). Sorted by
      // entity id — the client spawns team A before team B, so this order is
      // the fallback team-split heuristic when a roster join fails.
      const shipTrajs = props.trajectories.filter(
        (t) => t.kind?.entityType === 2 && t.samples.length >= 80,
      );
      const shipEntityIds = shipTrajs.map((t) => t.entityId).sort((a, b) => a - b);
      const assignments = resolveRosterAssignments(shipTrajs);

      // Aircraft (entityType 4): rendered as a lightweight THREE.Points cloud
      // (one vertex per squadron), colored cyan. Positions update per frame.
      const planeTrajs = props.trajectories.filter(
        (t) => t.kind?.entityType === 4 && t.samples.length >= 2,
      );
      if (planeTrajs.length > 0) {
        const positions = new Float32Array(planeTrajs.length * 3);
        const colors = new Float32Array(planeTrajs.length * 3);
        for (let i = 0; i < planeTrajs.length; i++) {
          positions[i * 3 + 1] = -9999; // hidden until placed
          colors[i * 3] = 0.45;
          colors[i * 3 + 1] = 0.8;
          colors[i * 3 + 2] = 1.0;
        }
        const pGeo = new THREE.BufferGeometry();
        pGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        pGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        const pMat = new THREE.PointsMaterial({
          size: 5,
          vertexColors: true,
          transparent: true,
          opacity: 0.9,
          sizeAttenuation: false,
          depthWrite: false,
        });
        const points = new THREE.Points(pGeo, pMat);
        points.userData.planeEntityIds = planeTrajs.map((t) => t.entityId);
        points.userData.planeTrajs = planeTrajs;
        scene.add(points);
        planeCloud = points;
      }

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
        const maxHp = streamMax ?? encHealth;
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
            if (role === "ally") allyAlive.value = Math.max(0, allyAlive.value - 1);
            else if (role === "enemy") enemyAlive.value = Math.max(0, enemyAlive.value - 1);
            // Kill feed + score tick. The killer is unknown from the replay
            // stream, so the feed names the victim only.
            if (!reportedSinks.has(entityId)) {
              reportedSinks.add(entityId);
              const who = label?.name ?? `#${entityId}`;
              const victimRole = role === "ally" ? "enemy" : "ally";
              if (victimRole === "ally") allyScore.value += 1;
              else enemyScore.value += 1;
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
      // Aircraft positions at this instant.
      if (planeCloud) {
        const trajs = planeCloud.userData.planeTrajs as EntityTrajectory[];
        const attr = planeCloud.geometry.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i < trajs.length; i++) {
          const s = sampleAt(trajs[i], t);
          const visible =
            s != null &&
            ((trajs[i].kind?.creationTime ?? -1) < 0 || t >= (trajs[i].kind?.creationTime ?? -1));
          if (visible && s) {
            attr.setXYZ(i, s.x, 2, -s.z);
          } else {
            attr.setXYZ(i, 0, -9999, 0);
          }
        }
        attr.needsUpdate = true;
      }
      // Update screen-space positions of floating labels from marker world positions.
      updateLabelPositions();
    }

    /** Time a team needs to fully capture a point (domination standard).
     *  The replay only logs ownership CHANGES (not the tick-by-tick progress),
     *  so the in-progress window is approximated as [changeTime - CAP_TIME,
     *  changeTime] with a live countdown. */
    const CAP_TIME = 40;

    /** Capture-zone display state per zone (ownership + capture progress),
     *  recomputed every frame from the zones' capSamples. */
    const capDisplay = ref<
      { owner: number; capturing: boolean; progress: number; remain: number }[]
    >([]);

    /** Derive cap ownership (0/1/2), per-zone capture progress, and the
     *  estimated score at playback time t from the zones' capSamples. */
    function updateCapsAndScore(t: number) {
      const zones = capZones.value;
      let allyCapPts = 0;
      let enemyCapPts = 0;
      const display: { owner: number; capturing: boolean; progress: number; remain: number }[] = [];
      for (let i = 0; i < zones.length && i < 3; i++) {
        const samples = zones[i].capSamples ?? [];
        let owner = 0;
        let lastChange = -Infinity;
        for (const s of samples) {
          if (s.time <= t) {
            owner = s.value;
            lastChange = s.time;
          } else {
            break;
          }
        }
        if (owner === 1) allyCapPts += 3;
        else if (owner === 2) enemyCapPts += 3;
        // Capture-in-progress window: the last change completed the capture;
        // the 40s before it the zone was being captured by that team.
        const capturing = owner !== 0 && t >= lastChange - CAP_TIME && t < lastChange;
        if (capturing) {
          if (owner === 1) allyCapPts += 1;
          else enemyCapPts += 1;
        }
        capStatus.value[i] = owner;
        display.push({
          owner,
          capturing,
          progress: capturing
            ? Math.max(0, Math.min(1, (t - (lastChange - CAP_TIME)) / CAP_TIME))
            : owner !== 0 ? 1 : 0,
          remain: capturing ? Math.max(0, Math.ceil(lastChange - t)) : 0,
        });
      }
      capDisplay.value = display;
      // Score = kills (deaths of the opposing side, already counted via the
      // sink feed) + current cap points.
      const allyKills = enemyTotal.value - enemyAlive.value;
      const enemyKills = allyTotal.value - allyAlive.value;
      allyScore.value = allyKills + allyCapPts;
      enemyScore.value = enemyKills + enemyCapPts;
    }

    /** First-person camera: keep the selected ship centered, camera trailing
     *  behind it along its heading. Called every render frame. */
    function followSelected() {
      const id = selectedEntityId.value;
      if (id == null) return;
      const ctrl = api.value?.controls;
      const cam = api.value?.camera;
      if (!ctrl || !cam) return;
      const marker = shipMarkers.find((m) => m.userData.entityId === id);
      if (!marker || !marker.visible) return;
      const pos = marker.position;
      const yaw = marker.rotation.y; // three.js yaw (already mirrored)
      // Behind the ship: opposite its heading, slightly above.
      const dist = 90;
      const behind = new THREE.Vector3(
        pos.x - Math.sin(yaw) * dist,
        35,
        pos.z - Math.cos(yaw) * dist,
      );
      cam.position.copy(behind);
      ctrl.target.copy(pos);
      ctrl.update();
    }

    /** Select a ship by clicking (either its 3D marker or its label). Clicking
     *  the empty scene clears the selection. */
    function selectShip(entityId: number | null) {
      selectedEntityId.value = entityId;
    }

    /** Simple label anti-overlap: visible labels are sorted by screen y and
     *  pushed down when they would cover an earlier one. */
    function avoidLabelOverlap() {
      const labels = shipLabels.value;
      const vis = labels.filter((l) => l.visible);
      vis.sort((a, b) => a.y - b.y);
      const placed: { x: number; y: number; w: number; h: number }[] = [];
      for (const l of vis) {
        const w = 120;
        const h = 46;
        let y = l.y;
        let guard = 0;
        while (guard++ < 8 && placed.some((p) => Math.abs(p.x - l.x) < (p.w + w) / 2 && y < p.y + p.h && y + h > p.y)) {
          y += h + 2;
        }
        l.y = y;
        placed.push({ x: l.x, y, w, h });
      }
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
      avoidLabelOverlap();
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
      if (seaSurface) {
        api.value?.scene.remove(seaSurface);
        seaSurface.geometry.dispose();
        (seaSurface.material as THREE.Material).dispose();
        seaSurface = null;
      }
      clearShipMarkerCache();
    });

    return () => (
      <div class="holo-map">
        <div ref={container} class="holo-map__canvas" onClick={() => selectShip(null)} />
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
                selectedEntityId.value === lbl.entityId ? "holo-label--selected" : "",
              ]}
              style={{
                left: `${lbl.x}px`,
                top: `${lbl.y}px`,
                borderColor: `#${TEAM_COLOR[lbl.role].toString(16).padStart(6, "0")}`,
              }}
              onClick={(e) => { e.stopPropagation(); selectShip(lbl.entityId); }}
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
              <span class="holo-map__score-alive">{allyAlive.value}/{allyTotal.value}</span>
            </span>
            <span class="holo-map__score-caps">
              {["A","B","C"].map((l,i) => {
                const c = capDisplay.value[i];
                const owner = c?.owner ?? 0;
                return (
                  <span
                    class={[
                      "holo-map__cap",
                      owner === 1 ? "holo-map__cap--ally" : owner === 2 ? "holo-map__cap--enemy" : "",
                      c?.capturing ? "holo-map__cap--capturing" : "",
                    ]}
                    title={c?.capturing ? `${l} 占领中 ${c?.remain}s` : owner === 0 ? "中立" : owner === 1 ? "我方控制" : "敌方控制"}
                  >
                    {l}
                    {c?.capturing ? <em class="holo-map__cap-timer">{c.remain}s</em> : null}
                  </span>
                );
              })}
            </span>
            <span class="holo-map__score-team holo-map__score--enemy">
              <strong class="holo-map__score-num">{enemyScore.value}</strong>
              <span class="holo-map__score-alive">{enemyAlive.value}/{enemyTotal.value}</span>
              <span class="holo-map__score-dot" style="background:#cc3333" />
            </span>
            <span class="holo-map__score-time" onClick={toggleTimeMode} title="点击切换 已播放/剩余/总时长">
              {timeMode.value === 1 ? "-" : ""}{displayTime()}
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
              <label>
                <input
                  type="checkbox"
                  checked={minimapShowTrails.value}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => { minimapShowTrails.value = (e.target as HTMLInputElement).checked; }}
                />
                {t("replay.minimap.trails")}
              </label>
            </div>
            <canvas ref={zoomCanvas} width={640} height={640} class="holo-map__mmzoom-canvas" />
          </div>
        ) : null}
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
