/**
 * Global tooltip context (module-level singleton, mirrors the popup manager).
 * A custom v-tooltip directive + a TooltipHost component replace the native
 * title-attribute tooltip with a styled, arrowed, viewport-aware one.
 *
 * Positioning is anchor-based (relative to the hovered element), not mouse
 * position: the host measures its own size and flips / clamps so the tooltip
 * never overflows the window edge.
 */
import { readonly, ref } from "vue";

export interface TooltipState {
  visible: boolean;
  content: string;
  /** The hovered element's rect, captured on show. */
  anchor: DOMRect | null;
}

const state = ref<TooltipState>({ visible: false, content: "", anchor: null });
let hideTimer: number | null = null;

function show(content: string, target: HTMLElement) {
  if (!content) return;
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  state.value = {
    visible: true,
    content,
    anchor: target.getBoundingClientRect(),
  };
}

function hide() {
  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    state.value.visible = false;
    state.value.anchor = null;
  }, 80);
}

export function useTooltip() {
  return {
    state: readonly(state),
    show,
    hide,
  };
}

/**
 * v-tooltip directive. Value is the tooltip text; when omitted, the element's
 * native title attribute is used instead (and suppressed so only the custom
 * tooltip appears).
 */
export const vTooltip = {
  mounted(el: HTMLElement, binding: { value?: unknown }) {
    let active = false;
    const resolve = (): string =>
      typeof binding.value === "string"
        ? binding.value
        : (el.getAttribute("title") ?? "");

    function onEnter() {
      const content = resolve();
      if (!content) return;
      active = true;
      if (el.hasAttribute("title")) {
        el.setAttribute("data-tooltip-title", el.getAttribute("title") ?? "");
        el.removeAttribute("title");
      }
      show(content, el);
    }

    function onLeave() {
      if (!active) return;
      active = false;
      hide();
      const orig = el.getAttribute("data-tooltip-title");
      if (orig !== null) {
        el.setAttribute("title", orig);
        el.removeAttribute("data-tooltip-title");
      }
    }

    el.addEventListener("mouseenter", onEnter);
    el.addEventListener("mouseleave", onLeave);
  },
};
