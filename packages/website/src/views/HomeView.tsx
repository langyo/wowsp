import { defineComponent } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { MonitorPlay, Eye, BarChart3, Ship, ArrowRight, Download, Github } from "lucide-vue-next";
import { useScrollReveal } from "@/composables/useScrollReveal";
import "./HomeView.scss";

const GITHUB = "https://github.com/langyo/wowsp";
const RELEASES = `${GITHUB}/releases`;

export default defineComponent({
  name: "HomeView",
  setup() {
    const { t } = useI18n();
    const logoUrl = `${import.meta.env.BASE_URL}logo.webp`;

    const features = [
      { icon: MonitorPlay, key: "replay" },
      { icon: Eye, key: "overlay" },
      { icon: BarChart3, key: "stats" },
      { icon: Ship, key: "viewer" },
    ] as const;

    const stats = [
      { value: "3D", key: "maps" },
      { value: "1200+", key: "ships" },
      { value: "Tab", key: "overlay" },
    ];

    const f1 = useScrollReveal(0);
    const f2 = useScrollReveal(100);
    const f3 = useScrollReveal(200);
    const f4 = useScrollReveal(300);
    const reveals = [f1, f2, f3, f4];

    return () => (
      <div class="home">
        {/* ── HERO ─────────────────────────────────────────── */}
        <section class="hero section-bg scanline-overlay">
          <div class="hero__glow" />
          <div class="hero__content">
            <div class="hero__badge accent-pill">
              <span class="hero__signal" />
              {t("hero.badge")}
            </div>

            <img src={logoUrl} alt="WoWSP" class="hero__logo animate-float" />

            <h1 class="hero__title">
              <span class="gradient-text">WoWSP</span>
            </h1>
            <p class="hero__tagline">{t("hero.tagline")}</p>
            <p class="hero__lede">{t("hero.lede")}</p>

            <div class="hero__actions">
              <a href={RELEASES} target="_blank" rel="noopener" class="hero__cta">
                <Download size={16} />
                {t("hero.download")}
              </a>
              <RouterLink to="/download" class="hero__cta hero__cta--ghost">
                {t("hero.docs")}
                <ArrowRight size={16} />
              </RouterLink>
              <a href={GITHUB} target="_blank" rel="noopener" class="hero__cta hero__cta--ghost">
                <Github size={16} />
                {t("hero.github")}
              </a>
            </div>

            <div class="hero__stats">
              {stats.map((s) => (
                <div class="hero__stat" key={s.key}>
                  <span class="hero__stat-value gradient-text">{s.value}</span>
                  <span class="hero__stat-label">{t(`hero.${s.key}`)}</span>
                </div>
              ))}
            </div>

            <p class="hero__version">{t("hero.version")}</p>
          </div>
        </section>

        {/* ── FEATURES ─────────────────────────────────────── */}
        <section id="features" class="features section-bg">
          <div class="features__head reveal is-visible">
            <span class="accent-pill">02 · {t("features.title")}</span>
            <h2 class="features__title gradient-text">{t("features.title")}</h2>
          </div>

          <div class="features__grid">
            {features.map((f, i) => {
              const Icon = f.icon;
              const r = reveals[i];
              return (
                <article
                  class={["feature-card industrial-card", r.cls()].join(" ")}
                  ref={r.setEl}
                  style={r.style()}
                  key={f.key}
                >
                  <div class="feature-card__icon">
                    <Icon size={24} />
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
