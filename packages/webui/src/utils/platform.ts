/**
 * Platform classification for feature gating — THREE separate concerns:
 *
 * - `isTauri()` — "packaged app shell (desktop OR phone WebView), not a
 *   plain browser tab". Existing mock-mode detection, unchanged semantics.
 * - `isMobileApp()` — "the ANDROID/iOS app build". Gates FEATURES that make
 *   no sense on a phone (local game-process watch, in-game overlay window,
 *   desktop updater, native folder pickers). Must NEVER key off window
 *   width: a narrow desktop window is still the desktop app.
 *
 * Responsive LAYOUT (drawer vs sidebar, bottom sheets vs centered modals)
 * instead keys off the viewport — hikari `useBreakpoint().isMobile` in
 * components, `isPhoneLayout()` where a store needs a width check outside a
 * component setup (useBreakpoint mounts lifecycle listeners). The two axes
 * are independent; do not conflate them.
 */

/** Dev override: `?mobileApp=1` forces the mobile-app gates on in a desktop
 *  browser so the phone build's feature gating is visually testable. The
 *  real signal additionally requires the Tauri shell. */
const FORCE_MOBILE_APP =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("mobileApp") === "1";

function hasTauriInternals(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** True inside any Tauri webview (desktop app or phone app). */
export function isTauri(): boolean {
  return hasTauriInternals();
}

/** Phone-webview UA sniff — iPadOS masquerades as desktop Safari, but the
 *  Tauri shell on phones controls its UA and always carries the platform
 *  token, so the sniff is reliable inside `__TAURI_INTERNALS__`. */
const MOBILE_UA_RE = /\b(Android|iPhone|iPad|iPod)\b/;

/** True only in the phone app build (Tauri + phone UA). */
export function isMobileApp(): boolean {
  if (FORCE_MOBILE_APP) return true;
  if (!hasTauriInternals()) return false;
  return typeof navigator !== "undefined" && MOBILE_UA_RE.test(navigator.userAgent);
}

/** Non-reactive phone-LAYOUT check (viewport < 768px CSS px, the same cut
 *  hikari's useBreakpoint().isMobile uses). For one-shot decisions outside
 *  a component setup — e.g. a store action choosing modal vs route. In
 *  components, prefer `useBreakpoint().isMobile` so layout reacts live. */
export function isPhoneLayout(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    !window.matchMedia("(min-width: 768px)").matches
  );
}
