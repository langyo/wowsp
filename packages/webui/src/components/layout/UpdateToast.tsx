import { defineComponent, onMounted, ref, watch } from "vue";

import { HkSpinner } from "@celestia-island/hikari";

import ToastCardBase, { type ToastCardBaseInstance } from "./ToastCardBase";
import { t } from "@/i18n";
import { useUpdaterStore } from "@/stores/updater";
import { isMobileApp } from "@/utils/platform";
import "./UpdateToast.scss";

/** The phone app build never runs update passes (AppShell skips the
 *  updater there); the card renders nothing in that build even if some
 *  store state were to leak in — belt and braces for quiet failures. */
const QUIET_BUILD = isMobileApp();

/**
 * UpdateToast — the updater's live pass card (校验官方渠道 / 测镜像 /
 * 下载中 / 安装中), raised once the user answers 立即更新 and torn down
 * when the pass ends. Thin store wiring over ToastCardBase (which owns
 * the Teleported slot, the enter/--leave motion and the delayed-unmount
 * machine): the pass needs a bottom progress bar, a spinner icon while
 * the official channels are verified and the mirrors race, and a single
 * 取消 action — the shared blocking card fixes the icon set and always
 * renders both buttons. No controls during install: once the installer
 * has spawned the app is about to be killed, so there is nothing left
 * to cancel.
 *
 * The pass ending plays a leave transition instead of snapping away: the
 * base stays mounted for the fade while this wrapper serves a frozen
 * snapshot of the pass state, so the folding card keeps its text and
 * progress instead of blanking. Renders nothing while the store is idle,
 * so it is safe to keep mounted unconditionally at the shell level.
 */
export default defineComponent({
  name: "UpdateToast",
  setup() {
    const updater = useUpdaterStore();
    const card = ref<ToastCardBaseInstance | null>(null);

    /** Frozen pass state served while the leave transition runs. */
    const held = ref<{ statusText: string; downloading: boolean; determinate: boolean; progress: number | null }>({
      statusText: "",
      downloading: false,
      determinate: false,
      progress: null,
    });

    /** One running-flip evaluation — the sync watcher and the mount
     *  replay (the immediate watcher fires before the base ref binds)
     *  share it. */
    function applyRunning(run: boolean) {
      if (run) {
        // A restart mid-leave cancels the pending unmount and restores
        // the live card.
        card.value?.show();
      } else if (card.value?.shown && !card.value.leaving) {
        held.value = {
          statusText: updater.statusText,
          downloading: updater.downloading,
          determinate: updater.phase === "download" && updater.progress != null,
          progress: updater.progress,
        };
        card.value.dismiss();
      }
    }

    watch(
      () => updater.running,
      applyRunning,
      // The store clears downloading/phase/progress in the same sync block
      // that drops `running` — a pre-flush watcher would sample the
      // already-cleared fallbacks. Sync fires at the running flip, while
      // the pass state is still live, so the frozen card keeps its real
      // text and progress.
      { immediate: true, flush: "sync" },
    );

    // Replay the live state once the base card's ref exists — a pass
    // already running at mount raises the card on the same clock the
    // setup-time watcher used to.
    onMounted(() => applyRunning(updater.running));

    return () => {
      if (QUIET_BUILD) return null;
      // Live store while running; the frozen snapshot while folding out.
      const live = updater.running;
      const statusText = live ? updater.statusText : held.value.statusText;
      const downloading = live ? updater.downloading : held.value.downloading;
      const determinate = live
        ? updater.phase === "download" && updater.progress != null
        : held.value.determinate;
      const progress = live ? updater.progress : held.value.progress;
      return (
        <ToastCardBase
          ref={card}
          tone="info"
          rootClass="update-toast"
          message={statusText}
          actions={
            downloading
              ? [
                  {
                    label: t("about.updateCancel"),
                    kind: "quiet",
                    onClick: () => updater.cancelDownload(),
                  },
                ]
              : []
          }
        >
          {{
            icon: () => <HkSpinner size="xs" tone="current" />,
            progress: () => (
              <div class="toast-card__track">
                <div
                  class={["toast-card__fill", !determinate && "toast-card__fill--indeterminate"]}
                  style={determinate ? { width: `${progress}%` } : undefined}
                />
              </div>
            ),
          }}
        </ToastCardBase>
      );
    };
  },
});
