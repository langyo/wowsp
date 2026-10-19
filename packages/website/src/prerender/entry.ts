// Prerender entry: renders the real app (App shell + view + i18n) to a
// static HTML string at BUILD time, via Vite's ssrLoadModule pipeline
// (same TSX/SASS/alias processing as the browser build — see
// scripts/prerender.ts). Loaded only by that script; never bundled.
// Keep the wiring in sync with main.ts / router/index.ts minus the
// browser-only side effects (theme init, listeners, fetches in
// onMounted never run during prerendering).
import "./shims";
import { createSSRApp, type Component } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { createI18n, type DefineLocaleMessage } from "vue-i18n";

import App from "@/App";
import HomeView from "@/views/HomeView";
import ModsView from "@/views/ModsView";
import DownloadView from "@/views/DownloadView";
import { SUPPORTED_LOCALES, type Locale } from "@/locales";

const modules = import.meta.glob("../messages/*.ts", { eager: true, import: "default" }) as Record<
  string,
  DefineLocaleMessage
>;

const messages: Record<string, DefineLocaleMessage> = {};
for (const code of SUPPORTED_LOCALES) {
  messages[code] = modules[`../messages/${code}.ts`] ?? {};
}

// The routes that get baked into static HTML. The real router
// lazy-loads these views; prerendering imports them eagerly so the
// render is synchronous and deterministic. The /docs redirect is
// server-side only and never prerendered.
const ROUTES: Record<string, { name: string; component: Component }> = {
  "/": { name: "home", component: HomeView },
  "/mods": { name: "mods", component: ModsView },
  "/download": { name: "download", component: DownloadView },
};

export async function prerender(path: string, locale: Locale): Promise<string> {
  const route = ROUTES[path];
  if (!route) throw new Error(`prerender: unknown route ${path}`);

  // All routes registered (one per render) so nav RouterLinks resolve
  // instead of warning about unmatched locations on the pages that
  // don't define them. The build base (BASE_URL, "/wowsp/" in CI)
  // matches the real router's createWebHistory flavor so prerendered
  // hrefs land on the bundled paths on every host that serves them.
  const router = createRouter({
    history: createMemoryHistory(import.meta.env.BASE_URL),
    routes: Object.entries(ROUTES).map(([routePath, r]) => ({
      path: routePath,
      name: r.name,
      component: r.component,
    })),
  });
  const i18n = createI18n({
    legacy: false,
    locale,
    fallbackLocale: "en",
    messages,
  });

  const app = createSSRApp(App);
  app.use(router).use(i18n);
  await router.push(path);
  await router.isReady();

  const { renderToString } = await import("vue/server-renderer");
  return renderToString(app);
}
