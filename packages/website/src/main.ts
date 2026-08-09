import { createApp } from "vue";
import { createI18n } from "vue-i18n";

import App from "./App";
import { router } from "@/router";
import en from "./messages/en";
import zhCN from "./messages/zh-CN";
import "@/theme/theme.scss";

const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: "en",
  messages: { en, "zh-CN": zhCN },
});

function detectLocale(): string {
  const nav = typeof navigator !== "undefined" ? navigator.language : "en";
  return nav.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

createApp(App).use(router).use(i18n).mount("#app");
