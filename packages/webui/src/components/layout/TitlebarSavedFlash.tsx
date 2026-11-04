import { defineComponent } from "vue";
import { HkPersistentToast } from "@celestia-island/hikari";

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
 * The chip rides hikari's HkPersistentToast with the success tone (green
 * Check on the toast chip grammar — hikari 0.55.274). Same live-region
 * contract as TitlebarLoading: the wrapper is ALWAYS mounted (only the
 * chip inside is conditional), so appearing content can announce without
 * recreating the region. Chrome, not a control — pointer-events pass off
 * the whole slot, wrapper and chip included.
 */
export default defineComponent({
  name: "TitlebarSavedFlash",
  setup() {
    return () => (
      <span class="titlebar-saved-slot" role="status" aria-live="polite">
        {settingsSavedFlash.value && (
          <HkPersistentToast tone="success" label={t("common.saved")} />
        )}
      </span>
    );
  },
});
