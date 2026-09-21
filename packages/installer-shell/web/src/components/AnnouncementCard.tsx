import { computed, defineComponent, type PropType } from "vue";

import type { InstallerLocale } from "../i18n";
import { pickAnnouncementVariants, pickTelemetryNotice } from "../announcement";
import "./AnnouncementCard.scss";

/**
 * Compact renderer for the mandatory free & open-source notice on the
 * license step: one labelled block per language variant (language name,
 * bold headline, body paragraph) separated by hairline dividers, with an
 * accent left edge. The variant list is recomputed from the host's
 * `locale` prop — the wizard's picked locale, so a switch on the mode
 * step re-picks the appended variant — and the card scrolls inside a
 * bounded height so the license pane keeps the license text and the agree
 * checkbox visible. No close button: the notice is mandatory and the
 * agree button stays disabled until its countdown runs out.
 *
 * A short usage-telemetry disclosure follows the free-notice blocks,
 * rendered in the locale the host reports (the third agreement document
 * carries the full notice).
 */
export default defineComponent({
  name: "AnnouncementCard",
  props: {
    /** The wizard's picked locale (drives the appended variant + the
     *  telemetry notice's language). */
    locale: { type: String as PropType<InstallerLocale>, required: true },
  },
  setup(props) {
    const variants = computed(() => pickAnnouncementVariants(props.locale));
    const telemetry = computed(() => pickTelemetryNotice(props.locale));

    return () => (
      <aside class="announce-card">
        {variants.value.map((variant) => (
          <section key={variant.id} class="announce-card__block">
            <span class="announce-card__lang">{variant.label}</span>
            <h3 class="announce-card__title">{variant.title}</h3>
            <p class="announce-card__body">{variant.body}</p>
          </section>
        ))}
        <section key="telemetry" class="announce-card__block">
          <span class="announce-card__lang">{telemetry.value.label}</span>
          <h3 class="announce-card__title">Usage Telemetry / 使用量遥测</h3>
          <p class="announce-card__body">{telemetry.value.text}</p>
        </section>
      </aside>
    );
  },
});
