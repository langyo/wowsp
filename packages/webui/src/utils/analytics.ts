/**
 * Google Analytics for the Tauri desktop shell, via the dedicated app web
 * stream (G-BGD43VPDEJ — separate from the website's G-83S2Y2V9DE).
 *
 * gtag.js normally keys reports off the page's hostname, which inside Tauri
 * is the opaque webview origin (`tauri://localhost` / `http://tauri.localhost`)
 * and lands as noise in GA. GA does not verify that page_location resolves,
 * so we present every hit under the canonical virtual host
 * `https://app.wowsp.langyo.xyz` — a label that need not actually resolve —
 * which keeps the app stream's reports grouped under one readable domain and
 * distinct from the website stream.
 *
 * The loader is injected at runtime (not via index.html) so it only ever runs
 * in the Tauri shell with a release build; dev sessions and the plain-browser
 * mock mode stay analytics-free. CSP in tauri.conf.json must allow
 * googletagmanager.com (script/connect) and google-analytics.com (collect).
 */

const APP_MEASUREMENT_ID = "G-BGD43VPDEJ";

/** Virtual canonical origin every app hit is reported under. */
const APP_PAGE_ORIGIN = "https://app.wowsp.langyo.xyz";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export function initAnalytics(): void {
  if (typeof window === "undefined") return;
  if (!("__TAURI_INTERNALS__" in window)) return;
  if (import.meta.env.DEV) return;

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag(...args: unknown[]) {
    window.dataLayer!.push(args);
  };
  window.gtag("js", new Date());
  window.gtag("config", APP_MEASUREMENT_ID, {
    // Anchor every hit on the virtual host so GA reports group by path
    // instead of the opaque tauri://localhost origin.
    page_location: `${APP_PAGE_ORIGIN}${window.location.pathname}`,
  });

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${APP_MEASUREMENT_ID}`;
  document.head.appendChild(script);
}

/** Report a client-side route change as a page_view on the virtual host. */
export function trackPageView(title: string, path: string): void {
  window.gtag?.("event", "page_view", {
    page_title: title,
    page_path: path,
    page_location: `${APP_PAGE_ORIGIN}${path}`,
  });
}
