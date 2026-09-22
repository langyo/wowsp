/**
 * Global delegated tooltip — one document-level hook that retires every
 * native `title` tooltip in the app in favor of hikari's presentation.
 *
 * Elements opt in with `data-hint="…"` (plain text, pre-localized at the
 * call site); optional `data-hint-pos="top|bottom|left|right"` overrides
 * the default top placement. `data-hint-tags` (JSON array of
 * `{ text, tone: "epic" | "rec" }`, also pre-localized) appends a chip row
 * under the text for ribbon-style qualifiers — the chips are built with
 * DOM APIs only, so anchor-supplied strings never become markup. Because
 * the hook delegates pointer/focus
 * events, rows rendered long after install (spec tables, filter chips,
 * map HUD buttons…) are covered with no per-component wiring.
 *
 * The popup is deliberately NOT a restyle: it reuses the exact
 * `.hk-tooltip-popup` structure and classes the HTooltip component
 * teleports (same fade cadence, same dark-mode palette from
 * HkTooltip.scss), and registers with usePopupManager kind "tooltip" so
 * it holds the tooltip z band — above modals/drawers, below toasts.
 * The one deliberate delta over HTooltip: placement clamps to the
 * viewport, so hints anchored at screen edges stay readable.
 */
import { usePopupManager } from "@celestia-island/hikari";
import "@celestia-island/hikari/components/HkTooltip.scss";
import "./globalTooltip.scss";

type Placement = "top" | "bottom" | "left" | "right";

/** A ribbon-style qualifier chip rendered under the hint text. Call sites
 *  pass these pre-localized via the `data-hint-tags` JSON attribute. */
export interface HintTag {
  text: string;
  tone: "epic" | "rec";
}

const TAG_TONES: ReadonlySet<string> = new Set(["epic", "rec"]);

/** Parse the `data-hint-tags` JSON attribute; anything malformed or off-
 *  schema degrades to "no chips" rather than breaking the hint. */
function tagsFor(el: HTMLElement): HintTag[] {
  const raw = el.dataset.hintTags;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (tag): tag is HintTag =>
      typeof tag === "object" &&
      tag !== null &&
      typeof (tag as HintTag).text === "string" &&
      (tag as HintTag).text.trim() !== "" &&
      typeof (tag as HintTag).tone === "string" &&
      TAG_TONES.has((tag as HintTag).tone),
  );
}

/** Parity with HTooltip's default hover delay. */
const SHOW_DELAY_MS = 300;
/** ≥ the popup's --hk-pop-in-duration fade (0.2s) before unmounting it. */
const HIDE_FADE_MS = 220;
/** Same anchor gap HkTooltip keeps. */
const ANCHOR_GAP_PX = 8;
/** Viewport clamp margin. */
const EDGE_MARGIN_PX = 8;

let installed = false;

export function installGlobalTooltip(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;

  const popup = document.createElement("div");
  popup.className = "hk-tooltip-popup";
  popup.setAttribute("role", "tooltip");
  const content = document.createElement("div");
  content.className = "hk-tooltip-content";
  popup.appendChild(content);
  popup.style.display = "none";
  document.body.appendChild(popup);

  // One persistent registration holds the tooltip z band for the app's
  // lifetime — same pattern as the long-lived toast stack; band slots
  // derive from LIVE entries only, so this never inflates later popups.
  const handle = usePopupManager().register("tooltip", false);
  popup.style.zIndex = String(handle.zIndex);

  let anchor: HTMLElement | null = null;
  let state: "hidden" | "pending" | "shown" = "hidden";
  let showTimer: number | null = null;
  let hideTimer: number | null = null;
  /** Last pointerdown timestamp — focus shows are suppressed briefly
   *  after a click so the click's own focus gain doesn't re-show the
   *  hint that same click just dismissed. */
  let pointerDownAt = -1e9;

  function clearShowTimer(): void {
    if (showTimer !== null) {
      window.clearTimeout(showTimer);
      showTimer = null;
    }
  }

  function place(): void {
    if (!anchor) return;
    const pos = (anchor.dataset.hintPos || "top") as Placement;
    const r = anchor.getBoundingClientRect();
    const w = popup.offsetWidth;
    const h = popup.offsetHeight;
    let left: number;
    let top: number;
    switch (pos) {
      case "bottom":
        left = r.left + r.width / 2 - w / 2;
        top = r.bottom + ANCHOR_GAP_PX;
        break;
      case "left":
        left = r.left - ANCHOR_GAP_PX - w;
        top = r.top + r.height / 2 - h / 2;
        break;
      case "right":
        left = r.right + ANCHOR_GAP_PX;
        top = r.top + r.height / 2 - h / 2;
        break;
      default:
        left = r.left + r.width / 2 - w / 2;
        top = r.top - ANCHOR_GAP_PX - h;
    }
    left = Math.min(Math.max(left, EDGE_MARGIN_PX), Math.max(window.innerWidth - w - EDGE_MARGIN_PX, EDGE_MARGIN_PX));
    top = Math.min(Math.max(top, EDGE_MARGIN_PX), Math.max(window.innerHeight - h - EDGE_MARGIN_PX, EDGE_MARGIN_PX));
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
  }

  function hideNow(): void {
    clearShowTimer();
    if (state === "hidden") return;
    anchor = null;
    state = "hidden";
    popup.classList.remove("hk-tooltip-visible");
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      hideTimer = null;
      // A newer hint may have taken over during the fade — only then
      // unmount the popup.
      if (state === "hidden") popup.style.display = "none";
    }, HIDE_FADE_MS);
  }

  function fire(): void {
    showTimer = null;
    const text = anchor?.dataset.hint;
    const r = anchor?.getBoundingClientRect();
    if (!anchor || !text || !r || (r.width === 0 && r.height === 0)) {
      // Anchor vanished (v-if swap under a stationary pointer): a zero
      // rect would clamp the popup into the top-left corner.
      hideNow();
      return;
    }
    const tags = tagsFor(anchor);
    if (tags.length === 0) {
      content.textContent = text;
    } else {
      const textEl = document.createElement("div");
      textEl.textContent = text;
      const tagsEl = document.createElement("div");
      tagsEl.className = "global-tooltip__tags";
      for (const tag of tags) {
        const chip = document.createElement("span");
        chip.className = `global-tooltip__tag global-tooltip__tag--${tag.tone}`;
        chip.textContent = tag.text;
        tagsEl.appendChild(chip);
      }
      content.replaceChildren(textEl, tagsEl);
    }
    popup.classList.remove("hk-tooltip-visible");
    popup.style.display = "block";
    place();
    // Flush layout so the fade-in transitions from opacity 0 instead of
    // snapping (display:none → visible skips transitions otherwise).
    void popup.offsetHeight;
    popup.classList.add("hk-tooltip-visible");
    state = "shown";
  }

  function show(target: HTMLElement, delay: number): void {
    if (anchor === target && state !== "hidden") return;
    if (state !== "hidden") hideNow();
    anchor = target;
    state = "pending";
    showTimer = window.setTimeout(fire, delay);
  }

  function anchorFor(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const el = target.closest<HTMLElement>("[data-hint]");
    return el && el.dataset.hint ? el : null;
  }

  document.addEventListener(
    "pointerover",
    (e) => {
      const el = anchorFor(e.target);
      if (el) show(el, SHOW_DELAY_MS);
      else if (state !== "hidden") hideNow();
    },
    true,
  );
  // Clicking an anchor (copy cells, filter chips…) dismisses immediately.
  document.addEventListener(
    "pointerdown",
    () => {
      pointerDownAt = performance.now();
      hideNow();
    },
    true,
  );
  // Keyboard support: focusing an anchor shows its hint without the
  // hover delay, losing focus hides it.
  document.addEventListener("focusin", (e) => {
    if (performance.now() - pointerDownAt < 300) return;
    const el = anchorFor(e.target);
    if (!el) return;
    if (anchor === el && state === "pending" && showTimer !== null) {
      // Focus shouldn't wait out a hover timer that is already running.
      clearShowTimer();
      fire();
    } else {
      show(el, 0);
    }
  });
  document.addEventListener("focusout", () => hideNow());
  // Any scroll re-anchors the popup's fixed position relative to a moved
  // anchor — hiding is cheaper than tracking scroll offsets.
  document.addEventListener("scroll", () => hideNow(), true);
  document.documentElement.addEventListener("pointerleave", () => hideNow());
  window.addEventListener("blur", () => hideNow());
  window.addEventListener("resize", () => {
    if (state === "shown") place();
  });
}
