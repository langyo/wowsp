import { defineComponent } from "vue";
import AppShell from "@/components/layout/AppShell";

/**
 * Root component for the MAIN window — just mounts the AppShell (sidebar +
 * content). The overlay window uses OverlayApp instead.
 */
export default defineComponent({
  name: "App",
  setup() {
    return () => <AppShell />;
  },
});
