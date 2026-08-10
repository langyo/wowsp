import { computed, defineComponent, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { Languages } from "lucide-vue-next";
import { LOCALE_OPTIONS, type Locale } from "@/locales";
import "./SiteNav.scss";

const GITHUB = "https://github.com/langyo/wowsp";

export default defineComponent({
  name: "SiteNav",
  setup() {
    const { t, locale } = useI18n();
    const docsHref = `${import.meta.env.BASE_URL}docs/`;
    const logoUrl = `${import.meta.env.BASE_URL}logo.webp`;

    const open = ref(false);
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

    function select(code: string) {
      locale.value = code as Locale;
      if (typeof document !== "undefined") document.documentElement.lang = code;
      try {
        localStorage.setItem("wowsp-site-locale", code);
      } catch {
        /* ignore */
      }
      open.value = false;
    }

    function toggle() {
      open.value = !open.value;
    }

    function onBlur(e: FocusEvent) {
      const next = e.relatedTarget as HTMLElement | null;
      if (!next || !(e.currentTarget as HTMLElement).contains(next)) {
        open.value = false;
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
            <a href="/#features" class="site-nav__link">{t("nav.features")}</a>
            <RouterLink to="/download" class="site-nav__link">{t("nav.download")}</RouterLink>
            <a href={docsHref} class="site-nav__link">{t("nav.docs")}</a>
            <a href={GITHUB} target="_blank" rel="noopener" class="site-nav__link">{t("nav.github")}</a>
          </nav>

          <div class="site-nav__lang" onBlur={onBlur}>
            <button
              class="site-nav__lang-btn"
              onClick={toggle}
              type="button"
              aria-haspopup="listbox"
              aria-expanded={open.value}
              aria-label={t("nav.language")}
            >
              <Languages size={14} />
              <span class="site-nav__lang-code">{current.value.native}</span>
            </button>
            <Transition name="s-lang">
              {open.value ? (
                <ul class="site-nav__lang-menu" role="listbox">
                  {LOCALE_OPTIONS.map((opt) => (
                    <li key={opt.code}>
                      <button
                        class={["site-nav__lang-opt", opt.code === locale.value ? "is-active" : ""].join(" ")}
                        onClick={() => select(opt.code)}
                        type="button"
                        role="option"
                        aria-selected={opt.code === locale.value}
                      >
                        <span class="site-nav__lang-opt-native">{opt.native}</span>
                        <span class="site-nav__lang-opt-label">{opt.label}</span>
                        {opt.code === locale.value ? <span class="site-nav__lang-opt-dot" /> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Transition>
          </div>
        </div>
      </header>
    );
  },
});
