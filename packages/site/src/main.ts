import { createApp } from "vue";
import { createI18n } from "vue-i18n";
import "virtual:uno.css";
import App from "./App.vue";

import en from "../locales/en.json";
import zhs from "../locales/zhs.json";
import zht from "../locales/zht.json";
import ja from "../locales/ja.json";
import ko from "../locales/ko.json";
import fr from "../locales/fr.json";
import es from "../locales/es.json";
import ru from "../locales/ru.json";
import ar from "../locales/ar.json";

function detectLocale(): string {
  try {
    const saved = localStorage.getItem("wowsp-site-locale");
    if (saved) return saved;
  } catch {}
  const nav = navigator.language.toLowerCase();
  if (nav.startsWith("zh")) return nav.includes("hant") || nav.includes("tw") || nav.includes("hk") ? "zht" : "zhs";
  if (nav.startsWith("ja")) return "ja";
  if (nav.startsWith("ko")) return "ko";
  if (nav.startsWith("fr")) return "fr";
  if (nav.startsWith("es")) return "es";
  if (nav.startsWith("ru")) return "ru";
  if (nav.startsWith("ar")) return "ar";
  return "en";
}

const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: "en",
  messages: { en, zhs, zht, ja, ko, fr, es, ru, ar },
});

const app = createApp(App);
app.use(i18n);
app.mount("#app");
