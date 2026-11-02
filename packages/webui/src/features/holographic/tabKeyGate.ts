/**
 * Tab gate for the holographic map's hold-to-show roster.
 *
 * The replay view reveals its Tab scoreboard on Tab (in-game muscle
 * memory; the same component also serves the always-on-top overlay
 * window), so while the map is mounted the browser's own focus traversal
 * must NOT also run on Tab: every repeat would walk the app's focus ring
 * one control further, dragging focus down the sidebar under the held
 * overlay. The map therefore claims Tab, with exactly one escape hatch.
 *
 * That escape hatch is a TEXT-ENTRY target: typing surfaces keep native
 * Tab (move to the next field, accept an inline completion). Buttons,
 * links, selects and every other focusable chrome deliberately do NOT
 * bail out — claiming their Tab is the whole point of the hold.
 */

/** Input types that are click-like controls, not typing surfaces. Every
 *  other type (text/search/email/url/tel/password/number/date/…) counts
 *  as text entry and keeps native Tab. */
const CLICK_LIKE_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** True when `el` (or its nearest matching ancestor) is a typing surface:
 *  a text-like input, a textarea, or a contenteditable host. */
function isTextEntry(el: Element): boolean {
  const field = el.closest("input, textarea, [contenteditable]");
  if (!field) return false;
  if (field instanceof HTMLInputElement) {
    return !CLICK_LIKE_INPUT_TYPES.has(field.type.toLowerCase());
  }
  if (field instanceof HTMLTextAreaElement) return true;
  // Contenteditable: the ATTRIBUTE decides. "false" (and a missing one,
  // unreachable through closest) leaves Tab to the map; jsdom does not
  // implement `isContentEditable`, so read the attribute instead.
  const attr = field.getAttribute("contenteditable");
  return attr != null && attr.toLowerCase() !== "false";
}

/**
 * True when the map may claim the Tab key: every target except a
 * text-entry element. Non-Element targets (window/document) can never be
 * a typing surface, so they claim too.
 */
export function shouldReserveTabKey(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return !isTextEntry(target);
}
