/** Chat-translation first-enable consent window.
 *
 *  The master switch alone must never post chat text to a third party: when
 *  consentVersion is still 0, flipping the switch opens THIS window instead of
 *  enabling, and only "Agree and enable" stamps consentVersion 1 together
 *  with enabled=true (one store write). Built on hikari's HkModal — the repo's
 *  one window component (the feedback export consent window is the sibling
 *  precedent); HkModal teleports to body, so the window stacks over the
 *  settings modal without any local overlay DOM.
 */
import { defineComponent } from "vue";
import { HkModal } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { useChatTranslateStore } from "@/stores/chatTranslate";

import "./chat-settings.scss";

export default defineComponent({
  name: "ChatTranslateConsentModal",
  props: {
    modelValue: { type: Boolean, required: true },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    const store = useChatTranslateStore();
    const close = () => emit("update:modelValue", false);
    const agree = () => {
      void store.acceptConsent();
      close();
    };
    return () => (
      <HkModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(value: boolean) => {
          if (!value) close();
        }}
        title={t("settings.chatTranslate.consentTitle")}
        width="32rem"
        footerActions={[
          {
            label: t("settings.chatTranslate.consentCancel"),
            variant: "secondary",
            onClick: close,
          },
          {
            label: t("settings.chatTranslate.consentAgree"),
            variant: "primary",
            onClick: agree,
          },
        ]}
      >
        <div class="chat-settings__consent">
          <p class="chat-settings__consent-body">
            {t("settings.chatTranslate.consentBody")}
          </p>
          <p class="chat-settings__consent-lead">
            {t("settings.chatTranslate.consentLead")}
          </p>
          <ul class="chat-settings__consent-list">
            <li>{t("settings.chatTranslate.consentItemText")}</li>
            <li>{t("settings.chatTranslate.consentItemContext")}</li>
            <li>{t("settings.chatTranslate.consentItemProvider")}</li>
            <li>{t("settings.chatTranslate.consentItemLocal")}</li>
          </ul>
        </div>
      </HkModal>
    );
  },
});
