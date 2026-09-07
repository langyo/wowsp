import { defineComponent } from "vue";
import AppTitleBar from "@/components/layout/AppTitleBar";
import AppShell from "@/components/layout/AppShell";

/**
 * Root component for the MAIN window — mounts AppTitleBar (our shell around
 * hikari's HTitleBar, frameless window chrome) above the AppShell (sidebar +
 * content). The wrapper self-guards: outside Tauri the caption buttons are
 * inert.
 *
 * The overlay window uses OverlayApp instead (no title bar).
 */
export default defineComponent({
  name: "App",
  setup() {
    return () => (
      <>
        <AppTitleBar icon="/logo.webp" title="WoWSP" />
        <AppShell />
      </>
    );
  },
});
