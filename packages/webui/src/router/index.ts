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
      // Live battle watch (desktop app only — the phone has no local game;
      // the sidebar hides the link there too).
      path: "/live",
      name: "live",
      component: () => import("@/views/replay/LiveView"),
    },
    {
      path: "/replay",
      name: "replay",
      component: () => import("@/views/replay/ReplayView"),
    },
    {
      // Map tactics analysis over the active install's full map inventory
      // (desktop app only — the sidebar hides the link on phones).
      path: "/tactics",
      name: "tactics",
      component: () => import("@/views/replay/TacticsView"),
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
