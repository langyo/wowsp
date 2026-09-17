import { defineComponent } from "vue";

import { useLanguage } from "@/i18n/useLanguage";

import { pickAnnouncementVariants } from "./announcementVariants";
import "./AnnouncementContent.scss";

/**
 * Presentational renderer for the free & open-source notice: one labelled
 * block per language variant (language name, bold headline, body paragraph),
 * separated by hairline dividers. Locale-reactive through the shared
 * language store — switching the UI language in settings immediately
 * adds/removes the fourth block. Shared by the forced first-launch
 * AnnouncementDialog and the always-visible card inside AboutModal.
 */
export default defineComponent({
  name: "AnnouncementContent",
  setup() {
    const lang = useLanguage();

    return () => (
      <div class="announce-content">
        {pickAnnouncementVariants(lang.uiLocale.value).map((variant) => (
          <section key={variant.id} class="announce-content__block">
            <span class="announce-content__lang">{variant.label}</span>
            <h3 class="announce-content__title">{variant.title}</h3>
            <p class="announce-content__body">{variant.body}</p>
          </section>
        ))}
      </div>
    );
  },
});
