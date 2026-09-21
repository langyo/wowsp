import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL || "/"),
  routes: [
    {
      path: "/",
      name: "home",
      component: () => import("@/views/HomeView"),
    },
    {
      path: "/mods",
      name: "mods",
      component: () => import("@/views/ModsView"),
    },
    {
      path: "/download",
      name: "download",
      component: () => import("@/views/DownloadView"),
    },
    {
      // Docs are built separately by lagrange and served under the site base
      // (/docs/ on the custom domain, /wowsp/docs/ on the Pages project URL).
      // lagrange switches language via `?lang=` query params (no subpaths).
      path: "/docs",
      name: "docs",
      redirect: () => `${import.meta.env.BASE_URL}docs/`,
    },
  ],
});

// SPA page-view tracking: gtag.js in index.html only records the initial
// load, so forward every client-side navigation to Analytics as well.
router.afterEach((to) => {
  const gtag = (window as { gtag?: (...args: unknown[]) => void }).gtag;
  gtag?.("event", "page_view", {
    page_title: String(to.name ?? to.path),
    page_path: to.fullPath,
  });
});

export default router;
