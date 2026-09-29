/**
 * In-game stats plugin (packages/ingame-plugin) presence + lifecycle for
 * the live-battle surfaces. One shared probe feeding two consumers:
 *
 * - LiveBattlePanel's status corner grades the telemetry source (plugin
 *   connected vs. degraded screen-capture inference),
 * - LiveIdleGuide offers one-click install when absent and uninstall when
 *   present, so a broken install can be reinstalled in place.
 *
 * Presence means the PnFMods bridge sits in the ACTIVE game install
 * (commands/ingame_plugin.rs); the probe re-runs whenever that selection
 * changes. The M2 bridge consumer will add a live "connected" signal on
 * top — for now "installed" is the strongest state, and the panel's
 * degraded badge explains exactly that gap.
 */
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import { api } from "@/api";
import { useConfigStore } from "@/stores/config";

export const useIngamePluginStore = defineStore("ingamePlugin", () => {
  const installed = ref(false);
  /** Null once probed; a failed probe (older shell, no install) stays null
   *  so consumers treat the plugin as absent rather than unknown. */
  const probed = ref(false);
  /** Discussions thread backing the mod-hub page (for the page link). */
  const discussion = ref<number | null>(null);
  /** "install" | "uninstall" while a lifecycle command is in flight. */
  const busy = ref<"install" | "uninstall" | null>(null);

  const config = useConfigStore();
  const gameRoot = computed(
    () => config.activeInstall?.path ?? "",
  );

  async function refresh() {
    const root = gameRoot.value;
    if (!root) {
      installed.value = false;
      probed.value = false;
      return;
    }
    try {
      const status = await api.ingamePluginStatus(root);
      installed.value = status.installed;
      discussion.value = status.discussion;
      probed.value = true;
    } catch {
      installed.value = false;
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

  const state = computed<"absent" | "installed">(() =>
    installed.value ? "installed" : "absent",
  );

  return { installed, probed, discussion, busy, state, gameRoot, refresh, install, uninstall };
});
