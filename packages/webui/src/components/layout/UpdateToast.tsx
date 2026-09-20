import { defineComponent, onBeforeUnmount, ref, Teleport, watch } from "vue";

import { HSpinner } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { useUpdaterStore } from "@/stores/updater";
import "./UpdateToast.scss";

/** Leave transition length — must match the --leave duration below. */
const LEAVE_MS = 260;

/**
 * UpdateToast — the updater's live pass card (下载中 / 测镜像 / 安装中),
 * raised once the user answers 立即更新 and torn down when the pass ends.
 * Visual language mirrors hikari's blocking-toast card (same fixed
 * top-right column, same `--hk-z-toast` band, same info-blue variant
 * surface) but is rendered here, not through `showBlockingToast`: the
 * pass needs a bottom progress bar, a spinner icon while mirrors race,
 * and a single 取消 action — the shared blocking card fixes the icon set
 * and always renders both buttons. No controls during install: once the
 * installer has spawned the app is about to be killed, so there is
 * nothing left to cancel.
 *
 * The pass ending plays a leave transition instead of snapping away: the
 * card stays mounted for the fade (delayed unmount, same pattern as the
 * global tooltip) and renders a frozen snapshot of the pass state so the
 * folding card keeps its text and progress instead of blanking. Renders
 * nothing while the store is idle, so it is safe to keep mounted
 * unconditionally at the shell level.
 */
export default defineComponent({
  name: "UpdateToast",
  setup() {
    const updater = useUpdaterStore();

    const mounted = ref(false);
    const leaving = ref(false);
    /** Frozen pass state served while the leave transition runs. */
    const held = ref<{ statusText: string; downloading: boolean; determinate: boolean; progress: number | null }>({
      statusText: "",
      downloading: false,
      determinate: false,
      progress: null,
    });
    let leaveTimer: number | undefined;

    watch(
      () => updater.running,
      (run) => {
        if (run) {
          // A restart mid-leave cancels the pending unmount and restores
          // the live card.
          if (leaveTimer !== undefined) {
            window.clearTimeout(leaveTimer);
            leaveTimer = undefined;
          }
          leaving.value = false;
          mounted.value = true;
        } else if (mounted.value && !leaving.value) {
          held.value = {
            statusText: updater.statusText,
            downloading: updater.downloading,
            determinate: updater.phase === "download" && updater.progress != null,
            progress: updater.progress,
          };
          leaving.value = true;
          leaveTimer = window.setTimeout(() => {
            leaveTimer = undefined;
            mounted.value = false;
            leaving.value = false;
          }, LEAVE_MS);
        }
      },
      // The store clears downloading/phase/progress in the same sync block
      // that drops `running` — a pre-flush watcher would sample the
      // already-cleared fallbacks. Sync fires at the running flip, while
      // the pass state is still live, so the frozen card keeps its real
      // text and progress.
      { immediate: true, flush: "sync" },
    );

    onBeforeUnmount(() => {
      if (leaveTimer !== undefined) window.clearTimeout(leaveTimer);
    });

    return () => {
      if (!mounted.value) return null;
      // Live store while running; the frozen snapshot while folding out.
      const live = updater.running;
      const statusText = live ? updater.statusText : held.value.statusText;
      const downloading = live ? updater.downloading : held.value.downloading;
      const determinate = live
        ? updater.phase === "download" && updater.progress != null
        : held.value.determinate;
      const progress = live ? updater.progress : held.value.progress;
      return (
        <Teleport to="body">
          <div class={["update-toast", leaving.value ? "update-toast--leave" : ""]} role="status">
            <div class="update-toast__row">
              <span class="update-toast__icon">
                <HSpinner size="xs" tone="current" />
              </span>
              <p class="update-toast__message">{statusText}</p>
              {downloading && (
                <button
                  type="button"
                  class="update-toast__cancel"
                  onClick={() => updater.cancelDownload()}
                >
                  {t("about.updateCancel")}
                </button>
              )}
            </div>
            <div class="update-toast__track">
              <div
                class={[
                  "update-toast__fill",
                  !determinate && "update-toast__fill--indeterminate",
                ]}
                style={determinate ? { width: `${progress}%` } : undefined}
              />
            </div>
          </div>
        </Teleport>
      );
    };
  },
});
