/** Pairing-section state for SettingsBody: the code copy/regenerate
 *  actions, the phone-side wizard deep link and the desktop status poll. */
import { onBeforeUnmount, ref } from "vue";

import { useToast } from "@celestia-island/hikari";
import { useRouter } from "vue-router";

import { t } from "@/i18n";
import { usePairingStore } from "@/stores/pairing";
import { isMobileApp } from "@/utils/platform";

export function useSettingsPairingState() {
  const pairingStore = usePairingStore();
  const router = useRouter();
  const toast = useToast();

  /** Clipboard route for the pairing code (the readonly OTP shows it big;
   *  copying is the desktop-to-phone handoff shortcut). */
  async function copyPin(pin: string) {
    if (!pin) return;
    try {
      await navigator.clipboard.writeText(pin);
      toast.success(t("settings.pairingPinCopied"));
    } catch {
      // Clipboard permission denied — the big OTP display is the fallback.
    }
  }
  /** Ask the gateway for a fresh pairing code (desktop regenerate). */
  const reallocBusy = ref(false);
  async function regenerateCode() {
    if (reallocBusy.value) return;
    reallocBusy.value = true;
    try {
      await pairingStore.reallocateCode();
    } catch {
      // surfaced via store.serverError; nothing else to do
    } finally {
      reallocBusy.value = false;
    }
  }
  /** Phone build: the wizard lives in the replay view — deep-link there
   *  and let ReplayView auto-open it (?pairing=1). */
  function openPairingWizard() {
    void router.push({ path: "/replay", query: { pairing: "1" } });
  }
  /** Desktop only: while the pairing section is visible and the server
   *  runs, poll the status so a gateway that comes up (or drops) flips
   *  the displayed code / mode hint without user action. */
  let pairingPoll: number | undefined;
  function stopPairingPoll() {
    window.clearInterval(pairingPoll);
    pairingPoll = undefined;
  }
  function startPairingPoll() {
    if (isMobileApp()) return;
    stopPairingPoll();
    pairingPoll = window.setInterval(() => {
      if (pairingStore.server?.running && !pairingStore.serverBusy) {
        void pairingStore.refreshServerStatus();
      }
    }, 3000);
  }
  onBeforeUnmount(stopPairingPoll);

  return {
    pairingStore,
    copyPin,
    reallocBusy,
    regenerateCode,
    openPairingWizard,
    startPairingPoll,
    stopPairingPoll,
  };
}
