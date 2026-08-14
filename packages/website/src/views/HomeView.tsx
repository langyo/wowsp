import { defineAsyncComponent, defineComponent } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import {
  MonitorPlay, Eye, BarChart3, Ship, ChevronDown, ChevronRight, Download, Github,
} from "lucide-vue-next";
import { UiButton, Reveal } from "@/components/ui";
import ModWindow from "@/components/showcase/ModWindow";
import LookupWindow from "@/components/showcase/LookupWindow";
import StatsWindow from "@/components/showcase/StatsWindow";
import "./HomeView.scss";

/* three.js lives in its own async chunk — the marketing shell stays light
 * and the live renderer streams in only when the page actually mounts. */
const ReplayLive = defineAsyncComponent(() => import("@/features/replay3d/ReplayLive"));
const ShipLive = defineAsyncComponent(() => import("@/features/replay3d/ShipLive"));

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

    const stats = [
      { value: "1200+", key: "ships" },
      { value: "3D", key: "maps" },
      { value: "Tab", key: "overlay" },
      { value: "CC0", key: "modsStat" },
    ] as const;

    return () => (
      <div class="home">
        {/* ── HERO — Apple-style product intro ─────────────── */}
        <section class="hero">
          <div class="aurora" />
          <div class="hero__content container">
            <Reveal>
              <div class="hero__badge accent-pill">
                <span class="hero__signal" />
                {t("hero.badge")}
              </div>
            </Reveal>

            <Reveal delay={80}>
              <h1 class="hero__title">
                <span class="gradient-text">WoWSP</span>
              </h1>
            </Reveal>

            <Reveal delay={160}>
              <p class="hero__tagline">{t("hero.tagline")}</p>
            </Reveal>

            <Reveal delay={240}>
              <p class="hero__lede">{t("hero.lede")}</p>
            </Reveal>

            <Reveal delay={320}>
              <div class="hero__actions">
                <UiButton size="lg" href={RELEASES} external>
                  <Download size={17} />
                  {t("hero.download")}
                </UiButton>
                <RouterLink to="/mods" custom>
                  {({ navigate }: { navigate: (e?: MouseEvent) => void }) => (
                    <UiButton size="lg" variant="secondary" onClick={navigate}>
                      {t("hero.mods")}
                    </UiButton>
                  )}
                </RouterLink>
                <UiButton size="lg" variant="text" href={GITHUB} external>
                  <Github size={16} />
                  {t("hero.github")}
                </UiButton>
              </div>
            </Reveal>

            <Reveal delay={420}>
              <div class="hero__stats">
                {stats.map((s) => (
                  <div class="hero__stat" key={s.key}>
                    <span class="hero__stat-value gradient-text">{s.value}</span>
                    <span class="hero__stat-label">{t(`hero.${s.key}`)}</span>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>

          <a class="hero__cue" href="#showcase-ships" aria-label="scroll">
            <ChevronDown size={20} />
          </a>
        </section>

        {/* ── SHOWCASE · 战舰展示 ───────────────────────────── */}
        <section id="showcase-ships" class="showcase showcase--ships">
          <div class="container showcase__head">
            <Reveal delay={80}>
              <h2 class="showcase__title">
                <span class="showcase__title-seg">{t("showcase.ships.titleA")}</span>
                <span class="showcase__title-seg">{t("showcase.ships.titleB")}</span>
              </h2>
            </Reveal>
            <Reveal delay={160}>
              <p class="showcase__desc">{t("showcase.ships.desc")}</p>
            </Reveal>
          </div>
          <Reveal delay={200} class="container">
            <div class="ship-stage">
              <ShipLive />
            </div>
          </Reveal>
        </section>

        {/* ── SHOWCASE · 对局复盘 ───────────────────────────── */}
        <section class="showcase showcase--replay section-bg">
          <div class="container showcase__head">
            <Reveal delay={80}>
              <h2 class="showcase__title">
                <span class="showcase__title-seg">{t("showcase.replay.titleA")}</span>
                <span class="showcase__title-seg">{t("showcase.replay.titleB")}</span>
              </h2>
            </Reveal>
            <Reveal delay={160}>
              <p class="showcase__desc">{t("showcase.replay.desc")}</p>
            </Reveal>
          </div>
          <Reveal delay={200} class="container">
            <ReplayLive />
          </Reveal>
        </section>

        {/* ── SHOWCASE · 舰船查询 ──────────────────────────── */}
        <section class="showcase showcase--lookup">
          <div class="container showcase__head">
            <Reveal delay={80}>
              <h2 class="showcase__title">
                <span class="showcase__title-seg">{t("showcase.lookup.titleA")}</span>
                <span class="showcase__title-seg">{t("showcase.lookup.titleB")}</span>
              </h2>
            </Reveal>
            <Reveal delay={160}>
              <p class="showcase__desc">{t("showcase.lookup.desc")}</p>
            </Reveal>
          </div>
          <Reveal delay={200} class="container">
            <LookupWindow />
          </Reveal>
        </section>

        {/* ── SHOWCASE · 水表战绩 ──────────────────────────── */}
        <section class="showcase showcase--stats section-bg">
          <div class="container showcase__head">
            <Reveal delay={80}>
              <h2 class="showcase__title">
                <span class="showcase__title-seg">{t("showcase.stats.titleA")}</span>
                <span class="showcase__title-seg">{t("showcase.stats.titleB")}</span>
              </h2>
            </Reveal>
            <Reveal delay={160}>
              <p class="showcase__desc">{t("showcase.stats.desc")}</p>
            </Reveal>
          </div>
          <Reveal delay={200} class="container">
            <StatsWindow />
          </Reveal>
        </section>

        {/* ── SHOWCASE · 插件管理 ───────────────────────────── */}
        <section class="showcase showcase--mods">
          <div class="aurora" />
          <div class="container showcase__head">
            <Reveal delay={80}>
              <h2 class="showcase__title">
                <span class="showcase__title-seg">{t("showcase.mods.titleA")}</span>
                <span class="showcase__title-seg">{t("showcase.mods.titleB")}</span>
              </h2>
            </Reveal>
            <Reveal delay={160}>
              <p class="showcase__desc">{t("showcase.mods.desc")}</p>
            </Reveal>
            <Reveal delay={220}>
              <RouterLink to="/mods" custom>
                {({ navigate }: { navigate: (e?: MouseEvent) => void }) => (
                  <UiButton variant="text" onClick={navigate}>
                    {t("showcase.mods.link")}
                    <ChevronRight size={15} />
                  </UiButton>
                )}
              </RouterLink>
            </Reveal>
          </div>
          <Reveal delay={260} class="container">
            <ModWindow />
          </Reveal>
        </section>

        {/* ── FEATURES ─────────────────────────────────────── */}
        <section id="features" class="features section-bg">
          <div class="container">
            <div class="features__head">
              <Reveal delay={80}>
                <h2 class="features__title">{t("features.subtitle")}</h2>
              </Reveal>
            </div>

            <div class="features__grid">
              {features.map((f, i) => {
                const Icon = f.icon;
                return (
                  <Reveal delay={i * 90} key={f.key}>
                    <article class="feature-card glass-panel is-interactive">
                      <div class="feature-card__icon">
                        <Icon size={22} />
                      </div>
                      <h3 class="feature-card__title">{t(`features.${f.key}.title`)}</h3>
                      <p class="feature-card__desc">{t(`features.${f.key}.desc`)}</p>
                    </article>
                  </Reveal>
                );
              })}
            </div>
          </div>
        </section>

        {/* ── CTA band ─────────────────────────────────────── */}
        <section class="cta-band">
          <div class="aurora" />
          <div class="container cta-band__inner">
            <Reveal>
              <h2 class="cta-band__title">{t("cta.title")}</h2>
            </Reveal>
            <Reveal delay={100}>
              <p class="cta-band__lede">{t("cta.lede")}</p>
            </Reveal>
            <Reveal delay={200}>
              <div class="cta-band__actions">
                <UiButton size="lg" href={RELEASES} external>
                  <Download size={17} />
                  {t("cta.download")}
                </UiButton>
                <UiButton size="lg" variant="text" href={GITHUB} external>
                  <Github size={16} />
                  GitHub
                </UiButton>
              </div>
            </Reveal>
          </div>
        </section>
      </div>
    );
  },
});
