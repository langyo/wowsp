import { defineComponent, onBeforeUnmount, onMounted, ref } from "vue";
import { PiggyBank } from "@lucide/vue";

import ToastCardBase, { type ToastCardBaseInstance } from "./ToastCardBase";
import { t } from "@/i18n";
import { usePiggyReminderStore } from "@/stores/piggyReminder";
import { useSettingsUiStore } from "@/stores/settingsUi";
import { isMobileApp, isNative } from "@/utils/platform";
import "./PiggyReminderToast.scss";

/** How long the card lingers before folding away on its own — the piggy
 *  is patient, so it outlasts the update card's 8 s. */
const AUTO_DISMISS_MS = 10000;

/** Boot delay: the update flow's cards go first (the after-update card
 *  folds at 8 s and the updater prompt rises around then), and every
 *  fixed card in this column shares one slot, so the piggy waits them
 *  out before checking the schedule. */
const BOOT_DELAY_MS = 20000;

/** Re-check cadence — long sessions (the tray close-behavior keeps the
 *  app alive for days) must still see a due period land while running. */
const RECHECK_MS = 60 * 60 * 1000;

/**
 * PiggyReminderToast — the piggy's periodic visitation card (猪猪找你有
 * 点事儿). Once per period (first use + 7 days, then monthly — see
 * stores/piggyReminder.ts) a piggy-pink card rises in the shared
 * top-right toast column; its action lands in the settings' About
 * section and arms the piggy's greeting there (a hmph bubble followed by
 * a poke invitation, so the easter egg teaches itself). Auto-folds like
 * its siblings; a dismissed-or-missed card counts as shown and waits for
 * the next period. Thin store wiring over ToastCardBase — the base owns
 * the fixed slot, the piggy skin-tone surface, the bold headline, the
 * quiet × and the filled 去看看 pill (its primary kind in the skin-tone
 * ink). Renders nothing outside the desktop Tauri shell (the phone build
 * has no desktop first-use flow worth nagging about), so it mounts
 * unconditionally next to the other cards.
 */
export default defineComponent({
  name: "PiggyReminderToast",
  setup() {
    const settings = useSettingsUiStore();
    const piggy = usePiggyReminderStore();
    const card = ref<ToastCardBaseInstance | null>(null);
    let autoTimer: number | undefined;
    let bootTimer: number | undefined;
    let recheckTimer: number | undefined;

    /** Stop the auto-dismiss, then fold the card out (the base's
     *  delayed unmount keeps it alive for the --leave transition). */
    function dismiss() {
      if (autoTimer !== undefined) {
        window.clearTimeout(autoTimer);
        autoTimer = undefined;
      }
      card.value?.dismiss();
    }

    /** One schedule evaluation: consume the period when it is due —
     *  consuming on RAISE (not on click) is what keeps a missed card
     *  from nagging again until the next period. */
    function check() {
      if (card.value?.shown) return;
      const due = piggy.checkDue();
      if (due === null) return;
      piggy.markShown(due);
      card.value?.show();
      autoTimer = window.setTimeout(dismiss, AUTO_DISMISS_MS);
    }

    onMounted(() => {
      if (!isNative() || isMobileApp()) return;
      bootTimer = window.setTimeout(check, BOOT_DELAY_MS);
      recheckTimer = window.setInterval(check, RECHECK_MS);
    });

    onBeforeUnmount(() => {
      if (bootTimer !== undefined) window.clearTimeout(bootTimer);
      if (recheckTimer !== undefined) window.clearInterval(recheckTimer);
      if (autoTimer !== undefined) window.clearTimeout(autoTimer);
    });

    return () => (
      <ToastCardBase
        ref={card}
        tone="piggy"
        rootClass="piggy-reminder"
        message={t("about.piggyReminderTitle")}
        bold
        close
        onClose={dismiss}
        actions={[
          {
            label: t("about.piggyReminderAction"),
            kind: "primary",
            class: "piggy-reminder__view",
            onClick: () => {
              // Arm the About piggy's greeting, then land on it —
              // the section consumes the arm, and the store's latch
              // guarantees exactly one greeting even if two
              // AboutContent instances are alive.
              piggy.armArrival();
              settings.show("about");
              dismiss();
            },
          },
        ]}
      >
        {{ icon: () => <PiggyBank size={16} /> }}
      </ToastCardBase>
    );
  },
});
