/**
 * The holographic replay map's performance diagnostics overlay — the
 * measurement battery behind every render-cost change. Reports, straight
 * from the render loop:
 *   - timing: rendered fps plus p50/p95 frame interval over a 2 s window,
 *     and the idle-skip ticks (frames the dirty gate decided not to paint)
 *   - draws: renderer.info draw calls / triangles of the last rendered
 *     frame, plus the canvas backing size and pixel ratio
 *   - gpu: the WebGL adapter string
 *
 * Packaged builds ship no DevTools, so this overlay is how "which GPU /
 * how many fps / how many draws" gets answered from a screenshot. It owns
 * no timer — the scene's own tick feeds it.
 *
 * Presentation is hikari's generic HkDebugFloat window (hikari #1288):
 * a standalone Vue app mounts the float, which teleports itself to
 * <body>. Since hikari's headerless chrome the seat is a bare HUD
 * (`chrome: "none"`): no title bar — hovering already fades the window,
 * a permanent "PERF ×" strip just burned vertical space. The whole
 * window body is the drag handle (viewport-clamped; the dropped spot
 * persists under localStorage `hk-debug-float:holo-perf` via persistKey —
 * position only for open, see below), and the close button plus the
 * per-section toggle chips (timing / draws / gpu) live in the float's
 * hover-revealed overlay, OUTSIDE the fading card so they stay legible
 * at PERF_HUD_HOVER_OPACITY. The toggles persist as the record's
 * `hidden` half (thin the HUD to the lines that matter right now; the
 * next mount restores the thinned set). `width: "auto"` sizes the
 * window to its longest line — `white-space: pre` mono lines are never
 * clipped by the seat, and the GPU adapter string (the longest line
 * almost always) pins the width steady while the numbers tick. The
 * numeric columns are space-padded anyway so the text itself stays
 * column-aligned while values change.
 *
 * The float's open state is deliberately session-only: the mount binds
 * a fresh controlled `open = true` and the persisted record's open half
 * is never honored, so the HUD can never come back stuck-hidden (the
 * same lesson as the `wowsp.perf` flag recounted below). Behavioral
 * notes: the old overlay was fully click-through (`pointer-events:
 * none`); the float intercepts pointers on its own box only —
 * everything outside it still reaches the page. And the old inline
 * `z-index: 2147483000` is gone: the float paints in hikari's
 * `--hk-z-debug-float` band (80000), strictly below the overlay root
 * (90000), so modals/toasts/tooltips paint above the HUD.
 *
 * Activation (see stores/perfHud — the session-only toggle): dev builds
 * default ON, packaged release builds default OFF, and the settings'
 * feedback pane flips it either way for the current app run only — the
 * toggle itself persists nothing (the dragged position and the hidden
 * sections are the exceptions, see the presentation paragraph above).
 * The earlier `?perf=1` / `?perf=0` URL parameters and the stored
 * `wowsp.perf` localStorage flag are gone on purpose: a flag that
 * support tooling could set but no packaged user could ever clear kept
 * the overlay stuck on across releases (it leaked into v0.6.9's release
 * build on a machine still carrying the flag).
 */
import * as THREE from "three";
import { createApp, defineComponent, h, ref, watchSyncEffect, type Ref } from "vue";
import { HkDebugFloat } from "@celestia-island/hikari";

/** Frame window for the percentile stats. */
const WINDOW_MS = 2000;
/** Overlay refresh cadence (text only — never the scene). */
const REPORT_MS = 500;
/** Opacity while the pointer rests on the float — a big dim, not a hide. */
export const PERF_HUD_HOVER_OPACITY = 0.15;

/** The report sections, in display order; hikari renders each through
 *  the same-named slot and gives it a hover toggle chip. */
export const PERF_HUD_SECTIONS = [
  { key: "timing", label: "timing" },
  { key: "draws", label: "draws" },
  { key: "gpu", label: "gpu" },
] as const;

/** Closed union of the section keys — the report maps are keyed by it
 *  so a lookup can never read `undefined` (noUncheckedIndexedAccess). */
type PerfHudSectionKey = (typeof PERF_HUD_SECTIONS)[number]["key"];

export interface PerfHud {
  /** Called right after renderer.render(): records one rendered frame. */
  tickRendered(renderer: THREE.WebGLRenderer, now: number): void;
  /** Called on a tick that rendered nothing (dirty gate said idle). */
  tickIdle(): void;
  dispose(): void;
}

export function createPerfHud(enabled: boolean): PerfHud | null {
  if (!enabled) return null;

  // The report text lives in Vue refs — one per section. A naive slot
  // binding would only re-render whenever Vue next flushes (the old
  // implementation wrote el.textContent directly into a hand-styled
  // div); the write lands through a sync-flush effect, not the reactive
  // binding: the scene's own tick feeds report(), so the text must hit
  // the DOM synchronously (a scheduled re-render would land one
  // microtask late).
  const statsText: Record<PerfHudSectionKey, Ref<string>> = {
    timing: ref(""),
    draws: ref(""),
    gpu: ref(""),
  };
  const statsEls: Partial<Record<PerfHudSectionKey, HTMLElement>> = {};
  const PerfHudFloat = defineComponent({
    name: "PerfHudFloat",
    setup() {
      // Session-only open state, bound CONTROLLED: the persisted record
      // (written by the float on close/drag-drop/toggle for the dragged
      // position and hidden sections) is never honored for open — a
      // fresh mount always opens, so the HUD can never return
      // stuck-hidden (the v0.6.9 `wowsp.perf` lesson below).
      const open = ref(true);
      watchSyncEffect(() => {
        // Read every section ref FIRST (unconditionally): at setup the
        // element map is still empty, and tracking must attach to the
        // TEXT refs — not to the mount order — so a later report flips
        // the DOM wherever sections are currently mounted.
        const text = {
          timing: statsText.timing.value,
          draws: statsText.draws.value,
          gpu: statsText.gpu.value,
        };
        for (const key of Object.keys(statsEls) as PerfHudSectionKey[]) {
          const el = statsEls[key];
          if (el) el.textContent = text[key];
        }
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
            // A bare HUD: no title bar (hover already fades the
            // window), the body itself is the drag handle, and the
            // close × + section chips reveal on hover. "PERF" survives
            // as the window's accessible name.
            chrome: "none",
            title: "PERF",
            // Fit the content: pre-formatted mono lines are never
            // clipped by a fixed-width seat.
            width: "auto",
            sections: [...PERF_HUD_SECTIONS],
            persistKey: "holo-perf",
          },
          {
            // Stable per-section hooks for diagnostics scripts,
            // screenshots and tests; the text nodes themselves are
            // owned by the sync effect above.
            ...Object.fromEntries(
              PERF_HUD_SECTIONS.map(({ key }) => [
                key,
                () =>
                  h("div", {
                    class: "holo-perf-hud",
                    "data-holo-perf": key,
                    style: { whiteSpace: "pre" },
                    ref: (el: unknown) => {
                      statsEls[key] = (el as HTMLElement) ?? undefined;
                      // A re-shown section remounts with an empty node;
                      // fill it from the current report immediately —
                      // the sync effect only fires when the TEXT next
                      // changes, which could be a report window away.
                      if (el) (el as HTMLElement).textContent = statsText[key].value;
                    },
                  }),
              ]),
            ),
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
    // Space-padded numeric columns: with white-space: pre the pads keep
    // the columns steady while digit counts change, and the padded text
    // never drives the seat wider than the GPU line.
    statsText.timing.value =
      "render " +
      String(fps).padStart(3) +
      " fps  p50 " +
      percentile(dts, 0.5).toFixed(1).padStart(5) +
      " ms  p95 " +
      percentile(dts, 0.95).toFixed(1).padStart(5) +
      " ms  idle-ticks " +
      idle;
    statsText.draws.value =
      "draws " +
      lastInfo.calls +
      "  tris " +
      (lastInfo.triangles / 1e6).toFixed(2) +
      "M  buffer " +
      buf +
      " @ " +
      ratio +
      "x";
    statsText.gpu.value =
      r != null ? describeGpu(r) : "gpu: waiting for first render";
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
