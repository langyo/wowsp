import { createRouter, createWebHistory } from "vue-router";

const routerBase = import.meta.env.BASE_URL || "/";

export const router = createRouter({
  history: createWebHistory(routerBase),
  routes: [
    {
      path: "/",
      name: "dashboard",
      component: () => import("@/views/DashboardView"),
    },
    {
      path: "/lookup",
      name: "lookup",
      component: () => import("@/views/LookupView"),
    },
    {
      path: "/ships",
      name: "ships",
      component: () => import("@/views/ShipsView"),
    },
    {
      path: "/replay",
      name: "replay",
      component: () => import("@/views/replay/ReplayView"),
    },
    {
      path: "/resources",
      name: "resources",
      component: () => import("@/views/ResourcesView"),
    },
    {
      path: "/settings",
      name: "settings",
      component: () => import("@/views/SettingsView"),
    },
  ],
});

export default router;
