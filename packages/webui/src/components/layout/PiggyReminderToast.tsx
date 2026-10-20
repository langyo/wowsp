import { defineComponent, onBeforeUnmount, onMounted, ref, Teleport } from "vue";
import { PiggyBank, X } from "@lucide/vue";

import { t } from "@/i18n";
import { usePiggyReminderStore } from "@/stores/piggyReminder";
import { useSettingsUiStore } from "@/stores/settingsUi";
import { isMobileApp, isTauri } from "@/utils/platform";
import "./PiggyReminderToast.scss";

/** Leave transition length — matches the --leave duration in the scss
 *  (same grammar as UpdateAppliedToast's folding card). */
const LEAVE_MS = 260;

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
 * the next period. Renders nothing outside the desktop Tauri shell (the
 * phone build has no desktop first-use flow worth nagging about), so it
 * mounts unconditionally next to the other cards.
 */
export default defineComponent({
  name: "PiggyReminderToast",
  setup() {
    const settings = useSettingsUiStore();
    const piggy = usePiggyReminderStore();

    const mounted = ref(false);
    const leaving = ref(false);
    let leaveTimer: number | undefined;
    let autoTimer: number | undefined;
    let bootTimer: number | undefined;
    let recheckTimer: number | undefined;

    /** Fold the card out (delayed unmount) and stop the auto-dismiss. */
    function dismiss() {
      if (autoTimer !== undefined) {
        window.clearTimeout(autoTimer);
        autoTimer = undefined;
      }
      if (!mounted.value || leaving.value) return;
      leaving.value = true;
      leaveTimer = window.setTimeout(() => {
        leaveTimer = undefined;
        mounted.value = false;
        leaving.value = false;
      }, LEAVE_MS);
    }

    /** One schedule evaluation: consume the period when it is due —
     *  consuming on RAISE (not on click) is what keeps a missed card
     *  from nagging again until the next period. */
    function check() {
      if (mounted.value || leaving.value) return;
      const due = piggy.checkDue();
      if (due === null) return;
      piggy.markShown(due);
      mounted.value = true;
      autoTimer = window.setTimeout(dismiss, AUTO_DISMISS_MS);
    }

    onMounted(() => {
      if (!isTauri() || isMobileApp()) return;
      bootTimer = window.setTimeout(check, BOOT_DELAY_MS);
      recheckTimer = window.setInterval(check, RECHECK_MS);
    });

    onBeforeUnmount(() => {
      if (bootTimer !== undefined) window.clearTimeout(bootTimer);
      if (recheckTimer !== undefined) window.clearInterval(recheckTimer);
      if (autoTimer !== undefined) window.clearTimeout(autoTimer);
      if (leaveTimer !== undefined) window.clearTimeout(leaveTimer);
    });

    return () => {
      if (!mounted.value) return null;
      return (
        <Teleport to="body">
          <div
            class={["piggy-reminder", leaving.value ? "piggy-reminder--leave" : ""]}
            role="status"
          >
            <div class="piggy-reminder__row">
              <span class="piggy-reminder__icon">
                <PiggyBank size={16} />
              </span>
              <p class="piggy-reminder__message">
                {t("about.piggyReminderTitle")}
              </p>
              <button
                type="button"
                class="piggy-reminder__close"
                aria-label={t("common.close")}
                onClick={dismiss}
              >
                <X size={14} />
              </button>
            </div>
            <div class="piggy-reminder__actions">
              <button
                type="button"
                class="piggy-reminder__view"
                onClick={() => {
                  // Arm the About piggy's greeting, then land on it —
                  // the section consumes the arm, and the store's latch
                  // guarantees exactly one greeting even if two
                  // AboutContent instances are alive.
                  piggy.armArrival();
                  settings.show("about");
                  dismiss();
                }}
              >
                {t("about.piggyReminderAction")}
              </button>
            </div>
          </div>
        </Teleport>
      );
    };
  },
});
