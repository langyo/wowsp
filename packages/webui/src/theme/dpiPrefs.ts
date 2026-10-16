/**
 * WoWSP's interface-scale (DPI) preference — a manual root zoom layered on
 * top of the browser's own zoom, ported from shittim-chest:
 *
 * Auto (null, the default) never touches scaling; the page follows the
 * browser/webview zoom untouched. A manual scale applies the standardized
 * CSS `zoom` on the document root, so layout, fonts and hit targets scale
 * together exactly like native browser zoom — no font-size or rem hacks
 * that drift out of sync with the layout.
 *
 * Values live on the 25% notches between 100 and 300. A staged value is
 * PREVIEWED with an app-level 10s countdown: with no explicit keep it
 * reverts to the persisted value, so the UI can never be trapped on an
 * unconfirmed scale. Two always-available escape hatches (Ctrl/Cmd+Alt+0,
 * `?dpi=auto` / `#dpi=auto`) plus the boot/resize risk rollback guarantee
 * a way back that does not depend on any popup UI being reachable.
 *
 * The preference persists under `wowsp-dpi` as a stringified percent.
 */
import { reactive, readonly, ref, type Ref } from "vue";

export const DPI_MIN = 100;
export const DPI_MAX = 300;
export const DPI_STEP = 25;

/** Seconds a preview stays live before it auto-reverts. */
export const DPI_REVERT_SECONDS = 10;

/**
 * Effective layout width (CSS px) below which the interface starts
 * breaking down: hit targets become unusable and panels overflow.
 * viewportWidth / (pct / 100) is the on-screen layout width a manual
 * DPI scale produces; anything under this floor is "risky".
 */
const DPI_MIN_EFFECTIVE_WIDTH = 360;

const DPI_KEY = "wowsp-dpi";

function isDpiScale(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= DPI_MIN && v <= DPI_MAX;
}

/**
 * Persisted manual DPI scale in percent (one of the 25% notches between
 * 100 and 300), or null for Auto — the default, where the page never
 * touches scaling and follows the browser's own zoom untouched. An invalid
 * stored value (garbage, out-of-range — e.g. left behind by a schema
 * change) HEALS onto Auto by removing the key: Auto is represented by the
 * key's absence, and clearing it makes the correction stick instead of
 * re-defaulting on every boot.
 */
export function loadDpiScale(): number | null {
  try {
    const raw = localStorage.getItem(DPI_KEY);
    if (raw == null) return null;
    const v = Number(raw);
    if (isDpiScale(v)) return v;
    localStorage.removeItem(DPI_KEY);
    return null;
  } catch {
    return null;
  }
}

export function saveDpiScale(pct: number | null): void {
  if (pct == null) localStorage.removeItem(DPI_KEY);
  else localStorage.setItem(DPI_KEY, String(pct));
}

/**
 * Apply the DPI preference through the browser's own zoom mechanism: the
 * standardized CSS `zoom` on the root element scales layout, fonts and hit
 * targets together exactly like native browser zoom — no font-size or rem
 * hacks that drift out of sync with the layout. Auto (null) clears the
 * override so the browser zoom behaves as the browser intends.
 */
export function applyDpiPrefs(): void {
  const el = document.documentElement;
  const pct = loadDpiScale();
  if (pct == null) {
    delete el.dataset.dpiScale;
    el.style.removeProperty("zoom");
  } else {
    el.dataset.dpiScale = String(pct);
    el.style.setProperty("zoom", String(pct / 100));
  }
}

/**
 * A manual scale is risky when the layout width it produces falls under
 * the usable floor — on a narrow window that means the UI can become
 * inoperable with no way back, so such values get an explicit revert
 * path (preview countdown / boot & resize rollback) instead of applying
 * blindly.
 */
export function isDpiRisky(pct: number, viewportWidth: number): boolean {
  if (!Number.isFinite(pct) || pct <= 0) return false;
  return viewportWidth / (pct / 100) < DPI_MIN_EFFECTIVE_WIDTH;
}

/** Like applyDpiPrefs but with an explicit pct, without persisting. */
function applyScaleVisually(pct: number): void {
  const el = document.documentElement;
  el.dataset.dpiScale = String(pct);
  el.style.setProperty("zoom", String(pct / 100));
}

// ── the applied root zoom (for canvas hosts) ─────────────────────────────
// A canvas whose backing store is sized from getBoundingClientRect — which
// answers AFTER the root's `zoom` — has to know the scale the root is
// drawn at, because the CSS size it measures is already zoom-enlarged
// while the WebGL pixel ratio must compensate for it or the ship stage
// renders blurry. The DPI preference is previewed live from the settings
// modal (`previewDpiScale`), so the value is watched rather than read once
// at boot: the same element the scale is written on is observed for the
// attribute and style changes.

/** Scale the document root is drawn at, `1` while DPI is Auto. */
let appliedDpiScaleRef: Ref<number> | null = null;
let appliedDpiObserver: MutationObserver | null = null;

function readAppliedDpiScale(): number {
  if (typeof document === "undefined") return 1;
  const el = document.documentElement;
  const notch = Number(el.dataset.dpiScale);
  if (Number.isFinite(notch) && notch > 0) return notch / 100;
  const inline = Number.parseFloat(el.style.getPropertyValue("zoom"));
  return Number.isFinite(inline) && inline > 0 ? inline : 1;
}

/**
 * The scale the document root is currently drawn at, reactive (`1` while DPI
 * is Auto). Consumers that size a backing store from measured CSS pixels —
 * the ship stage and holographic map renderers' pixel ratio — scale their
 * contract by it; everything else can ignore it.
 */
export function useAppliedDpiScale(): Ref<number> {
  if (appliedDpiScaleRef) return appliedDpiScaleRef;
  const scale = ref(readAppliedDpiScale());
  appliedDpiScaleRef = scale;
  if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
    // App-lifetime observer on purpose: the scale belongs to the document,
    // not to whichever component happened to ask first.
    appliedDpiObserver = new MutationObserver(() => {
      const next = readAppliedDpiScale();
      if (next !== scale.value) scale.value = next;
    });
    appliedDpiObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "data-dpi-scale"],
    });
  }
  return scale;
}

/** Test hook: disconnect the singleton's observer and drop it, so the next
 *  call reads the DOM afresh instead of stacking another observer. */
export function resetAppliedDpiScaleForTest(): void {
  appliedDpiObserver?.disconnect();
  appliedDpiObserver = null;
  appliedDpiScaleRef = null;
}

// ── preview controller (app-level countdown task) ────────────────────────
// The countdown is an APP-LEVEL task, deliberately not owned by any
// component: its state lives in this module-level reactive store and its
// single interval runs here, so a preview (and its revert) survives the
// settings modal unmounting and stays cancellable from anywhere. UIs (the
// confirm modal) are pure views over `useDpiCountdown()`.

export interface DpiCountdownState {
  /** Whether a preview countdown is currently running. */
  active: boolean;
  /** Whole seconds left before the auto-revert fires. */
  remaining: number;
  /** The scale currently previewed (visually applied, not persisted). */
  scale: number | null;
}

// Created lazily (first use) so importing this module stays side-effect
// free and SSR-safe — no reactive graph and no timers at import time.
let dpiCountdownState: DpiCountdownState | null = null;

function countdownState(): DpiCountdownState {
  if (dpiCountdownState == null) {
    dpiCountdownState = reactive({ active: false, remaining: 0, scale: null });
  }
  return dpiCountdownState;
}

/** Readonly reactive view of the countdown store for UIs. */
export function useDpiCountdown(): Readonly<DpiCountdownState> {
  return readonly(countdownState());
}

let previewedScale: number | null = null;
let countdownInterval: ReturnType<typeof setInterval> | null = null;

function stopCountdownTask(): void {
  if (countdownInterval != null) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  if (dpiCountdownState != null) {
    dpiCountdownState.active = false;
    dpiCountdownState.remaining = 0;
    dpiCountdownState.scale = null;
  }
}

function startCountdownTask(): void {
  stopCountdownTask();
  const state = countdownState();
  state.active = true;
  state.remaining = DPI_REVERT_SECONDS;
  state.scale = previewedScale;
  countdownInterval = setInterval(() => {
    const s = countdownState();
    s.remaining = Math.max(0, s.remaining - 1);
    if (s.remaining <= 0) {
      // The safety net expired with no answer: the controller itself
      // reverts to the persisted value and resets the store.
      revertPreviewDpiScale();
    }
  }, 1000);
}

/**
 * Apply a scale visually WITHOUT persisting it. Every preview starts the
 * app-level countdown task: after DPI_REVERT_SECONDS with no user answer
 * the persisted value is re-applied — the timeout is the safety net that
 * guarantees the UI can never be trapped on an unconfirmed scale.
 */
export function previewDpiScale(pct: number): void {
  if (typeof window === "undefined") return;
  previewedScale = pct;
  applyScaleVisually(pct);
  startCountdownTask();
}

/** Persist the currently previewed pct and cancel the countdown task. */
export function keepDpiScale(): void {
  stopCountdownTask();
  const pct = previewedScale;
  previewedScale = null;
  if (pct != null) saveDpiScale(pct);
}

/**
 * Cancel the preview/countdown and re-apply the PERSISTED value — the
 * escape hatch that always leads back to a working UI.
 */
export function revertPreviewDpiScale(): void {
  stopCountdownTask();
  previewedScale = null;
  applyDpiPrefs();
}

/**
 * Hard reset to Auto: clears the persisted scale AND any live preview.
 * This is the guaranteed way back that does not depend on any popup UI
 * being reachable — at a huge scale the very settings modal that hosts the
 * DPI control may be the thing that is broken, so the reset must work
 * with the interface at its worst.
 */
export function resetDpiScale(): void {
  saveDpiScale(null);
  revertPreviewDpiScale();
}

/** Query/hash values accepted by the boot reset escape hatch. */
const DPI_RESET_TOKENS = new Set(["auto", "reset", "default", "100"]);

/**
 * Whether the current URL asks for a boot-time scale reset (`?dpi=auto`,
 * `#dpi=reset`, …). The complement of the keyboard hatch: works when the
 * keyboard is impractical (remote desktop, kiosk shells) or the shortcut
 * is forgotten — the address bar is always there even when the UI is
 * unusable, and the clear PERSISTS so one reset is enough.
 */
function bootResetRequested(): boolean {
  if (typeof window === "undefined") return false;
  const hash = window.location.hash.startsWith("#dpi=")
    ? window.location.hash.slice("#dpi=".length)
    : null;
  const query = new URLSearchParams(window.location.search).get("dpi");
  return [hash, query].some(
    (v) => v != null && DPI_RESET_TOKENS.has(v.trim().toLowerCase()),
  );
}

/** The scale currently previewed (visually applied, not persisted), if any. */
export function getPreviewedDpiScale(): number | null {
  return previewedScale;
}

export function isDpiCountdownActive(): boolean {
  return countdownInterval != null;
}

/** Milliseconds left on the active revert countdown (0 when none). */
export function getDpiCountdownRemainingMs(): number {
  const state = dpiCountdownState;
  if (state == null || !state.active) return 0;
  return state.remaining * 1000;
}

/** Whole seconds left on the active revert countdown (0 when none). */
export function getDpiCountdownRemaining(): number {
  return Math.ceil(getDpiCountdownRemainingMs() / 1000);
}

// Runtime rollback state: a manual (persisted, not previewed) scale that
// turns risky after a resize downgrades to Auto instead of trapping the
// user. Debounced so a drag-resize doesn't flap the zoom.
let resizeListener: (() => void) | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
// The always-on keyboard escape hatch (Ctrl/Cmd+Alt+0) — registered once
// with the resize listener and torn down with it.
let keyListener: ((e: KeyboardEvent) => void) | null = null;

/**
 * Boot-time rollback: a persisted manual scale that is risky for the
 * CURRENT viewport (small window vs large one, resize between sessions)
 * is cleared to Auto before first paint, so a value saved on a large
 * screen can never brick the UI on a small one. A `?dpi=auto` /
 * `#dpi=auto` URL hatch clears the persisted scale unconditionally —
 * the way back that works even when every popup is unreachable.
 */
export function initDpiPrefs(): void {
  if (bootResetRequested()) saveDpiScale(null);
  const persisted = loadDpiScale();
  if (typeof window !== "undefined" && persisted != null && isDpiRisky(persisted, window.innerWidth)) {
    saveDpiScale(null);
  }
  applyDpiPrefs();

  if (typeof window === "undefined" || resizeListener != null) return;
  resizeListener = () => {
    if (resizeTimer != null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (previewedScale != null || countdownInterval != null) return; // preview manages its own revert
      const applied = loadDpiScale();
      if (applied != null && isDpiRisky(applied, window.innerWidth)) {
        saveDpiScale(null);
        applyDpiPrefs();
      }
    }, 300);
  };
  window.addEventListener("resize", resizeListener);
  // Ctrl/Cmd+Alt+0 anywhere → instant reset to Auto. Capture-phase so a
  // buried or fully zoomed-beyond-usable UI still gets it; the combo has
  // no native browser binding to shadow. This is the "way back" that
  // never depends on the settings modal / DPI control being reachable.
  if (keyListener == null) {
    keyListener = (e: KeyboardEvent) => {
      if (e.key !== "0") return;
      if (!e.altKey || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      resetDpiScale();
    };
    window.addEventListener("keydown", keyListener, true);
  }
}

/** Test-only teardown: removes the resize listener and cancels timers. */
export function shutdownDpiPrefs(): void {
  stopCountdownTask();
  previewedScale = null;
  if (resizeTimer != null) {
    clearTimeout(resizeTimer);
    resizeTimer = null;
  }
  if (typeof window === "undefined") return;
  if (resizeListener != null) {
    window.removeEventListener("resize", resizeListener);
    resizeListener = null;
  }
  if (keyListener != null) {
    window.removeEventListener("keydown", keyListener, true);
    keyListener = null;
  }
}
