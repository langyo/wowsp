/**
 * Overlay composable. Wires the overlay store to a Tab-key listener: while the
 * key is held, the overlay becomes visible (and WoWSP captures + re-anchors the
 * roster); on release it hides. Matches Mode 2 in PLAN.md.
 *
 * TODO(M8): the real detector reads `lastCapture.rosterRect` to re-anchor the
 * rendered roster; this skeleton just toggles visibility.
 */
import { onBeforeUnmount, onMounted } from "vue";

import { useOverlayStore } from "@/stores/overlay";

export function useOverlay() {
  const store = useOverlayStore();

  function onTabDown(e: KeyboardEvent) {
    if (e.key !== "Tab") return;
    e.preventDefault();
    if (!store.visible) void store.setVisible(true);
  }
  function onTabUp(e: KeyboardEvent) {
    if (e.key !== "Tab") return;
    if (store.visible) void store.setVisible(false);
  }

  onMounted(() => {
    window.addEventListener("keydown", onTabDown);
    window.addEventListener("keyup", onTabUp);
  });
  onBeforeUnmount(() => {
    window.removeEventListener("keydown", onTabDown);
    window.removeEventListener("keyup", onTabUp);
  });

  return {
    arenaInfo: store.arenaInfo,
    visible: store.visible,
    allies: store.allies,
    enemies: store.enemies,
    refresh: (dir?: string) => store.refreshArenaInfo(dir),
  };
}
