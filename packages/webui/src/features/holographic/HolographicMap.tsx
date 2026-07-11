import { defineComponent, onBeforeUnmount, ref, watch } from "vue";
import * as THREE from "three";

import { useThreeScene } from "./useThreeScene";
import type { EntityTrajectory, VehicleEntry } from "@/api";
import "./HolographicMap.scss";

/**
 * The holographic battle map. Renders every entity's decoded trajectory (M3)
 * as a colored line, plus a ship marker at the current playback time that
 * points along its heading. A time slider scrubs the whole match.
 *
 * Coordinates: WoWS world space is x=east, z=north (planar). We map (x,z)
 * straight onto the three.js XZ plane and drop y. Bounds auto-fit to the data.
 */
export default defineComponent({
  name: "HolographicMap",
  props: {
    replayPath: { type: String, default: "" },
    trajectories: { type: Array as () => EntityTrajectory[], default: () => [] },
    /** Roster from the replay header — used to color allies/enemies. */
    vehicles: { type: Array as () => VehicleEntry[], default: () => [] },
  },
  setup(props) {
    const container = ref<HTMLElement | null>(null);
    const { ready, api } = useThreeScene(container);

    // Playback state.
    const duration = ref(0);
    const current = ref(0);
    const playing = ref(false);
    let playRaf = 0;
    let lastTick = 0;

    // Three.js objects we own (to dispose on change/unmount).
    let trajectoryLines: THREE.Line[] = [];
    let shipMarkers: THREE.Group[] = [];
    let bounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;

    function clearActors() {
      const scene = api.value?.scene;
      if (!scene) return;
      for (const l of trajectoryLines) {
        scene.remove(l);
        l.geometry.dispose();
        (l.material as THREE.Material).dispose();
      }
      for (const m of shipMarkers) {
        scene.remove(m);
        m.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose();
            (o.material as THREE.Material).dispose();
          }
        });
      }
      trajectoryLines = [];
      shipMarkers = [];
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

    /** Build the trajectory lines + ship markers from the decoded data. */
    function rebuildActors() {
      clearActors();
      const scene = api.value?.scene;
      if (!scene || props.trajectories.length === 0) return;

      for (const traj of props.trajectories) {
        if (traj.samples.length < 2) continue;
        // Ally/enemy color: we can only guess by entity id parity without the
        // roster map; prefer the roster's shipId match when available.
        const isAlly = allyOf(traj.entityId);
        const color = isAlly ? 0x47e3a5 : 0xff4200;

        // Trajectory line on the XZ plane (y=0.5 to hover above the grid).
        const pts = traj.samples.map((s) => new THREE.Vector3(s.x, 0.5, s.z));
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 });
        const line = new THREE.Line(geom, mat);
        scene.add(line);
        trajectoryLines.push(line);

        // Ship marker: a small cone pointing along heading (yaw). Added once,
        // repositioned each frame by updateMarkersAt().
        const marker = new THREE.Group();
        const coneGeom = new THREE.ConeGeometry(14, 36, 8);
        const coneMat = new THREE.MeshBasicMaterial({ color });
        const cone = new THREE.Mesh(coneGeom, coneMat);
        // Cone points +Y by default; rotate so it lies flat and points +Z at yaw 0.
        cone.rotation.x = Math.PI / 2;
        marker.add(cone);
        marker.userData.entityId = traj.entityId;
        marker.visible = false;
        scene.add(marker);
        shipMarkers.push(marker);
      }
    }

    /** Map an entity id to ally/enemy. The roster's vehicles[].id is the player
     * id, not the entity id, so without the EntityCreate packet we approximate:
     * first half of trajectories (by entity id) = allies. Good enough for a
     * visual; M-entity-create will make this exact. */
    function allyOf(entityId: number): boolean {
      const ids = props.trajectories.map((t) => t.entityId).sort((a, b) => a - b);
      const idx = ids.indexOf(entityId);
      return idx < ids.length / 2;
    }

    /** Position + orient each ship marker at the current playback time. */
    function updateMarkersAt(t: number) {
      for (const marker of shipMarkers) {
        const entityId = marker.userData.entityId as number;
        const traj = props.trajectories.find((tr) => tr.entityId === entityId);
        if (!traj || traj.samples.length === 0) {
          marker.visible = false;
          continue;
        }
        const s = sampleAt(traj, t);
        if (!s) {
          marker.visible = false;
          continue;
        }
        marker.visible = true;
        marker.position.set(s.x, 0.5, s.z);
        // yaw is heading about vertical (Y) axis; rotate the marker group.
        marker.rotation.y = s.yaw;
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

    // Recompute + rebuild whenever trajectories change.
    watch(
      () => props.trajectories,
      () => {
        recomputeBoundsAndCamera();
        rebuildActors();
        updateMarkersAt(current.value);
      },
      { deep: false },
    );

    // Recompute markers whenever the scrubber moves.
    watch(current, (t) => updateMarkersAt(t));

    // Once the scene is ready, build actors for any trajectories already set.
    watch(ready, (r) => {
      if (r) {
        recomputeBoundsAndCamera();
        rebuildActors();
        updateMarkersAt(current.value);
      }
    });

    onBeforeUnmount(() => {
      cancelAnimationFrame(playRaf);
      clearActors();
    });

    return () => (
      <div class="holo-map">
        <div ref={container} class="holo-map__canvas" />
        {!ready.value ? <div class="holo-map__hint">Initializing holographic scene…</div> : null}
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
