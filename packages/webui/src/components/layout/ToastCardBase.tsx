import { computed, defineComponent, onBeforeUnmount, ref, Teleport, type PropType } from "vue";
import { X } from "@lucide/vue";

import { t } from "@/i18n";
import "./ToastCardBase.scss";

/** Card surface tones — one per legacy variant (info / success / warning)
 *  plus the piggy's own skin tone. */
export type ToastCardTone = "info" | "success" | "warning" | "piggy";

/** An action pill under the headline. `kind`: primary = the filled white
 *  pill (the card's main move), outline = the translucent white outline
 *  (the quiet fallback), quiet = the small outlined text button (the
 *  pass card's 取消 grammar). */
export interface ToastCardAction {
  label: string;
  kind?: "primary" | "outline" | "quiet";
  disabled?: boolean;
  /** Legacy per-card BEM hook appended beside the base classes (the
   *  UpdateAppliedToast parity tests select `.update-applied__view`). */
  class?: string;
  onClick: () => void;
}

/** The instance handle the per-card wrappers drive — the ONE leave
 *  machine (mounted/leaving + the delayed-unmount timer) lives in the
 *  base; the store-dumb wrappers only call in. */
export interface ToastCardBaseInstance {
  /** Raise the card: cancels a pending leave (a restart mid-leave
   *  restores the live card) and mounts. */
  show(): void;
  /** Fold the card out — the delayed unmount that gives the --leave
   *  transition its window. No-op while hidden or already leaving. */
  dismiss(): void;
  readonly shown: boolean;
  readonly leaving: boolean;
}

/** Leave-transition length, read off the theme's --duration-normal token
 *  (getComputedStyle parse — "240ms", "0.24s" and bare numbers all
 *  accepted; 260 ms fallback while no sheet is loaded, e.g. the unit
 *  tests where vitest stubs CSS imports). The --leave CSS animates the
 *  same token, so the timer and the transition cannot drift apart;
 *  reduced-motion zeroing collapses both to an instant fold. */
function readLeaveMs(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--duration-normal")
    .trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(raw);
  if (!match) return 260;
  const value = Number.parseFloat(match[1]);
  return match[2] === "s" ? value * 1000 : value;
}

/**
 * ToastCardBase — the single wowsp-local toast card primitive behind the
 * shell's bespoke top-right cards (UpdateAppliedToast /
 * UpdateStrandedToast / DownloadToast / AudioPlayerToast /
 * PiggyReminderToast). Owns, once for the whole family: the Teleported
 * fixed slot (hikari's toast column geometry — top 4rem / right 1rem /
 * the `--hk-z-toast` band / 22rem / blur), the ONE enter keyframe and the
 * ONE --leave modifier (driven by the delayed-unmount machine above), the
 * headline row (icon slot, message, never-shrinking meta, trailing slot,
 * quiet ×), the body slot, the right-aligned action pills and the
 * progress slot region.
 *
 * The base stays STORE-DUMB: sync-flush frozen-snapshot watchers, mount
 * graces and seek-flag resets are per-card wrapper concerns — each card
 * appends its legacy BEM root via `rootClass`, so its selectors and
 * sheets survive unchanged. Like the hikari cards it mirrors, the slot is
 * single-occupancy by design — two simultaneous passes overlap exactly,
 * the documented trade-off; no stacking/queueing is added here.
 */
export default defineComponent({
  name: "ToastCardBase",
  props: {
    /** Surface variant (background + primary-pill ink). */
    tone: { type: String as PropType<ToastCardTone>, default: "info" },
    /** The card's legacy BEM root, appended after the base classes so
     *  the per-card selector hooks (tests, sheets) survive unchanged. */
    rootClass: { type: String, required: true },
    /** Live-region semantics: "status" (polite) or "alert" (the
     *  stranded card's assertive raise). */
    role: { type: String as PropType<"status" | "alert">, default: "status" },
    /** Headline text — the `message` slot overrides it for composite
     *  rows (the audio card's name + running time). */
    message: { type: String, default: "" },
    /** Bold headline grammar (the success / warning / piggy cards wrap)
     *  vs the pass cards' single-line ellipsis. */
    bold: { type: Boolean, default: false },
    /** Hover-hint for the headline (the delegated data-hint channel —
     *  the mod pass surfaces its full step text on hover). */
    hint: { type: String, default: "" },
    /** Never-shrinking tabular readout on the row's right (the mod
     *  pass's "downloading 42% · 1.5 MB/s"). Empty → not rendered. */
    meta: { type: String, default: "" },
    /** Render the quiet × dismiss affordance (emits `close`). */
    close: { type: Boolean, default: false },
    /** Action pills under the row (right-aligned). */
    actions: { type: Array as PropType<ToastCardAction[]>, default: () => [] },
  },
  emits: { close: () => true },
  setup(props, { slots, emit, expose }) {
    const mounted = ref(false);
    const leaving = ref(false);
    const leaveMs = readLeaveMs();
    let leaveTimer: number | undefined;

    /** Raise the card (a restart mid-leave cancels the pending unmount
     *  and restores the live card). */
    function show() {
      if (leaveTimer !== undefined) {
        window.clearTimeout(leaveTimer);
        leaveTimer = undefined;
      }
      leaving.value = false;
      mounted.value = true;
    }

    /** Fold the card out — the delayed unmount that keeps the card
     *  alive for the --leave transition instead of snapping away. */
    function dismiss() {
      if (!mounted.value || leaving.value) return;
      leaving.value = true;
      leaveTimer = window.setTimeout(() => {
        leaveTimer = undefined;
        mounted.value = false;
        leaving.value = false;
      }, leaveMs);
    }

    onBeforeUnmount(() => {
      if (leaveTimer !== undefined) window.clearTimeout(leaveTimer);
    });

    expose({
      show,
      dismiss,
      shown: computed(() => mounted.value),
      leaving: computed(() => leaving.value),
    });

    return () => {
      if (!mounted.value) return null;
      const cls = props.rootClass;
      return (
        <Teleport to="body">
          <div
            class={["toast-card", `toast-card--${props.tone}`, cls, leaving.value ? `${cls}--leave` : ""]}
            role={props.role}
          >
            <div class="toast-card__row">
              {slots.icon && (
                <span class={["toast-card__icon", `${cls}__icon`]}>{slots.icon()}</span>
              )}
              <p
                class={["toast-card__message", `${cls}__message`, props.bold && "toast-card__message--bold"]}
                data-hint={props.hint || undefined}
              >
                {slots.message ? slots.message() : props.message}
              </p>
              {props.meta ? (
                <span class={["toast-card__meta", `${cls}__meta`]}>{props.meta}</span>
              ) : null}
              {slots.trailing?.()}
              {props.close && (
                <button
                  type="button"
                  class="toast-card__close"
                  aria-label={t("common.close")}
                  onClick={() => emit("close")}
                >
                  <X size={14} />
                </button>
              )}
            </div>
            {slots.body?.()}
            {props.actions.length > 0 && (
              <div class="toast-card__actions">
                {props.actions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    class={["toast-card__action", `toast-card__action--${action.kind ?? "primary"}`, action.class]}
                    disabled={action.disabled}
                    onClick={action.onClick}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
            {slots.progress?.()}
          </div>
        </Teleport>
      );
    };
  },
});
