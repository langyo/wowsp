/** Keeps one settings section's render failure from taking the pane down.
 *
 *  Policy (user-facing contract):
 *  - an ORDINARY failure just raises the standard error toast (the app-wide
 *    sink already logs it) and the section is retried once after the error
 *    pass settles — a transient throw must not leave stale DOM behind;
 *  - a SEVERE failure (the retry throws again) fills the pane with the
 *    shared retryable ErrorCard instead of leaving a half-rendered husk.
 *
 *  The remount host uses `display: contents`: the settings pane's scroll and
 *  layout chain expect the section's own root as a direct child, and no
 *  wrapper box may be introduced. */
import { defineComponent, onErrorCaptured, ref } from "vue";

import { t } from "@/i18n";
import ErrorCard from "@/components/base/ErrorCard";
import { reportUiError } from "@/utils/uiError";

export default defineComponent({
  name: "SectionBoundary",
  setup(_, { slots }) {
    const error = ref("");
    const epoch = ref(0);
    const failures = ref(0);
    onErrorCaptured((err) => {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      reportUiError(message, stack);
      failures.value += 1;
      if (failures.value >= 2) {
        error.value = message;
        return false;
      }
      window.setTimeout(() => {
        epoch.value += 1;
      }, 250);
      return false;
    });
    return () => {
      if (error.value) {
        return (
          <ErrorCard
            error={error.value}
            description={t("settings.sectionCrashed")}
            retry={() => {
              error.value = "";
              failures.value = 0;
              epoch.value += 1;
            }}
          />
        );
      }
      return (
        <div key={epoch.value} class="settings-section-host">
          {slots.default?.()}
        </div>
      );
    };
  },
});
