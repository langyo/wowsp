/**
 * Three.js scene lifecycle composable for the holographic map. Encapsulates
 * renderer/scene/camera setup, a requestAnimationFrame render loop, resize
 * handling, and disposal. Returns the scene/camera/renderer so callers can add
 * meshes (map plane, ship markers, trajectory lines).
 *
 * The render loop runs continuously; callers mutate the scene and the next
 * frame picks it up. M4: ship markers + trajectories are added by
 * `HolographicMap.tsx` from the decoded `EntityTrajectory[]`.
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, type Ref } from "vue";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface ThreeScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
}

export function useThreeScene(
  container: Ref<HTMLElement | null>,
  onFrame?: (dt: number) => void,
) {
  const ready = ref(false);
  const api = shallowRef<ThreeScene | null>(null);
  let rafId = 0;
  let resizeObs: ResizeObserver | null = null;

  onMounted(() => {
    const el = container.value;
    if (!el) return;
    const width = el.clientWidth || 800;
    const height = el.clientHeight || 600;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1220);

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 20000);
    camera.position.set(0, 800, 800);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height, true);
    el.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);
    controls.minPolarAngle = 0.1;           // nearly top-down
    controls.maxPolarAngle = Math.PI / 2.1; // ~85°, prevent going below horizon
    controls.minDistance = 200;
    controls.maxDistance = 6000;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };
    controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
    controls.update();

    const grid = new THREE.GridHelper(4000, 80, 0x00aaff, 0x004466);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    scene.add(grid);

    api.value = { scene, camera, renderer, controls };
    ready.value = true;

    const clock = new THREE.Clock();
    const tick = () => {
      controls.update();
      if (onFrame) onFrame(clock.getDelta());
      renderer.render(scene, camera);
      rafId = requestAnimationFrame(tick);
    };
    tick();

    resizeObs = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, true);
    });
    resizeObs.observe(el);
  });

  onBeforeUnmount(() => {
    cancelAnimationFrame(rafId);
    resizeObs?.disconnect();
    const a = api.value;
    if (a) {
      a.controls.dispose();
      a.renderer.dispose();
      a.renderer.domElement.remove();
    }
    api.value = null;
    ready.value = false;
  });

  return { ready, api };
}
