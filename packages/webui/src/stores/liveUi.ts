import { defineStore } from "pinia";
import { ref } from "vue";

export type LiveViewMode = "roster" | "mine";

/**
 * Live-page UI state shared between distant siblings: the 全员/我的 view
 * switch renders dead-center in the app title bar on desktop (AppTitleBar)
 * exactly like the dashboard's 水表/游玩时间 pair, while LiveView's body
 * reads the same value to mount the roster panel or the personal-stats one.
 * Session-scoped on purpose — reopening the app lands back on the roster
 * view, the live page's primary face.
 */
export const useLiveUiStore = defineStore("liveUi", () => {
  const viewMode = ref<LiveViewMode>("roster");

  return { viewMode };
});
