import { defineComponent, onMounted, ref } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import { Check, Download, MessageCircle, RefreshCw } from "@lucide/vue";

import { HButton, HModal } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { useUpdaterStore } from "@/stores/updater";
import { openExternal } from "@/utils/openExternal";
import AnnouncementContent from "./AnnouncementContent";
import "./AboutModal.scss";

/**
 * About modal: app name + version (dynamic via Tauri app API), tech stack,
 * links, license, and the QQ feedback group notice. Carries the mandatory
 * free & open-source notice as a permanent, always-visible card (no dismiss
 * — the dismissible twin lives in AnnouncementDialog). Includes a "check for
 * updates" action when the updater is available. Every link opens through
 * the Rust backend so the system default browser is used (the webview
 * itself never navigates remotely).
 */

const TECH_LINKS = [
  { label: "Rust", url: "https://www.rust-lang.org" },
  { label: "Vue 3", url: "https://vuejs.org" },
  { label: "Tauri 2", url: "https://tauri.app" },
  { label: "Three.js", url: "https://threejs.org" },
  { label: "Pinia", url: "https://pinia.vuejs.org" },
  { label: "UnoCSS", url: "https://unocss.dev" },
];

/** The About body — logo, version + updater, tech tags, links, license
 *  footer, QQ line, then the mandatory free & open-source notice as the
 *  last card. Rendered inside the AboutModal and inline in the settings
 *  modal's 关于 section. */
export const AboutContent = defineComponent({
  name: "AboutContent",
  setup() {
    const version = ref("0.1.0");
    const updater = useUpdaterStore();

    onMounted(async () => {
      // Dynamic version from the Tauri shell (falls back to package.json).
      try {
        version.value = await getVersion();
      } catch {
        // Browser dev mode — keep default "0.1.0".
      }
      // Portable installs can't self-update (NSIS-only) — probe once.
      void updater.init();
    });

    return () => (
      <div class="about-modal">
          <div class="about-modal__logo">
            <img src="/logo.webp" alt="WoWSP" />
          </div>
          <h2 class="about-modal__name">WoWSP</h2>
          <p class="about-modal__subtitle">{t("about.subtitle")}</p>
          <div class="about-modal__version">
            <span>v{version.value}</span>
            {updater.portable ? (
              <span class="about-modal__portable">Portable</span>
            ) : updater.running ? (
              <span class="about-modal__updating">{updater.statusText}</span>
            ) : updater.available ? (
              <HButton variant="secondary" size="sm" onClick={() => void updater.downloadAndInstall()}>
                <Download size={12} /> {t("about.updateAvailable", { version: updater.version ?? "" })}
              </HButton>
            ) : updater.checked ? (
              <span class="about-modal__up-to-date">
                <Check size={12} /> {t("about.upToDate")}
              </span>
            ) : (
              <HButton variant="ghost" size="sm" onClick={() => void updater.check()}>
                <RefreshCw size={12} /> {t("about.checkUpdate")}
              </HButton>
            )}
          </div>

          <p class="about-modal__desc">{t("about.description")}</p>

          <div class="about-modal__tech">
            {TECH_LINKS.map((tech) => (
              <button
                key={tech.label}
                type="button"
                class="about-modal__tech-tag"
                data-hint={tech.url}
                onClick={() => void openExternal(tech.url)}
              >
                {tech.label}
              </button>
            ))}
          </div>

          <div class="about-modal__links">
            <button
              type="button"
              class="about-modal__link"
              onClick={() => void openExternal("https://github.com/langyo/wowsp")}
            >
              GitHub
            </button>
            <button
              type="button"
              class="about-modal__link"
              onClick={() => void openExternal("https://github.com/langyo/wowsp/issues")}
            >
              {t("about.issues")}
            </button>
          </div>

          <footer class="about-modal__footer">
            <button
              type="button"
              class="about-modal__license"
              data-hint="Synthetic Source License 1.0"
              onClick={() => void openExternal("https://github.com/celestia-island/sysl")}
            >
              SySL-1.0 {t("about.license")}
            </button>
            <span>·</span>
            <button
              type="button"
              class="about-modal__license"
              onClick={() => void openExternal("https://github.com/langyo")}
            >
              © langyo
            </button>
          </footer>

          <p class="about-modal__qq">
            <MessageCircle size={12} />
            <span>{t("about.qqGroupNotice")}</span>
            <strong>{t("about.qqGroupNumber")}</strong>
          </p>

          {/* Mandatory free & open-source notice: rendered in full as the
              very last card — all info first, warning last, no inner
              scrollbar (the host scroller is the only one). */}
          <div class="about-modal__notice">
            <AnnouncementContent />
          </div>
        </div>
    );
  },
});

export default defineComponent({
  name: "AboutModal",
  props: {
    modelValue: { type: Boolean, default: false },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
  },
  setup(props, { emit }) {
    return () => (
      <HModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={t("about.title")}
        width="26rem"
      >
        <AboutContent />
      </HModal>
    );
  },
});
