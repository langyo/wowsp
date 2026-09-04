import { defineComponent } from "vue";
import { HTitleBar } from "@celestia-island/hikari";
import AppShell from "@/components/layout/AppShell";

/**
 * Root component for the MAIN window — mounts the shared HTitleBar (frameless
 * window chrome, from hikari) above the AppShell (sidebar + content).
 * HTitleBar self-guards: it renders nothing outside Tauri.
 *
 * The overlay window uses OverlayApp instead (no title bar).
 */
export default defineComponent({
  name: "App",
  setup() {
    return () => (
      <>
        <HTitleBar logoSrc="/logo.webp" appName="WoWSP" />
        <AppShell />
      </>
    );
  },
});
