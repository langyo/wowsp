import { defineComponent } from "vue";
import { HkModal, HkSettingsHint } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { useSettingsUiStore, type SettingsSection } from "@/stores/settingsUi";
import SettingsShell from "@/components/settings/SettingsShell";
import { useSettingsBody } from "@/components/settings/useSettingsBody";
import LanguageSection from "@/components/settings/sections/LanguageSection";
import AppearanceSection from "@/components/settings/sections/AppearanceSection";
import CloseBehaviorSection from "@/components/settings/sections/CloseBehaviorSection";
import StatsSection from "@/components/settings/sections/StatsSection";
import GamePathSection from "@/components/settings/sections/GamePathSection";
import AccountSection from "@/components/settings/sections/AccountSection";
import NetworkSection from "@/components/settings/sections/NetworkSection";
import PairingSection from "@/components/settings/sections/PairingSection";
import UpdatesSection from "@/components/settings/sections/UpdatesSection";
import ChangelogSection from "@/components/settings/ChangelogSection";
import OverlaySection from "@/components/settings/sections/OverlaySection";
import FeedbackSection from "@/components/settings/FeedbackSection";
import AboutSection from "@/components/settings/sections/AboutSection";
import AttributionsSection from "@/components/settings/sections/AttributionsSection";
import SharingSection from "@/components/settings/sections/SharingSection";
import "../layout/SettingsModal.scss";

/**
 * Shared settings body: the section rail + the section cards. Rendered by
 * BOTH surfaces — the desktop modal (components/layout/SettingsModal) and
 * the phone-layout /settings page (views/SettingsView). Which surface is
 * showing the body is abstracted into the single `active` prop: section
 * identity lives in the settingsUi store (shared), while mount/refresh
 * side effects (net config load, cache refresh, DPI staged-notch escape
 * hatches) key off `active` so they fire identically when the modal opens
 * and when the page mounts.
 *
 * The state lives in useSettingsBody (components/settings/
 * useSettings*.ts composables); the section cards are the focused
 * components under sections/, each receiving the shared context. On the
 * phone app build the gamePath, overlay and closeBehavior sections are
 * filtered out of the rail (no local game install / no overlay window
 * there / no tray or window close button to configure).
 */
export default defineComponent({
  name: "SettingsBody",
  props: {
    /** True while the hosting surface (modal or page) is showing this
     *  body — drives the open-time refreshes and the DPI discard hatch. */
    active: { type: Boolean, default: false },
  },
  setup(props) {
    const ui = useSettingsUiStore();
    const ctx = useSettingsBody(props);
    return () => (
        <>
        {/* The shell is the local SettingsShell — hikari's HkSettingsBody
            anatomy (the settings-window grammar this app upstreamed,
            2026-09-23) extended with a grouped rail: titled clusters over
            the nav entries. Active-section state, pane scrolling and the
            switch-restarts-at-top behavior follow the shared component's
            contract; this body keeps only the section content. Section
            identity stays in the settingsUi store so openers can land on
            a specific section. */}
        <SettingsShell
          groups={ctx.railGroups.value}
          section={ui.section}
          onUpdate:section={(key: string) => (ui.section = key as SettingsSection)}
          navLabel={t("settings.title")}
        >
          {{
          language: () => <LanguageSection />,
          appearance: () => <AppearanceSection ctx={ctx} />,
          closeBehavior: () => <CloseBehaviorSection ctx={ctx} />,
          stats: () => <StatsSection />,
          gamePath: () => <GamePathSection ctx={ctx} />,
          account: () => <AccountSection />,
          network: () => <NetworkSection ctx={ctx} />,
          pairing: () => <PairingSection ctx={ctx} />,
          updates: () => <UpdatesSection ctx={ctx} />,
          changelog: () => (
          <>
          <ChangelogSection />
          </>
          ),
          overlay: () => <OverlaySection ctx={ctx} />,
          feedback: () => (
          <>
          <FeedbackSection />
          </>
          ),
          about: () => <AboutSection />,
          attributions: () => <AttributionsSection />,
          sharing: () => <SharingSection />,
          }}
        </SettingsShell>

        {/* DPI preview confirm — a pure view over dpiPrefs' app-level
            countdown store (all keep/revert logic lives there): it floats
            above whichever surface hosts the body while a preview is live,
            closing it via X/backdrop counts as Keep, "Revert now" restores
            the persisted value, and expiry reverts by itself. */}
        <HkModal
          modelValue={ctx.dpi.dpiCountdown.active}
          onUpdate:modelValue={(v: boolean) => {
            if (!v && ctx.dpi.dpiCountdown.active) ctx.dpi.onDpiKeep();
          }}
          title={t("settings.dpiConfirmTitle")}
          width="22rem"
          footerActions={ctx.dpi.dpiConfirmActions.value}
        >
          <HkSettingsHint>
            {t("settings.dpiRevertCountdown", {
              scale: ctx.dpi.dpiCountdown.scale,
              seconds: ctx.dpi.dpiCountdown.remaining,
            })}
          </HkSettingsHint>
        </HkModal>
        </>
    );
  },
});
