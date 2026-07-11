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
    const { config, detect } = useGameDetect();
    onMounted(() => void detect());

    // Pinia store refs — read via storeToRefs so they stay reactive in the
    // render function without manual `.value` (which had caused a null crash
    // when the store hadn't resolved yet).
    return () => {
      const active = config.activeInstall;
      const detecting = config.detecting;
      return (
        <main class="home">
          <header class="home__hero">
            <h1 class="home__title">{t("common.app.name")}</h1>
            <p class="home__subtitle">{t("common.app.tagline")}</p>
          </header>

          <section class="home__card">
            <h2 class="home__card-title">{t("common.detect.title")}</h2>
            {detecting ? (
              <p class="home__card-state home__card-state--loading">
                {t("common.detect.scanning")}
              </p>
            ) : active ? (
              <p class="home__card-state home__card-state--ok">
                <span>{t("common.detect.found")}</span>
                <code class="home__path">{active.path}</code>
                {active.realm ? <span class="home__realm">{active.realm}</span> : null}
              </p>
            ) : (
              <p class="home__card-state home__card-state--empty">{t("common.detect.none")}</p>
            )}
            <div class="home__card-actions">
              <SButton variant="secondary" size="sm" onClick={() => detect()}>
                {t("common.detect.rescan")}
              </SButton>
            </div>
          </section>

          <section class="home__modes">
            <button class="home__mode" onClick={() => router.push("/replay")}>
              <div class="home__mode-name">{t("nav.replay")}</div>
              <div class="home__mode-desc">Open a .wowsreplay and replay the match on the holographic map.</div>
            </button>
            <div class="home__mode home__mode--disabled" title="Overlay launches as a separate window when a battle is detected.">
              <div class="home__mode-name">{t("nav.overlay")}</div>
              <div class="home__mode-desc">Transparent in-game roster overlay. Opens automatically as a separate window when a battle loads (requires the game running).</div>
            </div>
          </section>
        </main>
      );
    };
  },
});
