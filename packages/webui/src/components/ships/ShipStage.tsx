import {
  defineComponent,
  getCurrentInstance,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import SSegmented from "@/components/base/SSegmented";
import SSpinner from "@/components/base/SSpinner";
import { resolveShipModelByShipId, resolveFallbackModel, loadGlbModel, type ShipModelSpec } from "@/features/holographic/modelLoader";
import { makeHoloMaterial as sharedMakeHoloMaterial, tickHoloUniforms, type HoloUniforms } from "@/features/holographic/holoShader";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { resolveShipImage } from "@/utils/shipImages";
import { t } from "@/i18n";
import { useToast } from "@/composables/useToast";
import type { ShipInfo } from "@/api";
import "./ShipStage.scss";

/**
 * Holographic ship viewer — the big interactive 3D stage at the top of the
 * ship detail modal.
 *
 * Replaces the old inline `init3dViewer` (fixed 150px, no interaction). This
 * stage renders the ship as a cyan hologram with Fresnel rim lighting +
 * scanlines + a faint wireframe overlay, and is fully orbit-controlled:
 * left-drag to rotate, wheel to zoom, right-drag to pan. Auto-rotates gently
 * until the user grabs it.
 *
 * `focusZone(zone)` flies the camera to a preset view of a ship region
 * (bow / midship / stern / deck / waterline), used by the WeaponBar to focus
 * a weapon module. The transition is a hand-rolled eased tween (no GSAP).
 *
 * The ship GLB is resolved via `resolveShipModelByShipId`, which follows the
 * skin→base redirect in `ship_models.json` — so ARP/AZUR/Black variants reuse
 * their base ship's model.
 */

/** Ship regions the camera can focus on (relative to model bbox). */
export type FocusZone = "default" | "bow" | "midship" | "stern" | "deck" | "waterline";

export default defineComponent({
  name: "ShipStage",
  props: {
    ship: { type: Object as () => ShipInfo | null, required: true },
  },
  // `focusZone` is stashed on the instance from inside setup() and surfaced
  // here via `exposed` so parents can call stageRef.value?.focusZone(...).
  // (setup() returns a render fn, not a state object, so this is the route.)
  exposed: {} as { focusZone?: (zone: FocusZone) => void },
  setup(props) {
    const inst = getCurrentInstance();
    const toast = useToast();
    const containerRef = ref<HTMLElement | null>(null);
    const viewMode = ref<"2d" | "3d">("3d");
    const loading = ref(false);
    const errorMsg = ref<string | null>(null);
    /** Whether a baked 3D model resolves for this ship. */
    const hasModel = ref(true);

    // Three.js state (kept in shallowRefs / closure vars; not reactive).
    const scene = shallowRef<THREE.Scene | null>(null);
    const camera = shallowRef<THREE.PerspectiveCamera | null>(null);
    const renderer = shallowRef<THREE.WebGLRenderer | null>(null);
    const controls = shallowRef<OrbitControls | null>(null);
    const modelGroup = shallowRef<THREE.Group | null>(null);
    /** Uniforms for the animated holographic shader (time + scan offset). */
    const uniforms = shallowRef<HoloUniforms | null>(null);
    /** Bounding box of the loaded model (for focus-zone camera placement). */
    const modelBox = shallowRef<THREE.Box3 | null>(null);

    let rafId = 0;
    let resizeObs: ResizeObserver | null = null;
    /** Active focus tween; cancelled if a new focus starts mid-flight. */
    let focusTween: (() => void) | null = null;
    let _turretMaterial: THREE.ShaderMaterial | null = null;
    let _turretMaterialBright: THREE.ShaderMaterial | null = null;
    let _turretTimer = 0;
    const FOCUS_DURATION_MS = 2500;
    const _allHoloUniforms: HoloUniforms[] = [];

    // ── Holographic shader ────────────────────────────────────────────────
    // The shader source + material factory live in the shared `holoShader`
    // module (also used by the replay's recorder-ship panel). This thin wrapper
    // also stashes the uniforms on the component ref so the render loop can
    // drive the scanline animation each frame via `tickHoloUniforms`.
    function makeHoloMaterial(): THREE.ShaderMaterial {
      const mat = sharedMakeHoloMaterial();
      _allHoloUniforms.push(mat.uniforms as unknown as HoloUniforms);
      if (!uniforms.value) uniforms.value = mat.uniforms as unknown as HoloUniforms;
      return mat;
    }

    // ── Scene lifecycle ───────────────────────────────────────────────────
    function initScene() {
      const el = containerRef.value;
      if (!el) return;
      const w = el.clientWidth || 600;
      const h = el.clientHeight || 320;

      const sc = new THREE.Scene();
      const isDark = document.documentElement.dataset.mode === "dark";
      const bg = isDark ? 0x0c121e : 0xf5f8fc;
      sc.background = new THREE.Color(bg);
      // Subtle radial fog for depth.
      sc.fog = new THREE.Fog(bg, 400, 1400);

      const cam = new THREE.PerspectiveCamera(45, w / h, 0.1, 5000);
      // Initial view before a model loads — matches the `default` focus-zone
      // framing (starboard-bow ~2 o'clock, elevated). focusZone("default")
      // re-positions precisely once the model bounds are known.
      cam.position.set(230, 215, 400);

      const rnd = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      rnd.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      rnd.setSize(w, h);
      el.appendChild(rnd.domElement);

      // Lights — mostly for the wireframe overlay (the holo shader is unlit).
      sc.add(new THREE.AmbientLight(0x335577, 0.8));
      const key = new THREE.DirectionalLight(0x66bbff, 0.7);
      key.position.set(120, 200, 120);
      sc.add(key);

      // A faint ground grid for spatial reference.
      const grid = new THREE.GridHelper(1200, 40, 0x1a3a55, 0x0e1f30);
      (grid.material as THREE.Material).transparent = true;
      (grid.material as THREE.Material).opacity = 0.4;
      (grid as any).position.y = -1;
      sc.add(grid);

      const ctrl = new OrbitControls(cam, rnd.domElement);
      ctrl.enableDamping = true;
      ctrl.dampingFactor = 0.08;
      ctrl.rotateSpeed = 0.8;
      ctrl.zoomSpeed = 0.9;
      ctrl.minDistance = 80;
      ctrl.maxDistance = 800;
      ctrl.maxPolarAngle = Math.PI * 0.85; // don't go under the grid floor
      ctrl.autoRotate = true;
      ctrl.autoRotateSpeed = 0.5;
      // Stop auto-rotate as soon as the user touches it.
      ctrl.addEventListener("start", () => {
        ctrl.autoRotate = false;
      });

      scene.value = sc;
      camera.value = cam;
      renderer.value = rnd;
      controls.value = ctrl;

      const clock = new THREE.Clock();
      const tick = () => {
        const dt = clock.getDelta();
        for (const u of _allHoloUniforms) tickHoloUniforms(u, dt);
        ctrl.update();
        rnd.render(sc, cam);
        rafId = requestAnimationFrame(tick);
      };
      tick();

      resizeObs = new ResizeObserver(() => {
        const cw = el.clientWidth;
        const ch = el.clientHeight;
        if (cw === 0 || ch === 0) return;
        cam.aspect = cw / ch;
        cam.updateProjectionMatrix();
        rnd.setSize(cw, ch);
      });
      resizeObs.observe(el);
    }

    async function loadModel() {
      const ship = props.ship;
      if (!ship) return;
      loading.value = true;
      errorMsg.value = null;
      try {
        let url = resolveShipModelByShipId(ship.shipId, ship.name);
        // Fallback: try to match a model of the same tier/nation/type if no
        // exact model exists for this ship. This lets the holographic stage
        // show a similar hull rather than a blank viewport.
        if (!url) {
          const encyclopedia = useEncyclopediaStore();
          const spec: ShipModelSpec = {
            shipId: ship.shipId,
            tier: ship.tier,
            nation: ship.nation,
            type: ship.type,
          };
          const pool: ShipModelSpec[] = encyclopedia.ships.map((s) => ({
            shipId: s.shipId,
            tier: s.tier,
            nation: s.nation,
            type: s.type,
          }));
          url = resolveFallbackModel(spec, pool);
        }
        if (!url) {
          hasModel.value = false;
          errorMsg.value = t("ships.detail.noModel");
          return;
        }
        hasModel.value = true;
        const model = await loadGlbModel(url);
        // The baked GLBs drop POSITION accessor min/max (smaller files), so
        // Box3.setFromObject can't infer bounds — compute them per-geometry first.
        model.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (mesh.geometry && mesh.geometry.attributes.position) {
            mesh.geometry.computeBoundingBox();
            mesh.geometry.computeBoundingSphere();
          }
        });
        modelGroup.value = model;

        // Apply holographic shader. Turret mesh gets a brighter variant.
        const holoHull = makeHoloMaterial();
        const holoTurret = makeHoloMaterial();
        const holoTurretBright = makeHoloMaterial();
        // Make the bright variant ~2× more visible.
        holoTurretBright.uniforms.baseColor.value.set(0.15, 0.85, 1.0);
        holoTurretBright.uniforms.fresnelColor.value.set(0.3, 0.9, 1.0);
        _turretMaterial = holoTurret;
        _turretMaterialBright = holoTurretBright;

        const meshes: THREE.Mesh[] = [];
        model.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
        });
        for (const mesh of meshes) {
          const isTurret = mesh.name === "turret" || (mesh.parent && mesh.parent.name === "turret");
          mesh.material = isTurret ? holoTurret : holoHull;
          // Faint structural-edge overlay — only shows edges where adjacent
          // faces meet at >20° (hides coplanar hull/deck triangles).
          const edgeGeo = new THREE.EdgesGeometry(mesh.geometry, 8);
          const line = new THREE.LineSegments(
            edgeGeo,
            new THREE.LineBasicMaterial({
              color: 0x2a8fb5,
              transparent: true,
              opacity: 0.18,
              depthWrite: false,
            }),
          );
          line.raycast = () => {};
          mesh.add(line);
        }

        if (scene.value) scene.value.add(model);
        modelGroup.value = model;
        // Normalize: center + uniform-scale to a 200-unit box.
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 1);
        const scale = 200 / maxDim;
        model.scale.setScalar(scale);
        const center = box.getCenter(new THREE.Vector3()).multiplyScalar(scale);
        model.position.sub(center);
        // Re-measure the normalized box for focus-zone placement.
        const normBox = new THREE.Box3().setFromObject(model);
        modelBox.value = normBox;

        focusZone("default");
      } catch (e) {
        errorMsg.value = (e as Error).message || String(e);
        toast.error(`3D model failed: ${errorMsg.value}`);
      } finally {
        loading.value = false;
      }
    }

    function disposeScene() {
      cancelAnimationFrame(rafId);
      focusTween = null;
      clearTimeout(_turretTimer);
      resizeObs?.disconnect();
      resizeObs = null;
      const c = controls.value;
      const r = renderer.value;
      const sc = scene.value;
      c?.dispose();
      if (sc) {
        sc.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.geometry) m.geometry.dispose();
          const mat = m.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else if (mat) mat.dispose();
        });
      }
      if (r) {
        r.dispose();
        r.domElement.remove();
      }
      scene.value = camera.value = renderer.value = controls.value = null;
      modelGroup.value = null;
      modelBox.value = null;
      uniforms.value = null;
    }

    onMounted(() => {
      // 3D is the default; init immediately. (2D needs no scene.)
      if (viewMode.value === "3d") {
        initScene();
        void loadModel();
      }
    });

    onBeforeUnmount(() => disposeScene());

    // Reload the model when the ship changes.
    watch(
      () => props.ship?.shipId,
      () => {
        if (viewMode.value === "3d") {
          // Remove the old model + any active highlight ring, then load the new one.
          clearTimeout(_turretTimer);
          if (modelGroup.value && scene.value) {
            scene.value.remove(modelGroup.value);
            modelGroup.value = null;
          }
          void loadModel();
        }
      },
    );

    // ── Focus zone highlight ─────────────────────────────────────────────
    let _activeGlows: THREE.Mesh[] = [];

    function clearGlows() {
      const sc = scene.value;
      for (const m of _activeGlows) {
        if (sc) sc.remove(m);
        (m.geometry as THREE.BufferGeometry).dispose();
        (m.material as THREE.Material).dispose();
      }
      _activeGlows = [];
    }

    function spawnGlow(pos: THREE.Vector3, radius: number, sc: THREE.Scene): THREE.Mesh {
      const geo = new THREE.SphereGeometry(radius, 16, 16);
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 } },
        vertexShader: `
          varying vec3 vNormal;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          varying vec3 vNormal;
          uniform float uTime;
          void main() {
            float rim = 1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0)));
            rim = pow(rim, 1.8);
            float pulse = 0.55 + 0.45 * sin(uTime * 5.0);
            float alpha = rim * pulse * 0.55;
            gl_FragColor = vec4(0.35, 0.88, 1.0, alpha);
          }`,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pos);
      sc.add(mesh);
      return mesh;
    }

    function focusZone(zone: FocusZone, count = 1): void {
      const cam = camera.value;
      const ctrl = controls.value;
      const box = modelBox.value;
      if (!cam || !ctrl || !box) return;
      ctrl.autoRotate = false;
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const len = size.x; // ship length (after normalize, ≈ up to 200)
      const half = len / 2;
      // Camera distance — closer than the default hero shot so weapon
      // details are visible. Scales with ship size.
      const dist = Math.max(size.x * 0.5, 120);
      const target = new THREE.Vector3(center.x, center.y, center.z);
      let camPos: THREE.Vector3;
      // View from starboard side, elevated ~35°, so turrets/guns on the
      // deck read clearly against the holographic hull.
      const el = 0.55; // ~32° elevation
      const az = 0.4;  // ~23° toward starboard
      switch (zone) {
        case "bow":
          // Focus on the forward third — main turrets live here.
          target.set(center.x + half * 0.55, center.y + size.y * 0.18, center.z);
          camPos = new THREE.Vector3(
            target.x + dist * 0.35,
            target.y + dist * el,
            target.z + dist * az,
          );
          break;
        case "stern":
          // Rear third — aft turrets, engine exhaust.
          target.set(center.x - half * 0.55, center.y + size.y * 0.18, center.z);
          camPos = new THREE.Vector3(
            target.x - dist * 0.35,
            target.y + dist * el,
            target.z + dist * az,
          );
          break;
        case "midship":
          // Center — secondaries, torpedo tubes, superstructure.
          target.set(center.x, center.y + size.y * 0.2, center.z);
          camPos = new THREE.Vector3(
            center.x,
            center.y + dist * el,
            center.z + dist * (az + 0.25),
          );
          break;
        case "deck":
          // Top-down-ish — AA mounts, rangefinders across the whole deck.
          target.set(center.x, center.y + size.y * 0.3, center.z);
          camPos = new THREE.Vector3(center.x, center.y + dist * 1.1, center.z + dist * 0.08);
          break;
        case "waterline":
          // Low-angle side view — torpedo belt, hull details.
          target.set(center.x - half * 0.3, center.y - size.y * 0.2, center.z);
          camPos = new THREE.Vector3(
            target.x - dist * 0.4,
            target.y + dist * 0.15,
            target.z + dist * 0.7,
          );
          break;
        default:
          // Starboard-bow "2 o'clock" vantage: ~60° azimuth from the bow
          // (the +X axis), elevated ~50° above the waterline so the deck
          // and superstructure both read. A high hero angle for the initial
          // holographic reveal. Spherical coords, X = bow, Z = starboard.
          {
            const az = Math.PI / 3; // 60° azimuth toward starboard (2 o'clock)
            const el = Math.PI * 0.28; // ~50° elevation (high vantage)
            const R = dist * 1.15;
            camPos = new THREE.Vector3(
              center.x + R * Math.cos(el) * Math.cos(az),
              center.y + R * Math.sin(el),
              center.z + R * Math.cos(el) * Math.sin(az),
            );
          }
      }
      tweenCamera(cam, ctrl, camPos, target, 700);
      // The `default` framing is the initial hero reveal — resume gentle
      // auto-rotation once the camera settles so the ship slowly turns. The
      // "start" listener on OrbitControls (set up in initScene) stops it as
      // soon as the user grabs the view. Explicit weapon-focus zones stay
      // non-rotating (autoRotate left off above).
      if (zone === "default") {
        const ctrlLocal = ctrl;
        window.setTimeout(() => {
          ctrlLocal.autoRotate = true;
        }, 750);
      }
      // Swap turret mesh to bright material on weapon focus.
      if (zone !== "default") {
        if (_turretMaterialBright && modelGroup.value) {
          modelGroup.value.traverse((child) => {
            const m = child as THREE.Mesh;
            if (m.isMesh && m.name === "turret") {
              m.material = _turretMaterialBright;
            }
          });
        }
        clearTimeout(_turretTimer);
        _turretTimer = window.setTimeout(() => {
          if (_turretMaterial && modelGroup.value) {
            modelGroup.value.traverse((child) => {
              const m = child as THREE.Mesh;
              if (m.isMesh && m.name === "turret") {
                m.material = _turretMaterial;
              }
            });
          }
        }, FOCUS_DURATION_MS);
      }
    }

    function tweenCamera(
      cam: THREE.PerspectiveCamera,
      ctrl: OrbitControls,
      toPos: THREE.Vector3,
      toTarget: THREE.Vector3,
      ms: number,
    ) {
      const fromPos = cam.position.clone();
      const fromTarget = ctrl.target.clone();
      const start = performance.now();
      // Cancel any in-flight tween.
      focusTween = null;
      const step = (now: number) => {
        if (focusTween === null) return; // cancelled
        const k = Math.min(1, (now - start) / ms);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // easeInOutQuad
        cam.position.lerpVectors(fromPos, toPos, e);
        ctrl.target.lerpVectors(fromTarget, toTarget, e);
        ctrl.update();
        if (k < 1) {
          focusTween = () => requestAnimationFrame(step);
          requestAnimationFrame(step);
        } else {
          focusTween = null;
        }
      };
      focusTween = () => requestAnimationFrame(step);
      requestAnimationFrame(step);
    }

    // Surface focusZone to the parent via the component's exposed object.
    if (inst) {
      (inst.exposed as { focusZone?: (zone: FocusZone) => void }) = { focusZone };
    }

    // ── View mode switch ──────────────────────────────────────────────────
    function setViewMode(mode: "2d" | "3d") {
      if (mode === viewMode.value) return;
      if (mode === "3d") {
        viewMode.value = "3d";
        // Wait for the container to render, then init.
        requestAnimationFrame(() => {
          initScene();
          void loadModel();
        });
      } else {
        disposeScene();
        viewMode.value = "2d";
      }
    }

    return () => {
      const ship = props.ship;
      return (
        <div class="ship-stage">
          <div
            class={["ship-stage__canvas", viewMode.value === "2d" ? "ship-stage__canvas--2d" : ""]}
            ref={containerRef}
          >
            {viewMode.value === "2d" ? (
              (() => {
                const img = ship ? resolveShipImage(ship.shipId, ship.images?.large) : null;
                return img ? (
                  <img class="ship-stage__2d-img" src={img} alt={ship?.name ?? ""} />
                ) : (
                  <div class="ship-stage__noimg">{t("ships.detail.noImage")}</div>
                );
              })()
            ) : null}
            {loading.value ? (
              <div class="ship-stage__overlay">
                <SSpinner center size="md" />
              </div>
            ) : null}
            {errorMsg.value ? (
              <div class="ship-stage__overlay ship-stage__overlay--error">{errorMsg.value}</div>
            ) : null}
          </div>

          <div class="ship-stage__controls">
            <span class="ship-stage__hint">
              {viewMode.value === "3d" ? t("ships.detail.stage.hint3d") : ""}
            </span>
            <SSegmented
              modelValue={viewMode.value}
              onUpdate:modelValue={(v: string) => setViewMode(v as "2d" | "3d")}
              options={[
                { value: "3d", label: "3D" },
                { value: "2d", label: "2D" },
              ]}
            />
          </div>
        </div>
      );
    };
  },
});
