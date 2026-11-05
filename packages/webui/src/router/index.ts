import { createRouter, createWebHistory } from "vue-router";

import { installNavigationSafetyNet } from "@celestia-island/hikari/runtime";

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
      // 游玩时间 — the water-meter page's sibling view. No sidebar entry by
      // design: it is switched from the title-bar's center button group,
      // which only renders while the dashboard section is open.
      path: "/playtime",
      name: "playtime",
      component: () => import("@/views/PlaytimeView"),
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
      // (desktop app only).
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

// Navigation safety net (hikari runtime, shittim-chest #754 lineage). WHY
// (2026-11-05 field incident): a history entry whose persisted router state
// carried a garbage `current` segment ("undefined/", the classic
// interpolated-undefined target) made EVERY router.push() die in
// vue-router's HTML5 history: the composed `origin + base + to` URL fails
// to parse (invalid port), its pushState throws, and the router's
// catch-branch full-page `location.replace(url)` throws the SyntaxError
// the user saw toasted — "Failed to execute 'replace' on 'Location':
// 'http://127.0.0.1:5199undefined/' is not a valid URL". Every navigation
// button in the shell was dead from then on (partial feature loss), and
// the state rides the history entry, so reloads did not heal it. The net
// sits BELOW the router: it folds off-origin / poisoned History targets
// onto the app landing before the native call (with a console warning +
// sessionStorage trail that names the producer for the next occurrence),
// and the router-level guard redirects targets lacking a leading "/".
// One successful navigation then rewrites the entry state clean, so an
// already-poisoned session self-heals on its first click. Module scope:
// installed before the app mounts and before the first navigation, and
// re-install is a no-op by the patch marker.
installNavigationSafetyNet({ router });

export default router;
