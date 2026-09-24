import { defineStore } from "pinia";
import { ref } from "vue";

import { router } from "@/router";
import { isMobileApp, isPhoneLayout } from "@/utils/platform";

/** Settings sections, in rail order (mirrors SettingsBody). */
export type SettingsSection =
  | "language"
  | "appearance"
  | "closeBehavior"
  | "stats"
  | "gamePath"
  | "account"
  | "network"
  | "pairing"
  | "updates"
  | "overlay"
  | "about"
  | "attributions";

export const SETTINGS_SECTION_IDS: readonly SettingsSection[] = [
  "language",
  "appearance",
  "closeBehavior",
  "stats",
  "gamePath",
  "account",
  "network",
  "pairing",
  "updates",
  "overlay",
  "about",
  "attributions",
];

/** Sections that make no sense on the phone app build: no local game
 *  install to pick (gamePath), no second overlay window (overlay), and no
 *  tray or close button to configure a close behavior for. The
 *  PAIRING section shows on BOTH builds — a CLIENT variant on the phone
 *  (open the wizard, manage paired computers) and the SERVER variant on the
 *  desktop. The rail filters only the truly inapplicable ones. */
const MOBILE_HIDDEN_SECTIONS: readonly SettingsSection[] = [
  "gamePath",
  "overlay",
  // Desktop-only: the phone build has no system tray and no window close
  // button, so there is no close behavior to configure.
  "closeBehavior",
];

/** Clamp a section request to what the current build can show. */
export function normalizeSettingsSection(s: SettingsSection): SettingsSection {
  return isMobileApp() && MOBILE_HIDDEN_SECTIONS.includes(s) ? "language" : s;
}

/** Sections available on this build, rail order. */
export function availableSettingsSections(): SettingsSection[] {
  const hidden = isMobileApp();
  return SETTINGS_SECTION_IDS.filter((id) => !hidden || !MOBILE_HIDDEN_SECTIONS.includes(id));
}

/**
 * App-singleton state for the settings surface. Openers live in several
 * places (title-bar gear, the sidebar's account button), so the surface
 * itself is driven through this store — `show("account")` also jumps to a
 * section.
 *
 * Two surfaces render the same body (components/settings/SettingsBody):
 * the desktop MODAL (mounted by AppShell on desktop layout) and the
 * /settings PAGE (phone layout's full page). On phone layout `show()`
 * navigates to the route (`?section=`) instead of raising the modal.
 */
export const useSettingsUiStore = defineStore("settingsUi", () => {
  const visible = ref(false);
  const section = ref<SettingsSection>("language");

  /** Open settings, optionally landing on a specific section. Without an
   *  argument the last-viewed section stays selected. Phone layout goes to
   *  the settings page (a real route, so the system back gesture works);
   *  desktop layout raises the app-singleton modal. */
  function show(at?: SettingsSection) {
    if (at) section.value = normalizeSettingsSection(at);
    if (isPhoneLayout()) {
      void router.push({ path: "/settings", query: { section: section.value } });
      return;
    }
    visible.value = true;
  }

  function hide() {
    visible.value = false;
  }

  return { visible, section, show, hide };
});
