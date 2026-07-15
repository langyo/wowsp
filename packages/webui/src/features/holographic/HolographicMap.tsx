import { defineComponent, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import * as THREE from "three";

import { useThreeScene } from "./useThreeScene";
import {
  resolveMapModelUrl,
  resolveShipModelForEntry,
  loadGlbModel,
  type ShipModelSpec,
} from "./modelLoader";
import { makeHoloMaterial, tickHoloUniforms, type HoloUniforms } from "./holoShader";
import { makeHoloContourMaterial } from "./holoContourShader";
import { buildShipMarker, disposeMarker, clearShipMarkerCache } from "./shipMarker";
import { TEAM_COLOR, roleFromRelation, holoColorsFor, type TeamRole } from "./teamColors";
import type { EntityTrajectory, ShipInfo, VehicleEntry } from "@/api";
import { tierToRoman } from "@/utils/tierRoman";
import ShipTypeIcon from "@/components/base/ShipTypeIcon";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
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
    // Uniforms objects for the map's holographic materials (islands + terrain
    // contour). Each material has its own uniforms; we tick all of them each
    // frame so the scanline sweep stays in sync across both shaders.
    const holoUniformsList: HoloUniforms[] = [];
    const { ready, api } = useThreeScene(container, (dt) => {
      for (const u of holoUniformsList) tickHoloUniforms(u, dt);
      // Keep floating label positions in sync even when the camera is
      // being panned/zoomed (Orbit-like controls aren't wired here yet,
      // but the projection is cheap enough to run every frame for when
      // they are).
      updateLabelPositions();
    });

    // Playback state.
    const duration = ref(0);
    const current = ref(0);
    const playing = ref(false);
    let playRaf = 0;
    let lastTick = 0;

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
      /** Screen-space left/top in px (relative to the canvas). Updated per-frame. */
      x: number;
      y: number;
      visible: boolean;
      dead: boolean;
    }
    const shipLabels = ref<ShipLabel[]>([]);
    /** World-position scratch vector reused each frame for label projection. */
    const _projVec = new THREE.Vector3();

    /** Tokens used to cancel in-flight async marker loads when actors are
     *  rebuilt/unmounted before a GLB resolves. Each rebuild bumps the epoch;
     *  stale loads compare against the live epoch before mutating the scene. */
    let markerEpoch = 0;

    function clearActors() {
      markerEpoch++; // invalidate any in-flight marker loads
      const scene = api.value?.scene;
      if (!scene) return;
      for (const l of trajectoryLines) {
        scene.remove(l);
        l.geometry.dispose();
        (l.material as THREE.Material).dispose();
      }
      for (const m of shipMarkers) {
        scene.remove(m);
        // Markers built by buildShipMarker share geometry with the global GLB
        // cache (identical ships reuse one buffer) — only dispose materials,
        // not geometry. Cone fallbacks own their geometry but disposeMarker
        // only touches materials, so dispose cones' geometry explicitly.
        if (m.userData.isCone) {
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
        holoUniformsList.length = 0;
      }
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
        const islandMat = makeHoloMaterial();
        const contourMat = makeHoloContourMaterial();
        holoUniformsList.push(
          islandMat.uniforms as unknown as HoloUniforms,
          contourMat.uniforms as unknown as HoloUniforms,
        );
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
          // A mesh is "terrain" if it or any ancestor node is named Terrain
          // (GLTFLoader propagates the glTF node name to the Object3D).
          let isTerrain = mesh.name === "Terrain";
          let p: THREE.Object3D | null = mesh.parent;
          while (!isTerrain && p && p !== model) {
            if (p.name === "Terrain") isTerrain = true;
            p = p.parent;
          }
          mesh.material = isTerrain ? contourMat : islandMat;
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
          if (s.z < minZ) minZ = s.z;
          if (s.z > maxZ) maxZ = s.z;
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
      const cam = api.value?.camera;
      if (!cam) return;
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      const w = b.maxX - b.minX;
      const d = b.maxZ - b.minZ;
      const span = Math.max(w, d, 200) * 0.7; // padding + min size
      cam.position.set(cx, span * 1.4, cz + span * 1.0);
      cam.lookAt(cx, 0, cz);
    }

    /** Map each ship trajectory to its roster entry (for team role + ship
     *  model) via the EntityCreate `vehicleId`. WoWS's MM-style tooling treats
     *  this as the player's per-match id, matching the roster `id` field. When
     *  a trajectory has no matching roster entry (older replay, decode gap),
     *  the role falls back to the entity-id spawn-order heuristic: the client
     *  spawns team A before team B, so the first half of ships (by entity id)
     *  are treated as allies. Unresolved ships never claim the "self" role, so
     *  the recorder's own marker stays uniquely green. */
    function resolveMarkerContext(
      traj: EntityTrajectory,
      shipEntityIds: number[],
    ): { role: TeamRole; shipInfo: ShipInfo | null } {
      const vehicles = props.vehicles;
      // 1. Exact: vehicleId (from EntityCreate) == roster id.
      const vid = traj.kind?.vehicleId;
      const entry =
        vid != null ? vehicles.find((v) => v.id === vid) : undefined;
      let role: TeamRole;
      let shipInfo: ShipInfo | null;
      if (entry) {
        role = roleFromRelation(entry.relation);
        shipInfo = props.encyclopedia.get(entry.shipId) ?? null;
      } else {
        // 2. Fallback: entity-id spawn order (team A spawns before team B).
        //    Never "self" — only the exact match earns the recorder tint.
        const idx = shipEntityIds.indexOf(traj.entityId);
        const isAlly = idx >= 0 && idx < shipEntityIds.length / 2;
        role = isAlly ? "ally" : "enemy";
        shipInfo = null;
      }
      return { role, shipInfo };
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
      const shipEntityIds = props.trajectories
        .filter((t) => t.kind?.entityType === 2 && t.samples.length >= 80)
        .map((t) => t.entityId)
        .sort((a, b) => a - b);

      const newLabels: ShipLabel[] = [];

      for (const traj of props.trajectories) {
        if (traj.samples.length < 2) continue;
        // Only render ships (EntityCreate type 2 with many samples); skip
        // zones/avatars/planes/torpedoes.
        if (traj.kind?.entityType !== 2 || traj.samples.length < 80) continue;

        const { role, shipInfo } = resolveMarkerContext(traj, shipEntityIds);
        const color = TEAM_COLOR[role];

        // Trajectory line on the XZ plane (y=0.5 to hover above the grid).
        const pts = traj.samples.map((s) => new THREE.Vector3(s.x, 0.5, s.z));
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 });
        const line = new THREE.Line(geom, mat);
        scene.add(line);
        trajectoryLines.push(line);

        // Marker: start as a cone, optionally upgraded to a ship model.
        const marker = new THREE.Group();
        const coneGeom = new THREE.ConeGeometry(14, 36, 8);
        const coneMat = new THREE.MeshBasicMaterial({ color });
        const cone = new THREE.Mesh(coneGeom, coneMat);
        cone.rotation.x = Math.PI / 2; // lie flat, point +Z at yaw 0
        marker.add(cone);
        marker.userData.entityId = traj.entityId;
        marker.userData.role = role;
        marker.userData.isCone = true;
        marker.userData.deathTime = traj.deathTime ?? null;
        marker.visible = false;
        scene.add(marker);
        shipMarkers.push(marker);

        // Async: swap the cone for the real/fallback ship model.
        const modelUrl = resolveShipModelForEntry(shipInfo, encSpecs);
        if (modelUrl) {
          buildShipMarker({ url: modelUrl, role })
            .then((shipModel) => {
              if (epoch !== markerEpoch || !api.value?.scene) return; // stale
              const pos = marker.position.clone();
              const yaw = marker.rotation.y;
              const visible = marker.visible;
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
              marker.position.copy(pos);
              marker.rotation.y = yaw;
              marker.visible = visible;
              marker.userData.isCone = false;
            })
            .catch(() => {
              /* cone stays — model load failed (corrupt/missing GLB) */
            });
        }

        // Floating label: player name + ship info for the overlay.
        const rosterEntry = props.vehicles.find((v) => v.id === traj.kind?.vehicleId);
        const name = rosterEntry?.name ?? `#${traj.entityId}`;
        const encStore = useEncyclopediaStore();
        const shipName = shipInfo
          ? encStore.shipDisplayName(shipInfo)
          : (rosterEntry?.shipName ?? "?");
        newLabels.push({
          entityId: traj.entityId,
          role,
          name,
          shipName,
          tier: shipInfo?.tier ?? null,
          type: shipInfo?.type ?? null,
          x: 0, y: 0,
          visible: false,
          dead: false,
        });
      }
      shipLabels.value = newLabels;
    }

    /** Position + orient each ship marker at the current playback time.
     *  Ships that have been destroyed (time ≥ deathTime) are frozen at their
     *  last known position and their materials desaturated to a faint grey
     *  tint that still hints at the original team colour. */
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
        marker.visible = true;
        marker.position.set(s.x, 0.5, s.z);
        marker.rotation.y = s.yaw;

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
            if (m.material && (m.material as any).uniforms) {
              const u = (m.material as any).uniforms;
              if (u.baseColor) u.baseColor.value.set(deadBase);
              if (u.fresnelColor) u.fresnelColor.value.set(deadFresnel);
              (m.material as THREE.Material).opacity = 0.35;
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
      () => props.encyclopedia,
      () => {
        if (ready.value) {
          rebuildActors();
          updateMarkersAt(current.value);
        }
      },
      { deep: false },
    );

    // Recompute markers whenever the scrubber moves.
    watch(current, (t) => updateMarkersAt(t));

    // Once the scene is ready, build actors for any trajectories already set
    // and attempt to load the terrain model.
    watch(ready, (r) => {
      if (r) {
        recomputeBoundsAndCamera();
        rebuildActors();
        updateMarkersAt(current.value);
        void tryLoadMapModel();
      }
    });

    // Reload terrain when the map changes (e.g. switching replays).
    watch(() => props.mapId, () => {
      if (ready.value) void tryLoadMapModel();
    });

    onBeforeUnmount(() => {
      cancelAnimationFrame(playRaf);
      clearActors();
      clearMapModel();
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
              {lbl.dead ? <span class="holo-label__dead-tag">{t("replay.legend.dead")}</span> : null}
            </div>
          ))}
        </div>
        {!ready.value ? <div class="holo-map__hint">Initializing holographic scene…</div> : null}
        {props.trajectories.length > 0 ? (
          <div class="holo-map__legend">
            <span class="holo-map__legend-item">
              <span class="holo-map__legend-dot" style={{ background: "#3cb478" }} />
              {t("replay.legend.self")}
            </span>
            <span class="holo-map__legend-item">
              <span class="holo-map__legend-dot" style={{ background: "#0078c8" }} />
              {t("replay.legend.ally")}
            </span>
            <span class="holo-map__legend-item">
              <span class="holo-map__legend-dot" style={{ background: "#e6aa32" }} />
              {t("replay.legend.enemy")}
            </span>
          </div>
        ) : null}
        {props.trajectories.length > 0 ? (
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
            <span class="holo-map__time">
              {current.value.toFixed(0)}s / {duration.value.toFixed(0)}s
            </span>
            <span class="holo-map__count">{props.trajectories.length} entities</span>
          </div>
        ) : null}
      </div>
    );
  },
});
