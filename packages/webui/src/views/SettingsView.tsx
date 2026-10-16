import { computed, defineComponent, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ArrowLeft } from "@lucide/vue";

import SettingsBody from "@/components/settings/SettingsBody";
import {
  SETTINGS_SECTION_IDS,
  normalizeSettingsSection,
  useSettingsUiStore,
  type SettingsSection,
} from "@/stores/settingsUi";
import { t } from "@/i18n";
import "./SettingsView.scss";

/** Parse a ?section= value into a valid section (falls back to the store's
 *  current one, i.e. the URL simply doesn't move it on garbage). */
function parseSection(raw: unknown): SettingsSection | null {
  const s = SETTINGS_SECTION_IDS.find((id) => id === String(raw ?? ""));
  return s ? normalizeSettingsSection(s) : null;
}

/**
 * Settings PAGE — the phone-layout surface for the shared settings body
 * (same SettingsBody as the desktop modal, with its own inner rail). A
 * real route, so the Android back gesture / drawer-back works naturally:
 * back leaves settings, back again would close the drawer if it pushed an
 * entry. The active section rides the URL (?section=account) — shareable,
 * and rail taps replace (not push) history so the back stack stays clean.
 *
 * The top bar carries the back affordance; the rail collapses to an icon
 * strip on phone widths (SettingsView.scss) and shows labels at wider
 * sizes, same as the desktop modal's rail.
 */
export default defineComponent({
  name: "SettingsView",
  setup() {
    const route = useRoute();
    const router = useRouter();
    const ui = useSettingsUiStore();

    // Landing: honor ?section= (clamped to what this build can show).
    const initial = parseSection(route.query.section);
    if (initial) ui.section = initial;

    /** Back = history back when there is somewhere to go (normal in-app
     *  arrival), else the dashboard (deep link / restored tab). */
    function goBack() {
      if (window.history.state?.back != null) {
        router.back();
      } else {
        void router.replace("/");
      }
    }

    // Rail taps (store) → URL. Replace, not push: section switches must
    // not stack history entries between the back-out point and here.
    watch(
      () => ui.section,
      (s) => {
        if (route.name !== "settings") return;
        if (route.query.section !== s) {
          void router.replace({ query: { ...route.query, section: s } });
        }
      },
    );

    // URL → store (settingsUi.show() while already on the page navigates
    // with a new ?section=; back/forward through section states too).
    watch(
      () => route.query.section,
      (raw) => {
        if (route.name !== "settings") return;
        const s = parseSection(raw);
        if (s && ui.section !== s) ui.section = s;
      },
    );

    const title = computed(() => t("settings.title"));

    return () => (
      <main class="settings-page">
        <header class="settings-page__bar">
          <button
            type="button"
            class="settings-page__back"
            onClick={goBack}
            aria-label={t("nav.back")}
          >
            <ArrowLeft size={17} />
            <span class="settings-page__back-label">{t("nav.back")}</span>
          </button>
          <h1 class="settings-page__title">{title.value}</h1>
        </header>
        <div class="settings-page__body">
          <SettingsBody active={true} />
        </div>
      </main>
    );
  },
});
