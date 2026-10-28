import { bootChromePlugin } from "@celestia-island/hikari/plugins/boot-chrome";

/**
 * hikari's pre-boot window chrome bar, wired for WoWSP's multi-window shell.
 *
 * WHY THIS MODULE EXISTS (rather than inline options in `vite.config.ts`): the
 * entry list is a safety contract, not a preference. WoWSP builds FIVE pages
 * and four of them — `overlay.html`, `aimcard.html`, `chat.html`, `tray.html` —
 * are transparent, click-through windows the Rust side positions over the game
 * (see `rollupOptions.input` in `vite.config.ts`); a caption bar painted inside
 * one of those is a 32 px strip floating over the game. Keeping the list here
 * lets `src/bootChrome.test.ts` check the contract against the really-installed
 * hikari plugin instead of trusting the config by eye.
 *
 * The bar itself is hikari's `res/boot-chrome.js`: it draws minimize /
 * maximize / close before this bundle exists, then removes itself as soon as
 * `AppTitleBar` (which wraps hikari's `HkTitleBar`) mounts and claims the
 * window with `hk:chrome-claim` — no WoWSP component change needed.
 *
 * The plugin deliberately warns once per skipped entry; on this repository that
 * is EXPECTED output (four pages are skipped on purpose), not a misconfig.
 */
export const BOOT_CHROME_HTML_FILES = ["index.html"] as const;

/** The plugin instance for `vite.config.ts`. */
export function wowspBootChrome() {
  return bootChromePlugin({
    title: "WoWSP",
    // ONLY the main shell. Listing a transparent overlay here puts a caption
    // bar inside that window, so a new page must be a conscious decision.
    htmlFiles: [...BOOT_CHROME_HTML_FILES],
  });
}
