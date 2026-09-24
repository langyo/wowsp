import { computed, defineComponent, type PropType } from "vue";

import { HkAlert } from "@celestia-island/hikari";

import type { LookupErrorPayload } from "@/transport/types";
import { t } from "@/i18n";
import "./LookupErrorNotice.scss";

/** The official API's rate-limit marker — when it shows up in the raw
 *  message/detail, the notice appends its own "wait and retry" hint
 *  instead of leaving the user with a bare generic failure. */
const RATE_LIMIT_RE = /REQUEST_LIMIT_EXCEEDED/i;

/**
 * Friendly rendering of a failed stats lookup, replacing the raw red
 * backend string:
 *   - "not found" (warning variant): localized title + explanation +
 *     likely causes (typo / deleted account / wrong realm), a highlighted
 *     line when this exact player was looked up successfully before (a now
 *     missing account was most likely deleted), and the raw English
 *     backend message collapsed for power users;
 *   - API failure (error variant): generic "could not complete" copy with
 *     a rate-limit hint when the official API says so, plus the raw error
 *     expandable. Without a structured payload the raw string IS the body.
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
        const desc = isPlayer
          ? t("lookup.error.playerNotFoundDesc", { name: p.query, realm: realmUpper.value })
          : t("lookup.error.clanNotFoundDesc", { query: p.query, realm: realmUpper.value });
        return (
          <div class="lookup-error-notice">
            <HkAlert variant="warning" title={isPlayer ? t("lookup.error.playerNotFoundTitle") : t("lookup.error.clanNotFoundTitle")} message={desc}>
              <div class="lookup-error-notice__body">
                <p class="lookup-error-notice__desc">{desc}</p>
                {isPlayer ? (
                  <>
                    <div class="lookup-error-notice__causes-title">
                      {t("lookup.error.causesTitle")}
                    </div>
                    <ul class="lookup-error-notice__causes">
                      <li>{t("lookup.error.causeTypo")}</li>
                      <li>{t("lookup.error.causeDeleted")}</li>
                      <li>{t("lookup.error.causeRealm", { realm: realmUpper.value })}</li>
                    </ul>
                  </>
                ) : (
                  <p class="lookup-error-notice__cause">{t("lookup.error.clanNotFoundCause")}</p>
                )}
                {props.seenBefore ? (
                  <p class="lookup-error-notice__seen">{t("lookup.error.seenBefore")}</p>
                ) : null}
                {/* The historical English backend string — collapse for
                    power users filing an issue, don't lead with it. */}
                <details class="lookup-error-notice__raw">
                  <summary>{t("lookup.error.rawDetail")}</summary>
                  <code>{p.message}</code>
                </details>
              </div>
            </HkAlert>
          </div>
        );
      }

      // API failure — structured or raw-only. No structured payload and no
      // raw text means nothing to say (defensive; LookupView only mounts
      // this component when an error exists).
      if (!p && props.raw == null) return null;
      const rawOnly = p == null;
      const desc = rawOnly ? props.raw! : t("lookup.error.apiErrorDesc");
      return (
        <div class="lookup-error-notice">
          <HkAlert variant="error" title={t("lookup.error.apiErrorTitle")} message={desc}>
            <div class="lookup-error-notice__body">
              <p class="lookup-error-notice__desc">{desc}</p>
              {rateLimited.value ? (
                <p class="lookup-error-notice__rate">{t("lookup.error.rateLimitHint")}</p>
              ) : null}
              {!rawOnly ? (
                <details class="lookup-error-notice__raw">
                  <summary>{t("lookup.error.rawDetail")}</summary>
                  {/* `message` already embeds the official detail verbatim
                      ("account/list: <detail>") — don't append it twice. */}
                  <code>{p!.message}</code>
                </details>
              ) : null}
            </div>
          </HkAlert>
        </div>
      );
    };
  },
});
