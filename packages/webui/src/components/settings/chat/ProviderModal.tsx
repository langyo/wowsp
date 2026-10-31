/** Chat-translation provider window: the OpenAI-compatible endpoint, the
 *  model name and the API key, all typed by hand.
 *
 *  The registry shortcut that once filled these fields was removed on user
 *  request: the tools list keeps changing and the player decides which
 *  endpoint/model to use. The window therefore stays a plain form — the
 *  endpoint owns a full-width row, so does the model (placeholder = the
 *  shell's default deepseek-flash), and so does the API key (tri-state
 *  semantics unchanged). The two knobs nobody tunes — timeout and temperature
 *  — collapse into one advanced panel (hikari HkExpansionPanel, closed by
 *  default) as two compact parameters on one line.
 *
 *  The window is a STAGED form: opening syncs the drafts from the store, edits
 *  stay drafts until the footer's Save, and closing discards what was not
 *  saved. The connectivity test lives in the footer and reports through
 *  toasts; the translation probe lives in its own window.
 */
import { defineComponent, ref, watch } from "vue";
import {
  HkButton,
  HkExpansionPanel,
  HkInput,
  HkModal,
  HkNumberInput,
  HkSettingsHint,
  HkTag,
  useToast,
} from "@celestia-island/hikari";

import { t } from "@/i18n";
import type { ChatTranslateConfigPublic } from "@/api/modules/chat";
import { useChatTranslateStore } from "@/stores/chatTranslate";

import "./chat-settings.scss";

export default defineComponent({
  name: "ChatTranslateProviderModal",
  props: {
    modelValue: { type: Boolean, required: true },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    const store = useChatTranslateStore();
    const toast = useToast();
    const close = () => emit("update:modelValue", false);

    // ── drafts (the tri-state key: untouched = null, typed = value, clear = "") ──
    const baseUrlDraft = ref("");
    const modelDraft = ref("");
    const apiKeyDraft = ref("");
    const apiKeyTouched = ref(false);
    const timeoutDraft = ref(10000);
    const temperatureDraft = ref(0);
    const providerTouched = ref(false);
    /** The footer's Save is in flight (double-clicks never queue twice). */
    const saving = ref(false);
    /** The last save of THIS open window failed (cleared on every open). */
    const saveFailed = ref(false);

    /** Pull every draft from the store's current (shell-sanitized) config. */
    function syncDrafts(config: ChatTranslateConfigPublic) {
      baseUrlDraft.value = config.provider.baseUrl;
      modelDraft.value = config.provider.model;
      timeoutDraft.value = config.provider.timeoutMs;
      temperatureDraft.value = config.provider.temperature;
    }

    watch(
      () => store.config,
      (config) => {
        // A write triggered while the window is open (another pane saving)
        // must not clobber half-typed endpoint text: touched drafts win.
        if (!providerTouched.value) {
          syncDrafts(config);
        }
        if (!apiKeyTouched.value) apiKeyDraft.value = "";
      },
      { immediate: true },
    );

    // Opening resets the touch flags and re-syncs: a cancelled window must
    // forget its unsaved drafts entirely.
    watch(
      () => props.modelValue,
      (open) => {
        if (!open) return;
        providerTouched.value = false;
        apiKeyTouched.value = false;
        apiKeyDraft.value = "";
        saveFailed.value = false;
        syncDrafts(store.config);
      },
    );

    async function save(): Promise<void> {
      // A connectivity probe in flight answers for the STORED config: an edit
      // landing mid-probe (footer Save, or an input's Enter) would mislabel
      // the result. The footer button is disabled too; this covers Enter.
      if (saving.value || store.testing) return;
      const apiKey = apiKeyTouched.value ? apiKeyDraft.value : null;
      saving.value = true;
      try {
        await store.setProvider(
          {
            baseUrl: baseUrlDraft.value.trim(),
            model: modelDraft.value.trim(),
            timeoutMs: Math.round(timeoutDraft.value),
            temperature: temperatureDraft.value,
          },
          apiKey,
        );
      } finally {
        saving.value = false;
      }
      if (store.lastSaveOk) {
        // Saved: release the drafts; the reply re-synced them from the
        // shell-sanitized values and the window closes.
        providerTouched.value = false;
        apiKeyTouched.value = false;
        apiKeyDraft.value = "";
        close();
        return;
      }
      // A FAILED write keeps the window open AND the typed key on screen so a
      // retry saves the same value.
      saveFailed.value = true;
    }

    function clearApiKey() {
      apiKeyTouched.value = false;
      apiKeyDraft.value = "";
      void store.setProvider({}, "");
    }

    /** Footer connectivity test: run the shell probe, then toast the verdict. */
    async function runTest(): Promise<void> {
      await store.testProvider();
      const result = store.testResult;
      if (!result) return;
      if (result.ok) {
        const message = result.modelEcho
          ? t("settings.chatTranslate.testOkModel", {
              model: result.modelEcho,
              ms: result.latencyMs,
            })
          : t("settings.chatTranslate.testOk", { ms: result.latencyMs });
        toast.success(message);
        return;
      }
      toast.error(
        t("settings.chatTranslate.testFail", { msg: result.error ?? "" }),
      );
    }

    return () => (
      <HkModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(value: boolean) => {
          if (!value) close();
        }}
        title={t("settings.chatTranslate.providerTitle")}
        width="36rem"
        footerActions={[
          {
            label: t("settings.chatTranslate.close"),
            variant: "secondary",
            onClick: close,
          },
          {
            label: t("settings.chatTranslate.testBtn"),
            variant: "secondary",
            loading: store.testing,
            disabled: store.testing,
            onClick: () => void runTest(),
          },
          {
            label: t("settings.chatTranslate.save"),
            variant: "primary",
            loading: saving.value,
            // A test in flight probes the STORED provider: letting a save
            // (or a clear) land mid-probe would answer for a config nobody
            // sees anymore.
            disabled: store.testing,
            onClick: () => void save(),
          },
        ]}
      >
        <div class="chat-settings__section">
          <div class="chat-settings__hint-row">
            <HkSettingsHint>{t("settings.chatTranslate.providerHint")}</HkSettingsHint>
            {store.envKeyOverride ? (
              <HkTag variant="info" size="sm">
                {t("settings.chatTranslate.envOverrideBadge")}
              </HkTag>
            ) : null}
          </div>

          {/* ── endpoint: its own full-width row ── */}
          <div class="chat-settings__field">
            <span class="settings-modal__lang-label">
              {t("settings.chatTranslate.baseUrl")}
            </span>
            <HkInput
              modelValue={baseUrlDraft.value}
              onUpdate:modelValue={(value: string) => {
                providerTouched.value = true;
                baseUrlDraft.value = value;
              }}
              placeholder="https://api.deepseek.com"
              submitOnEnter={save}
            />
            <HkSettingsHint>{t("settings.chatTranslate.baseUrlDesc")}</HkSettingsHint>
          </div>

          {/* ── model: its own full-width row (placeholder = shell default) ── */}
          <div class="chat-settings__field">
            <span class="settings-modal__lang-label">
              {t("settings.chatTranslate.model")}
            </span>
            <HkInput
              modelValue={modelDraft.value}
              onUpdate:modelValue={(value: string) => {
                providerTouched.value = true;
                modelDraft.value = value;
              }}
              placeholder="deepseek-flash"
              submitOnEnter={save}
            />
          </div>

          {/* ── API key: its own full-width row (tri-state semantics kept) ── */}
          <div class="chat-settings__field">
            <span class="settings-modal__lang-label">
              {t("settings.chatTranslate.apiKey")}
            </span>
            <div class="settings-modal__netmanual">
              <div class="settings-modal__netinput">
                <HkInput
                  variant="password"
                  modelValue={apiKeyDraft.value}
                  onUpdate:modelValue={(value: string) => {
                    apiKeyTouched.value = true;
                    apiKeyDraft.value = value;
                  }}
                  placeholder={
                    store.apiKeySet
                      ? t("settings.chatTranslate.apiKeySet")
                      : t("settings.chatTranslate.apiKeyMissing")
                  }
                  submitOnEnter={save}
                />
              </div>
              {store.apiKeySet ? (
                <HkButton
                  size="sm"
                  variant="ghost"
                  disabled={saving.value || store.testing}
                  onClick={clearApiKey}
                >
                  {t("settings.chatTranslate.apiKeyClear")}
                </HkButton>
              ) : null}
            </div>
          </div>

          {/* ── the two knobs nobody tunes, collapsed by default ── */}
          <HkExpansionPanel
            class="chat-settings__advanced-panel"
            title={t("settings.chatTranslate.advancedParams")}
            subtitle={t("settings.chatTranslate.advancedHint")}
          >
            {/* Both knobs on ONE line: each is a label + a compact field; the
                row only wraps on genuinely narrow windows. */}
            <div class="chat-settings__param-row">
              <label class="chat-settings__param">
                <span class="settings-modal__lang-label">
                  {t("settings.chatTranslate.timeoutMs")}
                </span>
                <HkNumberInput
                  class="chat-settings__number"
                  modelValue={timeoutDraft.value}
                  onUpdate:modelValue={(value: number) => {
                    providerTouched.value = true;
                    timeoutDraft.value = value;
                  }}
                  min={3000}
                  max={60000}
                  step={500}
                />
              </label>
              <label class="chat-settings__param">
                <span class="settings-modal__lang-label">
                  {t("settings.chatTranslate.temperature")}
                </span>
                <HkNumberInput
                  class="chat-settings__number"
                  modelValue={temperatureDraft.value}
                  onUpdate:modelValue={(value: number) => {
                    providerTouched.value = true;
                    temperatureDraft.value = value;
                  }}
                  min={0}
                  max={2}
                  step={0.1}
                />
              </label>
            </div>
          </HkExpansionPanel>

          {saveFailed.value ? (
            <HkSettingsHint>{t("settings.chatTranslate.saveFailed")}</HkSettingsHint>
          ) : null}
        </div>
      </HkModal>
    );
  },
});
