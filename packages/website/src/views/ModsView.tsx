import { defineComponent, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  Boxes, ShieldCheck, Sparkles, MessagesSquare, ChevronRight,
  Compass, DownloadCloud, BadgeCheck, RefreshCcw,
} from "@lucide/vue";
import { HButton, HCheckbox, HInput, HRadio, HTag } from "@celestia-island/hikari";
import { LinkButton, Reveal } from "@/components/ui";
import "./ModsView.scss";

const DISCUSSIONS = "https://github.com/langyo/wowsp/discussions";

export default defineComponent({
  name: "ModsView",
  setup() {
    const { t } = useI18n();

    const pillars = [
      { icon: Boxes, key: "sources" },
      { icon: ShieldCheck, key: "compat" },
      { icon: Sparkles, key: "content" },
    ] as const;

    const steps = [
      { icon: Compass, key: "discover" },
      { icon: DownloadCloud, key: "install" },
      { icon: BadgeCheck, key: "verify" },
      { icon: RefreshCcw, key: "migrate" },
    ] as const;

    const cats = ["aux", "skins", "voice", "patches"] as const;
    /* Roadmap mirrored from the app: everything but the version migrator
       already ships in the Mod Hub (catalog, indexer, installer). */
    const roadmap = [
      { key: "manifest", shipped: true },
      { key: "indexer", shipped: true },
      { key: "installer", shipped: true },
      { key: "migrator", shipped: false },
      { key: "browser", shipped: true },
    ] as const;

    /* interactive installer demo state */
    const source = ref("zip");
    const optRestore = ref(true);
    const optHash = ref(true);
    const optMigrate = ref(true);
    const url = ref("");

    return () => (
      <div class="mods">
        {/* ── hero ─────────────────────────────────────────── */}
        <section class="mods__hero">
          <div class="aurora" />
          <div class="container mods__hero-inner">
            <Reveal delay={80}>
              <h1 class="mods__title">{t("mods.hero.title")}</h1>
            </Reveal>
            <Reveal delay={160}>
              <p class="mods__lede">{t("mods.hero.lede")}</p>
            </Reveal>
            <Reveal delay={240}>
              <div class="mods__badges">
                <HTag variant="primary">{t("mods.hero.badgeAslain")}</HTag>
                <HTag variant="warning">{t("mods.hero.badgeGh")}</HTag>
                <HTag variant="success">{t("mods.hero.badgeCc0")}</HTag>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── pillars ──────────────────────────────────────── */}
        <section class="mods__section container">
          <div class="mods__grid mods__grid--3">
            {pillars.map((p, i) => {
              const Icon = p.icon;
              return (
                <Reveal delay={i * 90} key={p.key}>
                  <article class="mods__card glass-panel is-interactive">
                    <div class="mods__card-icon"><Icon size={22} /></div>
                    <h3 class="mods__card-title">{t(`mods.pillars.${p.key}.title`)}</h3>
                    <p class="mods__card-desc">{t(`mods.pillars.${p.key}.desc`)}</p>
                  </article>
                </Reveal>
              );
            })}
          </div>
        </section>

        {/* ── pipeline ─────────────────────────────────────── */}
        <section class="mods__section container">
          <Reveal class="mods__section-head">
            <h2 class="mods__section-title">{t("mods.pipeline.title")}</h2>
          </Reveal>
          <ol class="mods__pipeline">
            {steps.map((s, i) => {
              const Icon = s.icon;
              return (
                <Reveal delay={i * 110} key={s.key}>
                  <li class="mods__step">
                    <span class="mods__step-no">{String(i + 1).padStart(2, "0")}</span>
                    <span class="mods__step-icon"><Icon size={20} /></span>
                    <h3 class="mods__step-title">{t(`mods.pipeline.${s.key}.title`)}</h3>
                    <p class="mods__step-desc">{t(`mods.pipeline.${s.key}.desc`)}</p>
                  </li>
                </Reveal>
              );
            })}
          </ol>
        </section>

        {/* ── installer demo (UI kit live) ─────────────────── */}
        <section class="mods__section container">
          <Reveal class="mods__section-head">
            <h2 class="mods__section-title">{t("mods.installer.title")}</h2>
            <p class="mods__section-desc">{t("mods.installer.desc")}</p>
          </Reveal>
          <Reveal>
            <div class="mods__installer glass-panel">
              <div class="mods__installer-col">
                <span class="mods__installer-label">{t("mods.installer.sourceLabel")}</span>
                <HRadio
                  modelValue={source.value}
                  onUpdate:modelValue={(v: string | number) => (source.value = String(v))}
                  direction="vertical"
                  options={[
                    { value: "zip", label: t("mods.installer.sourceZip") },
                    { value: "gh", label: t("mods.installer.sourceGh") },
                    { value: "local", label: t("mods.installer.sourceLocal") },
                  ]}
                />
              </div>
              <div class="mods__installer-col">
                <span class="mods__installer-label">{t("mods.installer.optionsLabel")}</span>
                <HCheckbox v-model={optRestore.value} label={t("mods.installer.optRestore")} />
                <HCheckbox v-model={optHash.value} label={t("mods.installer.optHash")} />
                <HCheckbox v-model={optMigrate.value} label={t("mods.installer.optMigrate")} />
              </div>
              <div class="mods__installer-col mods__installer-col--wide">
                <HInput
                  v-model={url.value}
                  type="url"
                  label={t("mods.installer.urlLabel")}
                  placeholder={t("mods.installer.urlPlaceholder")}
                  hint={t("mods.installer.urlHint")}
                />
                <div class="mods__installer-actions">
                  <HButton disabled>{t("mods.installer.install")}</HButton>
                  <span class="mods__installer-note">{t("mods.installer.note")}</span>
                </div>
              </div>
            </div>
          </Reveal>
        </section>

        {/* ── categories ───────────────────────────────────── */}
        <section class="mods__section container">
          <Reveal class="mods__section-head">
            <h2 class="mods__section-title">{t("mods.cats.title")}</h2>
            <p class="mods__section-desc">{t("mods.cats.desc")}</p>
          </Reveal>
          <div class="mods__grid mods__grid--4">
            {cats.map((c, i) => (
              <Reveal delay={i * 80} key={c}>
                <article class="mods__cat glass-panel is-interactive">
                  <span class="mods__cat-count gradient-text">{t(`mods.cats.${c}.count`)}</span>
                  <h3 class="mods__cat-title">{t(`mods.cats.${c}.title`)}</h3>
                  <p class="mods__cat-desc">{t(`mods.cats.${c}.desc`)}</p>
                </article>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ── roadmap ──────────────────────────────────────── */}
        <section class="mods__section container">
          <Reveal class="mods__section-head">
            <h2 class="mods__section-title">{t("mods.roadmap.title")}</h2>
            <p class="mods__section-desc">{t("mods.roadmap.desc")}</p>
          </Reveal>
          <div class="mods__roadmap">
            {roadmap.map((r, i) => (
              <Reveal delay={i * 70} key={r.key}>
                <div class="mods__road-item glass-panel">
                  <span class="mods__road-index gradient-text">{String(i + 1).padStart(2, "0")}</span>
                  <div class="mods__road-body">
                    <h3 class="mods__road-title">
                      {t(`mods.roadmap.${r.key}.title`)}
                      <HTag variant={r.shipped ? "success" : "default"}>
                        {t(r.shipped ? "mods.roadmap.statusShipped" : "mods.roadmap.statusPlanned")}
                      </HTag>
                    </h3>
                    <p class="mods__road-desc">{t(`mods.roadmap.${r.key}.desc`)}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ── CTA ──────────────────────────────────────────── */}
        <section class="mods__cta">
          <div class="aurora" />
          <div class="container mods__cta-inner">
            <Reveal>
              <h2 class="mods__cta-title">{t("mods.cta.title")}</h2>
            </Reveal>
            <Reveal delay={100}>
              <p class="mods__cta-lede">{t("mods.cta.lede")}</p>
            </Reveal>
            <Reveal delay={200}>
              <LinkButton size="lg" href={DISCUSSIONS} external>
                <MessagesSquare size={17} />
                {t("mods.cta.button")}
                <ChevronRight size={16} />
              </LinkButton>
            </Reveal>
          </div>
        </section>
      </div>
    );
  },
});
