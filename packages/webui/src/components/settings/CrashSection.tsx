/** Crash analysis (游戏崩溃分析) settings section — PLACEHOLDER: the
 *  watchdog's records/analysis UI lands in a follow-up change; today the
 *  section renders its shell so the rail entry and deep-links (the crash
 *  toast's 分析 action) resolve to real content. The store behind it is
 *  stores/crash.ts. */
import { defineComponent } from "vue";
import { HkSettingsGroup, HkSettingsHint } from "@celestia-island/hikari";

import { t } from "@/i18n";

export default defineComponent({
  name: "SettingsCrashSection",
  setup() {
    return () => (
      <HkSettingsGroup title={t("crash.section.title")}>
        <HkSettingsHint>{t("crash.section.empty")}</HkSettingsHint>
      </HkSettingsGroup>
    );
  },
});
