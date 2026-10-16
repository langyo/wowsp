/** Game-path section state for SettingsBody: install rows, activation and
 *  the in-game plugin presence probe (shared by the gamePath, overlay and
 *  closeBehavior sections through the body context). */
import { computed, ref, watch } from "vue";

import { api, type GameInstall } from "@/api";
import { t } from "@/i18n";
import { useConfigStore } from "@/stores/config";
import { useAccountStore } from "@/stores/account";
import { useGameStatusStore } from "@/stores/gameStatus";
import { usePluginPromptStore } from "@/stores/pluginPrompt";
import { useIngamePluginStore } from "@/stores/ingamePlugin";
import { useToast } from "@celestia-island/hikari";
import { sameGamePath } from "@/utils/gamePath";

/** Catalog id of the in-game plugin's mod-hub row (discussion #640) — the
 *  page button deep-links /resources?mod=<id>. */
export const INGAME_PLUGIN_MOD_ID = "battle.ingame.stats";

export function useSettingsGamePaths() {
  const configStore = useConfigStore();
  const accounts = useAccountStore();
  const gameStatus = useGameStatusStore();
  const toast = useToast();
  const pluginPrompt = usePluginPromptStore();

  // ── game-path table (see the 游戏路径 section) ────────────────────────
  const pickingPath = ref(false);
  /** Whether the add-path dialog (detection / browse actions) is open. */
  const addPathOpen = ref(false);
  /** Two-step delete confirm per install card (path of the armed row) —
   *  the same arm → confirm pattern as the wallpaper strip. */
  const installArmed = ref<string | null>(null);

  const installRows = computed<GameInstall[]>(() => configStore.installs);
  const activePath = computed(() => configStore.activeInstall?.path ?? "");
  const detecting = computed(() => configStore.detecting);

  // ── in-game stats plugin (roster "plugin detection" option) ──────────
  // Presence probe for the PnFMods bridge mod (commands/ingame_plugin.rs):
  // the option stays greyed until the plugin is installed in the active
  // game install, and the page button below deep-links the mod's
  // Discussions thread. Refreshed whenever the active install changes.
  const ingamePluginInstalled = ref(false);
  const ingamePluginDiscussion = ref<number | null>(null);
  async function refreshIngamePlugin() {
    const root = activePath.value;
    if (!root) {
      ingamePluginInstalled.value = false;
      return;
    }
    try {
      const status = await api.ingamePluginStatus(root);
      ingamePluginInstalled.value = status.installed;
      ingamePluginDiscussion.value = status.discussion;
    } catch {
      // older shell / mock backend — the option simply stays greyed
      ingamePluginInstalled.value = false;
    }
  }
  watch(activePath, () => void refreshIngamePlugin());

  // The shared plugin store (probed at boot by AppShell; the install
  // prompt's 一键安装 lands there too) keeps the local ref fresh —
  // without this mirror the section's status hint would still read
  // "not installed" after an install through the re-check window.
  const ingamePluginStore = useIngamePluginStore();
  watch(
    () => [ingamePluginStore.probed, ingamePluginStore.installed] as const,
    ([probed, installed]) => {
      if (probed) ingamePluginInstalled.value = installed;
    },
    { immediate: true },
  );

  /** The closeBehavior section's 重新检查 button: re-probe through the
   *  shared plugin store (one source of truth — the mirror above keeps
   *  this section's hint in step), then raise the shared install prompt
   *  when still absent (or toast the fresh state). Deliberately ignores
   *  the 不再提示 marker — this entry IS the way back in after a
   *  decline. */
  async function recheckIngamePlugin() {
    if (!activePath.value) {
      toast.info(t("settings.pluginPromptStateNoGame"));
      return;
    }
    await ingamePluginStore.refresh();
    if (!ingamePluginStore.probed) {
      // older shell / probe failure — the same offline key the plugin
      // lifecycle actions return
      toast.error(t("common.game.offline"));
      return;
    }
    ingamePluginInstalled.value = ingamePluginStore.installed;
    if (ingamePluginStore.installed) {
      toast.info(t("settings.pluginPromptStateInstalled"));
    } else {
      pluginPrompt.open();
    }
  }

  // The process watcher synthesizes an install for a running exe that no
  // detected install claims — a one-click fallback row above the actions.
  const runningInstall = computed<GameInstall | null>(() => {
    const p = gameStatus.process;
    if (!p.running || !p.matchedInstall) return null;
    if (installRows.value.some((i) => sameGamePath(i.path, p.matchedInstall!.path))) return null;
    if (sameGamePath(p.matchedInstall.path, activePath.value)) return null;
    return p.matchedInstall;
  });

  /** Drop an install row (two-step confirm): remove it from the store —
   *  removed rows are remembered as ignored, so re-detection doesn't
   *  resurrect them. */
  async function removeInstall(i: GameInstall) {
    installArmed.value = null;
    try {
      await configStore.removeInstall(i.path);
      toast.info(t("common.gamePath.removed"));
    } catch (e) {
      toast.error((e as Error).message || String(e));
    }
  }

  /** Follow a client switch to that realm's preferred account. */
  async function followRealm(realm?: string | null) {
    if (!realm) return;
    const switched = await accounts.autoSwitchRealm(realm);
    if (switched) {
      toast.info(t("account.autoSwitched", { name: switched.nickname }));
    }
  }

  async function activateInstall(i: GameInstall) {
    if (sameGamePath(i.path, activePath.value)) return;
    try {
      await configStore.selectInstall(i.path);
      await followRealm(i.realm);
      toast.info(t("common.gamePath.applied"));
    } catch (e) {
      toast.error((e as Error).message || String(e));
    }
  }

  /** Native folder picker → validate → pin as the active install.
   *  Resolves true only when a folder was picked and applied — false on
   *  cancel or error, so the add-path dialog stays open. */
  async function browseFolder(): Promise<boolean> {
    if (pickingPath.value) return false;
    pickingPath.value = true;
    try {
      // Null = the user closed the native dialog — not an error.
      const picked = await api.pickGameFolder();
      if (!picked) return false;
      const resolved = await configStore.setManualPath(picked.path);
      if (!resolved) return false;
      await followRealm(resolved.realm);
      toast.info(t("common.gamePath.applied"));
      return true;
    } catch (e) {
      toast.error(`${t("common.gamePath.invalid")}\n${(e as Error).message || e}`);
      return false;
    } finally {
      pickingPath.value = false;
    }
  }

  /** Open the add-path dialog from the dashed section row. */
  function openAddPath() {
    addPathOpen.value = true;
  }

  async function useRunning() {
    const i = runningInstall.value;
    if (!i) return;
    pickingPath.value = true;
    try {
      const resolved = await configStore.setManualPath(i.path);
      if (!resolved) return;
      await followRealm(resolved.realm);
      toast.info(t("common.gamePath.applied"));
    } catch (e) {
      toast.error(`${t("common.gamePath.invalid")}\n${(e as Error).message || e}`);
    } finally {
      pickingPath.value = false;
    }
  }

  return {
    pickingPath,
    addPathOpen,
    installArmed,
    installRows,
    activePath,
    detecting,
    ingamePluginInstalled,
    ingamePluginDiscussion,
    refreshIngamePlugin,
    recheckIngamePlugin,
    runningInstall,
    removeInstall,
    activateInstall,
    browseFolder,
    openAddPath,
    useRunning,
  };
}
