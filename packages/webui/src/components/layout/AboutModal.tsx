import { defineComponent, onMounted, ref } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import { Check, Download, RefreshCw } from "lucide-vue-next";

import { HButton, HModal } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { useUpdaterStore } from "@/stores/updater";
import "./AboutModal.scss";

/**
 * About modal: app name + version (dynamic via Tauri app API), tech stack,
 * links, license. Includes a "check for updates" action when the updater
 * plugin is available.
 */
export default defineComponent({
  name: "AboutModal",
  props: {
    modelValue: { type: Boolean, default: false },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
  },
  setup(props, { emit }) {
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
      <HModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={t("about.title")}
        width="26rem"
      >
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
            ) : updater.available ? (
              <HButton variant="secondary" size="sm" onClick={() => void updater.downloadAndInstall()}>
                <Download size={12} /> {t("about.updateAvailable")}
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
            {["Rust", "Vue 3", "Tauri 2", "Three.js", "Pinia", "UnoCSS"].map((tech) => (
              <span class="about-modal__tech-tag">{tech}</span>
            ))}
          </div>

          <div class="about-modal__links">
            <a href="https://github.com/langyo/wowsp" target="_blank" rel="noopener">
              GitHub
            </a>
            <a href="https://github.com/langyo/wowsp/issues" target="_blank" rel="noopener">
              {t("about.issues")}
            </a>
          </div>

          <footer class="about-modal__footer">
            {/* License name links to the official SySL repository (the
                authoritative text per the LICENSE file). */}
            <a
              class="about-modal__license"
              href="https://github.com/celestia-island/sysl"
              target="_blank"
              rel="noopener"
            >
              SySL-1.0
            </a>
            <span>{t("about.license", { author: "langyo" })}</span>
          </footer>
        </div>
      </HModal>
    );
  },
});
