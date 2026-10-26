import { defineStore } from "pinia";
import { ref } from "vue";

import { router } from "@/router";
import { isMobileApp, isPhoneLayout } from "@/utils/platform";

/** Settings sections. The id set only — rail order comes from
 *  SETTINGS_GROUPS below (the union's textual order is not meaningful). */
export type SettingsSection =
  | "language"
  | "appearance"
  | "closeBehavior"
  | "stats"
  | "gamePath"
  | "account"
  | "network"
  | "blacklistSync"
  | "pairing"
  | "updates"
  | "resources"
  | "installCleanup"
  | "changelog"
  | "overlayCalibration"
  | "feedback"
  | "about"
  | "attributions"
  | "sharing";

/** Rail groups (first level): titled clusters of related sections (the
 *  second level). Rail order is group order, then member order —
 *  SETTINGS_SECTION_IDS derives from this, so the flat list can never
 *  drift out of the grouped anatomy. */
export type SettingsGroupId =
  | "general"
  | "game"
  | "connection"
  | "app"
  | "about";

export interface SettingsGroupSpec {
  id: SettingsGroupId;
  /** Member sections, in rail order within the group. */
  sections: readonly SettingsSection[];
}

export const SETTINGS_GROUPS: readonly SettingsGroupSpec[] = [
  { id: "general", sections: ["language", "appearance", "closeBehavior"] },
  { id: "game", sections: ["stats", "overlayCalibration", "gamePath"] },
  { id: "connection", sections: ["account", "network", "blacklistSync", "pairing"] },
  { id: "app", sections: ["updates", "resources", "installCleanup", "changelog"] },
  { id: "about", sections: ["feedback", "about", "attributions", "sharing"] },
];

/** All sections in rail order (group order, then member order). */
export const SETTINGS_SECTION_IDS: readonly SettingsSection[] = SETTINGS_GROUPS.flatMap(
  (group) => group.sections,
);

/** One-shot pane-focus anchors: the card an opener can ask the settings
 *  surface to glide onto after landing its section (the pack-update
 *  toast uses this to bring the card with the live progress bar into
 *  view). A value matches the target card's `data-settings-anchor`
 *  attribute; SettingsShell consumes the request and reports it done
 *  (`update:focusAnchor` = null), so it never replays on a later plain
 *  open. */
export const SETTINGS_ANCHOR_BAKED_MODELS = "baked-models";

/** The overlayCalibration section's anchor list (游戏内显示校准's bottom
 *  card — the per-client PvP/PvE Tab-anchor readouts): the live battle
 *  panel's locate pill opens the section glided onto this card, so the
 *  手动定位 surface is in view instead of the water-meter toggles above
 *  it. */
export const SETTINGS_ANCHOR_CALIBRATION_LIST = "calibration-list";

/** Sections that make no sense on the phone app build: no local game
 *  install to pick (gamePath) and no tray or close button to configure a
 *  close behavior for. The PAIRING section shows on BOTH builds — a
 *  CLIENT variant on the phone (open the wizard, manage paired computers)
 *  and the SERVER variant on the desktop. The rail filters only the truly
 *  inapplicable ones. */
const MOBILE_HIDDEN_SECTIONS: readonly SettingsSection[] = [
  "gamePath",
  // Desktop-only: the overlay-calibration page hosts the in-game water
  // meter AND the anchor calibration list — both edit the desktop
  // Tab-overlay detector's world, which the phone build (no overlay
  // window) has no use for.
  "overlayCalibration",
  // Desktop-only: the phone build has no system tray and no window close
  // button, so there is no close behavior to configure.
  "closeBehavior",
  // Desktop-only: the diagnostics file sink never attaches on mobile (see
  // the Rust logging module) — logcat covers Android debugging, and the
  // phone has no file manager to reveal a log folder in anyway.
  "feedback",
  // Desktop-Windows only: the duplicate-install detection reads the
  // desktop install's ARP registration, which the phone build has none of.
  "installCleanup",
];

/** Clamp a section request to what the current build can show. */
export function normalizeSettingsSection(s: SettingsSection): SettingsSection {
  return isMobileApp() && MOBILE_HIDDEN_SECTIONS.includes(s) ? "language" : s;
}

/** A group as the current build may show it: hidden members filtered out. */
export interface SettingsGroupView {
  id: SettingsGroupId;
  sections: SettingsSection[];
}

/** Groups available on this build, rail order; a group whose every member
 *  is hidden on this build is dropped entirely, so the rail never shows an
 *  empty title. */
export function availableSettingsGroups(): SettingsGroupView[] {
  const hidden = isMobileApp();
  return SETTINGS_GROUPS.map(({ id, sections }) => ({
    id,
    sections: sections.filter((id) => !hidden || !MOBILE_HIDDEN_SECTIONS.includes(id)),
  })).filter((group) => group.sections.length > 0);
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
  /** Pending one-shot card glide (a SETTINGS_ANCHOR_* value) consumed by
   *  SettingsShell when the landed section renders; null when idle. */
  const focusAnchor = ref<string | null>(null);

  /** Open settings, optionally landing on a specific section — and
   *  optionally gliding the pane onto one of that section's cards (a
   *  SETTINGS_ANCHOR_* value; consumed by SettingsShell, see its
   *  focusAnchor prop). Without arguments the last-viewed section stays
   *  selected and no glide is pending. Phone layout goes to the settings
   *  page (a real route, so the system back gesture works); desktop
   *  layout raises the app-singleton modal. */
  function show(at?: SettingsSection, anchor?: string) {
    if (at) section.value = normalizeSettingsSection(at);
    focusAnchor.value = anchor ?? null;
    if (isPhoneLayout()) {
      void router.push({ path: "/settings", query: { section: section.value } });
      return;
    }
    visible.value = true;
  }

  function hide() {
    visible.value = false;
  }

  return { visible, section, focusAnchor, show, hide };
});
