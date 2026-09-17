import { defineComponent } from "vue";

import { pickAnnouncementVariants } from "../announcement";
import "./AnnouncementCard.scss";

/**
 * Compact renderer for the mandatory free & open-source notice on the
 * license step: one labelled block per language variant (language name,
 * bold headline, body paragraph) separated by hairline dividers, with an
 * accent left edge. The variant list is computed once from
 * navigator.language — the installer has no runtime locale switching —
 * and the card scrolls inside a bounded height so the license pane keeps
 * the license text and the agree checkbox visible. No close button: the
 * notice is mandatory and the agree button stays disabled until its
 * countdown runs out.
 */
export default defineComponent({
  name: "AnnouncementCard",
  setup() {
    const variants = pickAnnouncementVariants(navigator.language);

    return () => (
      <aside class="announce-card">
        {variants.map((variant) => (
          <section key={variant.id} class="announce-card__block">
            <span class="announce-card__lang">{variant.label}</span>
            <h3 class="announce-card__title">{variant.title}</h3>
            <p class="announce-card__body">{variant.body}</p>
          </section>
        ))}
      </aside>
    );
  },
});
