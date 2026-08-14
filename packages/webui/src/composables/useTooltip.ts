/**
 * Global tooltip context (module-level singleton, mirrors the popup manager).
 * A custom v-tooltip directive + a TooltipHost component replace the native
 * title-attribute tooltip with a styled, arrowed, z-index-managed one.
 */
import { readonly, ref } from "vue";

export interface TooltipState {
  visible: boolean;
  content: string;
  x: number;
  y: number;
}

const state = ref<TooltipState>({ visible: false, content: "", x: 0, y: 0 });
let hideTimer: number | null = null;

function show(content: string, target: HTMLElement) {
  if (!content) return;
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  const r = target.getBoundingClientRect();
  state.value = {
    visible: true,
    content,
    x: r.left + r.width / 2,
    y: r.top,
  };
}

function move(x: number, y: number) {
  if (state.value.visible) {
    state.value.x = x;
    state.value.y = y;
  }
}

function hide() {
  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    state.value.visible = false;
  }, 80);
}

export function useTooltip() {
  return {
    state: readonly(state),
    show,
    move,
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

    function onMove(e: MouseEvent) {
      if (active) move(e.clientX, e.clientY);
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
    el.addEventListener("mousemove", onMove);
    el.addEventListener("mouseleave", onLeave);
  },
};
