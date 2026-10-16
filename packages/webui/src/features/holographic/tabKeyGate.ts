/**
 * Focus-traversal gate for the holographic map's Tab handling.
 *
 * The replay view toggles its roster overlay on Tab (in-game muscle
 * memory, intended for the always-on-top overlay window), but the same
 * component also runs inside the normal desktop app where Tab must keep
 * moving focus. This predicate says when the map may reserve Tab for
 * itself: only when the keystroke did NOT land inside an interactive
 * element.
 */

/** Elements that must keep native Tab focus traversal. */
const INTERACTIVE_SELECTOR =
  "input, textarea, select, button, a[href], [contenteditable]";

/**
 * True when the map may claim the Tab key (target is not an interactive
 * element — e.g. plain body/canvas), false when Tab must fall through to
 * the browser's focus traversal.
 */
export function shouldReserveTabKey(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return target.closest(INTERACTIVE_SELECTOR) == null;
}
