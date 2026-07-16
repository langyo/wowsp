import { createApp } from "vue";
import { createI18n } from "vue-i18n";
import "virtual:uno.css";
import App from "./App.vue";

import en from "../locales/en.json";
import zhs from "../locales/zhs.json";

const LOCALES = ["en", "zhs"] as const;
type Locale = (typeof LOCALES)[number];

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem("wowsp-site-locale");
    if (saved && LOCALES.includes(saved as Locale)) return saved as Locale;
  } catch {}
  const nav = navigator.language;
  return nav.startsWith("zh") ? "zhs" : "en";
}

const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: "en",
  messages: { en, zhs },
});

const app = createApp(App);
app.use(i18n);
app.mount("#app");
