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
 * mock mode stay analytics-free. It also waits for the first-run wizard
 * (`wowsp-onboarding-completed`, set by OnboardingWizard's finish(), which
 * calls initAnalytics() again) and honors the Settings → About opt-out
 * (`wowsp-analytics-disabled`), matching docs/{lang}/license/usage-telemetry.md. CSP in tauri.conf.json must allow
 * googletagmanager.com (script/connect) and google-analytics.com (collect).
 */
import { readonly, ref } from "vue";

const APP_MEASUREMENT_ID = "G-BGD43VPDEJ";

/** Virtual canonical origin every app hit is reported under. */
const APP_PAGE_ORIGIN = "https://app.wowsp.langyo.xyz";

/** Written by OnboardingWizard's finish(); nothing is sent before it. */
const ONBOARDING_COMPLETED_KEY = "wowsp-onboarding-completed";

/** "1" = the user turned telemetry off in Settings → About. */
const DISABLED_KEY = "wowsp-analytics-disabled";

/** gtag.js's documented per-property kill switch (`window['ga-disable-<id>']`). */
const GA_DISABLE_FLAG = `ga-disable-${APP_MEASUREMENT_ID}`;

// Only public feature names belong in telemetry. In particular, /lookup's
// query can carry a player nickname and /replay's query a local file path.
const PAGE_TITLES: Readonly<Record<string, string>> = {
  "/": "dashboard",
  "/playtime": "playtime",
  "/lookup": "lookup",
  "/ships": "ships",
  "/live": "live",
  "/replay": "replay",
  "/tactics": "tactics",
  "/resources": "resources",
  "/settings": "settings",
};

let tagScript: HTMLScriptElement | null = null;
let tagReady = false;
let configured = false;
let lastReportedPath: string | null = null;

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(DISABLED_KEY) !== "1";
  } catch {
    // An unreadable preference might contain an opt-out; do not assume consent.
    return false;
  }
}

const enabled = ref(readEnabled());
/** One preference for both the settings page and modal, including when a
 * storage write fails and the choice can only apply to this session. */
export const analyticsEnabled = readonly(enabled);

/** Reactive getter for callers that do not bind the readonly ref directly. */
export function isAnalyticsEnabled(): boolean {
  return enabled.value;
}

function pageFields(path: string) {
  const pathname = path.split(/[?#]/, 1)[0];
  if (!Object.prototype.hasOwnProperty.call(PAGE_TITLES, pathname)) return null;
  return {
    page_title: PAGE_TITLES[pathname],
    page_path: pathname,
    page_location: `${APP_PAGE_ORIGIN}${pathname}`,
    // Never let gtag fall back to a browser referrer containing a player name.
    page_referrer: "",
  };
}

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
  if (readKey(ONBOARDING_COMPLETED_KEY) === null) return;
  if (!isAnalyticsEnabled()) return;
  (window as unknown as Record<string, unknown>)[GA_DISABLE_FLAG] = false;
  if (tagReady) {
    trackPageView(window.location.pathname);
    return;
  }
  if (tagScript) return;

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    // Use Google's documented command format (an Arguments object).
    window.dataLayer!.push(arguments);
  };

  const script = document.createElement("script");
  tagScript = script;
  script.async = true;
  script.referrerPolicy = "no-referrer";
  script.src = `https://www.googletagmanager.com/gtag/js?id=${APP_MEASUREMENT_ID}`;
  script.onload = () => {
    tagReady = true;
    // Do not queue visits while loading: a later opt-out must not leave old
    // events waiting to be replayed if the user turns telemetry back on.
    // Re-check the gates and report only the current page once the tag is ready.
    initAnalytics();
  };
  script.onerror = () => {
    script.remove();
    tagScript = null;
  };
  document.head.appendChild(script);
}

/** Persist the Settings → About telemetry switch. Turning it off also
 *  raises gtag's kill switch so the running session stops sending at once;
 *  turning it on loads the tag if this session has not yet. */
export function setAnalyticsEnabled(value: boolean): void {
  // Update all mounted settings consumers before attempting persistence.
  enabled.value = value;
  if (!value) lastReportedPath = null;
  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>)[GA_DISABLE_FLAG] = !value;
  }
  try {
    if (value) localStorage.removeItem(DISABLED_KEY);
    else localStorage.setItem(DISABLED_KEY, "1");
  } catch {
    // Unpersistable storage: the session preference above still applies.
  }
  if (value) initAnalytics();
}

/** Report only a known feature route; arbitrary titles, queries, fragments,
 * and unknown paths never enter either the config or event payload. */
export function trackPageView(path: string): void {
  if (!tagReady || !isAnalyticsEnabled()) return;
  const page = pageFields(path);
  if (!page || lastReportedPath === page.page_path) return;
  const update = configured;
  if (!configured) {
    window.gtag?.("js", new Date());
    configured = true;
  }
  window.gtag?.("config", APP_MEASUREMENT_ID, {
    ...page,
    update,
    // Deployment requirement: turn OFF Enhanced Measurement for the app
    // stream in GA Admin. This flag only disables config's implicit hit;
    // GA's history/form/click listeners are controlled by the stream, and
    // can bypass these sanitized app events if enabled remotely.
    // https://developers.google.com/analytics/devguides/collection/ga4/views
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
  window.gtag?.("event", "page_view", page);
  lastReportedPath = page.page_path;
}
