/**
 * Global delegated tooltip — one document-level hook that retires every
 * native `title` tooltip in the app in favor of hikari's presentation.
 *
 * Elements opt in with `data-hint="…"` (plain text, pre-localized at the
 * call site); optional `data-hint-pos="top|bottom|left|right"` overrides
 * the default top placement. `data-hint-tags` (JSON array of
 * `{ text, tone: "epic" | "rec" }`, also pre-localized) appends a chip row
 * under the text for ribbon-style qualifiers — the chips are built with
 * DOM APIs only, so anchor-supplied strings never become markup.
 * `data-hint-card` (JSON `HintCard`, pre-localized) replaces the text
 * entirely with a structured hover card — head row (icon / title /
 * badge), optional flagged subtitle and label/value rows — for anchors
 * that present an entity's basic parameters (e.g. the replay list's
 * own-ship tag). Because the hook delegates pointer/focus
 * events, rows rendered long after install (spec tables, filter chips,
 * map HUD buttons…) are covered with no per-component wiring.
 *
 * The popup is deliberately NOT a restyle: it reuses the exact
 * `.hk-tooltip-popup` structure and classes the HkTooltip component
 * teleports (same fade cadence, same dark-mode palette from
 * HkTooltip.scss), and registers with usePopupManager kind "tooltip" so
 * it holds the tooltip z band — above modals/drawers, below toasts.
 * The one deliberate delta over HkTooltip: placement clamps to the
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

/** A label/value line of a structured hint card (see `HintCard`). */
export interface HintCardRow {
  label: string;
  value: string;
}

/** A structured hover card replacing the plain hint text. Every field is
 *  a pre-localized, app-supplied string (same contract as `data-hint`);
 *  the popup renders it with DOM APIs only. */
export interface HintCard {
  title: string;
  /** Head-right qualifier — the tier numeral for ship cards. */
  badge?: string;
  /** Decorative head icon (ship-class art); alt stays empty. */
  iconUrl?: string;
  /** Identity line under the head ("日本 · 战列舰"). */
  subtitle?: string;
  /** Small flag image leading the subtitle line. */
  subtitleFlagUrl?: string;
  /** Parameter rows under an optional hairline divider. */
  rows?: HintCardRow[];
}

/** Shape-validate parsed `data-hint-card` JSON; blank optional fields are
 *  dropped, and a card without a usable title degrades to null. */
export function hintCardFrom(parsed: unknown): HintCard | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.title !== "string" || o.title.trim() === "") return null;
  const card: HintCard = { title: o.title };
  if (typeof o.badge === "string" && o.badge.trim() !== "") card.badge = o.badge;
  if (typeof o.iconUrl === "string" && o.iconUrl.trim() !== "") card.iconUrl = o.iconUrl;
  if (typeof o.subtitle === "string" && o.subtitle.trim() !== "") card.subtitle = o.subtitle;
  if (typeof o.subtitleFlagUrl === "string" && o.subtitleFlagUrl.trim() !== "") {
    card.subtitleFlagUrl = o.subtitleFlagUrl;
  }
  if (Array.isArray(o.rows)) {
    const rows = o.rows.filter(
      (row): row is HintCardRow =>
        typeof row === "object" &&
        row !== null &&
        typeof (row as HintCardRow).label === "string" &&
        (row as HintCardRow).label.trim() !== "" &&
        typeof (row as HintCardRow).value === "string" &&
        (row as HintCardRow).value.trim() !== "",
    );
    if (rows.length > 0) card.rows = rows;
  }
  return card;
}

/** Parse the `data-hint-card` JSON attribute; anything malformed or off-
 *  schema degrades to "no card" (the plain-text path) rather than
 *  breaking the hint. */
function cardFor(el: HTMLElement): HintCard | null {
  const raw = el.dataset.hintCard;
  if (!raw) return null;
  try {
    return hintCardFrom(JSON.parse(raw));
  } catch {
    return null;
  }
}

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

/** Build the card DOM for a validated `HintCard` — DOM APIs only, so
 *  anchor-supplied strings stay text nodes. */
function renderCard(card: HintCard): HTMLElement {
  const root = document.createElement("div");
  root.className = "global-tooltip__card";

  const head = document.createElement("div");
  head.className = "global-tooltip__card-head";
  if (card.iconUrl) {
    const icon = document.createElement("img");
    icon.className = "global-tooltip__card-icon";
    icon.src = card.iconUrl;
    icon.alt = "";
    icon.draggable = false;
    head.appendChild(icon);
  }
  const title = document.createElement("span");
  title.className = "global-tooltip__card-title";
  title.textContent = card.title;
  head.appendChild(title);
  if (card.badge) {
    const badge = document.createElement("span");
    badge.className = "global-tooltip__card-badge";
    badge.textContent = card.badge;
    head.appendChild(badge);
  }
  root.appendChild(head);

  if (card.subtitle) {
    const sub = document.createElement("div");
    sub.className = "global-tooltip__card-sub";
    if (card.subtitleFlagUrl) {
      const flag = document.createElement("img");
      flag.className = "global-tooltip__card-flag";
      flag.src = card.subtitleFlagUrl;
      flag.alt = "";
      flag.draggable = false;
      sub.appendChild(flag);
    }
    const text = document.createElement("span");
    text.textContent = card.subtitle;
    sub.appendChild(text);
    root.appendChild(sub);
  }

  if (card.rows && card.rows.length > 0) {
    const rows = document.createElement("div");
    rows.className = "global-tooltip__card-rows";
    for (const row of card.rows) {
      const line = document.createElement("div");
      line.className = "global-tooltip__card-row";
      const label = document.createElement("span");
      label.className = "global-tooltip__card-row-label";
      label.textContent = row.label;
      const value = document.createElement("span");
      value.className = "global-tooltip__card-row-value";
      value.textContent = row.value;
      line.append(label, value);
      rows.appendChild(line);
    }
    root.appendChild(rows);
  }

  return root;
}

/** Parity with HkTooltip's default hover delay. */
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
    const r = anchor?.getBoundingClientRect();
    if (!anchor || !r || (r.width === 0 && r.height === 0)) {
      // Anchor vanished (v-if swap under a stationary pointer): a zero
      // rect would clamp the popup into the top-left corner.
      hideNow();
      return;
    }
    const card = cardFor(anchor);
    if (card) {
      popup.classList.add("global-tooltip--card");
      content.replaceChildren(renderCard(card));
    } else {
      popup.classList.remove("global-tooltip--card");
      const text = anchor.dataset.hint;
      if (!text) {
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
    const el = target.closest<HTMLElement>("[data-hint], [data-hint-card]");
    return el && (el.dataset.hint || el.dataset.hintCard) ? el : null;
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
