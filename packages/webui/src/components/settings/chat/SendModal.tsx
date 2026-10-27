/** Chat-translation sending window: the suffix toggle and layout, the split
 *  threshold and the paste-hint timeout. The PRIMARY send choice (off /
 *  clipboard) deliberately stays on the first-level card — it is the feature
 *  toggle, not a detail. Every control writes the store immediately, so the
 *  window's footer only closes.
 */
import { defineComponent } from "vue";
import { HkModal, HkNumberInput, HkSwitch, HkTabs } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { useChatTranslateStore } from "@/stores/chatTranslate";

import "./chat-settings.scss";

export default defineComponent({
  name: "ChatTranslateSendModal",
  props: {
    modelValue: { type: Boolean, required: true },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    const store = useChatTranslateStore();
    const close = () => emit("update:modelValue", false);
    return () => (
      <HkModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(value: boolean) => {
          if (!value) close();
        }}
        title={t("settings.chatTranslate.sendTitle")}
        width="32rem"
        footerActions={[
          {
            label: t("settings.chatTranslate.close"),
            variant: "secondary",
            onClick: close,
          },
        ]}
      >
        <div class="chat-settings__section">
          <div class="stats-prefs">
            <div class="stats-prefs__row">
              <span class="stats-prefs__row-text">
                <span class="stats-prefs__row-label">
                  {t("settings.chatTranslate.suffix")}
                </span>
              </span>
              <HkSwitch
                modelValue={store.config.send.suffixEnabled}
                onUpdate:modelValue={(value: boolean) =>
                  void store.setSend({ suffixEnabled: value })
                }
              />
            </div>
          </div>
          <div class="settings-modal__langs">
            <div class="settings-modal__lang">
              <span class="settings-modal__lang-label">
                {t("settings.chatTranslate.suffixFormat")}
              </span>
              <HkTabs
                block
                variant="segmented"
                modelValue={store.config.send.suffixFormat}
                onUpdate:modelValue={(value: string) =>
                  void store.setSend({ suffixFormat: value })
                }
                tabs={[
                  {
                    key: "per-segment",
                    label: t("settings.chatTranslate.suffixPerSegment"),
                  },
                  {
                    key: "unified",
                    label: t("settings.chatTranslate.suffixUnified"),
                  },
                ]}
              />
            </div>
            <div class="settings-modal__lang">
              <span class="settings-modal__lang-label">
                {t("settings.chatTranslate.splitChars")}
              </span>
              <HkNumberInput
                modelValue={store.config.send.splitChars}
                onUpdate:modelValue={(value: number) =>
                  void store.setSend({ splitChars: value })
                }
                min={40}
                max={138}
              />
            </div>
            <div class="settings-modal__lang">
              <span class="settings-modal__lang-label">
                {t("settings.chatTranslate.hintTimeout")}
              </span>
              <HkNumberInput
                modelValue={store.config.send.hintTimeoutS}
                onUpdate:modelValue={(value: number) =>
                  void store.setSend({ hintTimeoutS: value })
                }
                min={5}
                max={600}
                step={5}
              />
            </div>
          </div>
        </div>
      </HkModal>
    );
  },
});
