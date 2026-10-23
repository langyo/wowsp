import { computed, defineComponent, type PropType } from "vue";

import ErrorCard from "@/components/base/ErrorCard";
import type { LookupErrorPayload } from "@/transport/types";
import { t } from "@/i18n";

/** The official API's rate-limit marker — when it shows up in the raw
 *  message/detail, the api-error card appends its own "wait and retry"
 *  hint instead of leaving the user with a bare generic failure. */
const RATE_LIMIT_RE = /REQUEST_LIMIT_EXCEEDED/i;

/**
 * Friendly rendering of a failed stats lookup on the standard error card
 * (the raw backend string lives in the card's JSON pane, never as a bare
 * red sentence):
 *   - "not found" (warning tone): localized title + explanation + likely
 *     causes (typo / deleted account / wrong realm) folded into the
 *     description, plus a closing line when this exact player was looked
 *     up successfully before (a now missing account was most likely
 *     deleted); the structured payload feeds the raw JSON pane;
 *   - API failure (error tone): generic "could not complete" copy with a
 *     rate-limit hint when the official API says so. Without a structured
 *     payload the raw string IS the description (tError passes plain
 *     sentences through untouched).
 */
export default defineComponent({
  name: "LookupErrorNotice",
  props: {
    /** Structured rejection payload; null = the backend sent no structured
     *  error and `raw` is rendered verbatim. */
    payload: { type: Object as () => LookupErrorPayload | null, default: null },
    /** Fallback raw error text for when no structured payload arrived. */
    raw: { type: String as PropType<string | null>, default: null },
    /** This exact player was looked up successfully before but can't be
     *  found now — highlight it as a most-likely-deleted account. */
    seenBefore: { type: Boolean, default: false },
  },
  setup(props) {
    const notFound = computed(() => props.payload != null && props.payload.kind !== "api");
    const rateLimited = computed(
      () =>
        RATE_LIMIT_RE.test(props.payload?.message ?? "") ||
        RATE_LIMIT_RE.test(props.payload?.detail ?? "") ||
        RATE_LIMIT_RE.test(props.raw ?? ""),
    );
    const realmUpper = computed(() => (props.payload?.realm ?? "").toUpperCase());

    return () => {
      const p = props.payload;
      if (notFound.value && p) {
        const isPlayer = p.kind === "account_not_found";
        // The card description stacks the canned explanation, the likely
        // causes (bulleted so they read as one compact block inside the
        // newline-rendering description), and — the strongest signal when
        // present — the "seen before but gone now" deletion verdict.
        const blocks = [
          isPlayer
            ? t("lookup.error.playerNotFoundDesc", { name: p.query, realm: realmUpper.value })
            : t("lookup.error.clanNotFoundDesc", { query: p.query, realm: realmUpper.value }),
        ];
        if (isPlayer) {
          blocks.push(
            [
              t("lookup.error.causeTypo"),
              t("lookup.error.causeDeleted"),
              t("lookup.error.causeRealm", { realm: realmUpper.value }),
            ]
              .map((line) => `· ${line}`)
              .join("\n"),
          );
        } else {
          blocks.push(`· ${t("lookup.error.clanNotFoundCause")}`);
        }
        if (props.seenBefore) blocks.push(t("lookup.error.seenBefore"));
        return (
          <ErrorCard
            tone="warning"
            title={isPlayer ? t("lookup.error.playerNotFoundTitle") : t("lookup.error.clanNotFoundTitle")}
            description={blocks.join("\n\n")}
            detail={p}
            code={p.kind}
          />
        );
      }

      // API failure — structured or raw-only. No structured payload and no
      // raw text means nothing to say (defensive; LookupView only mounts
      // this component when an error exists). Falsy check, not == null: an
      // empty-string raw would otherwise mount the card with an empty
      // details pane.
      if (!p && !props.raw) return null;
      if (!p) {
        return <ErrorCard title={t("lookup.error.apiErrorTitle")} error={props.raw} />;
      }
      return (
        <ErrorCard
          title={t("lookup.error.apiErrorTitle")}
          // `message` already embeds the official detail verbatim
          // ("account/list: <detail>") — the canned description must not
          // duplicate it; the raw pair stays visible in the JSON pane.
          description={
            rateLimited.value
              ? `${t("lookup.error.apiErrorDesc")}\n\n${t("lookup.error.rateLimitHint")}`
              : t("lookup.error.apiErrorDesc")
          }
          detail={p}
          code={p.kind}
        />
      );
    };
  },
});
