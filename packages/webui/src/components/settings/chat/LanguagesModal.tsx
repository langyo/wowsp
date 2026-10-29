/** Chat-translation target-language window: the reading language, the
 *  auto/fixed mode, the per-request target cap and the two checkbox grids
 *  (always / never translate into). Every control writes the store
 *  immediately (the old inline card's behavior) — the window is a roomier
 *  view, not a staged form, so its footer only closes.
 */
import { defineComponent } from "vue";
import {
  HkCheckbox,
  HkModal,
  HkNumberInput,
  HkSelect,
  HkSettingsHint,
  HkSettingsSub,
  HkTabs,
} from "@celestia-island/hikari";

import { t } from "@/i18n";
import type { TranslateLang } from "@/api/modules/chat";
import { useChatTranslateStore } from "@/stores/chatTranslate";

import { LANG_OPTIONS } from "./shared";
import "./chat-settings.scss";

export default defineComponent({
  name: "ChatTranslateLanguagesModal",
  props: {
    modelValue: { type: Boolean, required: true },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    const store = useChatTranslateStore();
    const close = () => emit("update:modelValue", false);

    function toggleAlways(lang: TranslateLang) {
      const current = store.config.languages.always;
      const next = current.includes(lang)
        ? current.filter((value) => value !== lang)
        : [...current, lang];
      void store.setLanguages({ always: next });
    }

    function toggleExclude(lang: TranslateLang) {
      const current = store.config.languages.exclude;
      const next = current.includes(lang)
        ? current.filter((value) => value !== lang)
        : [...current, lang];
      void store.setLanguages({ exclude: next });
    }

    /** The checkbox grid for one target-language list (always / exclude). */
    function languageGrid(
      selected: readonly string[],
      toggle: (lang: TranslateLang) => void,
      title: string,
    ) {
      return (
        <HkSettingsSub title={title}>
          <div class="settings-modal__langs">
            {LANG_OPTIONS.map(({ lang, label }) => (
              <HkCheckbox
                key={lang}
                size="sm"
                label={label}
                modelValue={selected.includes(lang)}
                onUpdate:modelValue={() => toggle(lang)}
              />
            ))}
          </div>
        </HkSettingsSub>
      );
    }

    return () => (
      <HkModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(value: boolean) => {
          if (!value) close();
        }}
        title={t("settings.chatTranslate.languagesTitle")}
        width="36rem"
        footerActions={[
          {
            label: t("settings.chatTranslate.close"),
            variant: "secondary",
            onClick: close,
          },
        ]}
      >
        <div class="chat-settings__section">
          <HkSettingsHint>{t("settings.chatTranslate.languagesHint")}</HkSettingsHint>
          <div class="settings-modal__langs">
            <div class="settings-modal__lang">
              <span class="settings-modal__lang-label">
                {t("settings.chatTranslate.selfLang")}
              </span>
              <HkSelect
                modelValue={store.config.languages.selfLang}
                onUpdate:modelValue={(value: string) =>
                  void store.setLanguages({ selfLang: value })
                }
                placeholder={t("settings.chatTranslate.selfLangAuto")}
                options={[
                  { value: "", label: t("settings.chatTranslate.selfLangAuto") },
                  ...LANG_OPTIONS.map(({ lang, label }) => ({
                    value: lang,
                    label,
                  })),
                ]}
              />
            </div>
            <div class="settings-modal__lang">
              <span class="settings-modal__lang-label">
                {t("settings.chatTranslate.mode")}
              </span>
              <HkTabs
                block
                variant="segmented"
                modelValue={store.config.languages.mode}
                onUpdate:modelValue={(value: string) =>
                  void store.setLanguages({ mode: value })
                }
                tabs={[
                  { key: "auto", label: t("settings.chatTranslate.modeAuto") },
                  { key: "fixed", label: t("settings.chatTranslate.modeFixed") },
                ]}
              />
            </div>
          </div>
          {/* The numeric cap follows the settings row grammar (label left,
              compact control right) instead of sitting in a grid column as
              a full-width bar. */}
          <div class="stats-prefs">
            <div class="stats-prefs__row">
              <span class="stats-prefs__row-text">
                <span class="stats-prefs__row-label">
                  {t("settings.chatTranslate.maxTargets")}
                </span>
              </span>
              <HkNumberInput
                class="chat-settings__number"
                modelValue={store.config.languages.maxTargets}
                onUpdate:modelValue={(value: number) =>
                  void store.setLanguages({ maxTargets: value })
                }
                min={1}
                max={6}
              />
            </div>
          </div>
          {languageGrid(
            store.config.languages.always,
            toggleAlways,
            t("settings.chatTranslate.always"),
          )}
          {languageGrid(
            store.config.languages.exclude,
            toggleExclude,
            t("settings.chatTranslate.exclude"),
          )}
        </div>
      </HkModal>
    );
  },
});
