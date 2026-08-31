import { createApp } from "vue";
import { createI18n } from "vue-i18n";

import { initTheme, initFontContext, applyViewportPolicy } from "@celestia-island/hikari";

import App from "./App";
import { router } from "@/router";
import { detectLocale, isValidLocale, SUPPORTED_LOCALES, type Locale } from "@/locales";
import { registerBrandThemes } from "./theme/brandThemes";
import "./styles/hikari.scss";
import "@/theme/theme.scss";

const modules = import.meta.glob("./messages/*.ts", { eager: true, import: "default" }) as Record<
  string,
  Record<string, unknown>
>;

const messages: Record<string, Record<string, any>> = {};
for (const code of SUPPORTED_LOCALES) {
  messages[code] = modules[`./messages/${code}.ts`] ?? {};
}

function loadLocale(): Locale {
  try {
    const saved = localStorage.getItem("wowsp-site-locale");
    if (saved && isValidLocale(saved)) return saved;
  } catch {
    /* storage unavailable */
  }
  return detectLocale();
}

const i18n = createI18n({
  legacy: false,
  locale: loadLocale(),
  fallbackLocale: "en",
  messages,
});

document.documentElement.lang = (i18n.global.locale as unknown as { value: string }).value;

// Theme: the brand "ocean" preset + hikari's theme/font runtime drive every
// --color-* token on the site (mode "system" follows the sun, matching the
// app). index.html declares the page theme globals pre-module.
registerBrandThemes();
initTheme();
initFontContext();
applyViewportPolicy();

createApp(App).use(router).use(i18n).mount("#app");
