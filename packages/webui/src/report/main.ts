/**
 * Report window bootstrap — the AI battle report's secondary window (E25),
 * a MINI Vue app in the tray-panel pattern: the shared theme pipeline
 * (bootstrap({surface:"report"}) → hikari theme + wowsp preferences) and
 * the shared i18n instance, but none of the main shell's DPI scale /
 * manual-locate machinery.
 *
 * Everything the view shows comes from `decision_static_report` over the
 * normal transport (the window's own capability covers it); the initial
 * target (replay path + entity) rides the URL query the Rust opener
 * builds, and re-targeting an already-open window rides the
 * wowsp://report-params event. 跳转 buttons emit wowsp://report-seek AT
 * the main window — the main shell listens and drives the 3D playhead.
 */
import { createApp } from "vue";

import ReportWindowView from "./ReportWindowView";
import { i18n, initLocaleMessages } from "@/i18n";
import { uiLocaleReady } from "@/i18n/useLanguage";
import { bootstrap } from "@/bootstrap";
import "@/styles/hikari.scss";
import "@/theme/theme.scss";

bootstrap({ surface: "report" });

const app = createApp(ReportWindowView);
app.use(i18n);
// Gate first paint on the locale bundles (same contract as the tray panel
// and the main shell): the report is a user-facing window, a raw-key flash
// on open would be a regression.
void Promise.all([initLocaleMessages(), uiLocaleReady])
  .catch(() => undefined)
  .then(() => app.mount("#app"));
