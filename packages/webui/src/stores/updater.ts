/**
 * Updater store, backed by the shun-based update commands in the Rust
 * shell (`commands/update.rs`): `update_check` resolves the configured
 * mirror sources and compares the `latest` marker against the running
 * version; `update_download` queues the installer artifact on the
 * unified download hub (`commands/download_hub.rs`) — mirrors raced, a
 * single writer streams into a version-scoped part file that SURVIVES
 * failed and cancelled passes, so a retry resumes where the last attempt
 * died instead of restarting from byte 0 — then launches it silently;
 * the hardened installer kills this app and installs the new build over
 * its directory.
 *
 * Progress arrives on the unified `wowsp://download-progress` channel
 * (kind "update", the single bus every download context shares):
 * `race`/`queued` render the indeterminate strip, `download` carries
 * `received`/`total`/`speedBps` — `received == total` is only ever sent
 * for a complete, verified file, so the bar can no longer hit ~100% and
 * then restart (the old mirror-failover failure mode) — and `install`
 * means the installer was spawned.
 *
 * The flow is prompted, never automatic. Discovering a newer version only
 * raises the idle prompt — a hikari blocking toast (立即更新 / 稍后) in the
 * top-right stack; answering 立即更新 (or the AboutModal pill) starts the
 * pass, which renders as the dedicated UpdateToast card: a spinner while
 * mirrors are raced, a bottom progress bar with percent + speed while the
 * artifact streams, and a single 取消 button (none once the installer has
 * spawned). 取消 tears the pass down via `update_cancel` — the part file
 * is kept as the resume base — and reads as "not now": the prompt stays
 * dismissed for the session. Failures are recorded in `error` and fall
 * back to the idle prompt (unless dismissed); a retry continues from the
 * retained part file.
 *
 * In browser-only dev mode the commands throw (no Tauri runtime); calls are
 * caught and surfaced via `error` so the UI degrades gracefully.
 *
 * Portable (USB / green) installs have no NSIS-based update path — the
 * updater is disabled there (`portable` flag from the Rust `is_portable`
 * command).
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

import { showBlockingToast } from "@celestia-island/hikari";

import { api, type DownloadProgress } from "@/api";
import { RPC } from "@/rpc";
import { t } from "@/i18n";
import { formatSpeed } from "@/utils/format";

/** Answer shape of the Rust `update_check` command. */
interface UpdateInfo {
  current: string;
  available: boolean;
  version: string | null;
}

export const useUpdaterStore = defineStore("updater", () => {
  const available = ref(false);
  const version = ref<string | null>(null);
  const current = ref("");
  const checking = ref(false);
  const downloading = ref(false);
  const progress = ref<number | null>(null);
  const installing = ref(false);
  // "race" while mirrors are probed / raced (or the pass waits in the
  // download hub's FIFO queue), "download" while the winner streams,
  // "install" once the installer is spawned.
  const phase = ref<"race" | "download" | "install" | null>(null);
  const speedBps = ref<number | null>(null);
  const checked = ref(false);
  const error = ref<string | null>(null);
  const portable = ref(false);
  // True once the user pressed 稍后 — the prompt hides for the session
  // (AboutModal keeps offering the update). Never reset: a fresh launch
  // starts a fresh store.
  const dismissed = ref(false);
  // The pending bus registration — memoized so AppShell's concurrent
  // `init()` calls can never register two handlers racing each other for
  // the `unlistenProgress` slot (the old check ran before the await and
  // let a double init bind twice).
  let progressBinding: Promise<void> | null = null;
  // Guards a duplicate idle prompt while one is already on screen.
  let promptPending = false;

  // True while the pass card should be on screen (download or spawned
  // installer); drives the AboutModal live pill too.
  const running = computed(() => downloading.value || installing.value);

  /** The pass card's live line for the current phase. */
  const statusText = computed(() => {
    if (installing.value) return t("about.updateInstalling");
    if (phase.value === "race") return t("about.updateRacing");
    if (phase.value === "download") {
      const pct = progress.value ?? 0;
      return `${t("about.updateDownloading")} ${pct}% · ${formatSpeed(speedBps.value)}`;
    }
    return t("about.updateDownloading");
  });

  /** Fold one unified-bus tick for THIS context into the store state. */
  function noteProgress(p: DownloadProgress): void {
    if (p.kind !== "update") return;
    // Stray events after a cancel / reset find the store idle — ignore
    // them so the card never paints a ghost pass.
    if (!running.value) return;
    if (p.phase === "race" || p.phase === "queued") {
      // Mirrors are being probed / raced (or the pass waits behind
      // another download) — indeterminate card state.
      phase.value = "race";
    } else if (p.phase === "download") {
      phase.value = "download";
      if (p.total > 0) {
        // The backend only lets received reach total on a complete,
        // verified file — no clamp needed, and no 100%-then-restart.
        progress.value = Math.round(
          Math.min(Math.max((p.received / p.total) * 100, 0), 100),
        );
      }
      speedBps.value = p.speedBps > 0 ? p.speedBps : null;
    } else if (p.phase === "install") {
      // The installer was spawned — reflect it even when the command's
      // promise never settles (the new build kills this app right after
      // the spawn). The streaming half of the pass is over, so the
      // cancel control goes away with it.
      phase.value = "install";
      installing.value = true;
      downloading.value = false;
    }
  }

  async function init() {
    try {
      portable.value = await invoke<boolean>("is_portable");
    } catch {
      portable.value = false;
    }
    // Bind the unified download-progress bus lazily; absent in browser
    // dev mode. The memoized promise makes concurrent init() calls
    // register exactly one handler.
    if (!progressBinding) {
      progressBinding = (async () => {
        try {
          api.listenDownloadProgress(noteProgress);
        } catch {
          // Not in Tauri — progress events simply never arrive.
        }
      })();
    }
    await progressBinding;
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
      // Mirror probes fail offline / behind firewalls — never worth a
      // global nag; the message just lands in `error`. Tauri rejects
      // commands with the raw Err string, not an Error instance.
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      checked.value = true;
      checking.value = false;
    }
    if (available.value) void offerPrompt();
  }

  /** The idle prompt card: 发现新版本 <version> with 立即更新 / 稍后.
   *  One at a time; 稍后 dismisses for the session. */
  async function offerPrompt() {
    if (portable.value || !available.value || dismissed.value) return;
    if (running.value || promptPending) return;
    promptPending = true;
    const answered = showBlockingToast(t("about.updatePrompt", { version: version.value ?? "" }), {
      confirmLabel: t("about.updateNow"),
      cancelLabel: t("about.updateLater"),
      variant: "info",
    });
    const go = await answered;
    promptPending = false;
    if (go) {
      void downloadAndInstall();
    } else {
      dismissed.value = true;
    }
  }

  async function downloadAndInstall() {
    if (portable.value || !available.value) return;
    if (running.value) return;
    downloading.value = true;
    phase.value = "race";
    // Seeded to 0; a resumed pass (the hub retained its part file)
    // overwrites this on the first download event with the committed
    // offset — the bar jumps straight to where the last attempt died.
    progress.value = 0;
    speedBps.value = null;
    error.value = null;
    try {
      // Resolves once the installer process has been spawned; on the success
      // path the hardened installer kills this app first, so this promise
      // often never settles — both outcomes are success by design.
      await invoke(RPC.update_download, {});
      installing.value = true;
      downloading.value = false;
    } catch (e) {
      // A user cancel (取消) is not a failure: the Rust side kept the part
      // file as the resume base of the next attempt. An explicit cancel
      // reads as "not now" — dismiss the prompt for the session like 稍后
      // would; failures fall back to the idle prompt unless dismissed.
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("update cancelled")) {
        dismissed.value = true;
      } else {
        error.value = msg;
      }
      downloading.value = false;
      installing.value = false;
      phase.value = null;
      progress.value = null;
      speedBps.value = null;
      if (!dismissed.value) void offerPrompt();
    }
  }

  /** The pass card's 取消: aborts the streaming download. The pending
   *  `update_download` promise rejects with "update cancelled", which
   *  `downloadAndInstall` folds back into the idle state. */
  function cancelDownload() {
    if (!downloading.value) return;
    void invoke(RPC.update_cancel).catch(() => {});
  }

  /** One-shot delayed check the app shell calls on mount (startup
   *  auto-check, delayed so launch I/O isn't contended). */
  function scheduleAutoCheck(delayMs = 5000) {
    if (portable.value) return;
    setTimeout(() => void check(), delayMs);
  }

  /** Resolve once the startup check has settled — immediately when the
   *  updater is disabled (portable) or already checked, and never later
   *  than `timeoutMs` (a dead network must not stall the caller). The
   *  resource pack's startup pass uses this to let app updates go first. */
  function waitForCheck(timeoutMs = 15000): Promise<void> {
    if (checked.value || portable.value) return Promise.resolve();
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = window.setInterval(() => {
        if (checked.value || portable.value || Date.now() - started >= timeoutMs) {
          window.clearInterval(timer);
          resolve();
        }
      }, 250);
    });
  }

  return {
    available,
    version,
    current,
    checking,
    downloading,
    progress,
    installing,
    phase,
    speedBps,
    checked,
    error,
    portable,
    dismissed,
    running,
    statusText,
    init,
    check,
    downloadAndInstall,
    cancelDownload,
    scheduleAutoCheck,
    waitForCheck,
    offerPrompt,
  };
});
