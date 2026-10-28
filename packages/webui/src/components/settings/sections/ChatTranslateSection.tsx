/** Chat-translation settings (设置 → 聊天翻译), grouped and gated.
 *
 *  The pane is deliberately staged (user feedback):
 *
 *  1. OFF shows ONLY the master switch and one line explaining what turning it
 *     on unlocks — no configuration tree behind a feature nobody enabled;
 *  2. flipping the switch on for the first time opens the CONSENT window
 *     (hikari HkModal, ConsentModal) instead of enabling: chat text reaches a
 *     third-party provider only after that explicit agreement;
 *  3. ON shows four COMPACT cards — provider / languages / sending / display —
 *     each a read-only summary plus a Configure button that opens its own
 *     secondary window. Only the primary send choice (off/clipboard) and the
 *     overlay panel switches stay inline; the details (endpoint, key, target
 *     languages, suffix/split knobs) live one click away.
 *
 *  The provider key's tri-state write semantics and the staged drafts moved
 *  into the provider window with the controls; this section owns only the
 *  gate, the summaries and the window open state.
 */
import { defineComponent, ref } from "vue";
import {
  HkButton,
  HkNumberInput,
  HkSettingsGroup,
  HkSettingsHint,
  HkSettingsSub,
  HkSwitch,
  HkTag,
  HkTabs,
} from "@celestia-island/hikari";

import { t } from "@/i18n";
import type { ChatTranslateSendMode } from "@/api/modules/chat";
import { useChatTranslateStore } from "@/stores/chatTranslate";
import { useOverlayConfigStore } from "@/stores/overlayConfig";
// The shared label-left / value-right row grammar (the same one the stats and
// overlay sections use).
import "../../stats/StatsPrefsControls.scss";
import ConsentModal from "@/components/settings/chat/ConsentModal";
import LanguagesModal from "@/components/settings/chat/LanguagesModal";
import ProviderModal from "@/components/settings/chat/ProviderModal";
import SendModal from "@/components/settings/chat/SendModal";
import TranslateTestModal from "@/components/settings/chat/TranslateTestModal";
import { endpointHost, languageLabel } from "@/components/settings/chat/shared";
import "../chat/chat-settings.scss";

/** One read-only summary row: a label from the settings namespace and the
 *  current value on the right (stats-prefs grammar, no interaction). */
function SummaryRow(props: { label: string; value: string }) {
  return (
    <div class="stats-prefs__row">
      <span class="stats-prefs__row-text">
        <span class="stats-prefs__row-label">{props.label}</span>
      </span>
      <span class="chat-settings__value">{props.value === "" ? "—" : props.value}</span>
    </div>
  );
}

export default defineComponent({
  name: "SettingsChatTranslateSection",
  setup() {
    const store = useChatTranslateStore();
    const overlayCfg = useOverlayConfigStore();
    void store.load();
    void overlayCfg.load();

    // ── windows ──────────────────────────────────────────────────────────
    const consentOpen = ref(false);
    const providerOpen = ref(false);
    const languagesOpen = ref(false);
    const sendOpen = ref(false);
    const translateTestOpen = ref(false);

    // ── master switch + first-enable consent ─────────────────────────────
    // Enabling without a recorded consent must not persist: the switch opens
    // the consent window instead, and only its "Agree and enable" stamps
    // consentVersion 1 together with enabled=true (one store write).
    function toggleEnabled(next: boolean) {
      if (next && store.config.consentVersion < 1) {
        consentOpen.value = true;
        return;
      }
      void store.setEnabled(next);
    }

    /** The reading language's display name (the follow-UI choice stays a
     *  sentence, not an empty cell). */
    function selfLangLabel(): string {
      const tag = store.config.languages.selfLang;
      return tag === ""
        ? t("settings.chatTranslate.selfLangAuto")
        : languageLabel(tag);
    }

    function modeLabel(): string {
      return store.config.languages.mode === "fixed"
        ? t("settings.chatTranslate.modeFixed")
        : t("settings.chatTranslate.modeAuto");
    }

    /** The summary chip's STATUS text — short, unlike the input's placeholder
     *  copy ("configured — type to replace" reads wrong in a read-only row). */
    function keyLabel(): string {
      return store.apiKeySet
        ? t("settings.chatTranslate.apiKeyConfigured")
        : t("settings.chatTranslate.apiKeyUnset");
    }

    return () => (
      <>
        <HkSettingsGroup title={t("settings.chatTranslate.title")}>
          <HkSettingsHint>{t("settings.chatTranslate.enableDesc")}</HkSettingsHint>
          <div class="stats-prefs">
            <div class="stats-prefs__row">
              <span class="stats-prefs__row-text">
                <span class="stats-prefs__row-label">
                  {t("settings.chatTranslate.enable")}
                </span>
              </span>
              <HkSwitch
                modelValue={store.config.enabled}
                onUpdate:modelValue={(value: boolean) => toggleEnabled(value)}
              />
            </div>
          </div>
          {!store.config.enabled ? (
            // OFF: the only visible copy. Nothing below the switch renders
            // until the feature is on (and consented).
            <HkSettingsHint>{t("settings.chatTranslate.offHint")}</HkSettingsHint>
          ) : (
            <>
              {/* ── provider summary ── */}
              <HkSettingsSub title={t("settings.chatTranslate.providerTitle")}>
                <div class="stats-prefs">
                  <SummaryRow
                    label={t("settings.chatTranslate.model")}
                    value={store.config.provider.model}
                  />
                  <SummaryRow
                    label={t("settings.chatTranslate.baseUrl")}
                    value={endpointHost(store.config.provider.baseUrl)}
                  />
                  <div class="stats-prefs__row">
                    <span class="stats-prefs__row-text">
                      <span class="stats-prefs__row-label">
                        {t("settings.chatTranslate.apiKey")}
                      </span>
                    </span>
                    <span class="chat-settings__tags">
                      <HkTag
                        variant={store.apiKeySet ? "success" : "warning"}
                        size="sm"
                      >
                        {keyLabel()}
                      </HkTag>
                      {store.envKeyOverride ? (
                        <HkTag variant="info" size="sm">
                          {t("settings.chatTranslate.envOverrideBadge")}
                        </HkTag>
                      ) : null}
                    </span>
                  </div>
                </div>
                <div class="chat-settings__hint-row">
                  <HkButton
                    size="sm"
                    onClick={() => (providerOpen.value = true)}
                  >
                    {t("settings.chatTranslate.providerConfigure")}
                  </HkButton>
                </div>
              </HkSettingsSub>

              {/* ── languages summary ── */}
              <HkSettingsSub title={t("settings.chatTranslate.languagesTitle")}>
                <div class="stats-prefs">
                  <SummaryRow
                    label={t("settings.chatTranslate.selfLang")}
                    value={selfLangLabel()}
                  />
                  <SummaryRow
                    label={t("settings.chatTranslate.mode")}
                    value={modeLabel()}
                  />
                  <SummaryRow
                    label={t("settings.chatTranslate.maxTargets")}
                    value={String(store.config.languages.maxTargets)}
                  />
                </div>
                <div class="chat-settings__hint-row">
                  <HkButton
                    size="sm"
                    onClick={() => (languagesOpen.value = true)}
                  >
                    {t("settings.chatTranslate.languagesConfigure")}
                  </HkButton>
                </div>
              </HkSettingsSub>

              {/* ── sending: the primary off/clipboard pick stays inline ── */}
              <HkSettingsSub title={t("settings.chatTranslate.sendTitle")}>
                <div class="stats-prefs">
                  <div class="stats-prefs__row">
                    <span class="stats-prefs__row-text">
                      <span class="stats-prefs__row-label">
                        {t("settings.chatTranslate.sendMode")}
                      </span>
                      <span class="stats-prefs__row-desc">
                        {t("settings.chatTranslate.sendModeDesc")}
                      </span>
                    </span>
                    <HkTabs
                      block
                      variant="segmented"
                      modelValue={store.sendMode}
                      onUpdate:modelValue={(value: string) =>
                        void store.setSendMode(value as ChatTranslateSendMode)
                      }
                      tabs={[
                        {
                          key: "off",
                          label: t("settings.chatTranslate.sendModeOff"),
                        },
                        {
                          key: "clipboard",
                          label: t("settings.chatTranslate.sendModeClipboard"),
                        },
                      ]}
                    />
                  </div>
                </div>
                <div class="chat-settings__hint-row">
                  <HkButton size="sm" onClick={() => (sendOpen.value = true)}>
                    {t("settings.chatTranslate.sendConfigure")}
                  </HkButton>
                </div>
              </HkSettingsSub>

              {/* ── display (overlay-config.toml, through the overlay store):
                     two inline rows, no window — this is the overlay panel's
                     own switch, not translation-service configuration. ── */}
              <HkSettingsSub title={t("settings.chatTranslate.displayTitle")}>
                <div class="stats-prefs">
                  <div class="stats-prefs__row">
                    <span class="stats-prefs__row-text">
                      <span class="stats-prefs__row-label">
                        {t("settings.chatTranslate.panelEnable")}
                      </span>
                      <span class="stats-prefs__row-desc">
                        {t("settings.chatTranslate.panelEnableDesc")}
                      </span>
                    </span>
                    <HkSwitch
                      modelValue={overlayCfg.chatPanel}
                      onUpdate:modelValue={(value: boolean) =>
                        void overlayCfg.setChatPanel(value)
                      }
                    />
                  </div>
                  <div class="stats-prefs__row">
                    <span class="stats-prefs__row-text">
                      <span class="stats-prefs__row-label">
                        {t("settings.chatTranslate.panelMaxLines")}
                      </span>
                    </span>
                    <HkNumberInput
                      modelValue={overlayCfg.chatPanelMaxLines}
                      onUpdate:modelValue={(value: number) =>
                        void overlayCfg.setChatPanelMaxLines(value)
                      }
                      min={3}
                      max={30}
                    />
                  </div>
                </div>
              </HkSettingsSub>

              {/* ── translation test: the end-to-end probe in its own window
                     (the provider window configures, this one validates) ── */}
              <div class="chat-settings__hint-row">
                <HkButton
                  size="sm"
                  onClick={() => (translateTestOpen.value = true)}
                >
                  {t("settings.chatTranslate.translateTestOpen")}
                </HkButton>
                <HkSettingsHint>
                  {t("settings.chatTranslate.translateTestHint")}
                </HkSettingsHint>
              </div>
            </>
          )}
        </HkSettingsGroup>

        <ConsentModal
          modelValue={consentOpen.value}
          onUpdate:modelValue={(value: boolean) => (consentOpen.value = value)}
        />
        <ProviderModal
          modelValue={providerOpen.value}
          onUpdate:modelValue={(value: boolean) => (providerOpen.value = value)}
        />
        <LanguagesModal
          modelValue={languagesOpen.value}
          onUpdate:modelValue={(value: boolean) => (languagesOpen.value = value)}
        />
        <SendModal
          modelValue={sendOpen.value}
          onUpdate:modelValue={(value: boolean) => (sendOpen.value = value)}
        />
        <TranslateTestModal
          modelValue={translateTestOpen.value}
          onUpdate:modelValue={(value: boolean) => (translateTestOpen.value = value)}
        />
      </>
    );
  },
});
