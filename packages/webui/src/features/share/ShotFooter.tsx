/**
 * ShotFooter — the DOM face of the project's fixed share watermark.
 *
 * Every canvas share shot already carries {@link drawFooter} (shotKit): the
 * mascot logo + brand + tagline on the left, the two fixed disclaimers in the
 * middle and the QQ group + project URL on the right. The AI report sheet is
 * captured from the DOM (html-to-image), so it renders this twin instead —
 * same strings ({@link shareFooterStrings}), same logo ({@link LOGO_URL}),
 * same project URL ({@link GITHUB_URL}) — and NO share surface can ship a
 * differently-branded footer.
 *
 * The dark surface carries its own inks (the sheet's --srp-* palette, with
 * plain fallbacks) because the copied PNG must not depend on the app theme.
 * Callers may append two kinds of extra lines: `notes` join the centered
 * disclaimer block (the AI diagnosis notice), `meta` join the right-hand
 * provenance block (the AI model version).
 */
import { defineComponent, type PropType } from "vue";

import { shareFooterStrings, GITHUB_URL, LOGO_URL } from "./shotKit";
import "./ShotFooter.scss";

export default defineComponent({
  name: "ShotFooter",
  props: {
    /** Extra centered lines under the two fixed disclaimers. */
    notes: { type: Array as PropType<string[]>, default: () => [] },
    /** Extra right-hand provenance lines under the project URL. */
    meta: { type: Array as PropType<string[]>, default: () => [] },
  },
  setup(props) {
    return () => {
      const strings = shareFooterStrings();
      return (
        <footer class="shot-footer">
          <div class="shot-footer__brand">
            <img class="shot-footer__logo" src={LOGO_URL} alt="" />
            <div class="shot-footer__brand-text">
              <strong class="shot-footer__name">WoWSP</strong>
              <span class="shot-footer__tagline">{strings.tagline}</span>
            </div>
          </div>
          <div class="shot-footer__center">
            <span>{strings.disclaimer1}</span>
            <span>{strings.disclaimer2}</span>
            {props.notes.map((line) => (
              <span key={line} class="shot-footer__note">
                {line}
              </span>
            ))}
          </div>
          <div class="shot-footer__right">
            <span class="shot-footer__qq">{strings.qqGroup}</span>
            <span class="shot-footer__url">{GITHUB_URL}</span>
            {props.meta.map((line) => (
              <span key={line} class="shot-footer__meta">
                {line}
              </span>
            ))}
          </div>
        </footer>
      );
    };
  },
});
