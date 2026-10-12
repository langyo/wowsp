/** The SettingsBody composition state: wires the section-focused
 *  sub-composables together, owns the section-activation watchers (the
 *  per-section refreshes and two-step-confirm disarms) and builds the
 *  grouped rail. Section components receive the returned context. */
import { computed, onMounted, watch } from "vue";
import {
  BarChart3,
  Bug,
  Copyright,
  FolderCog,
  Globe,
  Info,
  Languages,
  Layers,
  Palette,
  Power,
  RefreshCw,
  ScrollText,
  Smartphone,
  UserRound,
} from "@lucide/vue";

import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { usePluginUpdatesStore } from "@/stores/pluginUpdates";
import { useOverlayConfigStore } from "@/stores/overlayConfig";
import {
  availableSettingsGroups,
  useSettingsUiStore,
  type SettingsGroupId,
  type SettingsSection,
} from "@/stores/settingsUi";
import { useChangelogStore } from "@/stores/changelog";
import type { SettingsRailGroup } from "@/components/settings/SettingsShell";
import { useSettingsGamePaths } from "@/components/settings/useSettingsGamePaths";
import { useSettingsAppearance } from "@/components/settings/useSettingsAppearance";
import { useSettingsNetworkState } from "@/components/settings/useSettingsNetworkState";
import { useSettingsUpdatesState } from "@/components/settings/useSettingsUpdatesState";
import { useSettingsPairingState } from "@/components/settings/useSettingsPairingState";
import { useSettingsDpiState } from "@/components/settings/useSettingsDpiState";
import { isMobileApp } from "@/utils/platform";

export function useSettingsBody(props: { active: boolean }) {
  const ui = useSettingsUiStore();
  const lang = useLanguage();
  const overlayCfg = useOverlayConfigStore();
  const pluginUpdates = usePluginUpdatesStore();
  // Phone-app build gate (desktop layout can still be narrow — that is
  // isMobile/isPhoneLayout, a different axis; see utils/platform).
  const mobileApp = isMobileApp();

  const gamePaths = useSettingsGamePaths();
  const appearance = useSettingsAppearance();
  const network = useSettingsNetworkState();
  const updates = useSettingsUpdatesState();
  const pairing = useSettingsPairingState();
  const dpi = useSettingsDpiState(
    () => props.active,
    () => ui.section,
  );

  const changelog = useChangelogStore();

  onMounted(() => void pluginUpdates.refresh());
  onMounted(() => {
    void overlayCfg.load();
    void gamePaths.refreshIngamePlugin();
  });

  watch(
    () => ui.section,
    (id) => {
      // Leaving the section disarms any pending two-step confirm.
      updates.clearArmed.value = null;
      updates.auxArmed.value = null;
      appearance.wallpaperArmed.value = null;
      // Re-sync the wallpaper list with the AppData folder (also heals a
      // failed boot-time listing instead of staying empty all session).
      if (id === "appearance") void appearance.wallpaper.refreshCustom();
      if (id === "pairing") {
        void pairing.pairingStore.refreshServerStatus();
        pairing.startPairingPoll();
      } else {
        pairing.stopPairingPoll();
      }
      // The changelog feed streams from GitHub Releases on demand —
      // never at startup — so opening the section is what loads it.
      if (id === "changelog") void changelog.ensureLoaded();
      if (id !== "updates") return;
      void updates.refreshDataPackRow(false);
      void updates.refreshModCatalogRow(false);
      void updates.cacheStore.refreshStatus();
      void updates.cacheStore.loadMirror().then(() => {
        updates.mirrorDraft.value = updates.cacheStore.githubMirror ?? "";
      });
      if (!updates.cacheStore.updatesCheckedAt) void updates.cacheStore.refreshUpdates();
    },
  );

  // The body can unmount when its surface closes (modal) or navigate
  // away (page), so reopening on the cache section would show stale
  // sizes/versions — refresh whenever the surface becomes active too.
  watch(
    () => props.active,
    (open) => {
      if (open && ui.section === "updates") {
        void updates.refreshDataPackRow(false);
        void updates.refreshModCatalogRow(false);
        void updates.cacheStore.refreshStatus();
        void updates.cacheStore.refreshUpdates();
      }
      if (open && ui.section === "pairing") {
        void pairing.pairingStore.refreshServerStatus();
        pairing.startPairingPoll();
      }
      if (open && ui.section === "changelog") void changelog.ensureLoaded();
      if (!open) pairing.stopPairingPoll();
    },
  );

  // Direct deep-link landing (?section=pairing — e.g. the phone app's
  // settings route): the section watcher above only fires on CHANGE, which
  // a landing mount already missed — refresh once here so the section never
  // shows stale pairing state.
  if (ui.section === "pairing") {
    void pairing.pairingStore.refreshServerStatus();
    pairing.startPairingPoll();
  }
  if (ui.section === "changelog") void changelog.ensureLoaded();
  // Same gap for the updates section's data-source rows: a landing mount
  // never triggers the watcher's loads (the pack cards mask it via their
  // boot-time store init — the rows have no such backstop).
  if (ui.section === "updates") {
    void updates.refreshDataPackRow(false);
    void updates.refreshModCatalogRow(false);
  }

  // ── section rail ────────────────────────────────────────────────────────
  // The left rail mirrors the main sidebar's nav look; only the active
  // section's card renders in the content pane. Section identity lives in
  // the settingsUi store so openers can land on a specific one. The phone
  // app build drops the gamePath / overlay / closeBehavior sections
  // (nothing to configure there).
  const SECTION_ICONS = {
    language: Languages,
    appearance: Palette,
    closeBehavior: Power,
    stats: BarChart3,
    gamePath: FolderCog,
    account: UserRound,
    network: Globe,
    pairing: Smartphone,
    updates: RefreshCw,
    changelog: ScrollText,
    overlay: Layers,
    feedback: Bug,
    about: Info,
    attributions: Copyright,
  };
  const sectionLabels = computed<Record<SettingsSection, string>>(() => ({
    language: t("settings.language"),
    appearance: t("settings.themeMode"),
    closeBehavior: t("settings.closeBehavior"),
    stats: t("settings.statsSection"),
    gamePath: t("settings.gamePath"),
    account: t("settings.account"),
    network: t("settings.network"),
    pairing: mobileApp ? t("settings.pairingMobile") : t("settings.pairing"),
    updates: t("settings.updates"),
    changelog: t("settings.changelog"),
    overlay: t("settings.overlay"),
    feedback: t("settings.feedback"),
    about: t("settings.about"),
    attributions: t("settings.attributions"),
  }));
  // The rail is grouped: five titled clusters (first level) over the
  // section entries (second level), so fourteen entries read as a few
  // named families instead of one flat list. Labels are resolved here —
  // icons for the entries, i18n titles for the groups — so the shell
  // owns only the rendering; build-hidden sections drop out with their
  // group (availableSettingsGroups never returns an empty one).
  const GROUP_LABEL_KEYS: Record<SettingsGroupId, string> = {
    general: "settings.groupGeneral",
    game: "settings.groupGame",
    connection: "settings.groupConnection",
    app: "settings.groupApp",
    about: "settings.groupAbout",
  };
  const railGroups = computed<SettingsRailGroup[]>(() =>
    availableSettingsGroups().map(({ id, sections }) => ({
      key: id,
      label: t(GROUP_LABEL_KEYS[id]),
      sections: sections.map((id) => ({
        key: id,
        label: sectionLabels.value[id],
        icon: SECTION_ICONS[id],
      })),
    })),
  );

  return {
    ui,
    lang,
    mobileApp,
    gamePaths,
    appearance,
    network,
    updates,
    pairing,
    dpi,
    railGroups,
  };
}

export type SettingsBodyCtx = ReturnType<typeof useSettingsBody>;
