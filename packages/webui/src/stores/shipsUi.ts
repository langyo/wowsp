import { defineStore } from "pinia";
import { ref } from "vue";

export type ShipsViewMode = "tree" | "grid" | "compare";

/**
 * Ship encyclopedia UI state shared between distant siblings: the
 * view-mode switch renders dead-center in the app title bar on desktop
 * (AppTitleBar) and in the page header on the phone layout (≤767px, where
 * the bar hosts the nav drawer controls instead), while ShipsView's body
 * reads the same value.
 */
export const useShipsUiStore = defineStore("shipsUi", () => {
  const viewMode = ref<ShipsViewMode>("tree");

  return { viewMode };
});
