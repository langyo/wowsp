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
 * a standalone Vue app mounts the float, which teleports itself into
 * <body>. Since hikari's headerless chrome the seat is a bare HUD
 * (`chrome: "none"`): no title bar — hovering already fades the window.
 * The whole window body is the drag handle (viewport-clamped; the dropped
 * spot persists under localStorage `hk-debug-float:holo-perf` via
 * persistKey — position only for open, see below). The window keeps
 * hikari's own localized debug label as its accessible name (no title
 * override); every visible label of our own goes through the app i18n.
 *
 * NO in-window close (user direction 2026-11-20): `closable: false`
 * drops hikari's hover-revealed ×, and the HUD owns its own chrome
 * instead. The FIRST ROW is the pin control plus the section switch: a
 * left-aligned HkIconButton pins the window — the "frozen" click-through
 * state (`interactive: false`) where the window stops taking pointers
 * and dims to FROZEN_OPACITY, with only the pin itself left addressable
 * (`data-hk-debug-float-pointer`) so it can always be released; the pin
 * keeps its own constant PIN_OPACITY in both states. The section switch
 * is hikari's HkPillToggleGroup (the standard grouped control — the old
 * hand-styled per-section HkButtons are gone) and its labels are
 * translated through the app i18n (`replay.perf.*`).
 * The card is a FIXED width (PERF_HUD_WIDTH, applied to the slot root) so
 * toggling sections can never reflow/resize the window; with every
 * section off the button row stays and the metric area keeps a reserved
 * height, so the HUD never collapses to a bare sliver.
 *
 * Section visibility persists in the SAME record the float owns (key
 * `hk-debug-float:holo-perf`, its `hidden` field) so existing users keep
 * their thinned set. Without `sections` HkDebugFloat never writes that
 * field itself — this module reads/writes it directly, and re-merges it
 * after the float's own open/position writes (drag-drop — the HUD renders
 * no close of its own) would otherwise drop it from the record.
 *
 * The numeric columns are space-padded so the text itself stays
 * column-aligned while values change (the lines keep their
 * `white-space: pre-wrap` mono form and their direct-DOM write path — see the
 * statsEls note below). The float's open state is deliberately
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
 * toggle itself persists nothing (the dragged position and the hidden
 * sections are the exceptions, see the presentation paragraph above).
 * The earlier `?perf=1` / `?perf=0` URL parameters and the stored
 * `wowsp.perf` localStorage flag are gone on purpose: a flag that
 * support tooling could set but no packaged user could ever clear kept
 * the overlay stuck on across releases (it leaked into v0.6.9's release
 * build on a machine still carrying the flag).
 */
import * as THREE from "three";
import {
  createApp,
  defineComponent,
  h,
  onBeforeUnmount,
  ref,
  watchSyncEffect,
  type CSSProperties,
  type Ref,
} from "vue";
import { HkDebugFloat, HkIconButton, HkPillToggleGroup } from "@celestia-island/hikari";
import { Pin, PinOff } from "@lucide/vue";

import { t as i18nT } from "@/i18n";

/** Frame window for the percentile stats. */
const WINDOW_MS = 2000;
/** Overlay refresh cadence (text only — never the scene). */
const REPORT_MS = 500;
/** Opacity while the pointer rests on the float — a big dim, not a hide.
 *  The section toggle row lives IN the card (the multi-select button
 *  group), so the dim has to keep buttons legible and clickable: 0.15
 *  (the old stats-only dim) rendered them as ghosts under the pointer. */
export const PERF_HUD_HOVER_OPACITY = 0.4;

/** Opacity of the frozen window's CONTENT (switch + stats) — the pin
 *  keeps PIN_OPACITY: the HUD keeps measuring but stops competing
 *  visually, and the hikari window stops taking pointers
 *  (`interactive: false`). */
const FROZEN_OPACITY = 0.4;

/** The pin control's own constant opacity — always semi-transparent
 *  (user direction), never a full-opacity chrome button. */
const PIN_OPACITY = 0.6;

/**
 * Fixed card width, applied to the slot root. Fixed so toggling a section
 * off can never reflow/resize the float (HkDebugFloat's `width: "auto"`
 * then follows this explicit width, not the content).
 *
 * 26rem is sized for the LONGEST always-readable report line, not a round
 * number: the timing line is 56 mono characters wide ("render 060 fps
 * p50 16.7 ms p95 33.3 ms idle-ticks 0") and the card inherits hikari's
 * 0.75rem mono — measured 369.5px in Consolas and 403.3px in Courier
 * New-class faces at 12px. 17rem (272px) clipped even the draws line
 * (283.7px), and the HUD's whole point is a screenshot-readable readout.
 * The GPU adapter string is unbounded: report lines WRAP
 * (`white-space: pre-wrap` + `overflow-wrap: anywhere`) instead of
 * clipping or scrolling — a wrapped second line beats a cut-off readout.
 */
export const PERF_HUD_WIDTH = "26rem";

/** Height reserved for the metric lines while every section is off — the
 *  card keeps a modest empty body area instead of collapsing. */
const STATS_MIN_HEIGHT = "2.5rem";

/** The report sections, in display order — the toggle row's order and the
 *  order the persisted `hidden` list is written in. `label` keeps the
 *  stable chip-era identity (diagnostics scripts may read the constant);
 *  the in-card buttons render the localized `replay.perf.<key>` label. */
export const PERF_HUD_SECTIONS = [
  { key: "timing", label: "timing" },
  { key: "draws", label: "draws" },
  { key: "gpu", label: "gpu" },
] as const;

/** Closed union of the section keys — the report maps are keyed by it
 *  so a lookup can never read `undefined` (noUncheckedIndexedAccess). */
type PerfHudSectionKey = (typeof PERF_HUD_SECTIONS)[number]["key"];

/** Section keys in display/persistence order. */
const SECTION_KEYS: readonly PerfHudSectionKey[] = PERF_HUD_SECTIONS.map(
  (section) => section.key,
);

/** The float's persistence key (hikari namespaces it as
 *  `hk-debug-float:<persistKey>`). */
const PERSIST_KEY = "holo-perf";
/** The localStorage record HkDebugFloat owns — we only touch its `hidden`
 *  field, leaving `open`/`x`/`y` to the float. */
const STORAGE_KEY = `hk-debug-float:${PERSIST_KEY}`;

export interface PerfHud {
  /** Called right after renderer.render(): records one rendered frame. */
  tickRendered(renderer: THREE.WebGLRenderer, now: number): void;
  /** Called on a tick that rendered nothing (dirty gate said idle). */
  tickIdle(): void;
  dispose(): void;
}

/**
 * Pure next-state for one section toggle: add or remove `key`, then keep
 * the list in PERF_HUD_SECTIONS order so every persisted write is
 * deterministic (the old hikari chips did the same).
 */
export function toggleHiddenSection(
  hidden: readonly PerfHudSectionKey[],
  key: PerfHudSectionKey,
): PerfHudSectionKey[] {
  const next = new Set(hidden);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return SECTION_KEYS.filter((sectionKey) => next.has(sectionKey));
}

/**
 * Pure reader for a record's `hidden` field: unknown/corrupt payloads
 * degrade to "every section visible", and only known section keys survive
 * (a renamed section must not resurrect as a hidden ghost). Order is
 * normalized to PERF_HUD_SECTIONS.
 */
export function parseHiddenSections(record: unknown): PerfHudSectionKey[] {
  if (record === null || typeof record !== "object") return [];
  const hidden = (record as { hidden?: unknown }).hidden;
  if (!Array.isArray(hidden)) return [];
  const keys = new Set(hidden.filter((key): key is string => typeof key === "string"));
  return SECTION_KEYS.filter((key) => keys.has(key));
}

/** Best-effort read of the persisted record (null when absent/corrupt). */
function readPersistedRecord(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The persisted hidden set (empty when the record is absent/corrupt). */
function readHiddenSections(): PerfHudSectionKey[] {
  return parseHiddenSections(readPersistedRecord());
}

/**
 * Write only the `hidden` half of the float's record. The open/position
 * halves are preserved: hikari refuses records without a boolean `open`
 * (it falls back to "nothing persisted"), so a record created here carries
 * `open: true` — harmless because the HUD's open state is session-only.
 */
function writeHiddenSections(hidden: readonly PerfHudSectionKey[]): void {
  try {
    const record = readPersistedRecord() ?? { open: true };
    if (typeof record.open !== "boolean") record.open = true;
    if (hidden.length > 0) record.hidden = [...hidden];
    else delete record.hidden;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Persistence is best-effort: a debug HUD must never break the page.
  }
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

  const cardStyle: CSSProperties = {
    width: PERF_HUD_WIDTH,
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-6)",
    // The fixed width is authoritative; overlong report lines WRAP inside
    // it (pre-wrap) instead of widening the card or clipping.
    minWidth: 0,
  };
  // Row 1: the pin at the leading edge, the pill switch beside it. The
  // pin keeps a fixed slot, so it can never overlap the switch whatever
  // the labels measure.
  const headStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-4)",
    minWidth: 0,
  };
  // Always semi-transparent (user direction) and never stretched into the
  // section buttons' space.
  const pinStyle: CSSProperties = {
    flex: "0 0 auto",
    opacity: String(PIN_OPACITY),
  };
  /** The dimmed half of the window: while frozen the switch and the stats
   *  fade to FROZEN_OPACITY; the pin stays at PIN_OPACITY above them so it
   *  can always be found and pressed to release the lock. */
  const dimStyle = (frozen: boolean): CSSProperties => ({
    minWidth: 0,
    opacity: frozen ? FROZEN_OPACITY : 1,
    transition: "opacity var(--duration-short) ease",
  });
  const statsStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-4)",
    minWidth: 0,
    // All sections off → keep this much empty body area, so the card
    // never collapses to the button row alone.
    minHeight: STATS_MIN_HEIGHT,
  };
  // Wrapping report lines: a long GPU adapter string or a wide timing
  // line breaks onto the next line instead of clipping at the card edge.
  const metricStyle: CSSProperties = {
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  };

  const PerfHudFloat = defineComponent({
    name: "PerfHudFloat",
    setup() {
      // Session-only open state, bound CONTROLLED: the persisted record
      // (written by the float on drag-drop for the dragged
      // position) is never honored for open — a fresh mount always
      // opens, so the HUD can never return stuck-hidden (the v0.6.9
      // `wowsp.perf` lesson above).
      const open = ref(true);
      // The thinned set, restored from the float's own record. The
      // float no longer receives `sections` (the in-card row replaces
      // its overlay chips), so its persistence does not know about
      // `hidden` — this module owns that half of the record.
      const hidden = ref<PerfHudSectionKey[]>(readHiddenSections());
      // The pin's click-through state, session-only like open: a frozen
      // window stops taking pointers and dims; only the pin stays live.
      const frozen = ref(false);
      const isVisible = (key: PerfHudSectionKey): boolean =>
        !hidden.value.includes(key);
      const toggleSection = (key: PerfHudSectionKey): void => {
        hidden.value = toggleHiddenSection(hidden.value, key);
        writeHiddenSections(hidden.value);
      };

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

      // HkDebugFloat still owns open/position and rewrites the record on
      // drag-drop; without `sections` those writes omit our `hidden`
      // field. Re-merge it right after such a write — these
      // document listeners run after the float's own bubble-phase
      // handlers, and only engage for events aimed inside the window.
      const realignPersistedHidden = (event: Event): void => {
        const target = event.target;
        if (
          !(target instanceof Element) ||
          target.closest(".hk-debug-float") === null
        ) {
          return;
        }
        const persisted = readHiddenSections();
        const current = hidden.value;
        if (
          persisted.length === current.length &&
          persisted.every((key, index) => key === current[index])
        ) {
          return;
        }
        writeHiddenSections(current);
      };
      const realignEvents = ["pointerup", "pointercancel", "click"] as const;
      for (const type of realignEvents) {
        document.addEventListener(type, realignPersistedHidden);
      }
      onBeforeUnmount(() => {
        for (const type of realignEvents) {
          document.removeEventListener(type, realignPersistedHidden);
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
            // A bare HUD: no title bar (hover already fades the window)
            // and the body itself is the drag handle. No title prop: the
            // window keeps hikari's own localized debug label as its
            // accessible name.
            chrome: "none",
            // The HUD owns its chrome: hikari's hover-revealed close is
            // dropped (the pin below replaces it), and a frozen window
            // leaves the pointer layer — only the data-hk-debug-float-
            // pointer pin keeps receiving events, to release the lock.
            closable: false,
            interactive: !frozen.value,
            // Fit the seat: the slot root pins PERF_HUD_WIDTH, so the
            // window follows that fixed width instead of its content.
            width: "auto",
            persistKey: PERSIST_KEY,
          },
          () =>
            h(
              "div",
              {
                class: "holo-perf-hud-root",
                "data-holo-perf-root": "",
                "data-holo-perf-frozen": frozen.value ? "" : undefined,
                style: cardStyle,
              },
              [
                // Row 1 — the pin and the grouped section switch. The pin
                // is the ONLY control that stays addressable while the
                // window is frozen (the user's release affordance) and
                // always sits at PIN_OPACITY; the switch is hikari's
                // standard HkPillToggleGroup.
                h(
                  "div",
                  {
                    class: "holo-perf-hud-head",
                    // Diagnostics hook for the row (scripts, screenshots,
                    // tests); the pin's data-holo-perf-pin and the card's
                    // data-holo-perf-frozen are the same kind of hook.
                    "data-holo-perf-toggles": "",
                    style: headStyle,
                  },
                  [
                    h(
                      HkIconButton,
                      {
                        class: "holo-perf-hud-pin",
                        "data-holo-perf-pin": "",
                        "data-hk-debug-float-pointer": "",
                        size: 24,
                        variant: "ghost",
                        "aria-label": i18nT("replay.perf.pin"),
                        "aria-pressed": frozen.value ? "true" : "false",
                        title: i18nT("replay.perf.pin"),
                        style: pinStyle,
                        onClick: () => {
                          frozen.value = !frozen.value;
                        },
                      },
                      () =>
                        h(frozen.value ? PinOff : Pin, {
                          size: 14,
                          "aria-hidden": "true",
                        }),
                    ),
                    h(
                      "div",
                      {
                        class: "holo-perf-hud-toggles",
                        style: dimStyle(frozen.value),
                      },
                      h(HkPillToggleGroup, {
                        label: i18nT("replay.perf.sections"),
                        options: PERF_HUD_SECTIONS.map(({ key }) => ({
                          value: key,
                          label: i18nT(`replay.perf.${key}`),
                        })),
                        selected: new Set(
                          PERF_HUD_SECTIONS.filter(({ key }) =>
                            isVisible(key),
                          ).map(({ key }) => key),
                        ),
                        onToggle: (value: string) => {
                          toggleSection(value as PerfHudSectionKey);
                        },
                      }),
                    ),
                  ],
                ),
                // The visible report lines. Stable per-section hooks for
                // diagnostics scripts, screenshots and tests; the text
                // nodes themselves are owned by the sync effect above.
                h(
                  "div",
                  {
                    class: "holo-perf-hud-stats",
                    "data-holo-perf-stats": "",
                    style: { ...statsStyle, ...dimStyle(frozen.value) },
                  },
                  PERF_HUD_SECTIONS.filter(({ key }) => isVisible(key)).map(
                    ({ key }) =>
                      h("div", {
                        key,
                        class: "holo-perf-hud",
                        "data-holo-perf": key,
                        style: metricStyle,
                        ref: (el: unknown) => {
                          statsEls[key] = (el as HTMLElement) ?? undefined;
                          // A re-shown section remounts with an empty node;
                          // fill it from the current report immediately —
                          // the sync effect only fires when the TEXT next
                          // changes, which could be a report window away.
                          if (el) (el as HTMLElement).textContent = statsText[key].value;
                        },
                      }),
                  ),
                ),
              ],
            ),
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
    // Space-padded numeric columns: under white-space: pre-wrap the pads
    // still keep the columns steady while digit counts change (a wrapped
    // long GPU string is the only line that leaves the grid).
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
