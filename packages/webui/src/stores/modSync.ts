import { defineStore } from "pinia";
import { ref } from "vue";

/**
 * Multi-client mod sync preference — whether the mod hub's catalog
 * install/uninstall ops fan out to EVERY detected game client (the
 * "one unified set of installed catalog mods" mode, realm-filtered per
 * target) or act on the active client alone ("managing individually").
 *
 * A webui-owned presentation-level preference, persisted in localStorage
 * the closeBehavior/statsPrefs way (the shell's game-config.toml is
 * backend scope and only carries the ACTIVE path anyway). DEFAULT ON:
 * unified is the shipped behavior, so — like closeBehavior's "ask" — the
 * "on" state IS the absence of the key; only the opt-out writes a value.
 * Older builds reading the same slot see nothing and keep their single
 * client behavior.
 */

/** The persisted slot, shared by every window of this app profile. */
export const MOD_SYNC_STORAGE_KEY = "wowsp-mod-sync";

/** Read the remembered preference, sweeping junk: a stale value would
 *  otherwise re-fail validation on every boot instead of falling back to
 *  the default. Missing key = first run = unified sync ON. Storage that
 *  throws degrades to ON for the session. */
export function loadModSyncEnabled(): boolean {
  try {
    const raw = localStorage.getItem(MOD_SYNC_STORAGE_KEY);
    if (raw === "off") return false;
    if (raw != null) localStorage.removeItem(MOD_SYNC_STORAGE_KEY);
    return true;
  } catch {
    return true;
  }
}

/** Persist one state. ON removes the key rather than writing a string —
 *  absent IS the default-on state, and builds that only understand the
 *  concrete opt-out keep working against the same slot. Failures are
 *  silent: the choice holds for the session. */
function persistModSyncEnabled(on: boolean): boolean {
  try {
    if (on) localStorage.removeItem(MOD_SYNC_STORAGE_KEY);
    else localStorage.setItem(MOD_SYNC_STORAGE_KEY, "off");
    return true;
  } catch {
    // see loadModSyncEnabled
    return false;
  }
}

/** App-wide source of truth as a MODULE-level ref (not store-owned
 *  state): the loader runs at import time, so the remembered mode is
 *  hydrated before any surface mounts — the mod hub's ops can fire from
 *  a deep link before its view was ever opened. */
export const modSyncState = ref(loadModSyncEnabled());

export const useModSyncStore = defineStore("modSync", () => {
  /** Shared with the module-level ref — the store is the write API. */
  const syncEnabled = modSyncState;

  function setSyncEnabled(v: boolean) {
    syncEnabled.value = v;
    persistModSyncEnabled(v);
  }

  /** Flip the mode (the Resources filter row's switch / ⋯ menu entry). */
  function toggleSync() {
    setSyncEnabled(!syncEnabled.value);
  }

  return { syncEnabled, setSyncEnabled, toggleSync };
});
