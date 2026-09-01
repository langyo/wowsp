import { defineComponent } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import GithubMark from "@/components/GithubMark";
import "./SiteFooter.scss";

const GITHUB = "https://github.com/langyo/wowsp";

export default defineComponent({
  name: "SiteFooter",
  setup() {
    const { t } = useI18n();
    const docsHref = `${import.meta.env.BASE_URL}docs/`;

    return () => (
      <footer class="site-footer">
        <div class="site-footer__inner">
          <div class="site-footer__col site-footer__col--brand">
            <span class="site-footer__brand">WoWSP</span>
            <span class="site-footer__muted">© 2026 langyo · {t("footer.license")}</span>
            <span class="site-footer__muted">{t("footer.made")}</span>
          </div>
            <nav class="site-footer__col site-footer__links">
              <RouterLink to="/mods" class="site-footer__link">{t("nav.mods")}</RouterLink>
            <RouterLink to="/download" class="site-footer__link">{t("nav.download")}</RouterLink>
            <a href={docsHref} class="site-footer__link">{t("nav.docs")}</a>
            <a href={GITHUB} target="_blank" rel="noopener" class="site-footer__link">
              <GithubMark size={12} style="vertical-align: -2px; margin-right: 4px;" />
              GitHub
            </a>
          </nav>
        </div>
      </footer>
    );
  },
});
