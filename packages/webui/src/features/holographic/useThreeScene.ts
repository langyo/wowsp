/**
 * Three.js scene lifecycle composable. Encapsulates renderer/scene/camera setup,
 * a requestAnimationFrame render loop, resize handling, and clean disposal —
 * the boilerplate every three.js mount needs. The holographic map and the
 * overlay roster share this; feature code adds meshes/markers to the returned
 * scene.
 *
 * TODO(M4): the real map mesh + ship markers are loaded from GLB produced by
 * scripts/model_convert/. This skeleton just clears the scene to a neutral
 * holographic plane so the plumbing renders end-to-end.
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, type Ref } from "vue";
import * as THREE from "three";

export interface ThreeScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
}

export function useThreeScene(container: Ref<HTMLElement | null>) {
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

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 5000);
    camera.position.set(0, 120, 180);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    el.appendChild(renderer.domElement);

    // A flat sea-colored plane as a stand-in until the real map GLB loads.
    const planeGeom = new THREE.PlaneGeometry(400, 400);
    const planeMat = new THREE.MeshBasicMaterial({ color: 0x0a3050, transparent: true, opacity: 0.6 });
    const plane = new THREE.Mesh(planeGeom, planeMat);
    plane.rotation.x = -Math.PI / 2;
    scene.add(plane);

    // Holographic grid overlay.
    const grid = new THREE.GridHelper(400, 40, 0x00aaff, 0x004466);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.4;
    scene.add(grid);

    api.value = { scene, camera, renderer };
    ready.value = true;

    const tick = () => {
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
      renderer.setSize(w, h);
    });
    resizeObs.observe(el);
  });

  onBeforeUnmount(() => {
    cancelAnimationFrame(rafId);
    resizeObs?.disconnect();
    const a = api.value;
    if (a) {
      a.renderer.dispose();
      a.renderer.domElement.remove();
    }
    api.value = null;
    ready.value = false;
  });

  return { ready, api };
}
