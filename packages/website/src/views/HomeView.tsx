import { defineComponent } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { MonitorPlay, Eye, BarChart3, Ship } from "lucide-vue-next";
import "./HomeView.scss";

const GITHUB = "https://github.com/langyo/wowsp";
const RELEASES = `${GITHUB}/releases`;

export default defineComponent({
  name: "HomeView",
  setup() {
    const { t } = useI18n();

    const features = [
      { icon: MonitorPlay, key: "replay" },
      { icon: Eye, key: "overlay" },
      { icon: BarChart3, key: "stats" },
      { icon: Ship, key: "viewer" },
    ] as const;

    return () => (
      <div class="home">
        <section class="hero">
          <img src="/logo.webp" alt="WoWSP" class="hero__logo" />
          <h1 class="hero__title">WoWSP</h1>
          <p class="hero__tagline">{t("hero.tagline")}</p>
          <p class="hero__lede">{t("hero.lede")}</p>
          <div class="hero__actions">
            <a href={RELEASES} target="_blank" rel="noopener" class="hero__cta">
              {t("hero.download")}
            </a>
            <RouterLink to="/download" class="hero__cta hero__cta--ghost">
              {t("hero.docs")} · {t("hero.github")}
            </RouterLink>
          </div>
          <p class="hero__version">{t("hero.version")}</p>
        </section>

        <section id="features" class="features">
          <h2 class="features__title">{t("features.title")}</h2>
          <div class="features__grid">
            {features.map((f) => {
              const Icon = f.icon;
              return (
                <article class="feature-card" key={f.key}>
                  <div class="feature-card__icon">
                    <Icon size={26} />
                  </div>
                  <h3 class="feature-card__title">{t(`features.${f.key}.title`)}</h3>
                  <p class="feature-card__desc">{t(`features.${f.key}.desc`)}</p>
                </article>
              );
            })}
          </div>
        </section>
      </div>
    );
  },
});
