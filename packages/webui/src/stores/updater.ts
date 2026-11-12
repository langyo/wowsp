/**
 * Updater store, backed by the shun-based update commands in the Rust
 * shell (`commands/update.rs`): `update_check` resolves the configured
 * mirror sources and compares the `latest` marker against the running
 * version; `update_download` queues the installer artifact on the
 * unified download hub (`commands/download_hub.rs`) — mirrors raced, a
 * single writer streams into a version-scoped part file that SURVIVES
 * failed and cancelled passes, so a retry resumes where the last attempt
 * died instead of restarting from byte 0 — then launches it silently;
 * the app exits itself right after the handoff, and the hardened
 * installer delivers over the directory and relaunches the new build.
 *
 * Progress is NOT tracked here: `update` is a `card` context of the unified
 * download context (stores/downloads), which folds its ticks and renders the
 * shared top-right pass card. This store keeps the update's own facts (the
 * available version, the idle prompt, the stranded-recovery handoff) and the
 * verbs; `downloadAndInstall` hands the command to `downloads.track`.
 *
 * The ticks themselves arrive on the unified `wowsp://download-progress`
 * channel (kind "update", the single bus every download context shares):
 * `verify` renders the indeterminate strip while the official
 * version/digest lookup settles (before any mirror is touched);
 * `race`/`queued` render the indeterminate strip, `download` carries
 * `received`/`total`/`speedBps` — `received == total` is only ever sent
 * for a complete, verified file, so the bar can no longer hit ~100% and
 * then restart (the old mirror-failover failure mode) — and `install`
 * means the installer was spawned.
 *
 * The flow is prompted, never automatic. Discovering a newer version only
 * raises the idle prompt — a hikari blocking toast (立即更新 / 稍后) in the
 * top-right stack; answering 立即更新 (or the AboutModal pill) starts the
 * pass on the SHARED download card (DownloadToast): the spinner covers the
 * mirror race, the bar follows the artifact with percent + speed + ETA, and
 * its 取消 action is the registry's `update_cancel` verb — the part file
 * stays as the resume base and the cancel reads as "not now" (the prompt
 * stays dismissed for the session). Failures fall back to the idle prompt
 * unless dismissed; a retry continues from the retained part file.
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

import { showBlockingToast, useToast } from "@celestia-island/hikari";

import { RPC } from "@/rpc";
import { t } from "@/i18n";
import { useDownloadsStore } from "@/stores/downloads";

/** Answer shape of the Rust `update_check` command. */
interface UpdateInfo {
  current: string;
  available: boolean;
  version: string | null;
}

/** Answer shape of the Rust `update_stranded_info` command: the previous
 *  launch handed off to an update that never landed (see the one-shot
 *  `update-pending.json` marker), and the downloaded installer may still
 *  be on disk for the run-the-wizard recovery. */
interface UpdateStrandedInfo {
  expected: string;
  installer_ready: boolean;
}

/** The website's standalone download page — the stranded-recovery card's
 *  fallback action when the cached installer is gone. */
const DOWNLOAD_PAGE_URL = "https://wowsp.langyo.xyz/download";

export const useUpdaterStore = defineStore("updater", () => {
  const toast = useToast();
  const available = ref(false);
  const version = ref<string | null>(null);
  const current = ref("");
  const downloads = useDownloadsStore();
  const checking = ref(false);
  const checked = ref(false);
  const error = ref<string | null>(null);
  const portable = ref(false);
  /** False until the is_portable probe has landed (true either way).
   *  Consumers that must not flash portable-specific UI while the probe is
   *  in flight (the ship-detail aircraft hint) gate on this; AppShell boot
   *  calls `probePortable()` directly on EVERY surface (init() is desktop
   *  only), so the wait is one tick. */
  const portableResolved = ref(false);
  // True once the user pressed 稍后 — the prompt hides for the session
  // (AboutModal keeps offering the update). Never reset: a fresh launch
  // starts a fresh store.
  const dismissed = ref(false);
  // Guards a duplicate idle prompt while one is already on screen.
  let promptPending = false;
  // The stranded handoff recorded by the Rust startup reconciliation
  // (`update-pending.json`), read once at init. Null on a clean boot or
  // after a landed update; non-null raises the recovery card.
  const stranded = ref<UpdateStrandedInfo | null>(null);
  // True once the recovery card's wizard action launched — the card
  // folds; the wizard takes it from there.
  const recovering = ref(false);

  // ── pass-derived state (the shared download context owns the pass) ──────
  // True while the pass should be on screen: the installer hand-off keeps it
  // up after the byte stream ends (the new build is about to replace this
  // app), and the AboutModal pill reads the same flag.
  const running = computed(() => downloads.busyFor("update"));

  /** The live line for surfaces that show one (AboutModal's pill, the
   *  updates card). The top-right card renders the pass itself. */
  const statusText = computed(() => {
    const pass = downloads.passFor("update");
    if (!pass || !pass.busy) return "";
    if (pass.phase === "install") return t("about.updateInstalling");
    if (pass.phase === "verify") return t("about.updateVerifying");
    if (pass.phase === "race") return t("about.updateRacing");
    return t("about.updateDownloading");
  });

  /** Probe the portable (便捷版) build flag — the single is_portable read
   *  shared by every surface. AppShell's boot calls this directly on ALL
   *  surfaces (phone build / browser dev included, where init() never runs),
   *  and init() starts with it for the desktop path. Portable-specific UI
   *  gates on `portableResolved` so it cannot resolve before the probe
   *  lands; a missing command (browser dev / older shell) resolves to false,
   *  i.e. normal-build behavior. Never throws. */
  async function probePortable(): Promise<void> {
    try {
      portable.value = await invoke<boolean>("is_portable");
    } catch {
      portable.value = false;
    }
    // The probe has landed either way — portable-specific UI may resolve now.
    portableResolved.value = true;
  }

  async function init() {
    // The desktop init path needs the portable flag before its delayed
    // passes read it; every surface's boot also probes directly (AppShell).
    await probePortable();
    // The unified download context owns the bus registration (one listener for
    // every kind); this store no longer binds one of its own.
    downloads.ensureWired();
    // Read the startup reconciliation's verdict (desktop only — the
    // commands are windows-gated; absent in browser dev mode).
    try {
      stranded.value = await invoke<UpdateStrandedInfo | null>(RPC.update_stranded_info);
    } catch {
      stranded.value = null;
    }
  }

  /** The recovery card's 干净重装: re-run the installer the stranded
   *  handoff already downloaded — visibly, as a standalone wizard. */
  async function reinstallFromCache() {
    if (!stranded.value?.installer_ready || recovering.value) return;
    recovering.value = true;
    try {
      await invoke(RPC.update_reinstall_from_cache, {});
    } catch (e) {
      // The wizard is the whole point — a failure to launch it leaves
      // the card up so the download-page fallback stays reachable.
      recovering.value = false;
      error.value = e instanceof Error ? e.message : String(e);
      return;
    }
    stranded.value = null;
  }

  /** The recovery card's fallback: the website's download page. */
  async function openDownloadPage() {
    try {
      await invoke(RPC.open_external, { url: DOWNLOAD_PAGE_URL });
    } catch {
      window.open(DOWNLOAD_PAGE_URL, "_blank", "noopener");
    }
  }

  async function check(opts: { quiet?: boolean } = {}) {
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
      // Explicit checks say WHY they failed (transient toast); the
      // startup auto-check passes quiet and stays silent — the pill on
      // the updates card covers it.
      if (!opts.quiet) {
        toast.error(t("settings.updatesCheckFailed", { message: error.value }));
      }
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
    error.value = null;
    // The pass lives in the unified download context: the shared top-right
    // card renders the mirror race, the stream and the installer hand-off,
    // and its cancel action is the registry's update_cancel verb.
    //
    // The command resolves once the installer process has been spawned; on
    // the success path the hardened installer kills this app first, so this
    // promise often never settles — both outcomes are success by design. The
    // context's pass therefore stays BUSY through the hand-off (it is settled
    // by the process exiting), which is exactly what keeps the card and the
    // AboutModal pill up while the spawn happens.
    const outcome = await downloads.track("update", () => invoke(RPC.update_download, {}));
    if (outcome.ok) return;
    const msg = outcome.error ?? "";
    if (msg.includes("update cancelled")) {
      // A user cancel is not a failure: the Rust side kept the part file as
      // the resume base. Read it as "not now" — dismiss the prompt for the
      // session like 稍后 would.
      dismissed.value = true;
    } else {
      error.value = msg;
      // The reset alone read as "nothing happened" (the 2026-10-25 v0.6.7
      // stale-relay incident: the pass refused before any byte streamed and
      // the banner simply re-offered) — say WHY it died before the idle
      // prompt comes back. Copyable: the raw refusal (digest-channel
      // disagreement et al.) is exactly what a support request needs.
      toast.error(t("about.updateFailed", { message: msg }));
    }
    if (!dismissed.value) void offerPrompt();
  }

  /** Surfaces that used to own a cancel button now defer to the registry verb
   *  on the shared card; this alias keeps the AboutModal/updates-card callers
   *  working through ONE implementation. */
  function cancelDownload() {
    void downloads.cancel("update");
  }

  /** One-shot delayed check the app shell calls on mount (startup
   *  auto-check, delayed so launch I/O isn't contended). */
  function scheduleAutoCheck(delayMs = 5000) {
    if (portable.value) return;
    setTimeout(() => void check({ quiet: true }), delayMs);
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
    checked,
    error,
    portable,
    portableResolved,
    dismissed,
    running,
    statusText,
    stranded,
    recovering,
    probePortable,
    init,
    reinstallFromCache,
    openDownloadPage,
    check,
    downloadAndInstall,
    cancelDownload,
    scheduleAutoCheck,
    waitForCheck,
    offerPrompt,
  };
});
