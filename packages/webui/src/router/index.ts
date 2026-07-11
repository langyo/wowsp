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
    // NOTE: the overlay (Mode 2) is NOT a route here — it's a separate window
    // created on demand by the Rust side, loading the same index.html with
    // ?window=overlay. main.ts mounts OverlayApp for that window.
  ],
});

export default router;
