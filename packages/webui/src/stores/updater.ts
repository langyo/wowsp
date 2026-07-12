import { defineStore } from "pinia";
import { ref } from "vue";
import { check as checkUpdate, type Update } from "@tauri-apps/plugin-updater";

/**
 * Auto-updater store. Wraps `@tauri-apps/plugin-updater`. Exposes check /
 * downloadAndInstall actions. The update endpoint + pubkey are configured in
 * tauri.conf.json `[plugins.updater]`; the Rust side registers the plugin
 * in main.rs.
 *
 * In browser-only dev mode the plugin throws (no Tauri runtime); calls are
 * caught and surfaced via `error` so the UI degrades gracefully.
 */
export const useUpdaterStore = defineStore("updater", () => {
  const available = ref(false);
  const version = ref<string | null>(null);
  const notes = ref<string | null>(null);
  const checking = ref(false);
  const downloading = ref(false);
  const checked = ref(false);
  const error = ref<string | null>(null);
  let pendingUpdate: Update | null = null;

  async function check() {
    checking.value = true;
    error.value = null;
    try {
      const update = await checkUpdate();
      checked.value = true;
      if (update) {
        available.value = true;
        version.value = update.version;
        notes.value = update.body;
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

  return { available, version, notes, checking, downloading, checked, error, check, downloadAndInstall };
});
