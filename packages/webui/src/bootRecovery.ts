import { bootRecoveryPlugin } from "@celestia-island/hikari/plugins/boot-recovery";

import type { Plugin } from "vite";

/**
 * Pre-boot origin self-heal for the main app window — the WoWSP WIRING.
 *
 * The implementation lives UPSTREAM in hikari since hikari #955 (published in
 * `@celestia-island/hikari` 0.55.249 as the `./plugins/boot-recovery`
 * subpath); this module is the thin host-side config WoWSP keeps in-tree so
 * `vite.config.ts` has one stable import and the host policy stays reviewable
 * in the host repo.
 *
 * WHY IT EXISTS (the 0.6.8 crash-recovery incident): WebView2's renderer died,
 * the shell's crash recovery reloaded the main window and it came back on
 * `http://tauri.localhostundefined/` — an origin that still serves
 * `index.html` (the embedded asset handler ignores the bogus host suffix) but
 * resolves every asset URL and the IPC channel against the wrong origin. The
 * module graph never loads, so the Vue app never mounts and the window sits on
 * the static "WoWSP loading…" placeholder forever. The published plugin
 * injects one classic inline script at the end of `index.html`'s `<head>`
 * (after the charset meta, so the 1024-byte encoding prescan still finds it):
 *
 *   1. ORIGIN HEAL — on a hostname that only starts with the app host, replace
 *      the location with the canonical origin; the window recovers by itself.
 *   2. BOOT WATCHDOG — after the deadline, if `#loading-screen` is still
 *      attached (i.e. `main.ts` never called `__loaderDismiss` after
 *      `app.mount`), replace its contents with a small reload panel. The
 *      reload is user-triggered only — a broken build must never reload-loop.
 *
 * `index.html` is the ONLY WoWSP page it is injected into: it is the only one
 * with the static loading screen; `overlay.html` / `aimcard.html` /
 * `chat.html` / `tray.html` are bare shell-managed windows over the game, and
 * reloading a transparent overlay mid-battle is the wrong recovery. The
 * component defaults already match WoWSP's contract (`#loading-screen`, the
 * `hidden` dismissal class, `injectTo: "head"`), so only the host copy and
 * the entry list need stating here.
 *
 * The generated script is deterministic, ASCII-only and classic (non-module)
 * so the Tauri shell can hash it into the app CSP at compile time — see the
 * published plugin's docs for the full contract.
 */
export function wowspBootRecovery(): Plugin {
  return bootRecoveryPlugin({
    // The report window (report.html) is a second app window: its
    // renderer death needs the same crash-origin heal as the main shell.
    htmlFiles: ["index.html", "report.html"],
    copy: {
      message:
        "WoWSP did not finish loading. The app window may have recovered from a crash; reloading usually fixes it.",
      retry: "Reload",
    },
  });
}
