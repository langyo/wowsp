import { defineComponent, onBeforeUnmount, ref, Teleport, watch } from "vue";
import { PackageCheck } from "@lucide/vue";

import { t } from "@/i18n";
import { isMobileApp } from "@/utils/platform";
import { usePluginUpdatesStore } from "@/stores/pluginUpdates";
import "./ModUpdateToast.scss";

/** Leave transition length — must match the --leave duration below. */
const LEAVE_MS = 260;

/** The phone app build has no local plugins to update (Sidebar hides the
 *  trigger there); the card renders nothing even if state leaked in. */
const QUIET_BUILD = isMobileApp();

/**
 * ModUpdateToast — the plugin batch-update pass card (一键更新 from the
 * client-version selector's hover hint). Same visual family as
 * UpdateToast (hikari's top-right toast column, info-blue surface,
 * bottom progress track): sequential plugin/mod updates with an overall
 * percent — indeterminate slide while the current item reports no
 * fraction (probe phase, mirror race). No cancel: catalog installs
 * cannot be aborted mid-flight, so the card simply runs to completion
 * and folds failures into an error toast at the end.
 *
 * The pass ending plays a leave transition instead of snapping away
 * (delayed unmount + frozen snapshot, the UpdateToast pattern). Renders
 * nothing while the store is idle, so it is safe to keep mounted
 * unconditionally at the shell level.
 */
export default defineComponent({
  name: "ModUpdateToast",
  setup() {
    const updates = usePluginUpdatesStore();

    const mounted = ref(false);
    const leaving = ref(false);
    /** Frozen pass state served while the leave transition runs. */
    const held = ref({ statusText: "", determinate: false, progress: 0 });
    let leaveTimer: number | undefined;

    function statusText(): string {
      const step = t("resources.pluginUpdateStep", {
        name: updates.currentName,
        done: updates.done + 1,
        total: updates.total,
      });
      const phaseText =
        updates.phase === "download" && updates.percent != null
          ? t("resources.pluginUpdateDownloading", { percent: updates.percent })
          : updates.phase === "install"
            ? t("resources.pluginUpdateInstalling")
            : "";
      return phaseText ? `${step} · ${phaseText}` : step;
    }

    watch(
      () => updates.running,
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
            statusText: statusText(),
            determinate: updates.overallPercent != null,
            progress: updates.overallPercent ?? 0,
          };
          leaving.value = true;
          leaveTimer = window.setTimeout(() => {
            leaveTimer = undefined;
            mounted.value = false;
            leaving.value = false;
          }, LEAVE_MS);
        }
      },
      // Sync so the snapshot samples the still-live pass state at the
      // running flip — the store clears its fields in the same block.
      { immediate: true, flush: "sync" },
    );

    onBeforeUnmount(() => {
      if (leaveTimer !== undefined) window.clearTimeout(leaveTimer);
    });

    return () => {
      if (QUIET_BUILD || !mounted.value) return null;
      const live = updates.running;
      const text = live ? statusText() : held.value.statusText;
      const determinate = live ? updates.overallPercent != null : held.value.determinate;
      const progress = live ? (updates.overallPercent ?? 0) : held.value.progress;
      return (
        <Teleport to="body">
          <div class={["mod-update-toast", leaving.value ? "mod-update-toast--leave" : ""]} role="status">
            <div class="mod-update-toast__row">
              <span class="mod-update-toast__icon">
                <PackageCheck size={14} />
              </span>
              <p class="mod-update-toast__message">{text}</p>
            </div>
            <div class="mod-update-toast__track">
              <div
                class={[
                  "mod-update-toast__fill",
                  !determinate && "mod-update-toast__fill--indeterminate",
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
