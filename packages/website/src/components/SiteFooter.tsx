import { defineComponent } from "vue";
import { useI18n } from "vue-i18n";
import "./SiteFooter.scss";

const GITHUB = "https://github.com/langyo/wowsp";

export default defineComponent({
  name: "SiteFooter",
  setup() {
    const { t } = useI18n();

    return () => (
      <footer class="site-footer">
        <div class="site-footer__inner">
          <span class="site-footer__copy">© 2026 langyo · {t("footer.license")}</span>
          <span class="site-footer__made">{t("footer.made")}</span>
          <a href={GITHUB} target="_blank" rel="noopener" class="site-footer__link">
            GitHub
          </a>
        </div>
      </footer>
    );
  },
});
