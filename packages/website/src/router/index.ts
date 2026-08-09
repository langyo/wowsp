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
