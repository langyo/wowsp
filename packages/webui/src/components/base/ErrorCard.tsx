import { computed, defineComponent, ref, type PropType, type VNode } from "vue";

import {
  HkButton,
  HkErrorLanding,
  HkJsonTree,
  useBreakpoint,
  type HErrorTone,
} from "@celestia-island/hikari";

import { t, tError } from "@/i18n";
import "./ErrorCard.scss";

/**
 * The app-wide standard for errors rendered INSIDE a page: hikari's error
 * landing (inline variant — the card without the viewport takeover) with
 * the raw failure structured through HkJsonTree, plus the built-in copy
 * action and an optional retry. Every view-level "show the error" surface
 * goes through here so raw backend text never lands on the page as a bare
 * red sentence again (2026-10 user direction: all in-page error prompts
 * use the standard error card).
 *
 * Copy flow mirrors hikari's own error family (HkErrorBoundary): the
 * friendly/localized sentence lives in the description, the raw payload in
 * the always-open JSON pane. `error` may be an English anyhow Display
 * sentence OR an i18n key (the plugin lifecycle stores' contract) — when
 * no explicit description is given, the error text is run through
 * tError() so key-shaped errors read localized while raw sentences pass
 * through untouched.
 */
export default defineComponent({
  name: "ErrorCard",
  props: {
    /** Raw error text exactly as the store/queue holds it. */
    error: { type: String as PropType<string | null | undefined>, default: undefined },
    /** Pre-translated headline; empty falls back to hikari's localized
     *  default title ("Something went wrong"). */
    title: { type: String, default: "" },
    /** Pre-translated secondary text (newlines render as breaks). Empty
     *  defaults to tError(error) — except when `error` itself is a JSON
     *  container (the tree already shows it; mirroring the blob into the
     *  description would only duplicate it unbounded). */
    description: { type: String, default: "" },
    /** Structured payload for the JSON tree (LookupErrorPayload, upload
     *  queue entries, …). Falls back to the JSON object embedded in
     *  `error` when it parses to one, else `{ message: error }`. */
    detail: { type: null, default: undefined },
    /** Wire error code chip. */
    code: { type: String, default: "" },
    /** HTTP status chip. */
    status: { type: Number, default: undefined },
    tone: { type: String as PropType<HErrorTone>, default: "error" },
    /** Retry action; seats a primary button beside the built-in copy one. */
    retry: { type: Function as PropType<(() => void) | undefined>, default: undefined },
    /** Retry wording override; empty falls back to common.retry. */
    retryLabel: { type: String, default: "" },
    /** A SECOND recovery affordance beside the retry — the recovery path
     *  the card cannot guess (e.g. "open the resource downloads" when the
     *  failure is a missing on-demand pack). Empty = nothing seats. */
    actionLabel: { type: String, default: "" },
    onAction: { type: Function as PropType<() => void>, default: undefined },
    /** Fill seating (hikari's landing `fill`): the host pane lays the card
     *  out as its shrinking region, so the card compresses its raw-details
     *  frame to FIT the pane instead of scrolling it. Opt-in — the default
     *  keeps every existing in-flow placement byte-identical. */
    fill: { type: Boolean, default: false },
  },
  setup(props) {
    /** The JSON container embedded in `error`, when the whole string is
     *  one — the tree prefers it, and the description must NOT mirror the
     *  blob as a raw paragraph (PostBattlePanel feeds entire payloads). */
    const embeddedJson = computed<Record<string, unknown> | unknown[] | null>(() => {
      if (props.detail !== undefined) return null;
      const raw = props.error ?? "";
      if (!raw) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null) {
          return parsed as Record<string, unknown> | unknown[];
        }
        return null;
      } catch {
        return null;
      }
    });

    const treeValue = computed<unknown>(() => {
      if (props.detail !== undefined) return props.detail;
      if (embeddedJson.value) return embeddedJson.value;
      const raw = props.error ?? "";
      return raw ? { message: raw } : undefined;
    });

    const descriptionText = computed(() => {
      if (props.description) return props.description;
      if (embeddedJson.value) return "";
      const raw = props.error ?? "";
      return raw ? tError(raw) : "";
    });

    // The clipboard payload is the structured form — issue reports carry
    // exactly what the pane showed, pretty-printed.
    const copyText = computed(() => {
      const v = treeValue.value;
      if (v === undefined) return props.error ?? "";
      try {
        return JSON.stringify(v, null, 2);
      } catch {
        return props.error ?? "";
      }
    });

    // The raw-details pane is the card's biggest block; on a phone sheet
    // it crushes everything above it, so the TOUCH layout starts with it
    // COLLAPSED behind a toggle (desktop keeps the always-open pane the
    // 2026-10 direction established). Desktop is byte-identical.
    const { isMobile } = useBreakpoint();
    const detailsOpen = ref(!isMobile.value);

    return () => {
      const rawTree = <HkJsonTree value={treeValue.value} ariaLabel="raw error details" />;
      const actions: VNode[] = [];
      if (props.retry) {
        actions.push(
          <HkButton key="error-card-retry" variant="primary" size="sm" onClick={() => props.retry?.()}>
            {props.retryLabel || t("common.retry")}
          </HkButton>,
        );
      }
      if (props.actionLabel && props.onAction) {
        actions.push(
          <HkButton key="error-card-action" variant="secondary" size="sm" onClick={() => props.onAction?.()}>
            {props.actionLabel}
          </HkButton>,
        );
      }
      return (
      <HkErrorLanding
        variant="inline"
        fill={props.fill}
        tone={props.tone}
        title={props.title}
        description={descriptionText.value}
        code={props.code}
        status={props.status}
        copyText={copyText.value}
      >
        {{
          // Always provided (HkErrorLanding freezes slot presence at mount);
          // HkJsonTree itself renders nothing for an empty value.
          default: () =>
            isMobile.value ? (
              <div class="error-card__details">
                <button
                  type="button"
                  class={["error-card__details-toggle", detailsOpen.value ? "is-open" : ""]}
                  onClick={() => (detailsOpen.value = !detailsOpen.value)}
                  aria-expanded={detailsOpen.value}
                >
                  {t("common.rawDetails")}
                  <span class="error-card__details-chev" aria-hidden="true">{detailsOpen.value ? "▴" : "▾"}</span>
                </button>
                {detailsOpen.value ? rawTree : null}
              </div>
            ) : (
              rawTree
            ),
          actions: () => actions,
        }}
      </HkErrorLanding>
      );
    };
  },
});
