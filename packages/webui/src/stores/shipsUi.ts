import { defineStore } from "pinia";
import { ref } from "vue";

export type ShipsViewMode = "tree" | "grid" | "compare";

/** Which server cluster's branch topology the tech tree renders. */
export type ShipsTreeRealm = "wg" | "lesta";

const TREE_REALM_KEY = "wowsp-ships-tree-realm";

function loadTreeRealm(): ShipsTreeRealm {
  try {
    return localStorage.getItem(TREE_REALM_KEY) === "lesta" ? "lesta" : "wg";
  } catch {
    return "wg";
  }
}

/**
 * Ship encyclopedia UI state shared between distant siblings: the
 * view-mode switch renders dead-center in the app title bar on desktop
 * (AppTitleBar) and in the page header on the phone layout (≤767px, where
 * the bar hosts the nav drawer controls instead), while ShipsView's body
 * reads the same value. `treeRealm` picks the tech-tree branch source
 * (WG reference topology vs the Lesta client's own research graph).
 */
export const useShipsUiStore = defineStore("shipsUi", () => {
  const viewMode = ref<ShipsViewMode>("tree");
  const treeRealm = ref<ShipsTreeRealm>(loadTreeRealm());

  function setTreeRealm(realm: ShipsTreeRealm) {
    treeRealm.value = realm;
    try {
      localStorage.setItem(TREE_REALM_KEY, realm);
    } catch {
      // Storage unavailable (webview restrictions) — keep the in-session value.
    }
  }

  return { viewMode, treeRealm, setTreeRealm };
});
