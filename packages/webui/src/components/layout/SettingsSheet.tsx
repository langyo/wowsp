import { defineComponent } from "vue";

import { HkModal } from "@celestia-island/hikari";

import { useSettingsUiStore } from "@/stores/settingsUi";
import { t } from "@/i18n";
import SettingsBody from "@/components/settings/SettingsBody";
import "./SettingsSheet.scss";

/**
 * Settings sheet — the PHONE-layout surface for the shared settings body
 * (components/settings/SettingsBody). Same shape as the desktop
 * SettingsModal: the app-singleton window is driven by the settingsUi
 * store (title-bar gear, sidebar account button), the body and its
 * section logic live in SettingsBody.
 *
 * hikari docks every HkModal as a bottom sheet below 768px, and the
 * built-in backGuard pushes a history entry on open, so the Android back
 * gesture closes the sheet (the reason the old /settings route page
 * existed — the shittim-chest convention this replaces is exactly this:
 * every phone window, settings included, pops from the bottom instead of
 * switching pages). The sheet is content-hugging up to the sheet cap
 * (100dvh − bar − safe area, AppShell's --hk-sheet-top-inset override);
 * a near-full sheet body keeps the rail usable.
 */
export default defineComponent({
  name: "SettingsSheet",
  setup() {
    const ui = useSettingsUiStore();
    return () => (
      <HkModal
        modelValue={ui.visible}
        onUpdate:modelValue={(v: boolean) => (v ? ui.show() : ui.hide())}
        title={t("settings.title")}
        width="58rem"
        contentClass="hk-settings-host wowsp-settings-sheet"
      >
        <SettingsBody active={ui.visible} />
      </HkModal>
    );
  },
});