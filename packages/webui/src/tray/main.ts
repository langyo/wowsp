/**
 * Tray panel window bootstrap — a MINI Vue app, not bare DOM like the
 * overlay page.
 *
 * The panel renders hikari components inside a themed card (the tray left
 * click opens it), so unlike the overlay's paint-instant constraint it can
 * afford the small Vue mount: it reuses the main shell's theme pipeline
 * (bootstrap({surface:"tray"}) → hikari theme + the wowsp mode/font/opacity
 * preferences — but NOT the DPI scale or the manual-locate cancel, both of
 * which only make sense in the main window), the shared i18n instance
 * (awaiting the persisted UI locale's bundle, same as the main entry) and
 * the session store. Everything it shows comes from the Rust session hub
 * (wowsp://session-changed), which is what keeps the panel and the main
 * window's bottom-left footer on the same page.
 */
import { createApp } from "vue";
import { createPinia } from "pinia";

import TrayPanel from "./TrayPanel";
import { i18n, initLocaleMessages } from "@/i18n";
import { uiLocaleReady } from "@/i18n/useLanguage";
import { bootstrap } from "@/bootstrap";
import "@/styles/hikari.scss";
import "@/theme/theme.scss";

bootstrap({ surface: "tray" });

const app = createApp(TrayPanel);
app.use(createPinia());
app.use(i18n);
// Gate first paint on the locale bundles (fallback + the persisted UI
// locale's apply, same contract as the main shell) so the panel never
// flashes raw keys or the wrong language over the tray.
void Promise.all([
  initLocaleMessages(),
  uiLocaleReady,
])
  .catch(() => undefined)
  .then(() => app.mount("#app"));
