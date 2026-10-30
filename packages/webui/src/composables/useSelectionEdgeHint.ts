/**
 * Selection edge hint — the app-local twin of hikari's scroll-container
 * `selectionHint` capability (upstream PR in flight at writing, not yet
 * published): a list taller than its viewport hides its SELECTED row as
 * soon as it scrolls out of the visible band, and nothing on screen says
 * which way to scroll for it. This composable senses that state and
 * returns it for the caller to bind as `data-selection-beyond` on a
 * positioned host; the colocated SCSS paints a primary-color gradient at
 * each offending edge (see useSelectionEdgeHint.scss). When the upstream
 * prop ships in a published hikari release, adopters can swap to it and
 * this file retires.
 *
 * Bind the returned state on a POSITIONED NON-SCROLLING host — for a
 * hikari HkScrollContainer that is its root (Vue fallthrough attrs land
 * there; the root is the fixed `position: relative; overflow: hidden`
 * box). Never bind it on the scrolling element itself: pseudo-elements
 * of an `overflow: auto` box live in SCROLLED space and the gradient
 * would scroll away with the content.
 *
 * Presentation knobs: the painter feathers the band's inline ends via
 * `--selection-hint-feather` (default `--space-24`) and sizes the band
 * via `--selection-hint-size`; everything else stays as-is (both vars
 * are consumer-overridable on the host itself — a direct declaration
 * beats an inherited one, so ancestor values never reach the painters;
 * see useSelectionEdgeHint.scss).
 *
 * Semantics (mirroring the upstream contract): a "selected" descendant
 * (the default selector matches hikari's own selection grammar —
 * non-false `aria-current`, `aria-selected="true"`, `.is-active`) that
 * lies FULLY outside the scroller's visible vertical band lights the
 * edge it lies beyond; one that is partially visible lights nothing.
 * Unrendered matches (`display: none` — empty `getClientRects()`) never
 * count. Both rects are read in drawn space, so a scaled/zoomed root
 * applies the same factor to both sides and cancels out.
 *
 * Liveness: the scroller's scroll events, resizes and the mutations
 * that can move a selection (childList/subtree plus the `class`,
 * `aria-current`, `aria-selected` attributes) all funnel into one
 * rAF-coalesced sensing pass. The scroller element is expected to be
 * stable per mount (the HkScrollContainer viewport is); if `getScroller`
 * starts returning a different element anyway, the next pass notices
 * and rebinds the listeners.
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";

import "./useSelectionEdgeHint.scss";

/** Which vertical edge(s) of the viewport currently hide the selection. */
export type SelectionBeyond = "top" | "bottom" | "both" | "none";

/** Default selection grammar, kept in lockstep with hikari's upstream
 *  default: nav rails mark the current entry with `aria-current` (any
 *  non-false value — "true", "page", "step"…), option lists with
 *  `aria-selected="true"`, class-driven surfaces with `.is-active`. */
export const DEFAULT_SELECTION_SELECTOR =
  '[aria-current]:not([aria-current="false"]), [aria-selected="true"], .is-active';

/**
 * Sense which vertical edges of `getScroller()`'s viewport hide the
 * selection. Returns the live state to bind as `data-selection-beyond`
 * (the "none" value is inert — the stylesheet paints nothing for it).
 */
export function useSelectionEdgeHint(
  getScroller: () => HTMLElement | null | undefined,
  selector: string = DEFAULT_SELECTION_SELECTOR,
): Ref<SelectionBeyond> {
  const beyond = ref<SelectionBeyond>("none");

  let boundEl: HTMLElement | null = null;
  let raf = 0;
  let ro: ResizeObserver | null = null;
  let mo: MutationObserver | null = null;

  function schedule(): void {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      sense();
    });
  }

  function sense(): void {
    const el = getScroller();
    if (!el) {
      if (beyond.value !== "none") beyond.value = "none";
      return;
    }
    if (el !== boundEl) rebind(el);
    const band = el.getBoundingClientRect();
    let above = false;
    let below = false;
    for (const row of Array.from(el.querySelectorAll<HTMLElement>(selector))) {
      // A display:none row has no boxes; it must not light the hint.
      if (row.getClientRects().length === 0) continue;
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= band.top) above = true;
      else if (rect.top >= band.bottom) below = true;
    }
    const next: SelectionBeyond = above && below ? "both" : above ? "top" : below ? "bottom" : "none";
    if (next !== beyond.value) beyond.value = next;
  }

  function rebind(el: HTMLElement): void {
    unbind();
    boundEl = el;
    el.addEventListener("scroll", schedule, { passive: true });
    ro = new ResizeObserver(schedule);
    ro.observe(el);
    // The .is-active class hopping between rows fires neither a scroll
    // nor a resize — only a mutation. Same closed attribute set as the
    // upstream observer: the three spellings the grammar matches ride on.
    mo = new MutationObserver(schedule);
    mo.observe(el, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "aria-current", "aria-selected"],
    });
  }

  function unbind(): void {
    boundEl?.removeEventListener("scroll", schedule);
    boundEl = null;
    ro?.disconnect();
    ro = null;
    mo?.disconnect();
    mo = null;
  }

  onMounted(() => sense());
  onBeforeUnmount(() => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    unbind();
  });

  return beyond;
}
