import { defineComponent, onBeforeUnmount, onMounted, ref } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import { CircleCheck } from "@lucide/vue";

import ToastCardBase, { type ToastCardBaseInstance } from "./ToastCardBase";
import { t } from "@/i18n";
import { useSettingsUiStore } from "@/stores/settingsUi";
import { peekLastRunVersion, recordRunVersion } from "@/utils/lastRunVersion";
import { isMobileApp, isNative } from "@/utils/platform";
import "./UpdateAppliedToast.scss";

/** How long the card lingers before folding away on its own — long
 *  enough to be noticed, short enough to be gone before the updater's
 *  delayed startup prompt could stack on top of it. */
const AUTO_DISMISS_MS = 8000;

/**
 * UpdateAppliedToast — the after-update success card (已更新到 v…). The
 * installer's relaunch is a brand-new process with no memory of the
 * pass, so the card keys off the persisted `wowsp-last-run-version`
 * slot instead: any boot whose version differs from the last recorded
 * one raises the card once, then records the new version. First-ever
 * boots stay silent (nothing to compare against).
 *
 * Thin store wiring over ToastCardBase — the base owns the fixed slot,
 * the success surface, the bold headline, the quiet × and the filled
 * 查看 pill (its primary kind in the success ink; the legacy
 * `update-applied__view` hook rides on the action). Renders nothing
 * outside the desktop Tauri shell (browser dev has no version to
 * compare; the phone app updates through its store pipeline), so it
 * mounts unconditionally next to UpdateToast.
 */
export default defineComponent({
  name: "UpdateAppliedToast",
  setup() {
    const settings = useSettingsUiStore();
    const card = ref<ToastCardBaseInstance | null>(null);
    const version = ref("");
    let autoTimer: number | undefined;

    /** Stop the auto-dismiss, then fold the card out (the base's
     *  delayed unmount keeps it alive for the --leave transition). */
    function dismiss() {
      if (autoTimer !== undefined) {
        window.clearTimeout(autoTimer);
        autoTimer = undefined;
      }
      card.value?.dismiss();
    }

    onMounted(async () => {
      if (!isNative() || isMobileApp()) return;
      let current: string;
      try {
        current = await getVersion();
      } catch {
        return;
      }
      // Record THIS run's version before deciding anything — even a
      // skipped boot (first ever, or already recorded) must leave the
      // slot current so the next update is still detected.
      const stored = peekLastRunVersion();
      recordRunVersion(current);
      if (!stored || stored === current) return;
      version.value = current;
      card.value?.show();
      autoTimer = window.setTimeout(dismiss, AUTO_DISMISS_MS);
    });

    onBeforeUnmount(() => {
      if (autoTimer !== undefined) window.clearTimeout(autoTimer);
    });

    return () => (
      <ToastCardBase
        ref={card}
        tone="success"
        rootClass="update-applied"
        message={t("about.updateAppliedTitle", { version: version.value })}
        bold
        close
        onClose={dismiss}
        actions={[
          {
            label: t("about.updateAppliedView"),
            kind: "primary",
            class: "update-applied__view",
            onClick: () => {
              settings.show("changelog");
              dismiss();
            },
          },
        ]}
      >
        {{ icon: () => <CircleCheck size={16} /> }}
      </ToastCardBase>
    );
  },
});
