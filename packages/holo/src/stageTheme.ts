/**
 * stageTheme — the one light/dark data source + refresh logic every 3D
 * renderer follows.
 *
 * Both host apps (desktop webui + marketing site) drive their theme through
 * hikari, which projects the RESOLVED mode onto
 * `<html data-mode="dark|light">` (setMode writes the attribute directly,
 * and its solar/"system" mode re-writes it whenever the daylight clock
 * flips). That attribute is therefore the one authoritative signal a
 * framework-free canvas can watch — no Vue import, no hikari import, and
 * the same truth in both hosts.
 *
 * Every 3D stage reads its mode through this module and subscribes once
 * for refreshes, so a mid-session theme flip reaches every canvas at once:
 *
 *   - desktop ship viewer (webui `ShipStage`) — scene bg + fog, ground
 *     grid, waterline gauge, holographic fill alpha,
 *   - desktop replay map (`useThreeScene` / `mapTerrain` palettes),
 *   - desktop mod-hub model stage (`ModelStage`),
 *   - the site's replay stage (`ReplayLive`) and the shared homepage
 *     turntable (`shipStage`'s holographic fill alpha).
 *
 * This is what the ship viewer lacked: it used to snapshot `dataset.mode`
 * once at scene init, so a mid-session theme flip left a light viewport
 * floating in a dark app (and vice versa) until the next model load. One
 * source, one refresh — all canvases flip together.
 */

/** The resolved stage mode. "system"-style preferences are already folded
 *  into this by the host (hikari writes the resolved value), so a canvas
 *  never sees anything but the two concrete modes. */
export type StageThemeMode = "dark" | "light";

/** Read the CURRENT effective stage mode. Dark is the default of last
 *  resort: with no live attribute (prerender, unit tests, exotic hosts)
 *  the OS color-scheme preference decides, and past that the shipped
 *  dark-first holographic look wins. */
export function readStageThemeMode(): StageThemeMode {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.getAttribute("data-mode");
    if (attr === "dark" || attr === "light") return attr;
  }
  if (typeof matchMedia === "function") {
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "dark";
}

export type StageThemeWatcher = (mode: StageThemeMode) => void;

export interface WatchStageThemeModeOptions {
  /** Fire the watcher with the current mode at subscribe time. Default
   *  true — mirrors the `watch(..., { immediate: true })` idiom the
   *  stages already use; pass false when the caller applies the mode
   *  itself right before subscribing. */
  immediate?: boolean;
}

/** One shared refresh pipeline: a single MutationObserver on the root
 *  `data-mode` attribute (plus an OS-scheme listener for attribute-less
 *  hosts) fans out to every watcher. The observer only exists while at
 *  least one stage is subscribed, and identical writes never re-fire —
 *  hosts that rewrite the same mode (hikari re-applies its preference on
 *  unrelated settings saves) stay silent. */
/** Subscription records — one per watch call, NOT keyed by function, so
 *  the same function subscribing twice gets two independent handles (a
 *  Set<function> would collapse them and let the first unsubscribe tear
 *  down shared observation under the second's feet). */
interface StageThemeSubscription {
  fn: StageThemeWatcher;
}
const subscriptions = new Set<StageThemeSubscription>();
let observer: MutationObserver | null = null;
let mediaQuery: MediaQueryList | null = null;
let onMediaChange: ((this: MediaQueryList, ev: MediaQueryListEvent) => void) | null = null;
/** Last mode handed to watchers — the dedupe + "don't double-fire on
 *  subscribe" guard. Null while nothing is observing. */
let lastNotified: StageThemeMode | null = null;

function notify(): void {
  const mode = readStageThemeMode();
  if (mode === lastNotified) return;
  lastNotified = mode;
  // Snapshot: a watcher may unsubscribe (or subscribe) mid-fanout. Each
  // call is isolated — one consumer throwing must not starve its peers
  // of the flip (a canvas stuck on the old theme is exactly the bug this
  // module exists to kill).
  for (const sub of [...subscriptions]) {
    try {
      sub.fn(mode);
    } catch (e) {
      console.error("[stageTheme] stage theme watcher threw", e);
    }
  }
}

function startWatching(): void {
  if (observer) return;
  // Record the current mode BEFORE anything can fire, so the observer's
  // first callback is a dedupe rather than a duplicate of the initial
  // read the subscriber just did.
  lastNotified = readStageThemeMode();
  if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
    observer = new MutationObserver(notify);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-mode"],
    });
  }
  if (typeof matchMedia === "function") {
    mediaQuery = matchMedia("(prefers-color-scheme: dark)");
    onMediaChange = () => notify();
    mediaQuery.addEventListener("change", onMediaChange);
  }
}

function stopWatching(): void {
  observer?.disconnect();
  observer = null;
  if (mediaQuery && onMediaChange) {
    mediaQuery.removeEventListener("change", onMediaChange);
  }
  mediaQuery = null;
  onMediaChange = null;
  lastNotified = null;
}

/** Subscribe to live stage-theme flips. Returns the unsubscribe handle
 *  (idempotent) — every stage calls it on dispose/unmount so the shared
 *  observer never outlives its last canvas. */
export function watchStageThemeMode(
  watcher: StageThemeWatcher,
  options: WatchStageThemeModeOptions = {},
): () => void {
  const { immediate = true } = options;
  const subscription: StageThemeSubscription = { fn: watcher };
  subscriptions.add(subscription);
  startWatching();
  if (immediate) {
    // Same-mode guard: a subscriber joining mid-session with an unchanged
    // mode must not re-fire the peers (it still gets its own initial call).
    // Unlike the fanout, a THROW here propagates to the subscriber — it is
    // the caller's own callback on its own subscribe.
    const previous = lastNotified;
    watcher(readStageThemeMode());
    lastNotified = previous;
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    subscriptions.delete(subscription);
    if (subscriptions.size === 0) stopWatching();
  };
}
