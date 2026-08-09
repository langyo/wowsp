import { computed, defineComponent } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import "./SiteNav.scss";

const GITHUB = "https://github.com/langyo/wowsp";

export default defineComponent({
  name: "SiteNav",
  setup() {
    const { t, locale } = useI18n();
    // Docs are served under the site base (/docs/ on the custom domain,
    // /wowsp/docs/ on the GitHub Pages project URL).
    const docsHref = `${import.meta.env.BASE_URL}docs/`;

    const langLabel = computed(() => (locale.value === "zh-CN" ? "EN" : "中文"));

    function toggleLang() {
      locale.value = locale.value === "zh-CN" ? "en" : "zh-CN";
      if (typeof document !== "undefined") {
        document.documentElement.lang = locale.value;
      }
    }

    return () => (
      <header class="site-nav">
        <RouterLink to="/" class="site-nav__brand">
          <img src="/logo.webp" alt="WoWSP" class="site-nav__logo" />
          <span class="site-nav__name">WoWSP</span>
        </RouterLink>

        <nav class="site-nav__links">
          <a href="/#features" class="site-nav__link">{t("nav.features")}</a>
          <RouterLink to="/download" class="site-nav__link">{t("nav.download")}</RouterLink>
          <a href={docsHref} class="site-nav__link">{t("nav.docs")}</a>
          <a href={GITHUB} target="_blank" rel="noopener" class="site-nav__link">{t("nav.github")}</a>
        </nav>

        <button class="site-nav__lang" onClick={toggleLang} type="button">
          {langLabel.value}
        </button>
      </header>
    );
  },
});
