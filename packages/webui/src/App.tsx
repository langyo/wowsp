import { defineComponent, onMounted, ref } from "vue";
import { getVersion } from "@tauri-apps/api/app";

import AppTitleBar from "@/components/layout/AppTitleBar";
import AppShell from "@/components/layout/AppShell";
import { useOverlayLifecycle } from "@/features/overlay/useOverlayLifecycle";

/**
 * Root component for the MAIN window — mounts AppTitleBar (our shell around
 * hikari's HTitleBar, frameless window chrome) above the AppShell (sidebar +
 * content). The title bar carries the running version as its subtitle,
 * resolved from the Tauri app API on mount. The wrapper self-guards:
 * outside Tauri the caption buttons are inert and the subtitle stays empty
 * (browser dev mode has no app version).
 *
 * The in-game overlay window is a separate pre-rendered page (overlay.html),
 * not a Vue view. While the game runs and the in-game overlay setting is on,
 * the overlay lifecycle keeps that transparent window + Tab watcher alive
 * (see useOverlayLifecycle).
 */
export default defineComponent({
  name: "App",
  setup() {
    const version = ref("");
    useOverlayLifecycle();

    onMounted(async () => {
      try {
        version.value = await getVersion();
      } catch {
        // Browser dev mode — no Tauri app API; leave the subtitle empty.
      }
    });

    return () => (
      <>
        <AppTitleBar
          icon="/logo.webp"
          title="WoWSP"
          subtitle={version.value ? `v${version.value}` : ""}
        />
        <AppShell />
      </>
    );
  },
});
