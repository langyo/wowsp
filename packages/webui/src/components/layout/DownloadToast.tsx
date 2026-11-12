import { defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { Download } from "@lucide/vue";

import ToastCardBase, { type ToastCardBaseInstance } from "./ToastCardBase";
import {
  DOWNLOAD_CARD_GRACE_MS,
  passPercent,
  phaseLabel,
  useDownloadsStore,
} from "@/stores/downloads";
import { t } from "@/i18n";
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
 * DownloadToast — the ONE top-right pass card for EVERY resource download.
 *
 * The app installer, the resource pack, the decision-model pack, the plugin
 * batch and any future context of the unified download registry render here,
 * and nowhere else: no settings pane draws a progress bar, and no download
 * kind keeps a bespoke card. A download therefore looks identical wherever it
 * was started from, follows the user to any page and survives closing the
 * settings modal.
 *
 * The card is data-driven off the pass ledger, so it needs no per-context
 * branches: the HEADLINE is the resource (or the batch item a pass is on), the
 * step line is the phase verb (or the owner's step text), and one fraction
 * drives the bar. That is everything the retired UpdateToast and
 * ModUpdateToast cards showed.
 *
 * Layout follows the mod pass card's split: the headline takes the ellipsis
 * while the never-shrinking meta carries the live "42% · 1.5 MB/s · 00:12
 * left", so a long localized resource name can never eat the numbers. The bar
 * runs the shared indeterminate slide whenever the phase has no fraction
 * (queued, racing mirrors, applying, an owner batch between items).
 *
 * The mount grace keeps a pass that lands instantly (already current, refused
 * before any byte) from flashing a card — the store turns those into a toast
 * instead. The leave transition serves a frozen snapshot, so the folding card
 * keeps real text and progress rather than blanking.
 *
 * Renders nothing while every card context is idle, so it mounts
 * unconditionally at the shell level.
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

    /** The card's second line: the owner's step text when it supplied one
     *  (a batch naming its item), else the phase verb, else nothing for a
     *  terminal pass (the headline + the finished verb already say it). */
    function stepText(pass: { phase: string; step: string }): string {
      if (pass.step) return pass.step;
      if (pass.phase === "done" || pass.phase === "error") return "";
      return phaseLabel(pass.phase);
    }

    /** The never-shrinking readout: percent, transfer rate and ETA, each only
     *  once it is real (no em-dash placeholders — a missing sample simply
     *  drops its part). */
    function metaText(pass: Parameters<typeof passPercent>[0]): string {
      if (!pass) return "";
      const percent = passPercent(pass);
      const parts: string[] = [];
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
     *  unmount path share it, so the grace clock is armed exactly once. */
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
          label: pass.label,
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
      const label = live && pass ? pass.label : held.value.label;
      const step = live && pass ? stepText(pass) : held.value.step;
      const meta = live && pass ? metaText(pass) : held.value.meta;
      const determinate = live && pass ? passPercent(pass) != null : held.value.determinate;
      const progress = live && pass ? (passPercent(pass) ?? 0) : held.value.progress;
      const cancellable =
        live && pass ? pass.busy && pass.cancellable && !pass.cancelling : held.value.cancellable;
      return (
        <ToastCardBase
          ref={card}
          tone="info"
          rootClass="download-toast"
          message={label}
          hint={live && step ? step : label}
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
