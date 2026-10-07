import { createApp } from "vue";
import { createPinia } from "pinia";

import App from "./App";
import router from "@/router";
import { i18n, initLocaleMessages } from "@/i18n";
import { uiLocaleReady } from "@/i18n/useLanguage";
import { bootstrap } from "./bootstrap";
import { runStartupMigrations } from "./migrations";
import { initAnalytics, trackPageView } from "@/utils/analytics";
import { probeSecondInstance, secondInstance } from "@/utils/secondInstance";
import "@/styles/hikari.scss";
import "@/theme/theme.scss";
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
// Duplicate-launch probe (utils/secondInstance): settled inside the mount
// gate below so the notice dialog is present at first paint — the real
// dashboard must never flash in a second copy. Runs BEFORE mount and never
// rejects (plain-browser and IPC-failure paths leave the flag false).
const secondInstanceReady = probeSecondInstance();
// Forward SPA route changes as page_views on the virtual canonical host.
// Registered before mount as always, but a duplicate launch reports no
// usage — its only surface is the "already running" notice.
router.afterEach((to) => {
  if (secondInstance.value) return;
  trackPageView(String(to.name ?? to.path), to.fullPath);
});
const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(i18n);
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
  secondInstanceReady,
]).then(() => {
  app.mount("#app");
  // Analytics rides the gate continuation, after the duplicate flag has
  // settled: a second copy (open for the few seconds the notice is up)
  // must not pollute the app stream, not even with its first page_view.
  if (!secondInstance.value) {
    // Google Analytics (Tauri shell + release only, see utils/analytics).
    initAnalytics();
  }
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
