/** Language settings section: the UI/data-language dropdown pair. */
import { defineComponent } from "vue";
import { HkSelect, HkSettingsGroup, HkSettingsHint } from "@celestia-island/hikari";

import { t, type Locale } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";

export default defineComponent({
  name: "SettingsLanguageSection",
  setup() {
    const lang = useLanguage();
    return () => (
          <>
          {/* language — two independent dropdowns: UI (app interface) vs data
              (game-asset names: ships/captains/maps). The same language can have
              different official translations across regions, e.g. 国服 simplified
              (animal names for IJN) vs 亚服 Chinese. */}
          <HkSettingsGroup title={t("settings.language")}>
            <div class="settings-modal__langs">
              <div class="settings-modal__lang">
                <span class="settings-modal__lang-label">{t("settings.uiLanguage")}</span>
                <HkSelect
                  modelValue={lang.uiLocale.value}
                  onUpdate:modelValue={(v: string) => lang.setUiLocale(v as Locale)}
                  options={lang.uiLocaleOptions.map((o) => ({ value: o.value, label: o.label }))}
                />
              </div>
              <div class="settings-modal__lang">
                <span class="settings-modal__lang-label">{t("settings.dataLanguage")}</span>
                <HkSelect
                  modelValue={lang.dataLanguage.value}
                  onUpdate:modelValue={(v: string) => lang.setDataLanguage(v)}
                  options={lang.wgLanguageOptions.map((o) => ({ value: o.value, label: o.label }))}
                />
              </div>
            </div>
            <HkSettingsHint>{t("settings.dataLanguageHint")}</HkSettingsHint>
          </HkSettingsGroup>

          </>
    );
  },
});
