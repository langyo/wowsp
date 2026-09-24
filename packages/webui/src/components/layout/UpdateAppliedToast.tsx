import { defineComponent, onBeforeUnmount, onMounted, ref, Teleport } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import { CircleCheck, X } from "@lucide/vue";

import { t } from "@/i18n";
import { useSettingsUiStore } from "@/stores/settingsUi";
import { isMobileApp, isTauri } from "@/utils/platform";
import "./UpdateAppliedToast.scss";

/** Leave transition length — matches the --leave duration in the scss
 *  (same grammar as UpdateToast's folding card). */
const LEAVE_MS = 260;

/** How long the card lingers before folding away on its own — long
 *  enough to be noticed, short enough to be gone before the updater's
 *  delayed startup prompt could stack on top of it. */
const AUTO_DISMISS_MS = 8000;

/** localStorage slot remembering the version the LAST run booted into:
 *  the update installer kills the app and relaunches the new build, so
 *  a fresh process compares this against its own version to know an
 *  update just landed (same pattern as the onboarding run-once flags). */
const LAST_RUN_KEY = "wowsp-last-run-version";

/**
 * UpdateAppliedToast — the after-update success card (已更新到 v…). The
 * installer's relaunch is a brand-new process with no memory of the
 * pass, so the card keys off the persisted `wowsp-last-run-version`
 * slot instead: any boot whose version differs from the last recorded
 * one raises the card once, then records the new version. First-ever
 * boots stay silent (nothing to compare against).
 *
 * Visual language is UpdateToast's twin — same fixed top-right column,
 * same `--hk-z-toast` band, same blur card — in the success green
 * variant, with a 查看 action that lands in the settings' 更新日志
 * section (GitHub Releases notes) instead of a progress bar. Renders
 * nothing outside the desktop Tauri shell (browser dev has no version
 * to compare; the phone app updates through its store pipeline), so it
 * mounts unconditionally next to UpdateToast.
 */
export default defineComponent({
  name: "UpdateAppliedToast",
  setup() {
    const settings = useSettingsUiStore();

    const mounted = ref(false);
    const leaving = ref(false);
    const version = ref("");
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

    onMounted(async () => {
      if (!isTauri() || isMobileApp()) return;
      let current: string;
      try {
        current = await getVersion();
      } catch {
        return;
      }
      // Record THIS run's version before deciding anything — even a
      // skipped boot (first ever, or already recorded) must leave the
      // slot current so the next update is still detected.
      const stored = localStorage.getItem(LAST_RUN_KEY);
      localStorage.setItem(LAST_RUN_KEY, current);
      if (!stored || stored === current) return;
      version.value = current;
      mounted.value = true;
      autoTimer = window.setTimeout(dismiss, AUTO_DISMISS_MS);
    });

    onBeforeUnmount(() => {
      if (autoTimer !== undefined) window.clearTimeout(autoTimer);
      if (leaveTimer !== undefined) window.clearTimeout(leaveTimer);
    });

    return () => {
      if (!mounted.value) return null;
      return (
        <Teleport to="body">
          <div
            class={["update-applied", leaving.value ? "update-applied--leave" : ""]}
            role="status"
          >
            <div class="update-applied__row">
              <span class="update-applied__icon">
                <CircleCheck size={16} />
              </span>
              <p class="update-applied__message">
                {t("about.updateAppliedTitle", { version: version.value })}
              </p>
              <button
                type="button"
                class="update-applied__close"
                aria-label={t("common.close")}
                onClick={dismiss}
              >
                <X size={14} />
              </button>
            </div>
            <div class="update-applied__actions">
              <button
                type="button"
                class="update-applied__view"
                onClick={() => {
                  settings.show("changelog");
                  dismiss();
                }}
              >
                {t("about.updateAppliedView")}
              </button>
            </div>
          </div>
        </Teleport>
      );
    };
  },
});
