/**
 * Custom-model 3D stage for the mod hub: renders the GLB parts the Rust
 * side cached for a `.geometry` family. Hull sections share the ship's
 * coordinate space, so the parts stack at identity transforms and the ship
 * assembles itself; every mesh wears the shared holographic shader (plus a
 * faint wireframe overlay) exactly like the map's ship markers — the raw
 * exports carry no textures, and the holo look is the app's 3D language.
 * The stage auto-frames the camera on the union bounding box, grounds the
 * model on its grid, and orbits as a turntable until the user grabs it.
 */
import { defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { t } from "@/i18n";
import { useTheme } from "@/theme";
import { useAppliedDpiScale } from "@/theme/dpiPrefs";
import type { ModelPreviewPart } from "@/api";
import { isTauri } from "@/utils/platform";
import { makeHoloMaterial, tickHoloUniforms, type HoloUniforms } from "@/features/holographic/holoShader";
import { loadGlbModel } from "@/features/holographic/modelLoader";
import { SCENE_THEMES } from "@/features/holographic/useThreeScene";

export default defineComponent({
  name: "ModelStage",
  props: {
    /** Cached GLB parts of one model family (non-empty when rendered). */
    parts: { type: Array as () => ModelPreviewPart[], required: true },
  },
  setup(props) {
    const host = ref<HTMLDivElement | null>(null);
    const busy = ref(true);
    const failed = ref("");
    const { effectiveMode } = useTheme();
    const dpiZoom = useAppliedDpiScale();

    // ── Scene bootstrap (bespoke, like ShipStage: the map's useThreeScene
    // is tuned for 4km terrains; a 17-unit ship needs its own clamps).
    let renderer: THREE.WebGLRenderer | null = null;
    let camera: THREE.PerspectiveCamera | null = null;
    let controls: OrbitControls | null = null;
    let scene: THREE.Scene | null = null;
    let grid: THREE.GridHelper | null = null;
    let group: THREE.Group | null = null;
    let rafId = 0;
    let resizeObs: ResizeObserver | null = null;
    let lastT = 0;

    const holoMat = makeHoloMaterial();
    // ShaderMaterial's uniforms record is an open IUniform map; the tick
    // helper wants the closed HoloUniforms shape (time/scanOffset drive).
    const holoUniforms = holoMat.uniforms as unknown as HoloUniforms;
    const wireMat = new THREE.MeshBasicMaterial({
      color: 0x33ccff,
      wireframe: true,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
    });

    function disposeGroup(g: THREE.Group): void {
      const meshes: THREE.Mesh[] = [];
      g.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
      });
      for (const mesh of meshes) mesh.geometry.dispose();
      g.clear();
    }

    /** Wrap every mesh in the shared holo material (marker pattern: collect
     *  first so the wireframe children don't recurse). */
    function dressModel(model: THREE.Object3D): void {
      const meshes: THREE.Mesh[] = [];
      model.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
      });
      for (const mesh of meshes) {
        mesh.geometry.computeBoundingBox();
        mesh.geometry.computeBoundingSphere();
        mesh.material = holoMat;
        const wire = new THREE.Mesh(mesh.geometry, wireMat);
        wire.raycast = () => {};
        mesh.add(wire);
      }
    }

    /** Ground `group` on the grid and frame the camera on its extents. */
    function frame(): void {
      if (!group || !camera || !controls || !scene) return;
      const box = new THREE.Box3().setFromObject(group);
      if (box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3());
      // Sit the model on the grid (keel at y=0) and center it in azimuth.
      group.position.x -= center.x;
      group.position.z -= center.z;
      group.position.y -= box.min.y;
      box.translate(new THREE.Vector3(-center.x, -box.min.y, -center.z));
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const r = Math.max(sphere.radius, 0.5);
      if (grid) {
        scene.remove(grid);
        grid.geometry.dispose();
        (grid.material as THREE.Material).dispose();
        grid = new THREE.GridHelper(r * 8, 40, 0x2f7fc2, 0x1a3b52);
        (grid.material as THREE.Material).transparent = true;
        (grid.material as THREE.Material).opacity = 0.25;
        scene.add(grid);
      }
      camera.near = Math.max(r / 200, 0.01);
      camera.far = r * 60;
      camera.updateProjectionMatrix();
      camera.position.set(r * 1.6, r * 1.1, r * 1.9);
      camera.lookAt(0, r * 0.25, 0);
      controls.target.set(0, r * 0.25, 0);
      controls.minDistance = r * 0.4;
      controls.maxDistance = r * 12;
      controls.update();
    }

    async function load(parts: ModelPreviewPart[]): Promise<void> {
      if (!scene || parts.length === 0) return;
      busy.value = true;
      failed.value = "";
      try {
        // The Rust side wrote each part under the asset-protocol scope —
        // convertFileSrc turns the absolute path into a fetchable URL the
        // model loader validates by GLB magic (SPA-fallback-proof).
        const models = await Promise.all(
          parts.map((part) => loadGlbModel(convertFileSrc(part.path))),
        );
        if (!scene) return; // unmounted mid-load
        const next = new THREE.Group();
        for (const model of models) next.add(model);
        dressModel(next);
        if (group) {
          scene.remove(group);
          disposeGroup(group);
        }
        group = next;
        scene.add(group);
        frame();
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        failed.value = detail;
      } finally {
        busy.value = false;
      }
    }

    onMounted(() => {
      const el = host.value;
      if (!el) return;
      const width = el.clientWidth || 640;
      const height = el.clientHeight || 320;
      scene = new THREE.Scene();
      scene.background = new THREE.Color(
        effectiveMode.value === "light" ? SCENE_THEMES.light.bg : SCENE_THEMES.dark.bg,
      );
      camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 2000);
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(window.devicePixelRatio * dpiZoom.value);
      renderer.setSize(width, height, true);
      el.appendChild(renderer.domElement);

      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.8;
      controls.maxPolarAngle = Math.PI / 1.9;
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      };
      // Grabbing the model ends the turntable (ShipStage behavior).
      controls.addEventListener("start", () => {
        if (controls) controls.autoRotate = false;
      });

      const tick = (now: number) => {
        rafId = requestAnimationFrame(tick);
        const dt = lastT ? Math.min((now - lastT) / 1000, 0.1) : 0.016;
        lastT = now;
        tickHoloUniforms(holoUniforms, dt);
        controls?.update();
        if (renderer && scene && camera) renderer.render(scene, camera);
      };
      rafId = requestAnimationFrame(tick);

      resizeObs = new ResizeObserver(() => {
        if (!el || !renderer || !camera) return;
        const w = el.clientWidth || 1;
        const h = el.clientHeight || 1;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, true);
      });
      resizeObs.observe(el);

      void load(props.parts);
    });

    watch(
      () => props.parts,
      (parts) => {
        if (parts.length > 0) void load(parts);
      },
      { deep: false },
    );
    watch(dpiZoom, (zoom) => {
      renderer?.setPixelRatio(window.devicePixelRatio * zoom);
    });
    watch(effectiveMode, (mode) => {
      if (scene) {
        scene.background = new THREE.Color(
          mode === "light" ? SCENE_THEMES.light.bg : SCENE_THEMES.dark.bg,
        );
      }
    });

    onBeforeUnmount(() => {
      cancelAnimationFrame(rafId);
      resizeObs?.disconnect();
      controls?.dispose();
      if (group && scene) {
        scene.remove(group);
        disposeGroup(group);
        group = null;
      }
      grid?.geometry.dispose();
      (grid?.material as THREE.Material | undefined)?.dispose();
      holoMat.dispose();
      wireMat.dispose();
      renderer?.dispose();
      renderer?.domElement.remove();
      renderer = null;
      scene = null;
    });

    return () => (
      <div class="model-stage">
        <div ref={host} class="model-stage__canvas" />
        {busy.value ? (
          <div class="model-stage__note">{t("resources.loadingAssets")}</div>
        ) : failed.value ? (
          <div class="model-stage__note model-stage__note--err">{failed.value}</div>
        ) : null}
        {!isTauri() && (
          <div class="model-stage__note">{t("resources.modelShellOnly")}</div>
        )}
        <div class="model-stage__hint">{t("resources.modelNote")}</div>
      </div>
    );
  },
});
