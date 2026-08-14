import { defineStore } from "pinia";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { check as checkUpdate, type Update } from "@tauri-apps/plugin-updater";

import { api } from "@/api";

/**
 * Auto-updater store. Wraps `@tauri-apps/plugin-updater`. Exposes check /
 * downloadAndInstall actions. The update endpoint + pubkey are configured in
 * tauri.conf.json `[plugins.updater]`; the Rust side registers the plugin
 * in main.rs.
 *
 * In browser-only dev mode the plugin throws (no Tauri runtime); calls are
 * caught and surfaced via `error` so the UI degrades gracefully.
 *
 * Portable (USB / green) installs have no NSIS-based update path — the
 * updater is disabled there (`portable` flag from the Rust `is_portable`
 * command).
 */
export const useUpdaterStore = defineStore("updater", () => {
  const available = ref(false);
  const version = ref<string | null>(null);
  const notes = ref<string | null>(null);
  const checking = ref(false);
  const downloading = ref(false);
  const checked = ref(false);
  const error = ref<string | null>(null);
  const portable = ref(false);
  let pendingUpdate: Update | null = null;

  async function init() {
    try {
      portable.value = await invoke<boolean>("is_portable");
    } catch {
      portable.value = false;
    }
  }

  async function check() {
    if (portable.value) return;
    checking.value = true;
    error.value = null;
    try {
      // Honor the Settings -> Network proxy choice (the updater plugin has
      // its own reqwest client that ignores it otherwise).
      let proxy: string | undefined;
      try {
        const net = await api.getNetworkConfig();
        proxy = net.effectiveProxy ?? undefined;
      } catch {
        proxy = undefined;
      }
      const update = await checkUpdate(proxy ? { proxy } : {});
      checked.value = true;
      if (update) {
        available.value = true;
        version.value = update.version;
        notes.value = update.body ?? null;
        pendingUpdate = update;
      } else {
        available.value = false;
        pendingUpdate = null;
      }
    } catch (e) {
      // Plugin not available in browser — not an error worth surfacing.
      error.value = (e as Error).message;
      checked.value = true;
    } finally {
      checking.value = false;
    }
  }

  async function downloadAndInstall() {
    if (portable.value) return;
    if (!pendingUpdate) {
      await check();
      if (!pendingUpdate) return;
    }
    downloading.value = true;
    try {
      await pendingUpdate.downloadAndInstall();
      // On Windows the installer triggers a restart automatically.
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      downloading.value = false;
    }
  }

  return { available, version, notes, checking, downloading, checked, error, portable, init, check, downloadAndInstall };
});
