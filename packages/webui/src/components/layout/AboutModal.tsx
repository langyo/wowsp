import { defineComponent, onMounted, ref } from "vue";
import { getVersion } from "@tauri-apps/api/app";

import SModal from "@/components/base/SModal";
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
    });

    return () => (
      <SModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={t("about.title")}
        width="26rem"
      >
        <div class="about-modal">
          <div class="about-modal__logo">⚓</div>
          <h2 class="about-modal__name">WoWSP</h2>
          <p class="about-modal__subtitle">{t("about.subtitle")}</p>
          <div class="about-modal__version">
            <span>v{version.value}</span>
            {updater.available ? (
              <button class="about-modal__update" onClick={() => void updater.downloadAndInstall()}>
                {t("about.updateAvailable")}
              </button>
            ) : updater.checked ? (
              <span class="about-modal__up-to-date">{t("about.upToDate")}</span>
            ) : (
              <button class="about-modal__check" onClick={() => void updater.check()}>
                {t("about.checkUpdate")}
              </button>
            )}
          </div>

          <p class="about-modal__desc">{t("about.description")}</p>

          <div class="about-modal__tech">
            {["Rust", "Vue 3", "Tauri 2", "Three.js", "Pinia", "UnoCSS"].map((tech) => (
              <span class="about-modal__tech-tag">{tech}</span>
            ))}
          </div>

          <div class="about-modal__links">
            <a href="https://github.com/celestia-island/wowsp" target="_blank" rel="noopener">
              GitHub
            </a>
            <a href="https://github.com/celestia-island/wowsp/issues" target="_blank" rel="noopener">
              {t("about.issues")}
            </a>
          </div>

          <footer class="about-modal__footer">
            <span>{t("about.license", { author: "langyo" })}</span>
          </footer>
        </div>
      </SModal>
    );
  },
});
