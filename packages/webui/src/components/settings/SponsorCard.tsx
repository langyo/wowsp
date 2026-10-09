import { defineComponent } from "vue";
import { Heart } from "@lucide/vue";

import { t } from "@/i18n";
import { openExternal } from "@/utils/openExternal";
import "./SponsorCard.scss";

/** The author's afdian page — data, not locale copy (the about.links
 *  pattern: one URL shared by every language). */
const AFDIAN_URL = "https://afdian.com/a/langyo";

/**
 * The sponsor card — the SECOND group of the credits section, right after
 * the special thanks. One wide card whose whole surface opens the author's
 * afdian page in the external browser; the body states, in the user's own
 * language, what a sponsorship is and is not: every donation funds the
 * project's AI costs, donating is optional, no employment/contract
 * relationship is formed, the app stays open source with no sponsor-gated
 * features, and the project is unaffiliated with Wargaming/Lesta/360.
 */
export default defineComponent({
  name: "SponsorCard",
  setup() {
    return () => (
      <button
        type="button"
        class="sponsor-card"
        data-hint={AFDIAN_URL}
        onClick={() => void openExternal(AFDIAN_URL)}
      >
        <span class="sponsor-card__icon" aria-hidden="true">
          <Heart size={18} />
        </span>
        <span class="sponsor-card__body">
          <span class="sponsor-card__name">{t("about.sponsor.cardName")}</span>
          <span class="sponsor-card__lead">{t("about.sponsor.lead")}</span>
          <span class="sponsor-card__notes">
            <span>{t("about.sponsor.voluntary")}</span>
            <span>{t("about.sponsor.noHire")}</span>
            <span>{t("about.sponsor.openSource")}</span>
            <span>{t("about.sponsor.noAffiliation")}</span>
          </span>
        </span>
        <span class="sponsor-card__platform" aria-hidden="true">
          afdian
        </span>
      </button>
    );
  },
});
