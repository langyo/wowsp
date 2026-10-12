/** About settings section: the about content and the telemetry
 *  disclosure group. */
import { defineComponent } from "vue";
import { HkSettingsGroup, HkSettingsHint, HkSwitch } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { analyticsEnabled, setAnalyticsEnabled } from "@/utils/analytics";
import { AboutContent } from "@/components/layout/AboutModal";
import { pickTelemetryNotice } from "@/components/layout/announcementVariants";

export default defineComponent({
  name: "SettingsAboutSection",
  setup() {
    const lang = useLanguage();
    return () => (
          <>
          {/* about */}
          <HkSettingsGroup title={t("settings.about")}>
            <AboutContent />
          </HkSettingsGroup>
          {/* usage-telemetry disclosure — its own group closing the section
              (moved out of the About notice card), rendered in the user's
              own language; the full notice lives at
              docs/{lang}/license/usage-telemetry.md. */}
          <HkSettingsGroup title={t("settings.telemetryTitle")}>
            <HkSettingsHint>
              {pickTelemetryNotice(lang.uiLocale.value).text}
            </HkSettingsHint>
            {/* The row styles compile under `.stats-prefs .stats-prefs__row`
                (see StatsPrefsControls.scss), so the group wrapper is what
                gives the label/desc column and the right-aligned switch
                their layout — without it the row renders unstyled. */}
            <div class="stats-prefs">
              <div class="stats-prefs__row">
                <span class="stats-prefs__row-text">
                  <span class="stats-prefs__row-label">{t("settings.telemetryToggle")}</span>
                  <span class="stats-prefs__row-desc">{t("settings.telemetryToggleDesc")}</span>
                </span>
                <HkSwitch modelValue={analyticsEnabled.value} onUpdate:modelValue={setAnalyticsEnabled} />
              </div>
            </div>
          </HkSettingsGroup>
          </>
    );
  },
});
