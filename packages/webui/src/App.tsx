import { defineComponent } from "vue";
import AppShell from "@/components/layout/AppShell";
import TitleBar from "@/components/layout/TitleBar";

/**
 * Root component for the MAIN window — mounts the custom TitleBar (frameless
 * window chrome) above the AppShell (sidebar + content).  TitleBar
 * self-guards: it renders nothing outside Tauri.
 *
 * The overlay window uses OverlayApp instead (no title bar).
 */
export default defineComponent({
  name: "App",
  setup() {
    return () => (
      <>
        <TitleBar />
        <AppShell />
      </>
    );
  },
});
