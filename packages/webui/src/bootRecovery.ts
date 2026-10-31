import { basename } from "node:path";

import type { Plugin } from "vite";

/**
 * Pre-boot self-recovery for the main app window: heal a corrupted app origin
 * and paint a manual-retry panel when the Vue app never mounts.
 *
 * WHY THIS MODULE EXISTS (the 0.6.8 crash-recovery incident): WebView2's
 * renderer died, the shell's crash recovery reloaded the main window and it
 * came back on `http://tauri.localhostundefined/` — an origin that still
 * serves `index.html` (the embedded asset handler ignores the bogus host
 * suffix) but resolves every asset URL and the IPC channel against the wrong
 * origin. The module graph never loads, so the Vue app never mounts,
 * `main.ts` never calls `__loaderDismiss`, and the window sits on the
 * static "WoWSP loading…" placeholder forever. The user cannot tell a slow boot
 * from a dead one, and the close button cannot even reach the quit loop
 * (nothing mounted to answer the Rust close handshake).
 *
 * The recovery is an INLINE script injected into the main window's `<head>`
 * (after the charset declaration, before any body content; a classic script, so
 * it still runs before the deferred module graph), with two independent halves:
 *
 *   1. ORIGIN HEAL (fast path): on a hostname that only STARTS WITH the app
 *      host, replace the location with the canonical origin + "/". The window
 *      recovers instead of staying broken; no user action needed.
 *
 *   2. BOOT WATCHDOG: on a normal origin, after
 *      `BOOT_RECOVERY_DEADLINE_MS` the script checks whether
 *      `#loading-screen` is still attached. The static loader is only
 *      removed by `__loaderDismiss` (index.html), which `main.ts` calls
 *      right after `app.mount` — so a loader that is still there means
 *      nothing mounted. Its contents are replaced with a minimal failure panel
 *      (message + button) whose button `location.reload()`s the page. The
 *      reload is never automatic: a permanently broken build must not spin in a
 *      reload loop, and a panel the user can read beats a flicker.
 *
 * WHY INLINE AND WHY END-OF-`<head>`:
 *   - Inline: the heal must not depend on a second HTTP request, which could
 *     404 on exactly the corrupted origin it exists to repair.
 *   - `injectTo: "head"` (end of `<head>`), NOT "head-prepend": the HTML
 *     encoding prescan only honours a `<meta charset>` found in the first
 *     1024 bytes, and this module's ~3.6 KB script prepended ahead of the
 *     existing declaration would push it out of that window (Tauri serves
 *     `text/html` with no charset parameter). Vite's "head" injection lands
 *     the tag after the charset meta and still before any body content.
 *   - A CLASSIC (non-module) inline script executes during parsing, while
 *     `type="module"` scripts are deferred until parsing finishes — so the
 *     heal still runs before the app bundle, and it does not need the asset
 *     requests that the corrupted origin breaks anyway.
 *   - The watchdog needs no imports, no i18n, no Pinia, no store: on the broken
 *     path none of those are guaranteed to exist. It is ES2017-safe
 *     `var`/`function` code (no optional chaining, no modules) and every
 *     value it formats is one of this module's constants — nothing is read from
 *     the page/URL beyond `location.protocol` / `location.hostname`, and the
 *     panel is built with DOM APIs + `textContent` (never `innerHTML`), so
 *     there is no injection surface. The generated script is ASCII-only on
 *     purpose: it is byte-hashed into the app CSP (see below).
 *
 * CSP: `tauri.conf.json`'s `security.csp` has no `'unsafe-inline'`, but
 * tauri-codegen SHA-256-hashes every inline script of the embedded HTML into
 * the policy at Rust build time (`dist/webui` must therefore be rebuilt BEFORE
 * the Rust binary, which is the normal CI/justfile order). Keeping this one
 * single inline tag — and never baking page input into it — keeps that hash a
 * constant.
 *
 * INJECTION SCOPE: `index.html` ONLY. It is the only page with the static
 * loading screen and the only one whose origin corruption strands the whole
 * shell; `overlay.html` / `aimcard.html` / `chat.html` / `tray.html`
 * are bare, shell-managed windows over the game — forcing a reload of a
 * transparent overlay mid-battle is precisely the wrong recovery.
 * `src/bootRecovery.test.ts` pins the scope, the script contract and the
 * `vite.config.ts` wiring.
 */

/**
 * The origin the Tauri shell serves the embedded frontend from on Windows and
 * Android. macOS/Linux serve the same assets over the `tauri://` scheme, which
 * `isCorruptedAppOrigin` deliberately never redirects.
 */
export const BOOT_RECOVERY_CANONICAL_ORIGIN = "http://tauri.localhost";

/** Hostname half of `BOOT_RECOVERY_CANONICAL_ORIGIN`. */
const APP_ORIGIN_HOSTNAME = "tauri.localhost";

/**
 * How long the WebView gets to mount the Vue app before the static loading
 * screen is judged dead and replaced with the failure panel.
 *
 * This is a ceiling, not a budget: a healthy cold start mounts in well under a
 * second, and a mount that happens to land just after the deadline only paints
 * the panel for a moment (the app's own `__loaderDismiss` then removes the
 * whole `#loading-screen` it lives in). Long enough that a slow disk or a
 * first model-pack init is not misreported as a failure.
 */
export const BOOT_RECOVERY_DEADLINE_MS = 15_000;

/**
 * CSS for the failure panel, injected as one inline `<style>` next to the
 * panel itself. Only the text/button colours are set here: the panel replaces
 * the CONTENTS of the existing `#loading-screen`, which keeps owning the
 * full-page backdrop from index.html. Both colour schemes mirror that file's
 * palette (dark `#cfe3ff` on `#0b1220`, light `#1e2837` on `#f5f8fc`) so the
 * fallback does not flash a different-looking window when the real theme never
 * loaded either.
 */
const FAILURE_PANEL_CSS = `#loading-screen .wowsp-boot-failure{display:flex;flex-direction:column;align-items:center;gap:1rem;max-width:32rem;padding:1.5rem;text-align:center}
#loading-screen .wowsp-boot-failure__message{margin:0;font-size:.95rem;line-height:1.5;color:#cfe3ff}
#loading-screen .wowsp-boot-failure__retry{font:inherit;font-size:.85rem;padding:.5rem 1.25rem;border:1px solid #cfe3ff;border-radius:6px;background:transparent;color:#cfe3ff;cursor:pointer}
#loading-screen .wowsp-boot-failure__retry:hover{background:rgba(207,227,255,.12)}
@media (prefers-color-scheme:light){#loading-screen .wowsp-boot-failure__message{color:#1e2837}#loading-screen .wowsp-boot-failure__retry{border-color:#1e2837;color:#1e2837}#loading-screen .wowsp-boot-failure__retry:hover{background:rgba(30,40,55,.08)}}`;

/**
 * Does `protocol://hostname` look like the app origin with crash-recovery
 * debris glued onto its hostname?
 *
 * Only the http(s) origins can be corrupted this way: the observed incident
 * produced `tauri.localhostundefined` (the scheme stayed http), and the
 * `tauri://` origins used on macOS/Linux have their own URL space — a
 * `tauri://` URL must never be redirected to an http one. The double check
 * on the hostname (prefix AND inequality) is the whole signal: the canonical
 * host itself is healthy, while any hostname that merely STARTS WITH it is a
 * corrupted variant of it (`tauri.localhostundefined`, `tauri.localhost.`,
 * `tauri.localhostx`). Every other host (dev server, asset/media hosts) is
 * untouched.
 */
export function isCorruptedAppOrigin(protocol: string, hostname: string): boolean {
  if (protocol !== "http:" && protocol !== "https:") return false;
  return hostname.startsWith(APP_ORIGIN_HOSTNAME) && hostname !== APP_ORIGIN_HOSTNAME;
}

/**
 * The whole recovery as one compact, dependency-free inline IIFE — the exact
 * text Vite injects into `index.html`'s `<head>`.
 *
 * No arguments and no page input: the only interpolated values are the
 * constants above (plus `FAILURE_PANEL_CSS`), JSON-escaped. The runtime reads
 * exactly `location.protocol` and `location.hostname` — never the path,
 * query or hash — and writes only constant text through `textContent`, so the
 * script cannot be steered by a crafted URL. It must never throw: every step
 * that can fail at runtime sits in a `try` / `catch`, because the one screen
 * this script replaces is the only feedback a broken boot has left.
 */
export function bootRecoveryScript(): string {
  return `(function () {
  "use strict";
  var CANONICAL_ORIGIN = ${JSON.stringify(BOOT_RECOVERY_CANONICAL_ORIGIN)};
  var DEADLINE_MS = ${BOOT_RECOVERY_DEADLINE_MS};
  var APP_HOSTNAME = ${JSON.stringify(APP_ORIGIN_HOSTNAME)};

  /* Mirror of isCorruptedAppOrigin() in bootRecovery.ts: only http(s) can be
     corrupted, and any app-host prefix that is not the host itself is debris. */
  function isCorrupted(protocol, hostname) {
    if (protocol !== "http:" && protocol !== "https:") return false;
    return hostname.indexOf(APP_HOSTNAME) === 0 && hostname !== APP_HOSTNAME;
  }

  /* Returns true when the navigation was accepted (the caller is about to leave
     this document and must stop), false when it threw before starting. */
  function openCanonical() {
    try {
      location.replace(CANONICAL_ORIGIN + "/");
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---- 1. origin heal: restore the app origin before the app bundle runs -- */
  try {
    if (isCorrupted(location.protocol, location.hostname)) {
      if (openCanonical()) return;
      /* The navigation was refused before it started: fall through to the
         watchdog below so the failure panel (whose button retries this same
         heal) still has a chance to rescue the window. */
    }
  } catch (e) {
    /* No usable location: let the watchdog below describe the failure. */
  }

  /* ---- 2. boot watchdog: mounted means __loaderDismiss removed the loader - */
  setTimeout(function () {
    try {
      var loading = document.getElementById("loading-screen");
      if (!loading) return; /* mounted: __loaderDismiss already removed it */
      /* Dismissed a moment ago and still fading: removal is already in flight,
         so painting a failure panel would flash over a live app. */
      if (loading.classList && loading.classList.contains("hidden")) return;
      showFailure(loading);
    } catch (e) {
      /* Never let the fallback break the last thing the window can show. */
    }
  }, DEADLINE_MS);

  function retry() {
    if (isCorrupted(location.protocol, location.hostname)) {
      openCanonical();
      return;
    }
    location.reload();
  }

  /* Replace the static placeholder's contents. Built from constant strings via
     DOM APIs only: no HTML-string parsing and no page input, so there is
     nothing to escape and nothing to inject. */
  function showFailure(loading) {
    loading.textContent = "";
    var style = document.createElement("style");
    style.textContent = ${JSON.stringify(FAILURE_PANEL_CSS)};
    var box = document.createElement("div");
    box.className = "wowsp-boot-failure";
    box.setAttribute("role", "alert");
    var message = document.createElement("p");
    message.className = "wowsp-boot-failure__message";
    message.textContent = "WoWSP did not finish loading. The app window may have recovered from a crash; reloading usually fixes it.";
    var button = document.createElement("button");
    button.type = "button";
    button.className = "wowsp-boot-failure__retry";
    button.textContent = "Reload WoWSP";
    button.addEventListener("click", retry);
    box.appendChild(message);
    box.appendChild(button);
    loading.appendChild(style);
    loading.appendChild(box);
  }
})();`;
}

/** The only page whose boot the recovery script runs on (see the module doc). */
const BOOT_RECOVERY_HTML_FILE = "index.html";

/**
 * Should the recovery script be injected into this HTML entry?
 *
 * Mirrors `bootChrome.ts`'s matching: the basename or a "/"-suffixed path
 * may match, and an absent filename counts as the main entry (Vite's transform
 * hook always passes one; a programmatic caller gets the main-window treatment
 * rather than silently losing the recovery).
 */
function isMainAppHtml(filename: string | undefined): boolean {
  if (!filename) return true;
  const name = basename(filename);
  return (
    name === BOOT_RECOVERY_HTML_FILE ||
    filename === BOOT_RECOVERY_HTML_FILE ||
    filename.endsWith("/" + BOOT_RECOVERY_HTML_FILE)
  );
}

/**
 * The recovery as a Vite plugin: one inline, classic (non-module) `<script>`
 * in the `<head>` of `index.html` and nothing else.
 *
 * Injected with `injectTo: "head"` (end of `<head>`) rather than
 * "head-prepend": the injection must stay AFTER the document's `<meta charset>`
 * so the encoding prescan (first 1024 bytes) still finds it — see the module
 * docs. The tag is classic rather than `type="module"` because a classic inline
 * script runs during parsing while modules are deferred, so the heal still lands
 * before the app bundle without moving the charset declaration.
 *
 * No `apply: 'build'`: dev serves the same HTML through this hook (the dev
 * server origin is legitimate, so the heal is a no-op there, but the watchdog
 * still reports a dev page that never mounts).
 */
export function wowspBootRecovery(): Plugin {
  return {
    name: "wowsp-boot-recovery",

    transformIndexHtml(_html, ctx) {
      const filename = ctx && typeof ctx.filename === "string" ? ctx.filename : "";
      if (!isMainAppHtml(filename)) return [];
      return [
        {
          tag: "script",
          attrs: { "data-wowsp-boot-recovery": "" },
          children: bootRecoveryScript(),
          injectTo: "head",
        },
      ];
    },
  };
}
