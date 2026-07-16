import { defineComponent } from "vue";
import { Package, Palette, Volume2, Puzzle } from "lucide-vue-next";

import { t } from "@/i18n";
import "./ResourcesView.scss";

/**
 * Resource configuration page — manage game mods, custom skins, and voice
 * packs. This is a new page that replaces the old settings position in the
 * sidebar (settings moved to a bottom-left icon button).
 *
 * Sections:
 *   - Game mods (plugins): install/uninstall overlay mod, mod status.
 *   - Custom skins: camo/skin management.
 *   - Voice packs: audio/voice overrides.
 *
 * Currently a scaffold — each section will be wired to Tauri commands.
 */
export default defineComponent({
  name: "ResourcesView",
  setup() {
    return () => (
      <div class="resources-view">
        <h1 class="resources-view__title">{t("resources.title")}</h1>

        {/* Game mods section */}
        <section class="resources-section">
          <div class="resources-section__head">
            <Puzzle size={18} />
            <h2>{t("resources.mods")}</h2>
          </div>
          <p class="resources-section__desc">{t("resources.modsDesc")}</p>
          <div class="resources-section__placeholder">
            {t("resources.comingSoon")}
          </div>
        </section>

        {/* Custom skins section */}
        <section class="resources-section">
          <div class="resources-section__head">
            <Palette size={18} />
            <h2>{t("resources.skins")}</h2>
          </div>
          <p class="resources-section__desc">{t("resources.skinsDesc")}</p>
          <div class="resources-section__placeholder">
            {t("resources.comingSoon")}
          </div>
        </section>

        {/* Voice packs section */}
        <section class="resources-section">
          <div class="resources-section__head">
            <Volume2 size={18} />
            <h2>{t("resources.voicePacks")}</h2>
          </div>
          <p class="resources-section__desc">{t("resources.voicePacksDesc")}</p>
          <div class="resources-section__placeholder">
            {t("resources.comingSoon")}
          </div>
        </section>
      </div>
    );
  },
});
