/** Install-cleanup settings section: the startup duplicate-install check
 *  toggle plus the live status row (detected leftover path + manual
 *  removal / re-check). The same flag the startup dialog's 不再提示
 *  checkbox writes. */
import { defineComponent, onMounted } from "vue";
import { HkButton, HkSettingsGroup, HkSettingsHint, HkSwitch } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { useDuplicateInstallStore } from "@/stores/duplicateInstall";

export default defineComponent({
  name: "SettingsInstallCleanupSection",
  setup() {
    const store = useDuplicateInstallStore();
    // The section mounts when its card becomes active — refresh the
    // switch and the detection so the row never shows a stale answer.
    onMounted(() => {
      void store.loadConfig();
      void store.check();
    });

    return () => (
      <HkSettingsGroup title={t("settings.installCleanup")}>
        <HkSettingsHint>{t("settings.dupCheckDesc")}</HkSettingsHint>
        {/* The row styles compile under `.stats-prefs .stats-prefs__row`
            (see StatsPrefsControls.scss), the same arrangement the
            telemetry toggle uses. */}
        <div class="stats-prefs">
          <div class="stats-prefs__row">
            <span class="stats-prefs__row-text">
              <span class="stats-prefs__row-label">{t("settings.dupCheckToggle")}</span>
              <span class="stats-prefs__row-desc">{t("settings.dupCheckToggleDesc")}</span>
            </span>
            <HkSwitch
              modelValue={store.promptEnabled}
              onUpdate:modelValue={(v: boolean) => void store.setPromptEnabled(v)}
            />
          </div>
        </div>
        {/* Live status: the detected leftover with a one-click removal,
            or the quiet all-clear with a manual re-check. */}
        <div class="settings-modal__pack">
          <div class="settings-modal__pack-info">
            <span class="settings-modal__pack-name">{t("settings.dupStatusLabel")}</span>
            {store.info ? (
              <span class="settings-modal__pack-desc">
                {store.info.version
                  ? t("settings.dupDetectedAt", { version: store.info.version })
                  : t("settings.dupDetectedNoVersion")}
              </span>
            ) : (
              <span class="settings-modal__pack-desc">{t("settings.dupNone")}</span>
            )}
            {store.info ? (
              <span class="settings-modal__pack-meta">{store.info.path}</span>
            ) : null}
            {store.info && !store.info.hasUninstaller ? (
              <span class="settings-modal__pack-meta">{t("settings.dupNoUninstaller")}</span>
            ) : null}
          </div>
          {store.info ? (
            <HkButton
              variant="danger"
              loading={store.uninstalling}
              disabled={!store.info.hasUninstaller}
              onClick={() => void store.uninstall()}
            >
              {t("settings.dupUninstallNow")}
            </HkButton>
          ) : (
            <HkButton
              variant="secondary"
              loading={store.checking}
              onClick={() => void store.check()}
            >
              {t("settings.dupRecheck")}
            </HkButton>
          )}
        </div>
      </HkSettingsGroup>
    );
  },
});
