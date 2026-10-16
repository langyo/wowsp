import { defineComponent, onMounted, ref } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import { HkContextMenuProvider } from "@celestia-island/hikari";
import { Settings } from "@lucide/vue";

import AppTitleBar from "@/components/layout/AppTitleBar";
import AppShell from "@/components/layout/AppShell";
import { useOverlayLifecycle } from "@/features/overlay/useOverlayLifecycle";
import { useLiveSessionGuard } from "@/features/replay/useLiveSessionGuard";
import { useSettingsUiStore } from "@/stores/settingsUi";
import { RPC } from "@/rpc";
import { transport } from "@/transport";
import { titlebarSubtitle } from "@/utils/titlebarSubtitle";
import { t } from "@/i18n";

/**
 * Root component for the MAIN window — mounts AppTitleBar (our shell around
 * hikari's HkTitleBar, frameless window chrome) above the AppShell (sidebar +
 * content). The title bar carries the running version as its subtitle,
 * resolved from the Tauri app API on mount, plus the settings gear as a
 * custom caption action (left of minimize). The wrapper self-guards:
 * outside Tauri the caption buttons are inert and the subtitle stays empty
 * (browser dev mode has no app version). Debug builds append the git
 * identity stamp (branch:hash7) behind the version so the running binary
 * pins to its checkout — see utils/titlebarSubtitle.
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
    const buildIdentity = ref("");
    const ui = useSettingsUiStore();
    useOverlayLifecycle();
    // Clears the /live retention (roster + self-stats) when the client
    // session identity moves — see useLiveSessionGuard.
    useLiveSessionGuard();

    onMounted(async () => {
      // Resolve together so the subtitle never flips from version-only to
      // version+stamp a frame apart in debug builds. Both fetches fail
      // silently in browser dev mode (no app version, no mock route) and
      // leave the subtitle empty.
      const [appVersion, identity] = await Promise.all([
        getVersion().catch(() => ""),
        transport.invoke<string>(RPC.get_build_identity).catch(() => ""),
      ]);
      version.value = appVersion;
      buildIdentity.value = identity;
    });

    return () => (
      // HkContextMenuProvider: the app-wide context-menu host — every
      // right-click / long-press / menu-key surface (the tactical board's
      // unit menus today) opens through this one hikari menu machinery.
      <HkContextMenuProvider>
        <AppTitleBar
          icon="/logo.webp"
          title="WoWSP"
          subtitle={titlebarSubtitle(version.value, buildIdentity.value)}
          customActions={[
            { id: "settings", label: t("nav.settings"), icon: <Settings size={15} /> },
          ]}
          onAction={() => ui.show()}
        />
        <AppShell />
      </HkContextMenuProvider>
    );
  },
});
