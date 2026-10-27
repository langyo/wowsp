/** Chat-translation settings section: the master switch + first-enable
 *  consent, the OpenAI-compatible provider card (endpoint/key/timeouts and
 *  the connectivity test), the target-language card, the overlay panel row
 *  (persisted in overlay-config.toml through stores/overlayConfig) and the
 *  send-suffix card.
 *
 *  Translation itself ships in a later version: this section stores the
 *  configuration and manages the provider key, and says so while the
 *  master switch is off.
 */
import { defineComponent, ref, watch } from "vue";
import {
  HkButton,
  HkCheckbox,
  HkInput,
  HkNumberInput,
  HkSelect,
  HkSettingsGroup,
  HkSettingsHint,
  HkSettingsSub,
  HkSwitch,
  HkTag,
  HkTabs,
} from "@celestia-island/hikari";

import { t } from "@/i18n";
import {
  SUPPORTED_TRANSLATE_LANGS,
  TRANSLATE_LANG_LABELS,
  type ChatTranslateSendMode,
  type DebugTranslationSource,
  type TranslateLang,
} from "@/api/modules/chat";
import { useChatTranslateStore } from "@/stores/chatTranslate";
import { useOverlayConfigStore } from "@/stores/overlayConfig";
// The shared label/description-left, control-right row grammar (the same
// one the stats and overlay sections use).
import "../../stats/StatsPrefsControls.scss";

/** Language tags as the checkbox grid's option list (native names). */
const LANG_OPTIONS = SUPPORTED_TRANSLATE_LANGS.map((lang) => ({
  lang,
  label: TRANSLATE_LANG_LABELS[lang],
}));

export default defineComponent({
  name: "SettingsChatTranslateSection",
  setup() {
    const store = useChatTranslateStore();
    const overlayCfg = useOverlayConfigStore();
    void store.load();
    void overlayCfg.load();

    // ── master switch + first-enable consent ─────────────────────────────
    // Enabling without a recorded consent must not persist: the switch
    // stays off and the inline consent block opens until "Agree and
    // enable" stamps consentVersion 1 in the same write.
    const consentOpen = ref(false);

    function toggleEnabled(next: boolean) {
      if (next && store.config.consentVersion < 1) {
        consentOpen.value = true;
        return;
      }
      void store.setEnabled(next);
    }

    function acceptConsent() {
      consentOpen.value = false;
      void store.acceptConsent();
    }

    // ── provider card drafts ─────────────────────────────────────────────
    // The endpoint rows stage local drafts and commit through the card's
    // Save button (the network rows' grammar). The key stays tri-state:
    // untouched = null (unchanged), typed = replace, Clear = "".
    const baseUrlDraft = ref("");
    const modelDraft = ref("");
    const apiKeyDraft = ref("");
    const apiKeyTouched = ref(false);
    const timeoutDraft = ref(10000);
    const temperatureDraft = ref(0);
    // A provider field edit stays a local draft until the card's Save: a
    // write triggered by ANOTHER card (a language toggle, …) resyncs the
    // store, and clobbering half-typed endpoint text there would lose the
    // user's input. Touched drafts keep their value; Save clears the flag.
    const providerTouched = ref(false);

    watch(
      () => store.config,
      (cfg) => {
        if (!providerTouched.value) {
          baseUrlDraft.value = cfg.provider.baseUrl;
          modelDraft.value = cfg.provider.model;
          timeoutDraft.value = cfg.provider.timeoutMs;
          temperatureDraft.value = cfg.provider.temperature;
        }
        // A saved key must leave the password field empty: the shell
        // never echoes it back, so a stale draft would be misleading.
        if (!apiKeyTouched.value) apiKeyDraft.value = "";
      },
      { immediate: true },
    );

    function saveProvider() {
      const apiKey = apiKeyTouched.value ? apiKeyDraft.value : null;
      // Release the drafts BEFORE the write settles: when the reply lands,
      // the config watcher above resyncs them from the shell-SANITIZED
      // values (a healed base URL, a clamped timeout) instead of keeping
      // what the user typed. A failed write simply leaves the drafts
      // unsynced — nothing is invented.
      providerTouched.value = false;
      apiKeyTouched.value = false;
      apiKeyDraft.value = "";
      void store.setProvider(
        {
          baseUrl: baseUrlDraft.value.trim(),
          model: modelDraft.value.trim(),
          timeoutMs: Math.round(timeoutDraft.value),
          temperature: temperatureDraft.value,
        },
        apiKey,
      );
    }

    function clearApiKey() {
      // Same release-first order: the reply's apiKeySet=false plus the
      // empty draft is the only state the card should show afterwards.
      apiKeyTouched.value = false;
      apiKeyDraft.value = "";
      void store.setProvider({}, "");
    }

    /** The one-line test verdict (null until the first run). Resolved in
     *  the render pass, like every other t() call, so a locale switch
     *  re-renders it with the rest of the card. */
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

    // ── try-translation probe ────────────────────────────────────────────
    // The typed line runs through the shell's real pipeline (detection →
    // prompt → provider → validation) with an empty match context; the
    // result lists one row per target language plus the detected source
    // language. The draft stays LOCAL: it is a probe input, not settings.
    const debugDraft = ref("");

    function runDebugTranslate() {
      void store.debugTranslate(debugDraft.value);
    }

    /** The source badge's copy for one result row. */
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

    /** Result header: the detected source language when the model reported
     *  one, otherwise a neutral dash placeholder. Resolved in the render
     *  pass like every other t() call so a locale switch re-renders it. */
    function debugResultTitle(): string | null {
      const result = store.debugResult;
      if (!result) return null;
      return t("settings.chatTranslate.tryResult", { lang: result.detected ?? "—" });
    }

    // ── language card ────────────────────────────────────────────────────
    function toggleAlways(lang: TranslateLang) {
      const current = store.config.languages.always;
      const next = current.includes(lang)
        ? current.filter((v) => v !== lang)
        : [...current, lang];
      void store.setLanguages({ always: next });
    }

    function toggleExclude(lang: TranslateLang) {
      const current = store.config.languages.exclude;
      const next = current.includes(lang)
        ? current.filter((v) => v !== lang)
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
                onUpdate:modelValue={(v: boolean) => toggleEnabled(v)}
              />
            </div>
          </div>
          {store.envKeyOverride ? (
            <HkTag variant="info" size="sm">
              {t("settings.chatTranslate.envOverrideBadge")}
            </HkTag>
          ) : null}
          {!store.config.enabled ? (
            <HkSettingsHint>{t("settings.chatTranslate.notAvailableOff")}</HkSettingsHint>
          ) : null}

          {/* First-enable consent — inline, one-shot: accepting stamps
              consentVersion 1 together with enabled=true. */}
          {consentOpen.value ? (
            <HkSettingsSub title={t("settings.chatTranslate.consentTitle")}>
              <HkSettingsHint>{t("settings.chatTranslate.consentBody")}</HkSettingsHint>
              <div class="settings-modal__netmanual">
                <HkButton size="sm" onClick={acceptConsent}>
                  {t("settings.chatTranslate.consentAgree")}
                </HkButton>
                <HkButton
                  size="sm"
                  variant="ghost"
                  onClick={() => (consentOpen.value = false)}
                >
                  {t("settings.chatTranslate.consentCancel")}
                </HkButton>
              </div>
            </HkSettingsSub>
          ) : null}

          {/* ── provider ── */}
          <HkSettingsSub title={t("settings.chatTranslate.providerTitle")}>
            <HkSettingsHint>{t("settings.chatTranslate.providerHint")}</HkSettingsHint>
            <div class="settings-modal__langs">
              <div class="settings-modal__lang">
                <span class="settings-modal__lang-label">
                  {t("settings.chatTranslate.baseUrl")}
                </span>
                <HkInput
                  modelValue={baseUrlDraft.value}
                  onUpdate:modelValue={(v: string) => {
                    providerTouched.value = true;
                    baseUrlDraft.value = v;
                  }}
                  placeholder="https://api.deepseek.com"
                  submitOnEnter={saveProvider}
                />
                <HkSettingsHint>{t("settings.chatTranslate.baseUrlDesc")}</HkSettingsHint>
              </div>
              <div class="settings-modal__lang">
                <span class="settings-modal__lang-label">
                  {t("settings.chatTranslate.model")}
                </span>
                <HkInput
                  modelValue={modelDraft.value}
                  onUpdate:modelValue={(v: string) => {
                    providerTouched.value = true;
                    modelDraft.value = v;
                  }}
                  placeholder="deepseek-chat"
                  submitOnEnter={saveProvider}
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
                      onUpdate:modelValue={(v: string) => {
                        apiKeyTouched.value = true;
                        apiKeyDraft.value = v;
                      }}
                      placeholder={
                        store.apiKeySet
                          ? t("settings.chatTranslate.apiKeySet")
                          : t("settings.chatTranslate.apiKeyMissing")
                      }
                      submitOnEnter={saveProvider}
                    />
                  </div>
                  {store.apiKeySet ? (
                    <HkButton size="sm" variant="ghost" onClick={clearApiKey}>
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
                  onUpdate:modelValue={(v: number) => {
                    providerTouched.value = true;
                    timeoutDraft.value = v;
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
                  onUpdate:modelValue={(v: number) => {
                    providerTouched.value = true;
                    temperatureDraft.value = v;
                  }}
                  min={0}
                  max={2}
                  step={0.1}
                />
              </div>
            </div>
            <div class="settings-modal__netmanual">
              <HkButton size="sm" onClick={saveProvider}>
                {t("settings.chatTranslate.save")}
              </HkButton>
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
              {testLine() ? <HkSettingsHint>{testLine()}</HkSettingsHint> : null}
            </div>

            {/* Try-translation probe — the end-to-end check: one line goes
                through detection/prompt/provider/validation with an empty
                match context, one result row per target language plus the
                source badge. The shell refuses while the feature is off or
                no key is stored (explicit error copy); the button is
                disabled with the same reason here so the card explains it
                up front. */}
            <HkSettingsHint>{t("settings.chatTranslate.tryTitle")}</HkSettingsHint>
            <div class="settings-modal__netmanual">
              <div class="settings-modal__netinput">
                <HkInput
                  modelValue={debugDraft.value}
                  onUpdate:modelValue={(v: string) => (debugDraft.value = v)}
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
          </HkSettingsSub>

          {/* ── languages ── */}
          <HkSettingsSub title={t("settings.chatTranslate.languagesTitle")}>
            <HkSettingsHint>{t("settings.chatTranslate.languagesHint")}</HkSettingsHint>
            <div class="settings-modal__langs">
              <div class="settings-modal__lang">
                <span class="settings-modal__lang-label">
                  {t("settings.chatTranslate.selfLang")}
                </span>
                <HkSelect
                  modelValue={store.config.languages.selfLang}
                  onUpdate:modelValue={(v: string) =>
                    void store.setLanguages({ selfLang: v })
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
                  onUpdate:modelValue={(v: string) =>
                    void store.setLanguages({ mode: v })
                  }
                  tabs={[
                    { key: "auto", label: t("settings.chatTranslate.modeAuto") },
                    { key: "fixed", label: t("settings.chatTranslate.modeFixed") },
                  ]}
                />
              </div>
              <div class="settings-modal__lang">
                <span class="settings-modal__lang-label">
                  {t("settings.chatTranslate.maxTargets")}
                </span>
                <HkNumberInput
                  modelValue={store.config.languages.maxTargets}
                  onUpdate:modelValue={(v: number) =>
                    void store.setLanguages({ maxTargets: v })
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
          </HkSettingsSub>

          {/* ── display (overlay-config.toml, through D's store) ── */}
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
                  onUpdate:modelValue={(v: boolean) => void overlayCfg.setChatPanel(v)}
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
                  onUpdate:modelValue={(v: number) =>
                    void overlayCfg.setChatPanelMaxLines(v)
                  }
                  min={3}
                  max={30}
                />
              </div>
            </div>
          </HkSettingsSub>

          {/* ── send ── */}
          <HkSettingsSub title={t("settings.chatTranslate.sendTitle")}>
            {/* How the outgoing translation reaches the player: off (the card
                only configures) or clipboard (the composed message is copied
                and the overlay shows the paste hint). */}
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
                  onUpdate:modelValue={(v: string) =>
                    void store.setSendMode(v as ChatTranslateSendMode)
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
            <div class="stats-prefs">
              <div class="stats-prefs__row">
                <span class="stats-prefs__row-text">
                  <span class="stats-prefs__row-label">
                    {t("settings.chatTranslate.suffix")}
                  </span>
                </span>
                <HkSwitch
                  modelValue={store.config.send.suffixEnabled}
                  onUpdate:modelValue={(v: boolean) =>
                    void store.setSend({ suffixEnabled: v })
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
                  onUpdate:modelValue={(v: string) =>
                    void store.setSend({ suffixFormat: v })
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
                  onUpdate:modelValue={(v: number) =>
                    void store.setSend({ splitChars: v })
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
                  onUpdate:modelValue={(v: number) =>
                    void store.setSend({ hintTimeoutS: v })
                  }
                  min={5}
                  max={600}
                  step={5}
                />
              </div>
            </div>
          </HkSettingsSub>
        </HkSettingsGroup>
      </>
    );
  },
});
