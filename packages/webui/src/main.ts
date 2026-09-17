import { createApp } from "vue";
import { createPinia } from "pinia";

import App from "./App";
import router from "@/router";
import { i18n } from "@/i18n";
import { bootstrap } from "./bootstrap";
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
bootstrap();
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

declare global {
  interface Window {
    __loaderDismiss?: () => void;
    __WOWSP_OS_PREFS__?: { locale: string; colorScheme: string };
    __TAURI__?: unknown;
  }
}
