import { defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { Download } from "@lucide/vue";

import ToastCardBase, { type ToastCardBaseInstance } from "./ToastCardBase";
import { t } from "@/i18n";
import {
  DOWNLOAD_CARD_GRACE_MS,
  passPercent,
  useDownloadsStore,
  type ResourcePass,
} from "@/stores/downloads";
import { formatEta, formatSpeed } from "@/utils/format";
import "./DownloadToast.scss";

/** Frozen pass state served while the leave transition runs. */
interface HeldPass {
  label: string;
  step: string;
  meta: string;
  determinate: boolean;
  progress: number;
  cancellable: boolean;
}

/**
 * DownloadToast — the ONE top-right pass card every resource download shares.
 *
 * The resource pack and the decision-model pack (and any future `card`
 * context in the download registry) render here instead of inside the
 * Settings pane: a download started from a card, a boot-time prompt or a deep
 * link looks identical, follows the user to any page, and cannot be missed
 * because the settings modal happened to be closed.
 *
 * Thin store wiring over ToastCardBase (which owns the teleported slot, the
 * enter/--leave motion and the delayed-unmount machine). The row is split the
 * same way the mod pass card splits it: the headline (resource name + phase
 * verb) takes the ellipsis, while the never-shrinking meta carries the live
 * "42% · 1.5 MB/s · 00:12 left" readout, so a long localized resource name can
 * never eat the numbers. The bar runs the shared indeterminate slide whenever
 * the phase has no fraction (queued, racing mirrors, applying).
 *
 * The mount grace (DOWNLOAD_CARD_GRACE_MS, owned by the store) keeps a pass
 * that lands instantly (already current, refused before any byte) from
 * flashing a card; the store turns those into a toast instead. The leave
 * transition serves a frozen snapshot, so the folding card keeps real text
 * and progress rather than blanking.
 *
 * Renders nothing while every card context is idle, so it is safe to mount
 * unconditionally at the shell level — exactly like UpdateToast.
 */
export default defineComponent({
  name: "DownloadToast",
  setup() {
    const downloads = useDownloadsStore();
    const card = ref<ToastCardBaseInstance | null>(null);
    const held = ref<HeldPass>({
      label: "",
      step: "",
      meta: "",
      determinate: false,
      progress: 0,
      cancellable: false,
    });
    let mountTimer: number | undefined;

    /** The phase verb for the current pass (the card's step line). */
    function stepText(pass: ResourcePass): string {
      switch (pass.phase) {
        case "queued":
          return t("settings.downloadQueued");
        case "race":
          return t("settings.downloadRacing");
        case "verify":
          return t("settings.downloadVerifying");
        case "download":
          return t("settings.downloadStreaming");
        case "apply":
        case "installing":
          return t("settings.downloadApplying");
        case "install":
          return t("settings.downloadInstalling");
        case "done":
          return t("settings.downloadFinished");
        case "error":
          return t("settings.downloadFailed");
        default:
          return t("settings.downloadStreaming");
      }
    }

    /** The never-shrinking readout: percent, transfer rate and ETA, each only
     *  once it is real (no em-dash placeholders — a missing sample simply
     *  drops its part). */
    function metaText(pass: ResourcePass): string {
      const parts: string[] = [];
      const percent = passPercent(pass);
      if (percent != null) parts.push(`${percent}%`);
      if (pass.speedBps > 0) parts.push(formatSpeed(pass.speedBps));
      if (percent != null && pass.total > pass.received && pass.speedBps > 0) {
        const eta = formatEta((pass.total - pass.received) / pass.speedBps);
        if (eta) parts.push(t("settings.resEta", { time: eta }));
      }
      if (pass.segments > 1) {
        parts.push(t("settings.resSegment", { current: pass.segment, total: pass.segments }));
      }
      return parts.join(" · ");
    }

    /** One raise/fold evaluation — the sync watcher, the mount replay and the
     *  tick watcher share it, so the grace clock is armed exactly once. */
    function applyRunning(run: boolean) {
      if (run) {
        if (mountTimer === undefined && !card.value?.shown) {
          // The mount grace: only a pass still running past the window earns
          // the card. A pass that lands inside it never flashes.
          mountTimer = window.setTimeout(() => {
            mountTimer = undefined;
            if (downloads.running) card.value?.show();
          }, DOWNLOAD_CARD_GRACE_MS);
        } else if (card.value?.leaving) {
          // A restart mid-leave cancels the pending unmount.
          card.value.show();
        }
        return;
      }
      if (mountTimer !== undefined) {
        // The pass died inside the grace — the card never mounted, and no
        // leave snapshot is taken (the frozen text of a dead pass is exactly
        // the flash this guard removes).
        window.clearTimeout(mountTimer);
        mountTimer = undefined;
      }
      const pass = downloads.cardPass;
      if (card.value?.shown && !card.value.leaving && pass) {
        held.value = {
          label: downloads.labelFor(pass.kind),
          step: stepText(pass),
          meta: metaText(pass),
          determinate: passPercent(pass) != null,
          progress: passPercent(pass) ?? 0,
          cancellable: false,
        };
        card.value.dismiss();
      }
    }

    watch(
      () => downloads.running,
      applyRunning,
      // Sync so the fold snapshot samples the still-live pass state at the
      // running flip (the store settles in the same block).
      { immediate: true, flush: "sync" },
    );

    // Replay the live state once the base ref exists — a pass already running
    // at mount earns the card on the grace clock the setup watcher armed.
    onMounted(() => applyRunning(downloads.running));

    onBeforeUnmount(() => {
      if (mountTimer !== undefined) window.clearTimeout(mountTimer);
    });

    return () => {
      const live = downloads.running;
      const pass = downloads.cardPass;
      const label = live && pass ? downloads.labelFor(pass.kind) : held.value.label;
      const step = live && pass ? stepText(pass) : held.value.step;
      const meta = live && pass ? metaText(pass) : held.value.meta;
      const determinate = live && pass ? passPercent(pass) != null : held.value.determinate;
      const progress = live && pass ? (passPercent(pass) ?? 0) : held.value.progress;
      const cancellable = live && pass ? pass.busy && !pass.cancelling : held.value.cancellable;
      return (
        <ToastCardBase
          ref={card}
          tone="info"
          rootClass="download-toast"
          message={label}
          hint={label}
          meta={meta}
          actions={
            cancellable && pass
              ? [
                  {
                    label: t("settings.cacheCancel"),
                    kind: "quiet",
                    onClick: () => void downloads.cancel(pass.kind),
                  },
                ]
              : []
          }
        >
          {{
            icon: () => <Download size={14} />,
            body: () => (step ? <p class="download-toast__step">{step}</p> : null),
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