/**
 * The holographic replay map's performance diagnostics overlay — the
 * measurement battery behind every render-cost change. Reports, straight
 * from the render loop:
 *   - rendered fps plus p50/p95 frame interval over a 2 s window
 *   - idle-skip ticks (frames the dirty gate decided not to paint)
 *   - renderer.info draw calls / triangles of the last rendered frame
 *   - canvas backing size, pixel ratio, and the WebGL adapter string
 *
 * Packaged builds ship no DevTools, so this overlay is how "which GPU /
 * how many fps / how many draws" gets answered from a screenshot. It owns
 * no timer — the scene's own tick feeds it.
 *
 * The overlay never intercepts the pointer (clicks pass straight through);
 * when the cursor rests on it, it dims itself far down so it never hides
 * the UI underneath.
 *
 * Activation (see stores/perfHud — the session-only toggle): dev builds
 * default ON, packaged release builds default OFF, and the settings'
 * feedback pane flips it either way for the current app run only —
 * nothing is persisted. The earlier `?perf=1` / `?perf=0` URL parameters
 * and the stored `wowsp.perf` localStorage flag are gone on purpose: a
 * flag that support tooling could set but no packaged user could ever
 * clear kept the overlay stuck on across releases (it leaked into
 * v0.6.9's release build on a machine still carrying the flag).
 */
import * as THREE from "three";

/** Frame window for the percentile stats. */
const WINDOW_MS = 2000;
/** Overlay refresh cadence (text only — never the scene). */
const REPORT_MS = 500;
/** Opacity while the pointer rests on the overlay — a big dim, not a hide. */
export const PERF_HUD_HOVER_OPACITY = 0.15;
/** Hover fade duration, ms. */
const HOVER_FADE_MS = 150;

/** Whether a client-space point sits inside a box. The right/bottom edges
 *  compare exclusively, so a zero-area box (no layout yet — fresh test DOM,
 *  hidden element) never reports a hit at its own collapsed origin. */
function pointerInRect(
  rect: { left: number; right: number; top: number; bottom: number },
  x: number,
  y: number,
): boolean {
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

export interface PerfHud {
  /** Called right after renderer.render(): records one rendered frame. */
  tickRendered(renderer: THREE.WebGLRenderer, now: number): void;
  /** Called on a tick that rendered nothing (dirty gate said idle). */
  tickIdle(): void;
  dispose(): void;
}

export function createPerfHud(enabled: boolean): PerfHud | null {
  if (!enabled) return null;
  const el = document.createElement("div");
  // Stable hook for diagnostics scripts, screenshots and tests (styles stay
  // inline so the overlay is self-contained and never enters app CSS).
  el.className = "holo-perf-hud";
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = [
    "position:fixed",
    "top:48px",
    "left:12px",
    "z-index:2147483000",
    "padding:6px 10px",
    "border-radius:6px",
    "background:rgba(4,8,15,0.82)",
    "color:#8fe3ff",
    "font:11px/1.6 ui-monospace,Consolas,monospace",
    "white-space:pre",
    // Fully click-through: everything under the overlay stays interactive.
    "pointer-events:none",
    // The hover dim is coordinate-driven (see the pointer tracker below)
    // because :hover can never fire on a pointer-events:none element.
    "opacity:1",
    "transition:opacity " + HOVER_FADE_MS + "ms ease",
  ].join(";");
  document.body.appendChild(el);

  const frames: { t: number; dt: number }[] = [];
  let lastNow = 0;
  let idleSinceReport = 0;
  let lastInfo = { calls: 0, triangles: 0 };
  let lastRenderer: THREE.WebGLRenderer | null = null;
  let gpu = "";
  let lastReport = 0;
  let disposed = false;

  // Dim while the pointer rests on the overlay. pointer-events:none already
  // lets every click reach the UI underneath; since :hover can never fire on
  // such an element, the dim watches window-level mouse coordinates and
  // compares them against the overlay's box instead.
  const setHover = (on: boolean): void => {
    el.style.opacity = on ? String(PERF_HUD_HOVER_OPACITY) : "";
  };
  const onPointerMove = (ev: MouseEvent): void => {
    if (disposed) return;
    setHover(pointerInRect(el.getBoundingClientRect(), ev.clientX, ev.clientY));
  };
  const onPointerGone = (): void => {
    if (!disposed) setHover(false);
  };
  window.addEventListener("mousemove", onPointerMove, { passive: true });
  window.addEventListener("blur", onPointerGone);
  document.documentElement.addEventListener("mouseleave", onPointerGone);

  const percentile = (sorted: number[], p: number): number =>
    sorted.length === 0
      ? 0
      : sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))];

  const describeGpu = (renderer: THREE.WebGLRenderer): string => {
    if (gpu) return gpu;
    try {
      const gl = renderer.getContext();
      const dbg = gl.getExtension("WEBGL_debug_renderer_info") as
        | { UNMASKED_RENDERER_WEBGL: number }
        | null;
      gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "n/a";
    } catch {
      gpu = "n/a";
    }
    return gpu;
  };

  const report = (now: number): void => {
    if (disposed || now - lastReport < REPORT_MS) return;
    lastReport = now;
    const idle = idleSinceReport;
    idleSinceReport = 0;
    while (frames.length > 0 && now - frames[0].t > WINDOW_MS) frames.shift();
    // Percentiles over RENDER intervals only — idle gaps (a paused scene
    // painting nothing) would inflate p95 with time nothing was drawn.
    const dts = frames
      .filter((f) => f.dt <= 100)
      .map((f) => f.dt)
      .sort((a, b) => a - b);
    const span =
      frames.length >= 2 ? frames[frames.length - 1].t - frames[0].t : 0;
    const fps = span > 0 ? Math.round(((frames.length - 1) * 1000) / span) : 0;
    const r = lastRenderer;
    const buf =
      r != null ? r.domElement.width + "x" + r.domElement.height : "?";
    const ratio = r != null ? r.getPixelRatio().toFixed(2) : "?";
    el.textContent =
      "render " +
      fps +
      " fps  p50 " +
      percentile(dts, 0.5).toFixed(1) +
      " ms  p95 " +
      percentile(dts, 0.95).toFixed(1) +
      " ms  idle-ticks " +
      idle +
      "\n" +
      "draws " +
      lastInfo.calls +
      "  tris " +
      (lastInfo.triangles / 1e6).toFixed(2) +
      "M  buffer " +
      buf +
      " @ " +
      ratio +
      "x\n" +
      (r != null ? describeGpu(r) : "gpu: waiting for first render");
  };

  return {
    tickRendered(renderer, now) {
      lastRenderer = renderer;
      if (lastNow > 0) frames.push({ t: now, dt: now - lastNow });
      lastNow = now;
      lastInfo = {
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
      };
      report(now);
    },
    tickIdle() {
      idleSinceReport += 1;
      report(performance.now());
    },
    dispose() {
      disposed = true;
      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("blur", onPointerGone);
      document.documentElement.removeEventListener("mouseleave", onPointerGone);
      el.remove();
    },
  };
}
