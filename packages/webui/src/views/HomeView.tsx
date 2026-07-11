import { defineComponent, onMounted } from "vue";
import { useRouter } from "vue-router";

import { useGameDetect } from "@/features/gamedetect/useGameDetect";
import { t } from "@/i18n";
import SButton from "@/components/base/SButton";

/**
 * Landing view. Runs game-install detection on mount and links to the two
 * modes (standalone review, in-game overlay).
 */
export default defineComponent({
  name: "HomeView",
  setup() {
    const router = useRouter();
    const gd = useGameDetect();
    onMounted(() => void gd.detect());

    return () => (
      <main class="home">
        <h1 class="home__title">{t("common.app.name")}</h1>
        <p class="home__subtitle">{t("common.app.tagline")}</p>

        <section class="home__detect">
          <h2>{t("common.detect.title")}</h2>
          {gd.detecting.value ? (
            <p>{t("common.detect.scanning")}</p>
          ) : gd.active.value ? (
            <p>
              {t("common.detect.found")}: <code>{gd.active.value.path}</code>
              {gd.active.value.realm ? ` (${gd.active.value.realm})` : null}
            </p>
          ) : (
            <p>{t("common.detect.none")}</p>
          )}
          <SButton variant="secondary" onClick={() => gd.detect()}>
            {t("common.detect.rescan")}
          </SButton>
        </section>

        <section class="home__modes">
          <SButton onClick={() => router.push("/replay")}>{t("nav.replay")}</SButton>
          <SButton variant="secondary" onClick={() => router.push("/overlay")}>
            {t("nav.overlay")}
          </SButton>
        </section>
      </main>
    );
  },
});
