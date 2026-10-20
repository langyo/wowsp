import { Transition, defineComponent } from "vue";
import { Check } from "@lucide/vue";

import { settingsSavedFlash } from "@/stores/settingsSavedFlash";
import { t } from "@/i18n";
import "./TitlebarSavedFlash.scss";

/**
 * Title-bar saved chip — the one-second "已保存" acknowledgment that a
 * settings write landed (see stores/settingsSavedFlash.ts, where every
 * persist path notifies). Renders inside HkTitleBar's `actions` slot
 * (AppTitleBar.tsx) beside the loading/fault/stream chips — right-aligned,
 * immediately left of the settings gear — so the caption cluster's
 * transient statuses stay in one place.
 *
 * Same live-region contract as TitlebarLoading: the wrapper is ALWAYS
 * mounted (only the chip inside is conditional), so appearing content can
 * announce without recreating the region. Chrome, not a control —
 * pointer-events pass off the whole slot, wrapper included.
 */
export default defineComponent({
  name: "TitlebarSavedFlash",
  setup() {
    return () => (
      <span class="titlebar-saved-slot" role="status" aria-live="polite">
        <Transition name="titlebar-saved">
          {settingsSavedFlash.value && (
            <span class="titlebar-saved-chip">
              <Check class="titlebar-saved-chip__icon" size={11} />
              <span class="titlebar-saved-chip__label">{t("common.saved")}</span>
            </span>
          )}
        </Transition>
      </span>
    );
  },
});
