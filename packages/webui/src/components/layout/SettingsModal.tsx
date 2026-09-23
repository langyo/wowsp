import { defineComponent } from "vue";

import { HModal } from "@celestia-island/hikari";

import { useSettingsUiStore } from "@/stores/settingsUi";
import { t } from "@/i18n";
import SettingsBody from "@/components/settings/SettingsBody";
import "./SettingsModal.scss";

/**
 * Settings modal — the DESKTOP-layout surface for the shared settings
 * body (components/settings/SettingsBody: rail + section cards). The body,
 * its state and its section logic live there; this wrapper only provides
 * the app-singleton HModal window, driven by the settingsUi store (the
 * title-bar gear and the sidebar's account button open it, optionally
 * landing on a section).
 *
 * Phone LAYOUT never mounts this component (AppShell swaps it for the
 * /settings page); hikari's HModal would bottom-sheet below 768px, but a
 * full page with its own rail reads better on a phone.
 */
export default defineComponent({
  name: "SettingsModal",
  setup() {
    const ui = useSettingsUiStore();
    return () => (
      <HModal
        modelValue={ui.visible}
        onUpdate:modelValue={(v: boolean) => (v ? ui.show() : ui.hide())}
        title={t("settings.title")}
        width="58rem"
        // hikari's settings-host contract class (the stable-frame rules
        // ship with the package's HkSettingsDialog.scss): body-inner
        // height 100%, constant shell height, flush pane scrollbar.
        contentClass="hk-settings-host"
      >
        <SettingsBody active={ui.visible} />
      </HModal>
    );
  },
});
