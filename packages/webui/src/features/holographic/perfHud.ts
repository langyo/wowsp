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
 * Presentation is hikari's generic HkDebugFloat window (hikari #1288): a
 * standalone Vue app mounts the float, which teleports itself to <body>,
 * and the report text lands in the `.holo-perf-hud` slot wrapper with
 * `white-space: pre` so the 3-line mono format is preserved. The float is
 * interactive where the old hand-rolled overlay was not: the header drags
 * (viewport-clamped; the dropped spot persists under localStorage
 * `hk-debug-float:holo-perf` via persistKey — position only, see below),
 * a close button hides it for the current app run, and hovering fades it
 * to PERF_HUD_HOVER_OPACITY. The float's open state is deliberately
 * session-only: the mount binds a fresh controlled `open = true` and the
 * persisted record's open half is never honored, so the HUD can never
 * come back stuck-hidden (the same lesson as the `wowsp.perf` flag
 * recounted below). Behavioral notes: the old overlay was fully
 * click-through (`pointer-events: none`); the float intercepts pointers
 * on its own box only — everything outside it still reaches the page.
 * And the old inline `z-index: 2147483000` is gone: the float paints in
 * hikari's `--hk-z-debug-float` band (80000), strictly below the overlay
 * root (90000), so modals/toasts/tooltips paint above the HUD.
 *
 * Activation (see stores/perfHud — the session-only toggle): dev builds
 * default ON, packaged release builds default OFF, and the settings'
 * feedback pane flips it either way for the current app run only — the
 * toggle itself persists nothing (the dragged position is the one
 * exception, see the presentation paragraph above). The earlier
 * `?perf=1` / `?perf=0` URL parameters and the stored `wowsp.perf`
 * localStorage flag are gone on purpose: a flag that support tooling
 * could set but no packaged user could ever clear kept the overlay
 * stuck on across releases (it leaked into v0.6.9's release build on a
 * machine still carrying the flag).
 */
import * as THREE from "three";
import { createApp, defineComponent, h, ref, watchSyncEffect } from "vue";
import { HkDebugFloat } from "@celestia-island/hikari";

/** Frame window for the percentile stats. */
const WINDOW_MS = 2000;
/** Overlay refresh cadence (text only — never the scene). */
const REPORT_MS = 500;
/** Opacity while the pointer rests on the float — a big dim, not a hide. */
export const PERF_HUD_HOVER_OPACITY = 0.15;

export interface PerfHud {
  /** Called right after renderer.render(): records one rendered frame. */
  tickRendered(renderer: THREE.WebGLRenderer, now: number): void;
  /** Called on a tick that rendered nothing (dirty gate said idle). */
  tickIdle(): void;
  dispose(): void;
}

export function createPerfHud(enabled: boolean): PerfHud | null {
  if (!enabled) return null;

  // The report text lives in a Vue ref; the slot wrapper re-renders
  // whenever report() flips it (the old implementation wrote
  // el.textContent directly into a hand-styled div). The write lands
  // through a sync-flush effect, not the reactive binding: the scene's
  // own tick feeds report(), so the text must hit the DOM synchronously
  // (a scheduled re-render would land one microtask late).
  const statsText = ref("");
  const statsEl = ref<HTMLElement>();
  const PerfHudFloat = defineComponent({
    name: "PerfHudFloat",
    setup() {
      // Session-only open state, bound CONTROLLED: the persisted record
      // (written by the float on close/drag-drop for the dragged
      // position) is never honored for open — a fresh mount always
      // opens, so the HUD can never return stuck-hidden (the
      // v0.6.9 `wowsp.perf` lesson below).
      const open = ref(true);
      watchSyncEffect(() => {
        if (statsEl.value) statsEl.value.textContent = statsText.value;
      });
      return () =>
        h(
          HkDebugFloat,
          {
            open: open.value,
            "onUpdate:open": (v: boolean) => {
              open.value = v;
            },
            position: "top-left",
            // Approximates the old overlay's top:48px seat; draggable
            // anyway, and a dropped position persists (position only —
            // the open half of the persisted record is ignored, see the
            // controlled open binding above).
            offset: 48,
            hoverOpacity: PERF_HUD_HOVER_OPACITY,
            title: "PERF",
            persistKey: "holo-perf",
          },
          {
            // Stable hook for diagnostics scripts, screenshots and tests;
            // the text node itself is owned by the sync effect above.
            default: () =>
              h("div", {
                class: "holo-perf-hud",
                style: { whiteSpace: "pre" },
                ref: statsEl,
              }),
          },
        );
    },
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(PerfHudFloat);
  app.mount(host); // HkDebugFloat teleports the window to <body> itself

  const frames: { t: number; dt: number }[] = [];
  let lastNow = 0;
  let idleSinceReport = 0;
  let lastInfo = { calls: 0, triangles: 0 };
  let lastRenderer: THREE.WebGLRenderer | null = null;
  let gpu = "";
  let lastReport = 0;
  let disposed = false;

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
    statsText.value =
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
      if (disposed) return;
      disposed = true;
      // Unmounting the app removes the teleported window from <body>;
      // the host div is ours to take back.
      app.unmount();
      host.remove();
    },
  };
}
