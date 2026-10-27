/** Chat-translation provider window: the OpenAI-compatible endpoint, the
 *  API key and its tri-state write semantics, the timeout/temperature knobs,
 *  the connectivity test and the try-translation probe — the end-to-end
 *  check lives here because it validates THIS configuration.
 *
 *  Drafts are component-local: the window opens by syncing them from the
 *  store, edits stay drafts until the footer's Save, and closing discards
 *  what was not saved (the touched flags reset on every open). That is the
 *  same conservative contract the old inline card had, minus the inline
 *  card: nothing writes the provider while the window is merely open.
 */
import { defineComponent, ref, watch } from "vue";
import {
  HkButton,
  HkInput,
  HkModal,
  HkNumberInput,
  HkSettingsHint,
  HkTag,
} from "@celestia-island/hikari";

import { t } from "@/i18n";
import type { ChatTranslateConfigPublic, DebugTranslationSource } from "@/api/modules/chat";
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
      if (saving.value) return;
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

    /** The one-line connectivity verdict (resolved in the render pass so a
     *  locale switch re-renders it with the rest of the window). */
    function testLine(): string | null {
      const result = store.testResult;
      if (!result) return null;
      if (!result.ok) {
        return t("settings.chatTranslate.testFail", { msg: result.error ?? "" });
      }
      return result.modelEcho
        ? t("settings.chatTranslate.testOkModel", {
            model: result.modelEcho,
            ms: result.latencyMs,
          })
        : t("settings.chatTranslate.testOk", { ms: result.latencyMs });
    }

    // ── try-translation probe (a local probe input, not settings) ──────────
    const debugDraft = ref("");

    function runDebugTranslate() {
      void store.debugTranslate(debugDraft.value);
    }

    function debugSourceLabel(source: DebugTranslationSource): string {
      switch (source) {
        case "passthrough":
          return t("settings.chatTranslate.trySourcePassthrough");
        case "untranslatable":
          return t("settings.chatTranslate.trySourceUntranslatable");
        default:
          return t("settings.chatTranslate.trySourceModel");
      }
    }

    function debugResultTitle(): string | null {
      const result = store.debugResult;
      if (!result) return null;
      return t("settings.chatTranslate.tryResult", { lang: result.detected ?? "—" });
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
            label: t("settings.chatTranslate.save"),
            variant: "primary",
            loading: saving.value,
            onClick: () => void save(),
          },
        ]}
      >
        <div class="chat-settings__section">
          <HkSettingsHint>{t("settings.chatTranslate.providerHint")}</HkSettingsHint>
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
                placeholder="deepseek-chat"
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
                    disabled={saving.value}
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
          <div class="chat-settings__hint-row">
            <HkButton
              size="sm"
              variant="ghost"
              disabled={store.testing}
              onClick={() => void store.testProvider()}
            >
              {store.testing
                ? t("settings.chatTranslate.testing")
                : t("settings.chatTranslate.testBtn")}
            </HkButton>
            {store.envKeyOverride ? (
              <HkTag variant="info" size="sm">
                {t("settings.chatTranslate.envOverrideBadge")}
              </HkTag>
            ) : null}
          </div>
          {testLine() ? <HkSettingsHint>{testLine()}</HkSettingsHint> : null}
          {saveFailed.value ? (
            <HkSettingsHint>{t("settings.chatTranslate.saveFailed")}</HkSettingsHint>
          ) : null}
        </div>

        {/* Try-translation probe — one line through the real pipeline with an
            empty match context; one result row per target language plus the
            source badge. Disabled (with the reason spelled out) while the
            feature is off or no key is stored. */}
        <div class="chat-settings__section">
          <HkSettingsHint>{t("settings.chatTranslate.tryTitle")}</HkSettingsHint>
          <div class="settings-modal__netmanual">
            <div class="settings-modal__netinput">
              <HkInput
                modelValue={debugDraft.value}
                onUpdate:modelValue={(value: string) => (debugDraft.value = value)}
                placeholder={t("settings.chatTranslate.tryLabel")}
                submitOnEnter={runDebugTranslate}
              />
            </div>
            <HkButton
              size="sm"
              variant="ghost"
              disabled={store.debugging || !store.config.enabled || !store.apiKeySet}
              onClick={runDebugTranslate}
            >
              {store.debugging
                ? t("settings.chatTranslate.tryRunning")
                : t("settings.chatTranslate.tryBtn")}
            </HkButton>
          </div>
          {!store.config.enabled || !store.apiKeySet ? (
            <HkSettingsHint>{t("settings.chatTranslate.tryNeedKey")}</HkSettingsHint>
          ) : null}
          {debugResultTitle() ? (
            <HkSettingsHint>{debugResultTitle()}</HkSettingsHint>
          ) : null}
          {store.debugResult && store.debugResult.translations.length === 0 ? (
            <HkSettingsHint>{t("settings.chatTranslate.tryEmpty")}</HkSettingsHint>
          ) : null}
          {store.debugResult && store.debugResult.translations.length > 0 ? (
            <div class="settings-modal__langs">
              {store.debugResult.translations.map((row) => (
                <div class="settings-modal__lang" key={row.lang} lang={row.lang}>
                  <span class="settings-modal__netmanual">
                    <span class="settings-modal__lang-label">{row.lang}</span>
                    <HkTag variant="info" size="sm">
                      {debugSourceLabel(row.source)}
                    </HkTag>
                  </span>
                  <span>{row.text || "—"}</span>
                </div>
              ))}
            </div>
          ) : null}
          {store.debugError ? (
            <HkSettingsHint>{store.debugError}</HkSettingsHint>
          ) : null}
        </div>
      </HkModal>
    );
  },
});
