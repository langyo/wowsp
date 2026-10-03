/**
 * Standalone in-game plugin install prompt — the second-chance ask for
 * users whose onboarding wizard predates the plugin step (existing
 * installs walking an upgrade) or who picked a game path only later.
 *
 * Visibility is app-global because two unrelated surfaces raise the same
 * window: AppShell (boot-time auto-ask once detection + the plugin probe
 * settle) and the settings' closeBehavior section (the manual re-check
 * button, the way back in after 不再提示). The dismissal marker is plain
 * localStorage so the onboarding wizard can write the SAME slot when its
 * own plugin offer is declined with the countdown guard — a user who just
 * said "not now" inside the wizard must not be re-asked at the next boot
 * on top of that.
 */
import { defineStore } from "pinia";
import { ref } from "vue";

/** localStorage key for the 不再提示 marker — "1" means the boot-time ask
 *  stays quiet until the settings re-check (or an install) clears it. */
const PROMPT_DISMISSED_KEY = "wowsp-plugin-prompt-dismissed";

function loadDismissed(): boolean {
  try {
    return localStorage.getItem(PROMPT_DISMISSED_KEY) === "1";
  } catch {
    // storage unavailable — treat as not dismissed (ask again), matching
    // the onboarding wizard's safe failure mode for unpersistable acks
    return false;
  }
}

function writeDismissed(v: boolean) {
  try {
    localStorage.setItem(PROMPT_DISMISSED_KEY, v ? "1" : "0");
  } catch {
    // storage unavailable — the choice just won't survive a restart
  }
}

/** Mark the boot-time ask as declined WITHOUT instantiating the store —
 *  the onboarding wizard's plugin offer writes this slot directly. */
export function markPluginPromptDismissed() {
  writeDismissed(true);
}

export const usePluginPromptStore = defineStore("pluginPrompt", () => {
  /** Window visibility — raised by AppShell's boot ask or the settings'
   *  re-check button; nothing else pops it. */
  const visible = ref(false);
  /** 不再提示 state — read at boot to keep the auto-ask quiet. */
  const dismissed = ref(loadDismissed());

  function open() {
    // Re-sync before raising: the wizard's decline writes the marker
    // directly (markPluginPromptDismissed), bypassing this instance —
    // without the refresh the modal would adopt a stale ref and an
    // unchecked 暂不安装 could erase that deliberate decline.
    dismissed.value = loadDismissed();
    visible.value = true;
  }

  function close() {
    visible.value = false;
  }

  /** The checkbox path: mirror the box into the marker. A checked decline
   *  silences the boot ask; an UNchecked decline through the re-opened
   *  window re-arms it — the checkbox starts at the marker's current
   *  state, so the settings re-check round-trips both ways. */
  function setDismissed(v: boolean) {
    dismissed.value = v;
    writeDismissed(v);
  }

  return { visible, dismissed, open, close, setDismissed };
});
