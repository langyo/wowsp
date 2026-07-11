import { createApp } from "vue";
import { createPinia } from "pinia";

import App from "./App";
import router from "./router";
import { i18n } from "@/i18n";
import "@/theme/theme.scss";
import "virtual:uno.css";

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
