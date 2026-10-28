/** Chat-translation provider window: the OpenAI-compatible endpoint, the
 *  API key and its tri-state write semantics, and the timeout/temperature
 *  knobs. The window is a STAGED form: opening syncs the drafts from the
 *  store, edits stay drafts until the footer's Save, and closing discards
 *  what was not saved (the touched flags reset on every open) — nothing
 *  writes the provider while the window is merely open.
 *
 *  The connectivity test lives in the footer (right before Save) and reports
 *  through hikari toasts (success carries the round-trip latency + echoed
 *  model; failure carries the shell's user-facing sentence wrapped in the
 *  localized template) — no inline verdict lines anymore. The translation
 *  probe moved OUT of this window into its own TranslateTestModal: testing a
 *  translation is a different job from configuring the provider.
 */
import { defineComponent, ref, watch } from "vue";
import {
  HkButton,
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
    /** The last save of THIS open window failed (cleared on every open, so a
     *  stale failure never greets the next visit). */
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
        // shell-sanitized values (a healed URL, a clamped numeric) and the
        // window closes, so there is nothing left on screen to protect.
        providerTouched.value = false;
        apiKeyTouched.value = false;
        apiKeyDraft.value = "";
        close();
        return;
      }
      // A FAILED write (no shell command, broken file) keeps the window open
      // AND the drafts untouched — the typed key stays on screen so a retry
      // saves the same value; clearing it here would silently degrade a
      // retry into "leave the stored key unchanged".
      saveFailed.value = true;
    }

    function clearApiKey() {
      apiKeyTouched.value = false;
      apiKeyDraft.value = "";
      void store.setProvider({}, "");
    }

    /** Footer connectivity test: run the shell probe, then toast the verdict.
     *  Success carries the latency (and the provider-echoed model when it
     *  reported one); failure wraps the shell's raw sentence in the localized
     *  testFail template. Never leaves a stale inline verdict behind. */
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
          <div class="settings-modal__langs">
            <div class="settings-modal__lang">
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
            <div class="settings-modal__lang">
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
          </div>
          <div class="settings-modal__langs">
            <div class="settings-modal__lang">
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
            <div class="settings-modal__lang">
              <span class="settings-modal__lang-label">
                {t("settings.chatTranslate.timeoutMs")}
              </span>
              <HkNumberInput
                modelValue={timeoutDraft.value}
                onUpdate:modelValue={(value: number) => {
                  providerTouched.value = true;
                  timeoutDraft.value = value;
                }}
                min={3000}
                max={60000}
                step={500}
              />
            </div>
            <div class="settings-modal__lang">
              <span class="settings-modal__lang-label">
                {t("settings.chatTranslate.temperature")}
              </span>
              <HkNumberInput
                modelValue={temperatureDraft.value}
                onUpdate:modelValue={(value: number) => {
                  providerTouched.value = true;
                  temperatureDraft.value = value;
                }}
                min={0}
                max={2}
                step={0.1}
              />
            </div>
          </div>
          {saveFailed.value ? (
            <HkSettingsHint>{t("settings.chatTranslate.saveFailed")}</HkSettingsHint>
          ) : null}
        </div>
      </HkModal>
    );
  },
});
