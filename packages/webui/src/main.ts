import { createApp } from "vue";
import { createPinia } from "pinia";

import App from "./App";
import router from "@/router";
import { i18n, initLocaleMessages } from "@/i18n";
import { uiLocaleReady } from "@/i18n/useLanguage";
import { bootstrap } from "./bootstrap";
import { runStartupMigrations } from "./migrations";
import { initAnalytics, trackPageView } from "@/utils/analytics";
import { reportUiError } from "@/utils/uiError";
import "@/styles/hikari.scss";
import "@/theme/theme.scss";
// Opaque-default surface layer — restates hikari's translucent fills as
// solidity-interpolated fills; must load AFTER the theme tokens it reads.
import "@/theme/surfaces.scss";
import "@/styles/image-asset.scss";
import "virtual:uno.css";

/**
 * WoWSP entry for the MAIN shell window — router-driven, custom title bar.
 * The in-game overlay window does NOT run this app: it loads a pre-rendered
 * static page (`overlay.html`, see src/overlay/main.ts) so it paints
 * instantly with no loading state.
 *
 * bootstrap() runs the shared global hooks (viewport policy, brand themes +
 * hikari theme/font init, deep-link theme forcing, hikari i18n seeding).
 */
// One-time app-version migrations (src/migrations): the gate + ledger live
// in the Rust shell (hifumi scaffold); the delegated WebView bodies run
// here. Fired BEFORE bootstrap() — bodies rewrite stored slots the
// preference modules hydrate at import — while `wowsp-last-run-version`
// still holds the previous run's version (the ledger seed hint), and
// awaited in the mount gate below so a body's visual change never flashes.
const migrationsReady = runStartupMigrations();
bootstrap();
// Google Analytics (Tauri shell + release only, see utils/analytics).
initAnalytics();
// Forward SPA route changes as page_views on the virtual canonical host.
router.afterEach((to) => {
  trackPageView(to.path);
});
const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(i18n);
// One error sink for render/watcher/computed failures: Vue routes them
// here (contained at callWithErrorHandling) and the sink logs to the app
// log and raises a standard toast. Without a handler the failure cascade
// is unbounded (observed 2026-10: a broken watcher froze the shell); the
// app must degrade to one reported broken view, never a silent freeze.
app.config.errorHandler = (err, _instance, info) => {
  const error = err instanceof Error ? err : new Error(String(err));
  reportUiError(`${error.message} (${String(info)})`, error.stack);
};
// Rejected promises and raw window errors outside Vue's scheduler take the
// same path — release builds have no console, the app log and toast are
// the only evidence a user can act on.
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  const error = reason instanceof Error ? reason : new Error(String(reason));
  reportUiError(error.message, error.stack);
});
window.addEventListener("error", (event) => {
  reportUiError(event.message, event.error?.stack);
});
// Gate first paint on the lazy locale bundles: the fallback (en-US), the
// detected initial locale, and the persisted UI locale's messages must all
// be registered before mounting, or the shell renders with vue-i18n's
// warnings / raw keys for a frame. A locale chunk that fails to fetch must
// not brick the shell: mount anyway and let vue-i18n degrade to raw keys.
void Promise.all([
  router.isReady(),
  initLocaleMessages().catch(() => undefined),
  uiLocaleReady.catch(() => undefined),
  migrationsReady,
]).then(() => {
  app.mount("#app");
  if (typeof window.__loaderDismiss === "function") {
    window.__loaderDismiss();
  }
});

declare global {
  interface Window {
    __loaderDismiss?: () => void;
    __WOWSP_OS_PREFS__?: { locale: string; colorScheme: string };
    __TAURI__?: unknown;
  }
}
