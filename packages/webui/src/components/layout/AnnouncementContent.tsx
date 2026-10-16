import { defineComponent } from "vue";

import { useLanguage } from "@/i18n/useLanguage";

import { pickAnnouncementVariant } from "./announcementVariants";
import "./AnnouncementContent.scss";

/**
 * Presentational renderer for the mandatory free & open-source notice,
 * shown ONCE in the user's own language (bold headline + body paragraph).
 * Locale-reactive through the shared language store — switching the UI
 * language in settings immediately swaps the copy. The usage-telemetry
 * disclosure is not part of this renderer: it lives in its own group at
 * the end of the settings' attributions section (the full notice stays at
 * docs/{lang}/license/usage-telemetry.md, shipped as the third agreement
 * document in the installer; the installer's license step keeps its own
 * multi-language card). Shared by the onboarding wizard's welcome step and
 * the always-visible card inside AboutModal.
 */
export default defineComponent({
  name: "AnnouncementContent",
  setup() {
    const lang = useLanguage();

    return () => {
      const variant = pickAnnouncementVariant(lang.uiLocale.value);
      return (
        <div class="announce-content">
          <section key={variant.id} class="announce-content__block">
            <h3 class="announce-content__title">{variant.title}</h3>
            <p class="announce-content__body">{variant.body}</p>
          </section>
        </div>
      );
    };
  },
});
