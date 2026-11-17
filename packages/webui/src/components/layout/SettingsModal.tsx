import { defineComponent } from "vue";

import { HkModal } from "@celestia-island/hikari";

import { useSettingsUiStore } from "@/stores/settingsUi";
import { t } from "@/i18n";
import SettingsBody from "@/components/settings/SettingsBody";
import "./SettingsModal.scss";

/**
 * Settings modal — the DESKTOP-layout surface for the shared settings
 * body (components/settings/SettingsBody: rail + section cards). The body,
 * its state and its section logic live there; this wrapper only provides
 * the app-singleton HkModal window, driven by the settingsUi store (the
 * title-bar gear and the sidebar's account button open it, optionally
 * landing on a section).
 *
 * Phone LAYOUT never mounts this component (AppShell swaps it for the
 * /settings page); hikari's HkModal would bottom-sheet below 768px, but a
 * full page with its own rail reads better on a phone.
 */
export default defineComponent({
  name: "SettingsModal",
  setup() {
    const ui = useSettingsUiStore();
    return () => (
      <HkModal
        modelValue={ui.visible}
        onUpdate:modelValue={(v: boolean) => (v ? ui.show() : ui.hide())}
        title={t("settings.title")}
        width="58rem"
        // hikari's settings-host contract class: the package's
        // HkSettingsDialog.scss ships the flush pane scrollbar, the
        // body-inner height pin AND the desktop frame's constant band
        // (--hk-settings-height, calc(70vh - 6.5rem)). WoWSP leaves the
        // band alone — the window never resizes between sections, and a
        // short section keeps a bounded dead band under its last card (the
        // accepted 2026-11-17 trade that retired the 2026-11-08 content-fit
        // hug and its 2026-11-11 floor). The one frame-adjacent override is
        // the desktop body-inner unpin in components/settings/
        // SettingsShell.scss, which keeps HkModal's size morph able to
        // re-pin the frame on a WINDOW resize.
        contentClass="hk-settings-host"
      >
        <SettingsBody active={ui.visible} />
      </HkModal>
    );
  },
});
