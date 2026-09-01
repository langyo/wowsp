import { computed, defineComponent, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { Languages, Download } from "@lucide/vue";
import { LOCALE_OPTIONS, type Locale } from "@/locales";
import { HButton, HMenu } from "@celestia-island/hikari";
import "./SiteNav.scss";

const GITHUB = "https://github.com/langyo/wowsp";

export default defineComponent({
  name: "SiteNav",
  setup() {
    const { t, locale } = useI18n();
    const docsHref = `${import.meta.env.BASE_URL}docs/`;
    const logoUrl = `${import.meta.env.BASE_URL}logo.webp`;

    const scrolled = ref(false);

    function onScroll() {
      scrolled.value = window.scrollY > 8;
    }

    onMounted(() => {
      onScroll();
      window.addEventListener("scroll", onScroll, { passive: true });
    });
    onUnmounted(() => window.removeEventListener("scroll", onScroll));

    const current = computed(
      () => LOCALE_OPTIONS.find((l) => l.code === locale.value) ?? LOCALE_OPTIONS[0],
    );

    const langItems = computed(() =>
      LOCALE_OPTIONS.map((opt) => ({
        key: opt.code,
        label: opt.label,
        checked: opt.code === locale.value,
      })),
    );
    const langOpen = ref(false);
    const langAnchor = ref<HTMLElement | null>(null);

    function select(code: string) {
      langOpen.value = false;
      locale.value = code as Locale;
      if (typeof document !== "undefined") document.documentElement.lang = code;
      try {
        localStorage.setItem("wowsp-site-locale", code);
      } catch {
        /* ignore */
      }
    }

    return () => (
      <header class={["site-nav", scrolled.value ? "is-scrolled" : ""].join(" ")}>
        <div class="site-nav__inner">
          <RouterLink to="/" class="site-nav__brand">
            <img src={logoUrl} alt="WoWSP" class="site-nav__logo" />
            <span class="site-nav__name">WoWSP</span>
          </RouterLink>

          <nav class="site-nav__links">
            <a href={`${import.meta.env.BASE_URL}#features`} class="site-nav__link">{t("nav.features")}</a>
            <RouterLink to="/mods" class="site-nav__link">{t("nav.mods")}</RouterLink>
            <RouterLink to="/download" class="site-nav__link">{t("nav.download")}</RouterLink>
            <a href={docsHref} class="site-nav__link">{t("nav.docs")}</a>
            <a href={GITHUB} target="_blank" rel="noopener" class="site-nav__link">{t("nav.github")}</a>
          </nav>

          <div class="site-nav__side">
            <span>
              <button
                type="button"
                ref={langAnchor}
                class="site-nav__lang-btn"
                aria-label={t("nav.language")}
                onClick={() => (langOpen.value = !langOpen.value)}
              >
                <Languages size={14} />
                <span class="site-nav__lang-code">{current.value.native}</span>
              </button>
              <HMenu
                items={langItems.value}
                open={langOpen.value}
                anchorRef={langAnchor.value}
                placement="bottom-end"
                onSelect={(code: string) => select(String(code))}
              />
            </span>
            <RouterLink to="/download" custom>
              {({ navigate }: { navigate: (e?: MouseEvent) => void }) => (
                <HButton size="sm" class="site-nav__cta" onClick={navigate}>
                  <Download size={14} />
                  {t("nav.download")}
                </HButton>
              )}
            </RouterLink>
          </div>
        </div>
      </header>
    );
  },
});
