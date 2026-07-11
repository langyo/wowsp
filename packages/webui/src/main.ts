import { createApp } from "vue";
import { createPinia } from "pinia";

import App from "./App";
import OverlayApp from "@/OverlayApp";
import router from "@/router";
import { i18n } from "@/i18n";
import "@/theme/theme.scss";
import "virtual:uno.css";

/**
 * WoWSP entry. The same index.html serves TWO windows:
 *   - the main shell (default) — router-driven, with the custom title bar
 *   - the overlay window — `?window=overlay`, transparent, no router/title bar
 *
 * The Rust side creates the overlay window on demand (transparent, always on
 * top, skip taskbar) pointing at the same URL with the query param. main.ts
 * branches here so each window gets the right root component + plugins.
 */
const isOverlay = new URLSearchParams(window.location.search).get("window") === "overlay";

if (isOverlay) {
  const app = createApp(OverlayApp);
  app.use(createPinia());
  app.use(i18n);
  app.mount("#app");
} else {
  const app = createApp(App);
  app.use(createPinia());
  app.use(router);
  app.use(i18n);
  router.isReady().then(() => {
    app.mount("#app");
    if (typeof window.__loaderDismiss === "function") {
      window.__loaderDismiss();
    }
  });
}

declare global {
  interface Window {
    __loaderDismiss?: () => void;
    __WOWSP_OS_PREFS__?: { locale: string; colorScheme: string };
    __TAURI__?: unknown;
  }
}
