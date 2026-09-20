import { defineStore } from "pinia";
import { ref } from "vue";

/** Settings modal sections, in rail order (mirrors SettingsModal). */
export type SettingsSection =
  | "language"
  | "appearance"
  | "stats"
  | "gamePath"
  | "account"
  | "network"
  | "updates"
  | "overlay"
  | "about"
  | "attributions";

/**
 * App-singleton state for the settings modal. Openers live in several
 * places (title-bar gear, the sidebar's client / account buttons), so the
 * modal instance itself is mounted once (AppShell) and everyone drives it
 * through this store — `show("gamePath")` also jumps to a section.
 */
export const useSettingsUiStore = defineStore("settingsUi", () => {
  const visible = ref(false);
  const section = ref<SettingsSection>("language");

  /** Open the modal, optionally landing on a specific section. Without an
   *  argument the last-viewed section stays selected. */
  function show(at?: SettingsSection) {
    if (at) section.value = at;
    visible.value = true;
  }

  function hide() {
    visible.value = false;
  }

  return { visible, section, show, hide };
});
