/** Keeps one settings section's render failure from blanking the whole
 *  settings pane: the failing section lands on its ErrorCard (retry remounts
 *  it) while the app-wide error sink still reports the failure as a toast and
 *  in the app log. */
import { defineComponent, onErrorCaptured, ref } from "vue";

import { t } from "@/i18n";
import ErrorCard from "@/components/base/ErrorCard";
import { reportUiError } from "@/utils/uiError";

export default defineComponent({
  name: "SectionBoundary",
  setup(_, { slots }) {
    const error = ref("");
    const epoch = ref(0);
    onErrorCaptured((err) => {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      error.value = message;
      // Report from here too (the sink dedupes): the boundary stays
      // recoverable while the app log still gets message + stack.
      reportUiError(message, stack);
      // Keep propagating to the app-level handler as well.
      return true;
    });
    return () => {
      if (error.value) {
        return (
          <ErrorCard
            error={error.value}
            description={t("settings.sectionCrashed")}
            retry={() => {
              error.value = "";
              epoch.value += 1;
            }}
          />
        );
      }
      // No wrapper element: the settings pane's scroll and layout chain
      // expects the section's own root (an extra <div> made the whole
      // settings body scroll instead of only the pane). Retry needs no
      // key: the previous vnode was the ErrorCard component, so returning
      // the slot mounts the section afresh.
      void epoch.value;
      return slots.default?.();
    };
  },
});
