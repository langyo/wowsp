import { defineComponent, onBeforeUnmount, onMounted, ref, watch, Teleport } from "vue";
import { TriangleAlert, X } from "@lucide/vue";

import { useUpdaterStore } from "@/stores/updater";
import { isMobileApp, isNative } from "@/utils/platform";
import { t } from "@/i18n";
import "./UpdateStrandedToast.scss";

/** Leave transition length — matches the --leave duration in the scss
 *  (same grammar as UpdateAppliedToast's folding card). */
const LEAVE_MS = 260;

/** How long the card lingers before folding away on its own — the
 *  recovery actions outlast the success card's 8 s: the wizard launch
 *  is a deliberate decision, not a glance. */
const AUTO_DISMISS_MS = 60000;

/**
 * UpdateStrandedToast — the stranded-update recovery card. When the
 * startup reconciliation finds the previous launch handed off to an
 * update that never landed (the one-shot `update-pending.json` marker
 * in the data dir), this warning card rises in the shared top-right
 * toast column with the two ways out: 干净重装 re-runs the installer the
 * stranded pass already downloaded — visibly, as a standalone wizard,
 * never silently — and 打开下载页 falls back to the website when the
 * cached installer is gone. The card folds on either action (the
 * wizard's own flow stops this app at its install step); the ordinary
 * update banner keeps offering the silent retry independently. Renders
 * nothing outside the desktop Tauri shell, like its sibling cards.
 */
export default defineComponent({
  name: "UpdateStrandedToast",
  setup() {
    const updater = useUpdaterStore();

    const mounted = ref(false);
    const leaving = ref(false);
    let leaveTimer: number | undefined;
    let autoTimer: number | undefined;

    /** Fold the card out (delayed unmount) and stop the auto-dismiss. */
    function dismiss() {
      if (autoTimer !== undefined) {
        window.clearTimeout(autoTimer);
        autoTimer = undefined;
      }
      if (!mounted.value || leaving.value) return;
      leaving.value = true;
      leaveTimer = window.setTimeout(() => {
        leaveTimer = undefined;
        mounted.value = false;
        leaving.value = false;
      }, LEAVE_MS);
    }

    onMounted(() => {
      if (!isNative() || isMobileApp()) return;
      // The store's init() reads the reconciliation verdict; the card
      // rises whenever a stranded handoff shows up (and again never —
      // the marker is one-shot).
      watch(
        () => updater.stranded,
        (stranded) => {
          if (stranded && !mounted.value) {
            mounted.value = true;
            autoTimer = window.setTimeout(dismiss, AUTO_DISMISS_MS);
          }
        },
        { immediate: true },
      );
    });

    onBeforeUnmount(() => {
      if (autoTimer !== undefined) window.clearTimeout(autoTimer);
      if (leaveTimer !== undefined) window.clearTimeout(leaveTimer);
    });

    return () => {
      if (!mounted.value || !updater.stranded) return null;
      const stranded = updater.stranded;
      return (
        <Teleport to="body">
          <div
            class={["update-stranded", leaving.value ? "update-stranded--leave" : ""]}
            role="alert"
          >
            <div class="update-stranded__row">
              <span class="update-stranded__icon">
                <TriangleAlert size={16} />
              </span>
              <p class="update-stranded__message">{t("about.updateStrandedTitle")}</p>
              <button
                type="button"
                class="update-stranded__close"
                aria-label={t("common.close")}
                onClick={dismiss}
              >
                <X size={14} />
              </button>
            </div>
            <p class="update-stranded__body">
              {t("about.updateStrandedBody", { version: stranded.expected })}
            </p>
            <div class="update-stranded__actions">
              {stranded.installer_ready && (
                <button
                  type="button"
                  class="update-stranded__reinstall"
                  disabled={updater.recovering}
                  onClick={() => {
                    void updater.reinstallFromCache();
                    dismiss();
                  }}
                >
                  {t("about.updateStrandedReinstall")}
                </button>
              )}
              <button
                type="button"
                class="update-stranded__download"
                onClick={() => {
                  void updater.openDownloadPage();
                  dismiss();
                }}
              >
                {t("about.updateStrandedDownload")}
              </button>
            </div>
          </div>
        </Teleport>
      );
    };
  },
});
