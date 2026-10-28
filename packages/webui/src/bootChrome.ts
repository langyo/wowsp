import { bootChromePlugin } from "@celestia-island/hikari/plugins/boot-chrome";
import type { Plugin } from "vite";

/**
 * hikari's pre-boot window chrome bar, wired for WoWSP's multi-window shell.
 *
 * WHY THIS MODULE EXISTS (rather than inline options in `vite.config.ts`):
 * `WEBUI_PAGES` below is the single list of HTML entries this package builds,
 * and `vite.config.ts` derives BOTH `build.rollupOptions.input` and the
 * boot-chrome plugin list from it. Keeping the table here lets
 * `src/bootChrome.test.ts` (a) catch a new page that was added to the package
 * but never classified as app window / overlay, (b) exercise the bar against
 * the really-installed hikari plugin, and (c) assert — with a source-level
 * guard — that `vite.config.ts` actually consumes this list instead of a stale
 * copy.
 *
 * The bar itself is hikari's `res/boot-chrome.js`: it draws minimize /
 * maximize / close before this bundle exists, then removes itself as soon as
 * `AppTitleBar` (which wraps hikari's `HkTitleBar`) mounts and claims the
 * window with `hk:chrome-claim` — no WoWSP component change needed.
 *
 * The plugin deliberately warns once per skipped entry; on this repository that
 * is EXPECTED output (four pages are skipped on purpose), not a misconfig.
 */

/** One HTML entry this package builds. */
export interface WebuiPage {
  /** Key in `rollupOptions.input` (the emitted entry chunk's name). */
  entry: string;
  /** The HTML file, next to the package root. */
  html: string;
  /**
   * Is this a real app window — the only kind the pre-boot bar may be
   * injected into? `false` = a transparent, click-through window the Rust side
   * positions over the game: a caption bar painted inside one of those is a
   * 32 px strip floating over the game.
   */
  bootChrome: boolean;
}

/**
 * Every page `rollupOptions.input` builds, and whether it is an app window.
 *
 * ADDING A PAGE IS A CONSCIOUS DECISION: `bootChrome` is a required field, so
 * a new entry cannot land without answering "does this window get the caption
 * bar?". `src/bootChrome.test.ts` fails if a package HTML file is missing from
 * this table, or if a page is reclassified without updating the expectation.
 */
export const WEBUI_PAGES = [
  { entry: "main", html: "index.html", bootChrome: true },
  { entry: "overlay", html: "overlay.html", bootChrome: false },
  { entry: "aimcard", html: "aimcard.html", bootChrome: false },
  { entry: "chat", html: "chat.html", bootChrome: false },
  { entry: "tray", html: "tray.html", bootChrome: false },
] as const satisfies readonly WebuiPage[];

/**
 * The entries the bar is injected into — derived from `WEBUI_PAGES`, never a
 * hand-maintained copy. ONLY the main shell is an app window.
 */
export const BOOT_CHROME_HTML_FILES: string[] = WEBUI_PAGES.filter(
  (page) => page.bootChrome,
).map((page) => page.html);

/** The plugin instance for `vite.config.ts`. */
export function wowspBootChrome(): Plugin {
  return bootChromePlugin({
    title: "WoWSP",
    // Only the app windows from the table above. Listing a transparent overlay
    // here puts a caption bar inside that window, so a new page must be a
    // conscious decision.
    htmlFiles: [...BOOT_CHROME_HTML_FILES],
  });
}

/**
 * The boot-chrome plugins for one build — EMPTY on the Android bundle.
 *
 * `WOWSP_MOBILE_BUNDLE=1` builds the APK, which runs inside a phone shell that
 * owns its own window: tao's Android minimize/maximize are no-ops, and the
 * phone UI hides the caption buttons (`AppTitleBar` drops them when
 * `isMobileApp()`), so injecting the desktop three-button bar there would paint
 * DEAD controls over the app from the first frame. Desktop keeps the bar before
 * the bundle exists — that is the whole point of the plugin.
 */
export function bootChromePluginsFor(mobileBundle: boolean): Plugin[] {
  return mobileBundle ? [] : [wowspBootChrome()];
}
