/**
 * optionStrip — the shared one-line pannable option track used by the
 * 水表 filter bar's nation popup (ShipFilterBar) and by every
 * FilterCategoryChip popup (replay rail, ship picker). The track is a
 * hikari HkScrollContainer (axis horizontal + fade), so the library
 * already owns the scrolling viewport, the edge fades (it senses
 * data-h-overflow and paints the masks itself) and its own wheel
 * translation rule. This module owns only what hikari does not:
 *
 *   - the wheel normalization: a real horizontal delta wins, a vertical
 *     notch is translated onto the strip and Firefox line mode is
 *     normalized to pixels (hikari's own rule adds the raw delta, so the
 *     normalized pan runs ahead of it — capture phase on the container
 *     root, and a consumed event never reaches the library's viewport
 *     rule);
 *   - the mouse drag-pan (pointer capture + the 5px click/pan threshold;
 *     the click a pan leaves behind is swallowed exactly once, so panning
 *     never selects an option).
 *
 * The host binds `attach` as the template ref on the HkScrollContainer
 * itself: the component's exposed handle resolves the scrolling viewport,
 * and the container root (the strip class, the grab cursor, data-panning)
 * is that viewport's parent. The composable only wires listeners while
 * the container is mounted.
 */
import { onBeforeUnmount, ref, watch, type Ref } from "vue";

import { useAppliedDpiScale } from "@/theme/dpiPrefs";

/** Firefox line-height wheel mode (deltaMode 1): one notch reports ~3
 *  lines, not pixels — normalized here so a notch pans a wheel-like
 *  distance on every engine (40px/line, the classic WebKit line height).
 *  Page mode (deltaMode 2, effectively extinct) passes through raw. */
export const WHEEL_LINE_PX = 40;

/** Horizontal pan distance for a wheel gesture over the strip: a real
 *  horizontal wheel/trackpad swipe (deltaX — shift+wheel reports as
 *  deltaX natively too) wins; a plain vertical wheel notch is translated
 *  onto the horizontal axis instead. */
export function stripWheelDelta(deltaMode: number, deltaX: number, deltaY: number): number {
  const raw = deltaX !== 0 ? deltaX : deltaY;
  return deltaMode === 1 ? raw * WHEEL_LINE_PX : raw;
}

/** Press→pan decision for the strip drag: once the pointer strays
 *  ≥ threshold px on EITHER axis the press turns into a pan; below it the
 *  gesture stays a click (and clicks must keep selecting options). */
export function panEngaged(dx: number, dy: number, threshold: number): boolean {
  return Math.abs(dx) >= threshold || Math.abs(dy) >= threshold;
}

/** Wire one strip container with the pan machinery. The host binds
 *  `attach` (template ref on the HkScrollContainer) and mirrors `panning`
 *  into data-panning; every listener — the drag-pan's pointerdown, the
 *  non-passive wheel rule and the capture-phase click swallow — rides the
 *  attach transitions here (a JSX onWheel prop is passive in some paths
 *  and could not preventDefault, and JSX has no capture-phase click
 *  prop; a component host's typed props take no native listener
 *  fallthrough either). */
export function useOptionStrip() {
  /** The container ROOT — the element the strip class, the grab cursor
   *  and data-panning live on, and the pointer surface for the drag. */
  const stripEl: Ref<HTMLElement | null> = ref(null);
  /** The real scroller: hikari's viewport inside the container root. */
  let viewportEl: HTMLElement | null = null;
  const panning = ref(false);
  // The root DPI zoom the drag-pan converts against — see onPointerMove
  // (`1` while the interface-scale preference is Auto).
  const dpiScale = useAppliedDpiScale();
  const PAN_THRESHOLD = 5;
  let pressX = 0;
  let pressY = 0;
  let lastX = 0;
  let armed = false;
  /** Set when a gesture turned into a pan: the trailing click (and only
   *  that one) must not select an option. */
  let dragged = false;

  /** Bind as the template ref on the HkScrollContainer rendering the
   *  strip. The ref value is the component's exposed handle; its
   *  getScrollElement() is the scrolling viewport, and that viewport's
   *  parent is the container root. */
  function attach(target: unknown) {
    if (target == null) {
      viewportEl = null;
      stripEl.value = null;
      return;
    }
    const handle = target as { getScrollElement?: () => HTMLElement | undefined };
    const vp = handle.getScrollElement?.() ?? null;
    viewportEl = vp;
    stripEl.value = vp?.parentElement ?? null;
  }

  function onWheel(e: WheelEvent) {
    const el = viewportEl;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const delta = stripWheelDelta(e.deltaMode, e.deltaX, e.deltaY);
    if (delta === 0) return;
    const prev = el.scrollLeft;
    el.scrollLeft += delta;
    // Consumed here: this listener rides the container root's capture
    // phase, ahead of hikari's own viewport wheel rule — stop the descent
    // so the library never adds its raw (unnormalized) delta on top. A
    // saturated edge lets the wheel keep scrolling the page behind.
    if (el.scrollLeft !== prev) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onPointerDown(e: PointerEvent) {
    if (e.pointerType !== "mouse" || e.button !== 0 || !viewportEl) return;
    // A pan released off-strip leaves no click behind; clear the stale
    // swallow flag so this press's own click always lands (chip rule).
    dragged = false;
    pressX = lastX = e.clientX;
    pressY = e.clientY;
    armed = false;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("pointercancel", onPointerCancel, { once: true });
  }

  function onPointerMove(e: PointerEvent) {
    if (!armed) {
      if (!panEngaged(e.clientX - pressX, e.clientY - pressY, PAN_THRESHOLD)) return;
      // Engage: capture the pointer so the pan keeps tracking off-panel,
      // flag the strip (grabbing cursor + selection off) and arm the
      // one-shot click swallow — with capture held, the trailing click
      // retargets to the strip anyway, never onto an option.
      armed = true;
      panning.value = true;
      dragged = true;
      stripEl.value?.setPointerCapture(e.pointerId);
    }
    e.preventDefault();
    const el = viewportEl;
    if (!el) return;
    // The pointer delta is visual px while scrollLeft is the strip's
    // zoomed local space — divide by the applied scale or the pan runs
    // scale× faster than the pointer under a manual interface scale (the
    // hint family's zoom notes).
    el.scrollLeft -= (e.clientX - lastX) / dpiScale.value;
    lastX = e.clientX;
  }

  function teardownPress() {
    armed = false;
    panning.value = false;
    window.removeEventListener("pointermove", onPointerMove);
  }

  function onPointerUp() {
    teardownPress();
  }

  function onPointerCancel() {
    // A cancelled gesture never leaves a click — no swallow to hold.
    dragged = false;
    teardownPress();
  }

  /** The click a completed pan leaves behind must never select an
   *  option: swallowed exactly once, capture phase (ahead of every
   *  option handler). Plain clicks pass untouched. */
  function onClickCapture(e: MouseEvent) {
    if (!dragged) return;
    dragged = false;
    e.stopPropagation();
  }

  /** A host popup that closed before the pan's trailing click (window
   *  blur mid-drag — pointerup lost) must not carry the swallow flag
   *  into the reopened panel. */
  function resetDragged() {
    dragged = false;
  }

  watch(stripEl, (el, prev) => {
    prev?.removeEventListener("pointerdown", onPointerDown);
    prev?.removeEventListener("wheel", onWheel, true);
    prev?.removeEventListener("click", onClickCapture, true);
    if (el) {
      el.addEventListener("pointerdown", onPointerDown);
      el.addEventListener("wheel", onWheel, { capture: true, passive: false });
      el.addEventListener("click", onClickCapture, true);
    }
  });
  onBeforeUnmount(() => {
    teardownPress();
    // Full listener teardown (parity with the pre-composable code): a
    // component unmounting mid-pan must not leave listeners behind on the
    // strip element or the window's once-listeners unheld.
    const el = stripEl.value;
    el?.removeEventListener("pointerdown", onPointerDown);
    el?.removeEventListener("wheel", onWheel, true);
    el?.removeEventListener("click", onClickCapture, true);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
  });

  return { attach, panning, resetDragged };
}
