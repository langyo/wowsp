/** Account settings section: the shared binder/switcher body. */
import { defineComponent } from "vue";
import { HkSettingsGroup, HkSettingsHint } from "@celestia-island/hikari";

import { t } from "@/i18n";
import AccountManagerContent from "@/components/account/AccountManagerContent";

export default defineComponent({
  name: "SettingsAccountSection",
  setup() {
    return () => (
          <>
          {/* account — the binder/switcher body shared with the dashboard's
              modal entry: search → bind, rich cards for every bound account,
              click to activate. Switching here leaves the section open (the
              wrapper modal closes instead). */}
          <HkSettingsGroup title={t("settings.account")}>
            <HkSettingsHint>{t("settings.accountHint")}</HkSettingsHint>
            <AccountManagerContent />
          </HkSettingsGroup>
          </>
    );
  },
});
