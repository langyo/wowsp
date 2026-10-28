/**
 * Three.js scene lifecycle composable for the holographic map. Encapsulates
 * renderer/scene/camera setup, a requestAnimationFrame render loop, resize
 * handling, and disposal. Returns the scene/camera/renderer so callers can add
 * meshes (map plane, ship markers, trajectory lines).
 *
 * The render loop runs while the page is visible (paused when the tab is
 * hidden); callers mutate the scene and the next frame picks it up. M4:
 * ship markers + trajectories are added by `HolographicMap.tsx` from the
 * decoded `EntityTrajectory[]`.
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from "vue";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createPerfHud, perfHudRequested, type PerfHud } from "./perfHud";
import { useTheme } from "@/theme";
import { useAppliedDpiScale } from "@/theme/dpiPrefs";

/** Orbit radius clamps as mounted, before fitCamera sizes them to the map.
 *  Named so the init numbers have a single home — the follow mode's chase
 *  clamp (see followCamera.ts) and its restore of the captured map bounds
 *  never hardcode against these. */
export const ORBIT_MIN_DISTANCE = 200;
export const ORBIT_MAX_DISTANCE = 6000;

export interface ThreeScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  /** Mark the framebuffer stale: the next uncapped tick repaints even when
   *  nothing else animates (seeks, actor swaps, OSD tone flips). */
  requestRender: () => void;
}

/** Scene palette per effective theme mode. The 3D viewport follows the app
 *  theme: dark keeps the deep-space hologram look, light switches to a soft
 *  paper-white sea so the replay view doesn't read as a dark island inside
 *  a light UI. Exported for HolographicMap's water planes. */
export const SCENE_THEMES = {
  dark: { bg: 0x0b1220, gridA: 0x00aaff, gridB: 0x004466, gridOpacity: 0.35 },
  light: { bg: 0xe8edf3, gridA: 0x2f7fc2, gridB: 0xaec3d6, gridOpacity: 0.5 },
} as const;

export type ScenePalette = (typeof SCENE_THEMES)["dark" | "light"];

/** Resolve the scene palette for the CURRENT effective mode ("light" vs
 *  anything else = dark). */
export function scenePalette(): ScenePalette {
  const { effectiveMode } = useTheme();
  return effectiveMode.value === "light" ? SCENE_THEMES.light : SCENE_THEMES.dark;
}

export function useThreeScene(
  container: Ref<HTMLElement | null>,
  /** Per-RENDERED-frame callback. Receives the dt since the previous
   *  rendered frame and whether OrbitControls moved the camera this tick;
   *  returning false says nothing animates, so the renderer may skip
   *  painting (see the cadence notes at the tick below). */
  onFrame?: (dt: number, cameraMoved: boolean) => boolean | void,
) {
  const ready = ref(false);
  const api = shallowRef<ThreeScene | null>(null);
  let rafId = 0;
  let resizeObs: ResizeObserver | null = null;
  /** Diagnostics overlay (null unless requested via ?perf=1 / the stored
   *  wowsp.perf preference — see perfHud.perfHudRequested) — owned by the
   *  mount scope but disposed from the unmount hook, hence this slot. */
  let perfHud: PerfHud | null = null;
  /** The armed devicePixelRatio media query + its disarm handle — cleaned
   *  up on unmount so a later monitor-scale flip cannot touch the disposed
   *  renderer (the { once } listener would otherwise stay armed). */
  let disarmDprListener: (() => void) | null = null;
  let stopThemeWatch: (() => void) | null = null;
  let stopDpiWatch: (() => void) | null = null;
  /** Removes the visibilitychange listener (which owns the loop's paused
   *  state) — unmount stops the loop for good, so nothing restarts it. */
  let stopVisibilityWatch: (() => void) | null = null;
  /** The live GridHelper, tracked so unmount can dispose its geometry and
   *  material — the theme watch already disposes the grid it replaces, but
   *  without this the CURRENT grid's GPU buffers leak on teardown. */
  let grid: THREE.GridHelper | null = null;

  onMounted(() => {
    const el = container.value;
    if (!el) return;
    const width = el.clientWidth || 800;
    const height = el.clientHeight || 600;

    const scene = new THREE.Scene();
    const { effectiveMode } = useTheme();
    scene.background = new THREE.Color(scenePalette().bg);

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 20000);
    camera.position.set(0, 800, 800);
    camera.lookAt(0, 0, 0);

    // The root's CSS `zoom` (theme/dpiPrefs DPI preference) enlarges the
    // canvas element visually WITHOUT adding backing-store pixels — scale
    // the pixel ratio by the applied zoom so the map stays crisp at
    // non-Auto scales; stopDpiWatch below re-runs this on changes
    // (setPixelRatio re-applies the current buffer size internally).
    // The product is clamped at 2: a 1.5× DPR with 1.5× DPI zoom asked the
    // GPU for 9× the CSS pixels every frame (the single biggest lag source
    // on hi-dpi screens), while everything past 2× is imperceptible here —
    // the scene is flat-shaded holo art, not fine text.
    const dpiZoom = useAppliedDpiScale();
    // Skip-gate bookkeeping: while nothing animates (paused, still camera)
    // the loop stops painting except for a heartbeat and explicit
    // requestRender() invalidations — see the tick below.
    let needsRender = true;
    // MSAA is a context-creation choice, so decide it ONCE from the initial
    // effective ratio: at high pixel densities the 4× sample resolve costs
    // far more bandwidth than the aliasing it hides on this flat-shaded
    // scene, while a low-density screen keeps it. ?msaa=1 forces it back
    // on for A/B comparison.
    const initialRatio = Math.min(window.devicePixelRatio * dpiZoom.value, 2);
    const forceMsaa = new URLSearchParams(location.search).get("msaa") === "1";
    const renderer = new THREE.WebGLRenderer({
      antialias: forceMsaa || initialRatio <= 1.25,
      // three r186 always creates an alpha context (see contextAttributes
      // in WebGLRenderer.js); alpha stays true so the clear path is unchanged.
      alpha: true,
      // Ask for the high-performance adapter where the browser honors the
      // hint — WebView2 currently ignores it on Windows, but it is free.
      powerPreference: "high-performance",
    });
    // One-line adapter diagnostic: "which GPU is WebGL on" must be
    // answerable from a screenshot instead of guesswork.
    {
      const gl = renderer.getContext();
      const dbg = gl.getExtension("WEBGL_debug_renderer_info") as
        | { UNMASKED_VENDOR_WEBGL: number; UNMASKED_RENDERER_WEBGL: number }
        | null;
      console.info("[holo-scene] webgl", {
        vendor: dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : "n/a",
        renderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "n/a",
        samples: gl.getParameter(gl.SAMPLES),
        sampleBuffers: gl.getParameter(gl.SAMPLE_BUFFERS),
        dpr: window.devicePixelRatio,
        ratio: initialRatio,
        msaa: forceMsaa || initialRatio <= 1.25,
      });
    }
    const applyPixelRatio = (zoom: number) => {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio * zoom, 2));
      // A fresh backing-store size must be painted even when idle.
      needsRender = true;
    };
    applyPixelRatio(dpiZoom.value);
    stopDpiWatch = watch(dpiZoom, (zoom) => {
      applyPixelRatio(zoom);
    });
    renderer.setSize(width, height, true);
    el.appendChild(renderer.domElement);
    // Moving the window between monitors with different scales changes
    // devicePixelRatio WITHOUT firing the ResizeObserver — re-apply the
    // ratio when the current density media query flips.
    const rearmDprListener = () => {
      const mq = matchMedia("(resolution: " + window.devicePixelRatio + "dppx)");
      mq.addEventListener("change", rearmDprListener, { once: true });
      applyPixelRatio(dpiZoom.value);
      // Replace any previously armed query (firing re-arms a new one).
      disarmDprListener?.();
      disarmDprListener = () => {
        mq.removeEventListener("change", rearmDprListener);
      };
    };
    rearmDprListener();
    perfHud = createPerfHud(perfHudRequested());

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);
    controls.minPolarAngle = 0.1;           // nearly top-down
    controls.maxPolarAngle = Math.PI / 2.1; // ~85°, prevent going below horizon
    controls.minDistance = ORBIT_MIN_DISTANCE;
    controls.maxDistance = ORBIT_MAX_DISTANCE;
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

    const buildGrid = (p: ScenePalette) => {
      const g = new THREE.GridHelper(4000, 80, p.gridA, p.gridB);
      (g.material as THREE.Material).transparent = true;
      (g.material as THREE.Material).opacity = p.gridOpacity;
      return g;
    };
    let gridLocal = buildGrid(scenePalette());
    grid = gridLocal;
    scene.add(gridLocal);
    // Follow live theme switches (settings toggle / solar system mode).
    stopThemeWatch = watch(effectiveMode, () => {
      const p = scenePalette();
      scene.background = new THREE.Color(p.bg);
      scene.remove(gridLocal);
      gridLocal.geometry.dispose();
      (gridLocal.material as THREE.Material).dispose();
      gridLocal = buildGrid(p);
      grid = gridLocal;
      scene.add(gridLocal);
      needsRender = true;
    });

    api.value = {
      scene,
      camera,
      renderer,
      controls,
      requestRender: () => {
        needsRender = true;
      },
    };
    ready.value = true;

    // ── Render cadence ─────────────────────────────────────────────────
    // 60 fps ceiling: high-refresh panels (120/165 Hz) hand the loop a
    // 6–8 ms budget this scene cannot meet, and the surplus frames only
    // add heat and compositor pressure; 60 trades nothing visible for a
    // stable frame time. Skipped ticks still consume the clock, so dt
    // handed to onFrame always spans real time.
    const TARGET_FRAME_MS = 1000 / 60 - 0.25;
    // Idle heartbeat: repaint at least twice a second so a missed
    // invalidation can never leave a stale framebuffer on screen.
    const HEARTBEAT_MS = 500;
    const clock = new THREE.Clock();
    let lastRenderAt = -1;
    let lastHeartbeat = 0;
    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick);
      if (lastRenderAt >= 0 && now - lastRenderAt < TARGET_FRAME_MS) return;
      lastRenderAt = now;
      const dt = clock.getDelta();
      const cameraMoved = controls.update();
      const animated = onFrame?.(dt, cameraMoved) ?? true;
      if (cameraMoved || animated || needsRender || now - lastHeartbeat >= HEARTBEAT_MS) {
        lastHeartbeat = now;
        needsRender = false;
        renderer.render(scene, camera);
        perfHud?.tickRendered(renderer, now);
      } else {
        perfHud?.tickIdle();
      }
    };

    // Render-loop pause on hidden tabs (phone / Android edition keeps
    // rAF-alikes burning otherwise): stop scheduling frames while
    // document.hidden, resume on visible. Mirrors shipStage's visibility
    // gating but with page visibility instead of IntersectionObserver.
    let loopRunning = false;
    const startLoop = () => {
      if (loopRunning) return;
      loopRunning = true;
      // Drop the delta accumulated while paused so the first resumed
      // frame does not hand a giant dt to onFrame, and render it at once
      // regardless of the cap.
      clock.getDelta();
      lastRenderAt = -1;
      needsRender = true;
      tick(performance.now());
    };
    const stopLoop = () => {
      if (!loopRunning) return;
      loopRunning = false;
      cancelAnimationFrame(rafId);
      rafId = 0;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") stopLoop();
      else startLoop();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    stopVisibilityWatch = () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    if (document.visibilityState !== "hidden") startLoop();

    resizeObs = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, true);
      needsRender = true;
    });
    resizeObs.observe(el);
  });

  onBeforeUnmount(() => {
    stopVisibilityWatch?.();
    cancelAnimationFrame(rafId);
    disarmDprListener?.();
    disarmDprListener = null;
    perfHud?.dispose();
    perfHud = null;
    stopThemeWatch?.();
    stopDpiWatch?.();
    resizeObs?.disconnect();
    const a = api.value;
    if (a) {
      a.controls.dispose();
      a.renderer.dispose();
      a.renderer.domElement.remove();
    }
    // The theme watch disposes each grid it replaces; the CURRENT grid's
    // geometry and material are per-mount GPU resources — release them here
    // too or they leak on teardown.
    if (grid) {
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      grid = null;
    }
    api.value = null;
    ready.value = false;
  });

  return { ready, api };
}
