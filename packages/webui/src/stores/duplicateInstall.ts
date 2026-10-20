/**
 * Duplicate-install hygiene state: the pre-0.6.26 silent-update bug could
 * leave a second WoWSP install on the pinned default path while the
 * player's real install lived elsewhere. The backend detects the leftover
 * through the ARP registration (see commands/duplicate_install.rs); this
 * store drives the two surfaces over it — the startup ask (once per
 * launch, unless the user ticked 不再提示 or switched the whole check off
 * in the settings' installCleanup section) and that settings section
 * itself (toggle + live status + manual removal).
 *
 * Suppression semantics (a deliberate product decision): the prompt only
 * goes quiet for good when the user EXPLICITLY ticked the checkbox when
 * closing the dialog; closing without the tick leaves the check on, so
 * the next launch asks again. The settings toggle writes the same single
 * flag the checkbox does.
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

import { useToast } from "@celestia-island/hikari";

import { RPC } from "@/rpc";
import { notifySettingsSaved } from "@/stores/settingsSavedFlash";
import { useSettingsUiStore } from "@/stores/settingsUi";
import { router } from "@/router";
import { t } from "@/i18n";

/** Answer shape of the Rust `duplicate_install_check` command. */
export interface DuplicateInstallInfo {
  path: string;
  version: string | null;
  hasUninstaller: boolean;
}

/** Shape of the persisted `duplicate-install.toml`. */
interface DuplicateInstallConfig {
  promptEnabled: boolean;
}

export const useDuplicateInstallStore = defineStore("duplicateInstall", () => {
  /** The currently detected leftover, if any (refreshed by check()). */
  const info = ref<DuplicateInstallInfo | null>(null);
  /** The persisted behavior switch (startup check + prompt). */
  const promptEnabled = ref(true);
  const checking = ref(false);
  const uninstalling = ref(false);
  /** Whether the boot-time ask window is open (modal visibility). */
  const showPrompt = ref(false);
  /** One ask per session: a closed dialog never re-opens on its own. */
  const prompted = ref(false);

  async function loadConfig() {
    try {
      const cfg = await invoke<DuplicateInstallConfig>(RPC.get_duplicate_install_config);
      promptEnabled.value = cfg.promptEnabled;
    } catch {
      // Non-Tauri / non-Windows lane — the default (on) stands.
    }
  }

  /** Refresh the detection (never throws; a failed probe just leaves the
   *  previous answer in place — the check is advisory UI, not a gate). */
  async function check() {
    checking.value = true;
    try {
      info.value = await invoke<DuplicateInstallInfo | null>(RPC.duplicate_install_check);
    } catch {
      // Browser dev mode / transient failure: keep the last answer.
    } finally {
      checking.value = false;
    }
  }

  /** The boot pass: load the switch, then check and ask when a leftover
   *  is live and asking is still enabled. */
  async function init() {
    await loadConfig();
    if (!promptEnabled.value) return;
    await check();
    // Never raise the boot ask over the settings window (its install
    // cleanup section may already be showing the same answer); the
    // session ask is only spent when the dialog actually showed, so a
    // settings-covered pass asks again on the next launch.
    const settingsUi = useSettingsUiStore();
    // Phone layout has no modal — its settings surface is the route.
    const settingsRoute = router.currentRoute.value.path === "/settings";
    if (info.value && !prompted.value && !settingsUi.visible && !settingsRoute) {
      prompted.value = true;
      showPrompt.value = true;
    }
  }

  /** One-shot delayed init the app shell calls on mount — late enough to
   *  stay out of launch I/O's way and out of the updater prompt's. */
  function scheduleCheck(delayMs = 9000) {
    setTimeout(() => void init(), delayMs);
  }

  /** Close the dialog. `neverAsk` is the checkbox state AT CLOSE: only an
   *  explicit tick silences future launches (it writes the same flag the
   *  settings toggle edits); an unticked close keeps the check armed. */
  function closePrompt(neverAsk: boolean) {
    if (neverAsk) void setPromptEnabled(false);
    showPrompt.value = false;
  }

  /** Persist the behavior switch (settings toggle / the checkbox). */
  async function setPromptEnabled(value: boolean) {
    const previous = promptEnabled.value;
    promptEnabled.value = value;
    try {
      const cfg = await invoke<DuplicateInstallConfig>(RPC.set_duplicate_install_config, {
        config: { promptEnabled: value },
      });
      promptEnabled.value = cfg.promptEnabled;
      notifySettingsSaved();
    } catch (e) {
      promptEnabled.value = previous;
      const toast = useToast();
      toast.error(`${t("settings.dupToggleSaveFailed")}\n${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Run the silent removal. The backend command resolves only when the
   *  leftover is gone (its own uninstaller, then the running install is
   *  re-registered), so the caller's button just shows a spinner. */
  async function uninstall() {
    if (uninstalling.value) return;
    uninstalling.value = true;
    const toast = useToast();
    try {
      await invoke(RPC.duplicate_install_uninstall);
      toast.success(t("settings.dupUninstallDone"));
      showPrompt.value = false;
      await check();
    } catch (e) {
      // Tauri rejects with the raw Err string — surface it verbatim.
      toast.error(`${t("settings.dupUninstallFailed")}\n${e instanceof Error ? e.message : String(e)}`);
    } finally {
      uninstalling.value = false;
    }
  }

  return {
    info,
    promptEnabled,
    checking,
    uninstalling,
    showPrompt,
    prompted,
    loadConfig,
    check,
    init,
    scheduleCheck,
    closePrompt,
    setPromptEnabled,
    uninstall,
  };
});
