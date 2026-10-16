import { defineComponent, onBeforeUnmount, ref } from "vue";

import { HkModal } from "@celestia-island/hikari";

import { t } from "@/i18n";
import "./ModOpDisclaimer.scss";

/** localStorage marker — "1" means the player has acknowledged the mod
 *  operation disclaimer once and never sits through it again. */
const ACK_KEY = "wowsp-modhub-disclaimer-acked";
/** Forced minimum reading time (seconds) before the confirm button
 *  unlocks — the same blind-click guard idea as the onboarding wizard's
 *  notice step, scaled up because this text is the one that matters. */
const ACK_COUNTDOWN_SECONDS = 10;

// Module-level singleton: the gate is awaited from ResourcesView's
// handlers while the modal itself renders inside that view — one live
// instance at a time, so plain module state is enough (the pluginPrompt
// store's marker pattern, minus Pinia: nothing else needs to react).
const open = ref(false);
const remaining = ref(ACK_COUNTDOWN_SECONDS);
const waiters: Array<(ok: boolean) => void> = [];
let timer: number | undefined;
/** In-memory twin of the localStorage marker, set on confirm even when
 *  persisting fails — with storage unavailable the ack then lives for
 *  this session instead of re-asking before every operation. */
let sessionAcked = false;

function isAcknowledged(): boolean {
  if (sessionAcked) return true;
  try {
    return localStorage.getItem(ACK_KEY) === "1";
  } catch {
    // storage unavailable — keep asking (safe failure mode for acks)
    return false;
  }
}

function settle(ok: boolean) {
  if (timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
  }
  open.value = false;
  remaining.value = ACK_COUNTDOWN_SECONDS;
  for (const w of waiters.splice(0)) w(ok);
}

/**
 * The gate in front of every mutating Mod Hub operation (install,
 * uninstall, enable/disable, folder install, migration, safe mode,
 * loader repair). Resolves immediately once the disclaimer has been
 * acknowledged; otherwise raises the modal and resolves after the
 * player either confirms — possible only once the countdown runs out,
 * a forced ten seconds of reading — or declines, which aborts the
 * operation before anything is touched.
 */
export function requestModOpDisclaimer(): Promise<boolean> {
  if (isAcknowledged()) return Promise.resolve(true);
  if (!open.value) {
    remaining.value = ACK_COUNTDOWN_SECONDS;
    open.value = true;
    timer = window.setInterval(() => {
      remaining.value = Math.max(0, remaining.value - 1);
      if (remaining.value === 0 && timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    }, 1000);
  }
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

/**
 * The disclaimer window itself — mounted once inside ResourcesView next
 * to its confirm dialogs; pure presentation over the module state above.
 */
export default defineComponent({
  name: "ModOpDisclaimer",
  setup() {
    function confirmAck() {
      sessionAcked = true;
      try {
        localStorage.setItem(ACK_KEY, "1");
      } catch {
        // storage unavailable — the session flag above covers this run
      }
      settle(true);
    }

    // Leaving the page mid-disclaimer aborts the pending operation —
    // its awaiting handler is gone with the view instance anyway.
    onBeforeUnmount(() => {
      if (open.value) settle(false);
    });

    return () => {
      const counting = remaining.value > 0;
      return (
        <HkModal
          modelValue={open.value}
          onUpdate:modelValue={(v: boolean) => {
            if (!v) settle(false);
          }}
          title={t("resources.disclaimer.title")}
          width="34rem"
          footerActions={[
            {
              label: t("resources.disclaimer.cancel"),
              variant: "secondary" as const,
              onClick: () => settle(false),
            },
            {
              label: counting
                ? t("resources.disclaimer.ackCountdown", { n: remaining.value })
                : t("resources.disclaimer.ack"),
              variant: "primary" as const,
              disabled: counting,
              onClick: confirmAck,
            },
          ]}
        >
          <div class="mod-disclaimer">
            <p class="mod-disclaimer__text">{t("resources.disclaimer.intro")}</p>
            <p class="mod-disclaimer__text mod-disclaimer__text--advice">
              {t("resources.disclaimer.advice")}
            </p>
            <p class="mod-disclaimer__note">{t("resources.disclaimer.note")}</p>
          </div>
        </HkModal>
      );
    };
  },
});
