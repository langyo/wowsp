import { createRouter, createWebHistory } from "vue-router";

const routerBase = import.meta.env.BASE_URL || "/";

export const router = createRouter({
  history: createWebHistory(routerBase),
  routes: [
    {
      path: "/",
      name: "home",
      component: () => import("@/views/HomeView"),
    },
    {
      // Standalone review mode: open a replay and scrub it on the holographic map.
      path: "/replay",
      name: "replay",
      component: () => import("@/views/replay/ReplayView"),
    },
    {
      // In-game overlay mode: transparent window showing both teams.
      path: "/overlay",
      name: "overlay",
      component: () => import("@/views/overlay/OverlayView"),
    },
  ],
});

export default router;
