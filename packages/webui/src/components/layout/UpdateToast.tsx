import { defineComponent, Teleport } from "vue";

import { HSpinner } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { useUpdaterStore } from "@/stores/updater";
import "./UpdateToast.scss";

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
 * nothing left to cancel. Renders nothing while the store is idle, so it
 * is safe to keep mounted unconditionally at the shell level.
 */
export default defineComponent({
  name: "UpdateToast",
  setup() {
    const updater = useUpdaterStore();

    return () => {
      if (!updater.running) return null;
      const determinate = updater.phase === "download" && updater.progress != null;
      return (
        <Teleport to="body">
          <div class="update-toast" role="status">
            <div class="update-toast__row">
              <span class="update-toast__icon">
                <HSpinner size="xs" tone="current" />
              </span>
              <p class="update-toast__message">{updater.statusText}</p>
              {updater.downloading && (
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
                style={determinate ? { width: `${updater.progress}%` } : undefined}
              />
            </div>
          </div>
        </Teleport>
      );
    };
  },
});
