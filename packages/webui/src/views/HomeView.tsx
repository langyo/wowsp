import { defineComponent, onMounted } from "vue";
import { useRouter } from "vue-router";

import { useGameDetect } from "@/features/gamedetect/useGameDetect";
import { t } from "@/i18n";
import SButton from "@/components/base/SButton";
import "./HomeView.scss";

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
        <header class="home__hero">
          <h1 class="home__title">{t("common.app.name")}</h1>
            <p class="home__subtitle">{t("common.app.tagline")}</p>
        </header>

        <section class="home__card">
          <h2 class="home__card-title">{t("common.detect.title")}</h2>
          {gd.detecting.value ? (
            <p class="home__card-state home__card-state--loading">
              {t("common.detect.scanning")}
            </p>
          ) : gd.active.value ? (
            <p class="home__card-state home__card-state--ok">
              <span>{t("common.detect.found")}</span>
              <code class="home__path">{gd.active.value.path}</code>
              {gd.active.value.realm ? (
                <span class="home__realm">{gd.active.value.realm}</span>
              ) : null}
            </p>
          ) : (
            <p class="home__card-state home__card-state--empty">{t("common.detect.none")}</p>
          )}
          <div class="home__card-actions">
            <SButton variant="secondary" size="sm" onClick={() => gd.detect()}>
              {t("common.detect.rescan")}
            </SButton>
          </div>
        </section>

        <section class="home__modes">
          <button class="home__mode" onClick={() => router.push("/replay")}>
            <div class="home__mode-name">{t("nav.replay")}</div>
            <div class="home__mode-desc">Open a .wowsreplay and replay the match on the holographic map.</div>
          </button>
          <button class="home__mode" onClick={() => router.push("/overlay")}>
            <div class="home__mode-name">{t("nav.overlay")}</div>
            <div class="home__mode-desc">Transparent in-game roster overlay, shown while Tab is held.</div>
          </button>
        </section>
      </main>
    );
  },
});
