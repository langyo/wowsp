/** Chat-translation TEST window: the end-to-end probe moved out of the
 *  provider window (configuring a provider and testing a translation are two
 *  different jobs). Pick a preset battle-chat case, translate it through the
 *  REAL pipeline, then inspect the three boxes that explain the call:
 *
 *   1. the system prompt the pipeline used (verbatim);
 *   2. the structured USER payload (JSON tree);
 *   3. the model's structured answer — the parsed JSON object when it parsed,
 *      the raw content text when it did not;
 *
 *  plus the compact result summary (detected language, latency, one row per
 *  target language with its source badge). The preset cases are grouped
 *  (basic / tactic / multi-language / edge) and are ordinary game battle-chat
 *  lines — nothing here is translated for its meaning, only exercised.
 */
import { computed, defineComponent, ref } from "vue";
import {
  HkButton,
  HkJsonTree,
  HkModal,
  HkSelect,
  HkSettingsHint,
  HkTag,
} from "@celestia-island/hikari";

import { t } from "@/i18n";
import type { DebugTranslateResult, DebugTranslationSource } from "@/api/modules/chat";
import { useChatTranslateStore } from "@/stores/chatTranslate";

import "./chat-settings.scss";

interface TestCase {
  id: string;
  /** i18n key of the case's human label. */
  labelKey: string;
  /** The game-chat line sent through the pipeline. */
  text: string;
}

interface TestGroup {
  id: string;
  labelKey: string;
  cases: TestCase[];
}

/** Preset cases. Texts are ORDINARY in-game battle-chat lines (the point is
 *  the pipeline path, not the wording); edge includes the untranslatable-only
 *  line, a Japanese line and a long line that exercises message splitting. */
const GROUPS: TestGroup[] = [
  {
    id: "basic",
    labelKey: "settings.chatTranslate.testGroupBasic",
    cases: [
      { id: "wp", labelKey: "settings.chatTranslate.testCaseWp", text: "wp" },
      { id: "gg", labelKey: "settings.chatTranslate.testCaseGg", text: "gg" },
      {
        id: "focusB",
        labelKey: "settings.chatTranslate.testCaseFocusB",
        text: "focus B",
      },
    ],
  },
  {
    id: "tactic",
    labelKey: "settings.chatTranslate.testGroupTactic",
    cases: [
      {
        id: "focusBEnemyDd",
        labelKey: "settings.chatTranslate.testCaseFocusBEnemyDd",
        text: "focus B, enemy DD spotted",
      },
      {
        id: "dontPushMid",
        labelKey: "settings.chatTranslate.testCaseDontPushMid",
        text: "don't push mid, wait for smoke",
      },
      {
        id: "radarNext",
        labelKey: "settings.chatTranslate.testCaseRadarNext",
        text: "radar next, push after",
      },
    ],
  },
  {
    id: "multi",
    labelKey: "settings.chatTranslate.testGroupMulti",
    cases: [
      {
        id: "mixedJa",
        labelKey: "settings.chatTranslate.testCaseMixedJa",
        text: "LOL gg wp よくやった",
      },
      {
        id: "mixedRu",
        labelKey: "settings.chatTranslate.testCaseMixedRu",
        text: "хорошая игра, wp",
      },
    ],
  },
  {
    id: "edge",
    labelKey: "settings.chatTranslate.testGroupEdge",
    cases: [
      {
        id: "symbols",
        labelKey: "settings.chatTranslate.testCaseSymbols",
        text: "*** ??? 123",
      },
      {
        id: "japaneseDd",
        labelKey: "settings.chatTranslate.testCaseJapaneseDd",
        text: "Bは敵の駆逐艦、気をつけて",
      },
      {
        id: "longLine",
        labelKey: "settings.chatTranslate.testCaseLongLine",
        text: "please focus the enemy destroyer on the right flank first and then push the cap together after the smoke clears",
      },
    ],
  },
];

/** Whether a text actually parses as JSON (HkJsonTree parses only JSON; a
 *  plain sentence gets a readable pre-formatted fallback beside the tree
 *  host). A starts-with-brace probe is not enough — the model can return a
 *  truncated object. */
function isJsonText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** Whether a text parses as a JSON CONTAINER — the only values HkJsonTree
 *  renders (primitives and unparsable text fall back to a readable pre; a
 *  raw "42" would otherwise leave the box blank). */
function isJsonContainerText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

/** Split the USER payload the shell builds: line 1 is the request JSON, the
 *  following line(s) are the `context: {...}` text the system prompt locks
 *  in — so the payload as a whole is NOT valid JSON. */
function splitUserPayload(payload: string): { jsonLine: string; rest: string } {
  const [firstLine = "", ...restLines] = payload.split("\n");
  return { jsonLine: firstLine, rest: restLines.join("\n").trim() };
}

export default defineComponent({
  name: "ChatTranslateTestModal",
  props: {
    modelValue: { type: Boolean, required: true },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    const store = useChatTranslateStore();
    const close = () => emit("update:modelValue", false);

    const activeGroupId = ref(GROUPS[0].id);
    const activeCaseId = ref(GROUPS[0].cases[0].id);
    /** The case whose trace the boxes below are showing. Switching the case
     *  clears it: an OLD trace under a NEW case's heading would explain the
     *  wrong call (the boxes are evidence, not a dashboard). */
    const resultCaseId = ref("");

    const activeGroup = computed(
      () => GROUPS.find((group) => group.id === activeGroupId.value) ?? GROUPS[0],
    );
    const activeCase = computed(
      () =>
        activeGroup.value.cases.find((item) => item.id === activeCaseId.value) ??
        activeGroup.value.cases[0],
    );

    /** Switching the group resets the case to that group's first entry. */
    function selectGroup(groupId: string) {
      activeGroupId.value = groupId;
      const group = GROUPS.find((candidate) => candidate.id === groupId) ?? GROUPS[0];
      activeCaseId.value = group.cases[0].id;
      resultCaseId.value = "";
    }

    function selectCase(caseId: string) {
      activeCaseId.value = caseId;
      resultCaseId.value = "";
    }

    /** The translate button's gate: the feature must be on AND a key must be
     *  available (a stored key or the environment override). */
    const blocked = computed(
      () => !store.config.enabled || (!store.apiKeySet && !store.envKeyOverride),
    );

    function runTranslate() {
      // Guard before the state stamp: a re-entry would tag the in-flight run's
      // result with the newly selected case.
      if (store.debugging) return;
      resultCaseId.value = activeCase.value.id;
      void store.debugTranslate(activeCase.value.text, []);
    }

    /** Whether the LAST result belongs to the currently selected case. */
    const resultCurrent = computed(
      () => resultCaseId.value !== "" && resultCaseId.value === activeCase.value.id,
    );

    function sourceLabel(source: DebugTranslationSource): string {
      switch (source) {
        case "passthrough":
          return t("settings.chatTranslate.trySourcePassthrough");
        case "untranslatable":
          return t("settings.chatTranslate.trySourceUntranslatable");
        default:
          return t("settings.chatTranslate.trySourceModel");
      }
    }

    function resultTitle(): string | null {
      const result = store.debugResult;
      if (!result) return null;
      return t("settings.chatTranslate.tryResult", { lang: result.detected ?? "—" });
    }

    /** One result box (title + body or the no-result placeholder). Kept as a
     *  local render helper so the three boxes share one frame. */
    function resultBox(
      title: string,
      result: DebugTranslateResult | null,
      body: () => unknown,
    ) {
      return (
        <div class="chat-settings__test-box">
          <div class="chat-settings__test-box-title">{title}</div>
          {result ? body() : <HkSettingsHint>{t("settings.chatTranslate.testNoResult")}</HkSettingsHint>}
        </div>
      );
    }

    return () => {
      // Only the trace of the CURRENTLY selected case renders: switching the
      // case clears it until the next run (see resultCaseId).
      const result = resultCurrent.value ? store.debugResult : null;
      // The error can arrive two ways: a guard failure rejects (debugError) or
      // the provider answered unusably (result.error with the trace attached).
      const error = resultCurrent.value
        ? (result?.error ?? store.debugError)
        : null;
      return (
        <HkModal
          modelValue={props.modelValue}
          onUpdate:modelValue={(value: boolean) => {
            if (!value) close();
          }}
          title={t("settings.chatTranslate.translateTestTitle")}
          width="46rem"
          footerActions={[
            {
              label: t("settings.chatTranslate.close"),
              variant: "secondary",
              onClick: close,
            },
          ]}
        >
          <div class="chat-settings__section">
            <HkSettingsHint>{t("settings.chatTranslate.translateTestHint")}</HkSettingsHint>
            <div class="settings-modal__langs">
              <div class="settings-modal__lang">
                <span class="settings-modal__lang-label">
                  {t("settings.chatTranslate.testGroupLabel")}
                </span>
                <HkSelect
                  modelValue={activeGroupId.value}
                  onUpdate:modelValue={(value: string) => selectGroup(value)}
                  options={GROUPS.map((group) => ({
                    value: group.id,
                    label: t(group.labelKey),
                  }))}
                />
              </div>
              <div class="settings-modal__lang">
                <span class="settings-modal__lang-label">
                  {t("settings.chatTranslate.testCaseLabel")}
                </span>
                <HkSelect
                  modelValue={activeCaseId.value}
                  onUpdate:modelValue={(value: string) => selectCase(value)}
                  options={activeGroup.value.cases.map((item) => ({
                    value: item.id,
                    label: t(item.labelKey),
                  }))}
                />
              </div>
            </div>

            {/* The selected case itself (read-only) + the translate action. */}
            <div class="chat-settings__test-case">
              <div class="chat-settings__test-case-head">
                <span class="settings-modal__lang-label">
                  {t("settings.chatTranslate.tryTitle")}
                </span>
                <HkButton
                  size="sm"
                  loading={store.debugging}
                  disabled={blocked.value || store.debugging}
                  onClick={() => runTranslate()}
                >
                  {store.debugging
                    ? t("settings.chatTranslate.tryRunning")
                    : t("settings.chatTranslate.tryBtn")}
                </HkButton>
              </div>
              <span class="chat-settings__test-case-label">
                {t("settings.chatTranslate.tryLabel")}
              </span>
              <div class="chat-settings__test-case-text">{activeCase.value.text}</div>
            </div>
            {blocked.value ? (
              <HkSettingsHint>{t("settings.chatTranslate.tryNeedKey")}</HkSettingsHint>
            ) : null}

            {error ? (
              <div class="chat-settings__test-error">
                {t("settings.chatTranslate.translateTestFailed", { msg: error })}
              </div>
            ) : null}

            {result ? (
              <div class="chat-settings__test-summary">
                <span>{resultTitle()}</span>
                <span class="chat-settings__test-elapsed">
                  {result.elapsedMs} ms
                </span>
              </div>
            ) : null}

            {resultBox(t("settings.chatTranslate.testSystemPrompt"), result, () => (
              <pre class="chat-settings__test-prompt">
                {(result && result.systemPrompt) || t("settings.chatTranslate.testNoResult")}
              </pre>
            ))}

            {resultBox(t("settings.chatTranslate.testInputPayload"), result, () => {
              // The payload is request-JSON on line 1 and a "context: {...}"
              // line after it, so render the head as a tree and the tail as
              // verbatim pre text; an unparsable head degrades to one pre
              // block with the whole payload.
              const { jsonLine, rest } = splitUserPayload(
                result?.userPayload ?? "",
              );
              if (!isJsonText(jsonLine)) {
                return (
                  <pre class="chat-settings__test-prompt">
                    {result?.userPayload ?? ""}
                  </pre>
                );
              }
              return (
                <div class="chat-settings__test-json">
                  <HkJsonTree text={jsonLine} maxDepth={8} />
                  {rest !== "" ? (
                    <pre class="chat-settings__test-prompt">{rest}</pre>
                  ) : null}
                </div>
              );
            })}

            {resultBox(t("settings.chatTranslate.testResponsePayload"), result, () => {
              if (result && result.response != null) {
                return (
                  <div class="chat-settings__test-json">
                    <HkJsonTree value={result.response} maxDepth={8} />
                  </div>
                );
              }
              const raw = result?.responseRaw ?? "";
              if (raw !== "") {
                // A JSON CONTAINER gets the tree; a primitive ("42", "null")
                // or plain prose gets the readable pre — HkJsonTree renders
                // containers only, so a primitive tree would leave the box
                // blank.
                return (
                  <div class="chat-settings__test-json">
                    {isJsonContainerText(raw) ? (
                      <HkJsonTree text={raw} maxDepth={8} />
                    ) : (
                      <pre class="chat-settings__test-prompt">{raw}</pre>
                    )}
                  </div>
                );
              }
              return <HkSettingsHint>{t("settings.chatTranslate.testNoResult")}</HkSettingsHint>;
            })}

            {result && result.translations.length > 0 ? (
              <div class="settings-modal__langs">
                {result.translations.map((row) => (
                  <div class="settings-modal__lang" key={row.lang} lang={row.lang}>
                    <span class="settings-modal__netmanual">
                      <span class="settings-modal__lang-label">{row.lang}</span>
                      <HkTag variant="info" size="sm">
                        {sourceLabel(row.source)}
                      </HkTag>
                    </span>
                    <span>{row.text || "—"}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {result && result.translations.length === 0 ? (
              <HkSettingsHint>{t("settings.chatTranslate.tryEmpty")}</HkSettingsHint>
            ) : null}
          </div>
        </HkModal>
      );
    };
  },
});
