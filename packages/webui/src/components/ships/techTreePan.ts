/**
 * techTreePan — interaction overrides for the ships view's tech-tree
 * body, whose scroller is a hikari HkScrollContainer (axis both). The
 * library owns the scrolling viewport and the overlay bars; this module
 * owns the two behaviors the in-game-style tree needs beyond hikari's
 * generic both-axis wheel rule:
 *
 *   - the wheel axis rule: a plain wheel notch scrolls the tree
 *     VERTICALLY — hikari's own both-axis hook converts every deltaY into
 *     scrollLeft — while Shift+wheel (which the browser reports as a
 *     native deltaX) and real horizontal trackpad swipes keep hikari's
 *     horizontal translation. Firefox line mode is normalized to pixels,
 *     same recipe as optionStrip's stripWheelDelta;
 *   - the mouse drag-pan: pressing the tree background (anything that is
 *     not a button/link/hint anchor — ship cards, ⓘ badges and the fork
 *     hint keep their own press behavior) and moving pans both axes;
 *     touch keeps the native gestures. hikari's overlay scrollbar is
 *     wired to MOUSEDOWN events, so a pan press on it must back off —
 *     the exclusion below keeps its compatibility mousedown alive.
 *
 * The host binds `attach` as the template ref on the HkScrollContainer
 * (its exposed handle resolves the scrolling viewport; the listeners ride
 * the container root — the viewport's parent — because a JSX onWheel prop
 * is passive in some paths and could not preventDefault, and the capture
 * phase must run ahead of hikari's viewport listener) and mirrors
 * `panning` into data-panning for the cursor/selection swap.
 */
import { onBeforeUnmount, ref, watch, type Ref } from "vue";

import { useAppliedDpiScale } from "@/theme/dpiPrefs";

import { WHEEL_LINE_PX } from "./optionStrip";

export function useTechTreePan() {
  /** The container ROOT — the element the tree-body class, the grab
   *  cursor, data-panning and both listeners live on. */
  const rootEl: Ref<HTMLElement | null> = ref(null);
  /** The real scroller: hikari's viewport inside the container root. */
  let viewportEl: HTMLElement | null = null;
  const panning = ref(false);
  // The root DPI zoom the drag-pan converts against — see onPointerMove
  // (`1` while the interface-scale preference is Auto).
  const dpiScale = useAppliedDpiScale();
  /** Press origin and the scrollport offset it was taken at — the pan
   *  writes absolute values derived from them, so no per-move drift. */
  let pressX = 0;
  let pressY = 0;
  let baseSL = 0;
  let baseST = 0;
  let panId = -1;

  /** Bind as the template ref on the tree body's HkScrollContainer: the
   *  component's exposed handle carries getScrollElement(), and that
   *  viewport's parent is the container root. */
  function attach(target: unknown) {
    viewportEl =
      target == null
        ? null
        : ((target as { getScrollElement?: () => HTMLElement | undefined }).getScrollElement?.() ??
          null);
    rootEl.value = viewportEl?.parentElement ?? null;
  }

  function onWheel(e: WheelEvent) {
    // Horizontal intent stays with hikari's rule: shift+wheel arrives as
    // a native deltaX, and a nonzero deltaX is a real horizontal swipe.
    if (e.shiftKey || e.deltaX !== 0) return;
    const el = viewportEl;
    // Without vertical overflow the plain wheel falls through to
    // hikari's horizontal translation — the only panning a short tree
    // would otherwise get.
    if (!el || el.scrollHeight <= el.clientHeight) return;
    e.preventDefault();
    e.stopPropagation();
    // Consumed at the vertical edges too: falling through there would
    // start an unexpected horizontal nudge mid-scroll.
    el.scrollTop += e.deltaMode === 1 ? e.deltaY * WHEEL_LINE_PX : e.deltaY;
  }

  function onPointerDown(e: PointerEvent) {
    if (e.pointerType !== "mouse" || e.button !== 0 || !viewportEl) return;
    if (!(e.target instanceof Element)) return;
    // Interactive anchors (cards, ⓘ badges, the fork hint, nation
    // buttons) keep their own press behavior, and so does hikari's
    // overlay scrollbar — its thumb/track drag rides mousedown events
    // that a preventDefaulted pointerdown would swallow.
    if (e.target.closest("button, a, [data-hint], [data-hint-card], .hk-scrollbar-track")) return;
    pressX = e.clientX;
    pressY = e.clientY;
    baseSL = viewportEl.scrollLeft;
    baseST = viewportEl.scrollTop;
    panId = e.pointerId;
    e.preventDefault();
    rootEl.value?.setPointerCapture(e.pointerId);
    panning.value = true;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("pointercancel", onPointerCancel, { once: true });
  }

  function onPointerMove(e: PointerEvent) {
    const el = viewportEl;
    if (e.pointerId !== panId || !el) return;
    // The pointer deltas are visual px while scrollLeft/scrollTop are the
    // tree's zoomed local space — divide by the applied scale or the pan
    // runs scale× faster than the pointer under a manual interface scale
    // (the hint family's zoom notes).
    const z = dpiScale.value;
    el.scrollLeft = baseSL - (e.clientX - pressX) / z;
    el.scrollTop = baseST - (e.clientY - pressY) / z;
  }

  function teardownPan() {
    panId = -1;
    panning.value = false;
    window.removeEventListener("pointermove", onPointerMove);
    // Whichever once-listener did not fire this gesture goes too.
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
  }

  function onPointerUp() {
    teardownPan();
  }

  function onPointerCancel() {
    teardownPan();
  }

  watch(rootEl, (el, prev) => {
    prev?.removeEventListener("pointerdown", onPointerDown);
    prev?.removeEventListener("wheel", onWheel, true);
    if (el) {
      el.addEventListener("pointerdown", onPointerDown);
      el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    }
  });

  onBeforeUnmount(() => {
    teardownPan();
    // A component unmounting mid-pan must not leave listeners behind on
    // the container root or the window's once-listeners unheld.
    const el = rootEl.value;
    el?.removeEventListener("pointerdown", onPointerDown);
    el?.removeEventListener("wheel", onWheel, true);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
  });

  return { attach, panning };
}
