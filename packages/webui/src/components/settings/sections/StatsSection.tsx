/** Stats (战绩 water-table prefs) settings section. */
import { defineComponent } from "vue";
import { HkSettingsGroup, HkSettingsHint } from "@celestia-island/hikari";

import { t } from "@/i18n";
import StatsPrefsControls from "@/components/stats/StatsPrefsControls";
import SealCustomizer from "@/components/stats/SealCustomizer";

export default defineComponent({
  name: "SettingsStatsSection",
  setup() {
    return () => (
          <>
          {/* 战绩 (water-table prefs) — the same controls as the
              onboarding wizard's preferences step (StatsPrefsControls),
              reading/writing the shared statsPrefs store. */}
          <HkSettingsGroup title={t("settings.statsSection")}>
            <HkSettingsHint>{t("settings.statsSectionHint")}</HkSettingsHint>
            <StatsPrefsControls ns="settings" />
            <SealCustomizer />
          </HkSettingsGroup>

          </>
    );
  },
});
