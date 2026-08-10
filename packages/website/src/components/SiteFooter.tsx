import { defineComponent } from "vue";
import { useI18n } from "vue-i18n";
import { Github } from "lucide-vue-next";
import "./SiteFooter.scss";

const GITHUB = "https://github.com/langyo/wowsp";

export default defineComponent({
  name: "SiteFooter",
  setup() {
    const { t } = useI18n();

    return () => (
      <footer class="site-footer">
        <div class="site-footer__inner">
          <span>© 2026 langyo · {t("footer.license")}</span>
          <span>{t("footer.made")}</span>
          <a href={GITHUB} target="_blank" rel="noopener" class="site-footer__link">
            <Github size={12} style="vertical-align: -2px; margin-right: 4px;" />
            GitHub
          </a>
        </div>
      </footer>
    );
  },
});
