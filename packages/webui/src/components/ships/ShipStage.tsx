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
import { resolveShipModelByShipId, loadGlbModel } from "@/features/holographic/modelLoader";
import { resolveShipImage } from "@/utils/shipImages";
import { t } from "@/i18n";
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
    const uniforms = shallowRef<{
      time: { value: number };
      scanOffset: { value: number };
    } | null>(null);
    /** Bounding box of the loaded model (for focus-zone camera placement). */
    const modelBox = shallowRef<THREE.Box3 | null>(null);

    let rafId = 0;
    let resizeObs: ResizeObserver | null = null;
    /** Active focus tween; cancelled if a new focus starts mid-flight. */
    let focusTween: (() => void) | null = null;
    /** Active highlight ring (spawned by focusZone); animated + disposed by the rAF loop. */
    let activeRing: {
      mesh: THREE.Mesh;
      born: number;
      duration: number;
      baseScale: number;
    } | null = null;

    // ── Holographic shader ────────────────────────────────────────────────
    // The baked GLBs have no normals (they're merged + stripped), so we compute
    // face normals in the fragment shader via screen-space derivatives (dFdx/
    // dFdy) — WebGL2 default in three r150+. Fresnel uses that normal vs. the
    // view direction. Scanlines sweep vertically; a wireframe pass is drawn as
    // a separate overlay mesh.
    const VERT = /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vViewPos;
      varying vec3 vLocalPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vLocalPos = position;
        vec4 vp = viewMatrix * wp;
        vViewPos = vp.xyz;
        gl_Position = projectionMatrix * vp;
      }
    `;
    const FRAG = /* glsl */ `
      precision highp float;
      uniform float time;
      uniform float scanOffset;
      uniform vec3 baseColor;
      uniform vec3 fresnelColor;
      varying vec3 vWorldPos;
      varying vec3 vViewPos;
      varying vec3 vLocalPos;
      void main() {
        // Face normal from screen-space derivatives of the world position.
        vec3 dx = dFdx(vWorldPos);
        vec3 dy = dFdy(vWorldPos);
        vec3 n = normalize(cross(dx, dy));
        // View direction (from fragment to camera, in world space).
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        // Fresnel: bright at glancing angles.
        float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 2.5);
        // Scanlines along the model's vertical (Y) axis, sweeping over time.
        float scan = sin((vLocalPos.y * 0.08 + scanOffset) * 6.2831) * 0.5 + 0.5;
        scan = smoothstep(0.82, 1.0, scan);
        vec3 col = baseColor * (0.35 + 0.25 * fres);
        col += fresnelColor * fres * 1.4;
        col += fresnelColor * scan * 0.6;
        float alpha = 0.72 + 0.28 * fres;
        gl_FragColor = vec4(col, alpha);
      }
    `;

    function makeHoloMaterial(): THREE.ShaderMaterial {
      const u = {
        time: { value: 0 },
        scanOffset: { value: 0 },
        baseColor: { value: new THREE.Color(0x0d6e8a) },
        fresnelColor: { value: new THREE.Color(0x33ccff) },
      };
      uniforms.value = u;
      return new THREE.ShaderMaterial({
        uniforms: u,
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
    }

    // ── Scene lifecycle ───────────────────────────────────────────────────
    function initScene() {
      const el = containerRef.value;
      if (!el) return;
      const w = el.clientWidth || 600;
      const h = el.clientHeight || 320;

      const sc = new THREE.Scene();
      sc.background = new THREE.Color(0x070d18);
      // Subtle radial fog for depth.
      sc.fog = new THREE.Fog(0x070d18, 400, 1400);

      const cam = new THREE.PerspectiveCamera(45, w / h, 0.1, 5000);
      cam.position.set(180, 90, 260);

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
      ctrl.autoRotateSpeed = 0.6;
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
        if (uniforms.value) {
          uniforms.value.time.value += dt;
          uniforms.value.scanOffset.value += dt * 0.6;
        }
        // Animate the focus-zone highlight ring: pulse scale + fade over its
        // lifetime, gently face the camera so the reticle stays visible, then
        // dispose when done.
        if (activeRing) {
          const r = activeRing;
          const elapsed = performance.now() - r.born;
          const k = Math.min(1, elapsed / r.duration);
          const pulse = 1 + 0.12 * Math.sin(elapsed * 0.014);
          // Expand outward as it fades (energy ripple dissipating).
          const grow = 1 + k * 0.4;
          r.mesh.scale.setScalar(pulse * grow);
          (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - k * k);
          // Keep the ring roughly facing the camera without snapping flat.
          r.mesh.lookAt(cam.position);
          if (k >= 1) {
            sc.remove(r.mesh);
            (r.mesh.geometry as THREE.BufferGeometry).dispose();
            (r.mesh.material as THREE.Material).dispose();
            activeRing = null;
          }
        }
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
        const url = resolveShipModelByShipId(ship.shipId, ship.name);
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

        // Apply the holographic shader to every mesh in the model. Collect meshes
        // first so we don't mutate the tree during traverse (the wireframe overlay
        // is added as a child — doing that mid-traverse would recurse forever).
        const holoMat = makeHoloMaterial();
        const wireMat = new THREE.MeshBasicMaterial({
          color: 0x2a8fb5,
          wireframe: true,
          transparent: true,
          opacity: 0.10,
          depthWrite: false,
        });
        const meshes: THREE.Mesh[] = [];
        model.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
        });
        for (const mesh of meshes) {
          mesh.material = holoMat;
          // Faint wireframe overlay pass, as a non-traversed child.
          const wire = new THREE.Mesh(mesh.geometry, wireMat);
          wire.raycast = () => {}; // overlay shouldn't intercept picks
          mesh.add(wire);
        }

        if (scene.value) scene.value.add(model);
        modelGroup.value = model;
        // Frame the model.
        focusZone("default");
      } catch (e) {
        errorMsg.value = (e as Error).message || String(e);
      } finally {
        loading.value = false;
      }
    }

    function disposeScene() {
      cancelAnimationFrame(rafId);
      focusTween = null;
      // Dispose any active highlight ring.
      if (activeRing && scene.value) {
        scene.value.remove(activeRing.mesh);
        (activeRing.mesh.geometry as THREE.BufferGeometry).dispose();
        (activeRing.mesh.material as THREE.Material).dispose();
        activeRing = null;
      }
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
          if (activeRing && scene.value) {
            scene.value.remove(activeRing.mesh);
            (activeRing.mesh.geometry as THREE.BufferGeometry).dispose();
            (activeRing.mesh.material as THREE.Material).dispose();
            activeRing = null;
          }
          if (modelGroup.value && scene.value) {
            scene.value.remove(modelGroup.value);
            modelGroup.value = null;
          }
          void loadModel();
        }
      },
    );

    // ── Focus zone highlight ring ──────────────────────────────────────────
    // Spawns a cyan pulsing RingGeometry at the focused ship region's world
    // position, oriented to face the camera. Animated (pulse + fade) by the
    // rAF render loop and disposed after `durationMs`. Replaces any prior ring.
    function spawnHighlightRing(zone: FocusZone, box: THREE.Box3, durationMs = 2000): void {
      const sc = scene.value;
      if (!sc) return;
      // Remove any prior ring first.
      if (activeRing) {
        sc.remove(activeRing.mesh);
        (activeRing.mesh.geometry as THREE.BufferGeometry).dispose();
        (activeRing.mesh.material as THREE.Material).dispose();
        activeRing = null;
      }
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const half = size.x / 2;
      // Ring placement per zone — matches the focusZone camera target.
      const pos = new THREE.Vector3();
      switch (zone) {
        case "bow": pos.set(center.x + half * 0.7, center.y + size.y * 0.2, center.z); break;
        case "stern": pos.set(center.x - half * 0.7, center.y + size.y * 0.2, center.z); break;
        case "deck": pos.set(center.x, center.y + size.y * 0.7, center.z); break;
        case "waterline": pos.set(center.x - half * 0.4, center.y - size.y * 0.2, center.z); break;
        case "midship":
        default: pos.set(center.x, center.y + size.y * 0.15, center.z);
      }
      const radius = Math.max(size.y * 0.9, 20);
      // A thin bright torus reads better as a "focus reticle" than a flat ring;
      // use TorusGeometry so the highlight has visible thickness from any angle.
      const tube = Math.max(radius * 0.04, 1.2);
      const geo = new THREE.TorusGeometry(radius, tube, 12, 48);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x66eeff,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pos);
      sc.add(mesh);
      activeRing = { mesh, born: performance.now(), duration: durationMs, baseScale: radius };
    }

    // ── Focus zone camera tween ───────────────────────────────────────────
    // focusZone flies the camera to a preset view of a ship region and spawns
    // a pulsing highlight ring there. Exposed to the parent via setupState so
    // the template ref can call it:
    //   stageRef.value?.focusZone("bow")
    function focusZone(zone: FocusZone): void {
      const cam = camera.value;
      const ctrl = controls.value;
      const box = modelBox.value;
      if (!cam || !ctrl || !box) return;
      ctrl.autoRotate = false;
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const len = size.x; // ship length (after normalize, ≈ up to 200)
      const half = len / 2;
      // Camera offset from center per zone. Distance scales with ship size.
      const dist = Math.max(size.length() * 0.9, 160);
      const target = new THREE.Vector3(center.x, center.y, center.z);
      let camPos: THREE.Vector3;
      switch (zone) {
        case "bow":
          camPos = new THREE.Vector3(center.x + half * 0.9, center.y + size.y * 0.3, dist * 0.55);
          target.set(center.x + half * 0.5, center.y, center.z);
          break;
        case "stern":
          camPos = new THREE.Vector3(center.x - half * 0.9, center.y + size.y * 0.3, dist * 0.55);
          target.set(center.x - half * 0.5, center.y, center.z);
          break;
        case "midship":
          camPos = new THREE.Vector3(center.x, center.y + size.y * 0.15, dist * 0.6); // broadside
          break;
        case "deck":
          camPos = new THREE.Vector3(center.x, center.y + dist * 0.9, dist * 0.2); // top-down
          break;
        case "waterline":
          camPos = new THREE.Vector3(center.x - half * 0.6, center.y - size.y * 0.4, dist * 0.5);
          target.set(center.x - half * 0.3, center.y - size.y * 0.2, center.z);
          break;
        default:
          camPos = new THREE.Vector3(center.x + 60, center.y + 90, dist * 1.1);
      }
      tweenCamera(cam, ctrl, camPos, target, 700);
      // Spawn the highlight ring for real weapon-focus zones (skip the default
      // framing call — that's just initial camera placement, not a focus action).
      if (zone !== "default") {
        spawnHighlightRing(zone, box);
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
