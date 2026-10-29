/** Chat-translation provider window: a registry-driven shortcut plus fully
 *  editable endpoint fields.
 *
 *  The top row pairs a SERVICE-PROVIDER picker with a MODEL picker, both fed
 *  by the shared langyo/provider-registry catalog (fetched through the shell:
 *  24h cache unless the refresh button forces a live fetch). Picking a preset
 *  fills the base URL and its default model; "custom" keeps both editable, so
 *  the window never depends on the registry being reachable. The API key owns
 *  its own full-width row (tri-state semantics unchanged), and the two knobs
 *  nobody tunes — timeout and temperature — collapse into one advanced panel
 *  (hikari HkExpansionPanel, closed by default).
 *
 *  The window is a STAGED form: opening syncs the drafts from the store, edits
 *  stay drafts until the footer's Save, and closing discards what was not
 *  saved. The connectivity test lives in the footer and reports through
 *  toasts; the translation probe lives in its own window.
 */
import { computed, defineComponent, ref, watch } from "vue";
import {
  HkButton,
  HkExpansionPanel,
  HkIconButton,
  HkInput,
  HkModal,
  HkNumberInput,
  HkSelect,
  HkSettingsHint,
  HkSpinner,
  HkTag,
  useToast,
} from "@celestia-island/hikari";
import { RefreshCw } from "@lucide/vue";

import { i18n, t } from "@/i18n";
import type {
  ChatProviderEntry,
  ChatProviderNames,
  ChatTranslateConfigPublic,
} from "@/api/modules/chat";
import { useChatTranslateStore } from "@/stores/chatTranslate";

import "./chat-settings.scss";

/** The picker's "custom" ids: custom provider = manual base URL, custom model =
 *  the free-form model input. The model sentinel uses NUL so no registry id
 *  can ever collide with it. */
const CUSTOM_PROVIDER = "";
const CUSTOM_MODEL = "\u0000custom";

/** Map the running interface locale to the registry's name columns. */
const REGISTRY_LOCALE_KEYS: Record<string, keyof ChatProviderNames> = {
  "zh-CN": "zhs",
  "zh-TW": "zht",
  "ja-JP": "ja",
  "ko-KR": "ko",
  "ru-RU": "ru",
  "fr-FR": "fr",
  "es-ES": "es",
};

/** Compare endpoint URLs the way the shell would normalize them: trim and
 *  ignore trailing slashes (the preset match is a convenience, not a gate). */
function normalizedUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

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
    /** Registry entry id currently picked, or "" for the custom provider. */
    const providerSelectValue = ref(CUSTOM_PROVIDER);
    /** Model id picked from the entry's catalog, or CUSTOM_MODEL. */
    const modelSelectValue = ref(CUSTOM_MODEL);
    /** The footer's Save is in flight (double-clicks never queue twice). */
    const saving = ref(false);
    /** The last save of THIS open window failed (cleared on every open). */
    const saveFailed = ref(false);

    const entries = computed<ChatProviderEntry[]>(
      () => store.registry?.providers ?? [],
    );
    const selectedEntry = computed<ChatProviderEntry | null>(
      () =>
        entries.value.find((entry) => entry.id === providerSelectValue.value) ??
        null,
    );
    /** The model picker shows the free input for a custom provider AND for the
     *  custom-model choice of a preset provider. */
    const showModelInput = computed(
      () =>
        providerSelectValue.value === CUSTOM_PROVIDER ||
        modelSelectValue.value === CUSTOM_MODEL,
    );

    function registryName(entry: ChatProviderEntry): string {
      const locale = (i18n.global.locale as unknown as { value: string }).value;
      const key = REGISTRY_LOCALE_KEYS[locale] ?? "en";
      return entry.names[key] || entry.names.en || entry.providerId || entry.id;
    }

    function providerOptions() {
      return [
        { value: CUSTOM_PROVIDER, label: t("settings.chatTranslate.providerPresetCustom") },
        ...entries.value.map((entry) => ({
          value: entry.id,
          label: registryName(entry),
        })),
      ];
    }

    function modelOptions() {
      const entry = selectedEntry.value;
      const preset = entry
        ? entry.models.map((model) => ({
            value: model.id,
            label: model.name || model.id,
          }))
        : [];
      return [
        ...preset,
        { value: CUSTOM_MODEL, label: t("settings.chatTranslate.modelPresetCustom") },
      ];
    }

    /** Pull every draft from the store's current (shell-sanitized) config. */
    function syncDrafts(config: ChatTranslateConfigPublic) {
      baseUrlDraft.value = config.provider.baseUrl;
      modelDraft.value = config.provider.model;
      timeoutDraft.value = config.provider.timeoutMs;
      temperatureDraft.value = config.provider.temperature;
    }

    /** Mirror the stored endpoint/model onto the pickers (never rewrites the
     *  drafts): a matching base URL selects that registry entry, and a model
     *  that is in its catalog selects that model — otherwise "custom". */
    function resolveSelection() {
      const baseUrl = normalizedUrl(baseUrlDraft.value);
      // Several entrypoints can share one base URL (a provider's one-time and
      // coding-plan endpoints, for example). Prefer the one whose catalog
      // actually contains the stored model, then the most specific entry (the
      // shortest catalog — the plan lists are subsets of the full one).
      const candidates = entries.value.filter(
        (candidate) => normalizedUrl(candidate.baseUrl) === baseUrl,
      );
      const matching = candidates.filter((candidate) =>
        candidate.models.some((model) => model.id === modelDraft.value),
      );
      const entry = (matching.length > 0 ? matching : candidates).reduce<
        typeof candidates[number] | undefined
      >(
        (best, candidate) =>
          best === undefined || candidate.models.length < best.models.length
            ? candidate
            : best,
        undefined,
      );
      if (!entry) {
        providerSelectValue.value = CUSTOM_PROVIDER;
        modelSelectValue.value = CUSTOM_MODEL;
        return;
      }
      providerSelectValue.value = entry.id;
      const inCatalog = entry.models.some(
        (model) => model.id === modelDraft.value,
      );
      modelSelectValue.value = inCatalog ? modelDraft.value : CUSTOM_MODEL;
    }

    watch(
      () => store.config,
      (config) => {
        // A write triggered while the window is open (another pane saving)
        // must not clobber half-typed endpoint text: touched drafts win.
        if (!providerTouched.value) {
          syncDrafts(config);
          resolveSelection();
        }
        if (!apiKeyTouched.value) apiKeyDraft.value = "";
      },
      { immediate: true },
    );

    // The catalog arrives asynchronously: resolve the stored endpoint against
    // it once it lands, unless the user has already picked something.
    watch(
      () => store.registry,
      () => {
        if (props.modelValue && !providerTouched.value) resolveSelection();
      },
    );

    // Opening resets the touch flags and re-syncs: a cancelled window must
    // forget its unsaved drafts entirely, then fetch the catalog (cached).
    watch(
      () => props.modelValue,
      (open) => {
        if (!open) return;
        providerTouched.value = false;
        apiKeyTouched.value = false;
        apiKeyDraft.value = "";
        saveFailed.value = false;
        syncDrafts(store.config);
        resolveSelection();
        void store.loadRegistry(false);
      },
    );

    /** A preset provider fills the endpoint + its preferred model; picking the
     *  custom provider keeps whatever is there so both fields stay editable. */
    function selectProvider(value: string) {
      providerTouched.value = true;
      providerSelectValue.value = value;
      if (value === CUSTOM_PROVIDER) {
        modelSelectValue.value = CUSTOM_MODEL;
        return;
      }
      const entry = entries.value.find((candidate) => candidate.id === value);
      if (!entry) return;
      baseUrlDraft.value = entry.baseUrl;
      const preferred = entry.defaultModel ?? entry.models[0]?.id ?? "";
      if (preferred !== "") modelDraft.value = preferred;
      modelSelectValue.value =
        preferred !== "" && entry.models.some((model) => model.id === preferred)
          ? preferred
          : CUSTOM_MODEL;
    }

    function selectModel(value: string) {
      providerTouched.value = true;
      modelSelectValue.value = value;
      if (value !== CUSTOM_MODEL) modelDraft.value = value;
    }

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

          {/* ── provider + model (registry-driven shortcuts) ── */}
          <div class="settings-modal__langs">
            <div class="settings-modal__lang">
              <span class="settings-modal__lang-label">
                {t("settings.chatTranslate.providerPreset")}
              </span>
              <div class="chat-settings__provider-select">
                <HkSelect
                  modelValue={providerSelectValue.value}
                  onUpdate:modelValue={(value: string) => selectProvider(value)}
                  options={providerOptions()}
                  panelTitle={t("settings.chatTranslate.providerPreset")}
                  placeholder={t("settings.chatTranslate.providerPresetCustom")}
                  disabled={store.registryLoading && entries.value.length === 0}
                />
                <HkIconButton
                  size={28}
                  disabled={store.registryLoading}
                  aria-label={t("settings.chatTranslate.registryRefresh")}
                  onClick={() => void store.loadRegistry(true)}
                >
                  {store.registryLoading ? (
                    <HkSpinner size={16} />
                  ) : (
                    <RefreshCw size={16} />
                  )}
                </HkIconButton>
              </div>
            </div>
            <div class="settings-modal__lang">
              <span class="settings-modal__lang-label">
                {t("settings.chatTranslate.modelPreset")}
              </span>
              {showModelInput.value && providerSelectValue.value !== CUSTOM_PROVIDER ? (
                <div class="chat-settings__field">
                  <HkSelect
                    modelValue={modelSelectValue.value}
                    onUpdate:modelValue={(value: string) => selectModel(value)}
                    options={modelOptions()}
                    panelTitle={t("settings.chatTranslate.modelPreset")}
                  />
                  <HkInput
                    modelValue={modelDraft.value}
                    onUpdate:modelValue={(value: string) => {
                      providerTouched.value = true;
                      modelSelectValue.value = CUSTOM_MODEL;
                      modelDraft.value = value;
                    }}
                    placeholder="deepseek-flash"
                    submitOnEnter={save}
                  />
                </div>
              ) : showModelInput.value ? (
                <HkInput
                  modelValue={modelDraft.value}
                  onUpdate:modelValue={(value: string) => {
                    providerTouched.value = true;
                    modelDraft.value = value;
                  }}
                  placeholder="deepseek-flash"
                  submitOnEnter={save}
                />
              ) : (
                <HkSelect
                  modelValue={modelSelectValue.value}
                  onUpdate:modelValue={(value: string) => selectModel(value)}
                  options={modelOptions()}
                  panelTitle={t("settings.chatTranslate.modelPreset")}
                />
              )}
            </div>
          </div>

          {store.registryLoading ? (
            <HkSettingsHint>
              {t("settings.chatTranslate.registryLoading")}
            </HkSettingsHint>
          ) : null}
          {!store.registryLoading && store.registryError ? (
            <HkSettingsHint>
              {t("settings.chatTranslate.registryFailed")} {store.registryError}
            </HkSettingsHint>
          ) : null}
          {!store.registryLoading && !store.registryError && store.registryStale ? (
            <HkSettingsHint>{t("settings.chatTranslate.registryStale")}</HkSettingsHint>
          ) : null}

          {/* ── endpoint: its own full-width row (presets only fill it) ── */}
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
            {/* Both knobs on ONE line (the review asked for "timeout and
                temperature as parameters in a row"): each is a label + a
                compact field; the row wraps only on genuinely narrow
                windows. */}
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
