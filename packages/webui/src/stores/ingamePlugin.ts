/**
 * In-game stats plugin (packages/ingame-plugin) presence + lifecycle for
 * the live-battle surfaces. One shared probe feeding three consumers:
 *
 * - LiveBattlePanel's status corner grades the telemetry source (plugin
 *   connected vs. degraded screen-capture inference),
 * - LiveBattlePanel's waiting state shows the plugin card status-only,
 * - LiveIdleGuide offers one-click install when absent, update when the
 *   installed bytes predate this app build (content-hash freshness — the
 *   in-game version string is pinned at 0.1.0 by owner decision), and
 *   uninstall when present, so a broken install can be reinstalled.
 *
 * Presence means the PnFMods bridge sits in the ACTIVE game install
 * (commands/ingame_plugin.rs); the probe re-runs whenever that selection
 * changes.
 */
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import { api } from "@/api";
import { useConfigStore } from "@/stores/config";

export const useIngamePluginStore = defineStore("ingamePlugin", () => {
  const installed = ref(false);
  /** Installed but not the bytes this app ships (older build / hand-edited)
   *  — the UI offers a one-click update. */
  const outdated = ref(false);
  /** Null once probed; a failed probe (older shell, no install) stays null
   *  so consumers treat the plugin as absent rather than unknown. */
  const probed = ref(false);
  /** Discussions thread backing the mod-hub page (for the page link). */
  const discussion = ref<number | null>(null);
  /** "install" | "uninstall" | "update" while a lifecycle command is in flight. */
  const busy = ref<"install" | "uninstall" | "update" | null>(null);

  const config = useConfigStore();
  const gameRoot = computed(
    () => config.activeInstall?.path ?? "",
  );

  async function refresh() {
    const root = gameRoot.value;
    if (!root) {
      installed.value = false;
      outdated.value = false;
      probed.value = false;
      return;
    }
    try {
      const status = await api.ingamePluginStatus(root);
      installed.value = status.installed;
      outdated.value = status.outdated === true;
      discussion.value = status.discussion;
      probed.value = true;
    } catch {
      installed.value = false;
      outdated.value = false;
      probed.value = false;
    }
  }

  /** One-click install: writes the PnFMods bridge into the active install
   *  (backend refuses while the game runs). Returns null on success, else
   *  the localized-error string for the caller to toast. */
  async function install(): Promise<string | null> {
    const root = gameRoot.value;
    if (!root || busy.value) return "common.game.offline";
    busy.value = "install";
    try {
      // Same PnFMods layout the probe installer writes (Main.py + the
      // 0-byte loader marker); the backend refuses while the game runs.
      await api.ingamePluginInstall(root);
      await refresh();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      busy.value = null;
    }
  }

  /** One-click update — install overwrites in place, so this is install
   *  with update-flavored busy state (the card shows its own spinner). */
  async function update(): Promise<string | null> {
    const root = gameRoot.value;
    if (!root || busy.value) return "common.game.offline";
    busy.value = "update";
    try {
      await api.ingamePluginInstall(root);
      await refresh();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      busy.value = null;
    }
  }

  async function uninstall(): Promise<string | null> {
    const root = gameRoot.value;
    if (!root || busy.value) return "common.game.offline";
    busy.value = "uninstall";
    try {
      await api.ingamePluginUninstall(root);
      await refresh();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      busy.value = null;
    }
  }

  // The active install is the probe's identity — switching installs (or
  // first detection on cold start) re-probes.
  watch(gameRoot, () => void refresh(), { immediate: true });

  const state = computed<"absent" | "outdated" | "installed">(() => {
    if (!installed.value) return "absent";
    return outdated.value ? "outdated" : "installed";
  });

  return {
    installed,
    outdated,
    probed,
    discussion,
    busy,
    state,
    gameRoot,
    refresh,
    install,
    update,
    uninstall,
  };
});
