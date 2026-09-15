import { defineStore } from "pinia";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { RPC } from "@/rpc";

/** Answer shape of the Rust `update_check` command. */
interface UpdateInfo {
  current: string;
  available: boolean;
  version: string | null;
}

/** Payload of the Rust `update-progress` event. */
interface UpdateProgress {
  phase: "download" | "install";
  percent: number;
}

/** Shortcut answers captured from the update prompt, forwarded to the
 *  silent installer via `update_download`. */
/**
 * Updater store, backed by the shun-based update commands in the Rust
 * shell (`commands/update.rs`): `update_check` resolves the configured
 * mirror sources and compares the `latest` marker against the running
 * version; `update_download` streams the lite installer artifact with
 * `update-progress` events, then launches it silently with the prompt's
 * shortcut answers — the hardened installer kills this app and installs
 * the new build over its directory (no auto-relaunch).
 *
 * The flow is prompted: the app shell schedules `scheduleAutoCheck()` on
 * mount, the update banner offers 立即更新 / 稍后 once a newer version
 * shows up, and only an explicit 立即更新 click starts the install
 * (`startAutoInstall()`). `dismissUpdate()` hides the banner for the
 * session — the update stays available from AboutModal. Failures are only
 * surfaced in AboutModal (`checked` / `error`), never as a global nag.
 *
 * In browser-only dev mode the commands throw (no Tauri runtime); calls are
 * caught and surfaced via `error` so the UI degrades gracefully.
 *
 * Portable (USB / green) installs have no NSIS-based update path — the
 * updater is disabled there (`portable` flag from the Rust `is_portable`
 * command).
 */
export const useUpdaterStore = defineStore("updater", () => {
  const available = ref(false);
  const version = ref<string | null>(null);
  const current = ref("");
  const checking = ref(false);
  const downloading = ref(false);
  const progress = ref<number | null>(null);
  const installing = ref(false);
  const checked = ref(false);
  const error = ref<string | null>(null);
  const portable = ref(false);
  // Shortcut answers from the last prompt click; both default on.

  // True once the user pressed 稍后 — the banner hides for the session
  // (AboutModal keeps offering the update). Never reset: a fresh launch
  // starts a fresh store.
  const dismissed = ref(false);
  let unlistenProgress: UnlistenFn | null = null;

  async function init() {
    try {
      portable.value = await invoke<boolean>("is_portable");
    } catch {
      portable.value = false;
    }
    // Bind the download-progress event lazily; absent in browser dev mode.
    if (!unlistenProgress) {
      try {
        unlistenProgress = await listen<UpdateProgress>("update-progress", (event) => {
          if (event.payload?.phase === "download") {
            progress.value = Math.round(event.payload.percent);
          } else if (event.payload?.phase === "install") {
            // The installer was spawned — reflect it even when the
            // command's promise never settles (the new build kills this
            // app right after the spawn).
            installing.value = true;
          }
        });
      } catch {
        // Not in Tauri — progress events simply never arrive.
      }
    }
  }

  async function check() {
    if (portable.value) return;
    checking.value = true;
    error.value = null;
    try {
      const info = await invoke<UpdateInfo>(RPC.update_check);
      current.value = info.current;
      available.value = info.available;
      version.value = info.version ?? null;
    } catch (e) {
      // Mirror probes fail offline / behind firewalls — never worth a global
      // nag; AboutModal shows the message on demand. Tauri rejects commands
      // with the raw Err string, not an Error instance.
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      checked.value = true;
      checking.value = false;
    }
  }

  async function downloadAndInstall() {
    if (portable.value || !available.value) return;
    downloading.value = true;
    progress.value = 0;
    error.value = null;
    try {
      // Resolves once the installer process has been spawned; on the success
      // path the hardened installer kills this app first, so this promise
      // often never settles — both outcomes are success by design. The
      // prompt's shortcut answers ride along to the silent installer.
      await invoke(RPC.update_download, {
      });
      installing.value = true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      downloading.value = false;
    }
  }

  /** One-shot delayed check the app shell calls on mount (startup
   *  auto-check, delayed so launch I/O isn't contended). */
  function scheduleAutoCheck(delayMs = 5000) {
    if (portable.value) return;
    setTimeout(() => void check(), delayMs);
  }

  /** Kick off the download+install from an explicit user action (the
   *  banner's 立即更新). Captures the prompt's shortcut answers for the
   *  silent installer; no-op while a pass is already running. */
  function startAutoInstall() {
    if (!available.value || downloading.value || installing.value) return;
    void downloadAndInstall();
  }

  /** The banner's 稍后 answer: hide the prompt for this session; the
   *  update stays available from AboutModal. */
  function dismissUpdate() {
    dismissed.value = true;
  }

  return {
    available,
    version,
    current,
    checking,
    downloading,
    progress,
    installing,
    checked,
    error,
    portable,
    dismissed,
    init,
    check,
    downloadAndInstall,
    scheduleAutoCheck,
    startAutoInstall,
    dismissUpdate,
  };
});
