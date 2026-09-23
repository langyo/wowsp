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
      // Phone-layout settings surface (full page with its own section
      // rail). Desktop keeps the settings modal; the route stays reachable
      // at any width and shares its body with the modal.
      path: "/settings",
      name: "settings",
      component: () => import("@/views/SettingsView"),
    },
  ],
});

export default router;
