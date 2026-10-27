import { defineComponent, onBeforeUnmount, ref, Teleport, watch } from "vue";
import { PackageCheck } from "@lucide/vue";

import { t } from "@/i18n";
import { MOD_PASS_CARD_GRACE_MS, usePluginUpdatesStore } from "@/stores/pluginUpdates";
import { formatSpeed } from "@/utils/format";
import { isMobileApp } from "@/utils/platform";
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
 * The row is split in two on purpose: the step line (item name + count)
 * takes all the ellipsis, while the meta line (live "downloading N% ·
 * X MB/s" — the app-updater parity — or the install verb) never shrinks,
 * so a long mod name can no longer swallow the progress readout.
 *
 * The pass ending plays a leave transition instead of snapping away
 * (delayed unmount + frozen snapshot, the UpdateToast pattern; the meta
 * text is frozen too). Renders nothing while the store is idle, so it is
 * safe to keep mounted unconditionally at the shell level.
 */
export default defineComponent({
  name: "ModUpdateToast",
  setup() {
    const updates = usePluginUpdatesStore();

    const mounted = ref(false);
    const leaving = ref(false);
    /** Frozen pass state served while the leave transition runs. */
    const held = ref({ stepText: "", metaText: "", determinate: false, progress: 0 });
    let leaveTimer: number | undefined;
    let mountTimer: number | undefined;

    /** The ellipsized line: which item the pass is on plus its step count. */
    function stepText(): string {
      return t("resources.pluginUpdateStep", {
        name: updates.currentName,
        done: updates.done + 1,
        total: updates.total,
      });
    }

    /** The never-shrinking meta: live download percent + transfer rate
     *  (formatSpeed is the app updater's formatter, em-dash until the
     *  mirror produces a sample), the install verb once streaming ends,
     *  and empty while the item's fraction is unknown (the bar animates
     *  the indeterminate slide then). */
    function metaText(): string {
      if (updates.phase === "download" && updates.percent != null) {
        const percent = t("resources.pluginUpdateDownloading", {
          percent: updates.percent,
        });
        return `${percent} · ${formatSpeed(updates.speedBps)}`;
      }
      if (updates.phase === "install") return t("resources.pluginUpdateInstalling");
      return "";
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
          if (mountTimer === undefined) {
            // The mount grace (MOD_PASS_CARD_GRACE_MS, owned by the
            // store): only a pass still running past the window earns
            // the card.
            mountTimer = window.setTimeout(() => {
              mountTimer = undefined;
              if (updates.running) mounted.value = true;
            }, MOD_PASS_CARD_GRACE_MS);
          }
        } else {
          if (mountTimer !== undefined) {
            // The pass died inside the grace — the card never mounts and
            // no leave snapshot is taken (the frozen text of a dead pass
            // is exactly the flash this guard exists to remove).
            window.clearTimeout(mountTimer);
            mountTimer = undefined;
          }
          if (mounted.value && !leaving.value) {
            held.value = {
              stepText: stepText(),
              metaText: metaText(),
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
        }
      },
      // Sync so the snapshot samples the still-live pass state at the
      // running flip — the store clears its fields in the same block.
      { immediate: true, flush: "sync" },
    );

    onBeforeUnmount(() => {
      if (leaveTimer !== undefined) window.clearTimeout(leaveTimer);
      if (mountTimer !== undefined) window.clearTimeout(mountTimer);
    });

    return () => {
      if (QUIET_BUILD || !mounted.value) return null;
      const live = updates.running;
      const step = live ? stepText() : held.value.stepText;
      const meta = live ? metaText() : held.value.metaText;
      const determinate = live ? updates.overallPercent != null : held.value.determinate;
      const progress = live ? (updates.overallPercent ?? 0) : held.value.progress;
      return (
        <Teleport to="body">
          <div class={["mod-update-toast", leaving.value ? "mod-update-toast--leave" : ""]} role="status">
            <div class="mod-update-toast__row">
              <span class="mod-update-toast__icon">
                <PackageCheck size={14} />
              </span>
              <p class="mod-update-toast__message" title={step}>
                {step}
              </p>
              {meta && <span class="mod-update-toast__meta">{meta}</span>}
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
