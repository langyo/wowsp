/**
 * Resource-pack + auxiliary-cache state for the Settings → updates panel.
 * Owns the single pack's status/update snapshots, the in-flight pass
 * progress (fed by the `wowsp://res-progress` stream) and the GitHub mirror
 * preference (persisted through network-config.toml, same file the network
 * section edits).
 *
 * The pack is content-addressed: `checkResUpdate` compares the local tree
 * hash against the `res-latest` manifest and reports the chain-patch path
 * (`deltaSteps`) when one exists — the panel then says "incremental, N
 * patches" instead of promising a ~1.2 GB re-download. `download` runs the
 * pass on the Rust side (which itself picks patches over the full archive).
 *
 * Startup policy lives in AppShell: the pack auto-downloads only when
 * ENTIRELY missing (lite install / wiped cache) AND the app itself is
 * current — app updates go first, the pack follows after the restart; an
 * outdated-but-present pack is surfaced here as `updateAvailable` instead
 * of silently re-pulling. The post-restart catch-up is prompted: the
 * first boot of a NEW build (last-run version moved) raises a blocking
 * toast (`offerUpdatePrompt`) instead of waiting for the user to find
 * the panel.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { showBlockingToast } from "@celestia-island/hikari";

import { api, type NetworkConfig, type ResProgress, type ResStatus, type ResUpdate } from "@/api";
import { t } from "@/i18n";
import { useSettingsUiStore } from "@/stores/settingsUi";
import { isMobileApp } from "@/utils/platform";

/** Speed smoothing over the per-event byte deltas (same shape as the
 *  Rust updater's ProgressTracker EWMA) and the minimum window between
 *  samples — the backend emits progress at most every 256 KiB, far
 *  faster than the readout needs. */
const SPEED_EWMA_ALPHA = 0.3;
const SPEED_MIN_SAMPLE_S = 0.25;

export const useCacheStore = defineStore("resourceCache", () => {
  const status = ref<ResStatus | null>(null);
  const update = ref<ResUpdate | null>(null);
  const auxCaches = ref<{ scope: string; sizeBytes: number }[]>([]);
  /** Live pass progress from the event stream; a terminal phase
   *  ("done"/"error") stays until the next refresh so the panel can show
   *  the outcome briefly. */
  const progress = ref<ResProgress | null>(null);
  /** Smoothed transfer rate of the running download pass (bytes/sec),
   *  derived client-side from the progress stream; null while idle,
   *  applying, or before a first sample window closes. */
  const speedBps = ref<number | null>(null);
  const updatesLoading = ref(false);
  const updatesCheckedAt = ref(0);
  /** ghproxy-style mirror prefix; saved through setNetworkConfig so the
   *  rest of the network config round-trips untouched. */
  const githubMirror = ref<string | null>(null);
  let progressWired = false;
  /** Whether the APK-bundled baseline was already handed to the shell
   *  (mobile; idempotence guard for the fetch + report pass). */
  let baselineReported = false;
  // Speed sampler state: last sampled byte offset / timestamp (0 =
  // window not open yet) and the EWMA accumulator. Closures inside the
  // setup body — one set per store instance, never shared.
  let sampleBytes = 0;
  let sampleAt = 0;
  let speedEwma = 0;

  /** True when the manifest is known and the local hash differs — drives
   *  the update banner in the updates section. */
  const anyUpdateAvailable = computed(() => update.value?.updateAvailable ?? false);

  /** True when the APK-bundled pack is the one serving (mobile; false on
   *  desktop and before the first status refresh). */
  const bundledServing = computed(() => status.value?.bundled ?? false);

  /** The chain-patch path length when a delta chain is known to exist
   *  (null = unknown / full download). */
  const deltaStepCount = computed<number | null>(() => {
    const steps = update.value?.deltaSteps;
    return steps ? steps.length : null;
  });

  /** Close the current speed window (next event opens a fresh one). */
  function resetSpeedSampler() {
    sampleBytes = 0;
    sampleAt = 0;
    speedEwma = 0;
    speedBps.value = null;
  }

  /** Fold one progress event into the store state and the speed
   *  sampler. Any pass boundary — a phase flip, a byte regression (new
   *  pass after the seeded restart, or a mirror failover restarting the
   *  same segment) — closes the window AND drops the displayed rate, so
   *  a rate measured over the old byte stream never outlives it; within
   *  a window the per-event deltas feed an EWMA at most every
   *  SPEED_MIN_SAMPLE_S. */
  function noteProgress(p: ResProgress) {
    const prev = progress.value;
    progress.value = p;
    const now = performance.now();
    if (p.phase !== "download" || !prev || prev.phase !== "download" || p.received < sampleBytes) {
      sampleBytes = p.received;
      sampleAt = p.phase === "download" ? now : 0;
      speedEwma = 0;
      speedBps.value = null;
      return;
    }
    if (sampleAt === 0) {
      // First download event of a window — baseline only, no rate yet.
      sampleBytes = p.received;
      sampleAt = now;
      return;
    }
    const elapsedS = (now - sampleAt) / 1000;
    const deltaBytes = p.received - sampleBytes;
    if (elapsedS < SPEED_MIN_SAMPLE_S || deltaBytes <= 0) return;
    const instant = deltaBytes / elapsedS;
    speedEwma = speedEwma > 0 ? SPEED_EWMA_ALPHA * instant + (1 - SPEED_EWMA_ALPHA) * speedEwma : instant;
    speedBps.value = speedEwma;
    sampleBytes = p.received;
    sampleAt = now;
  }

  function wireProgressStream() {
    if (progressWired) return;
    progressWired = true;
    // Outside the Tauri shell (browser dev) there is no event source; the
    // optional listener simply stays unset there. The store lives for the
    // app's lifetime, so the returned unlisten is intentionally dropped.
    const un = api.listenResProgress?.(noteProgress);
    if (un instanceof Promise) void un.catch(() => {});
  }

  /** Mobile: fetch the APK-bundled manifest (same-origin static file the
   *  mobile build ships at `/wowsp-res.json`) and hand its tree hash +
   *  version to the shell, so `getResStatus` / `checkResUpdate` can reason
   *  about the pack actually serving. Idempotent and quiet — an APK
   *  without the manifest (older bundle) simply keeps cache-only
   *  semantics. Desktop is a no-op. */
  async function reportBundledBaseline(): Promise<void> {
    if (baselineReported || !isMobileApp()) return;
    baselineReported = true;
    try {
      const resp = await fetch("/wowsp-res.json");
      if (!resp.ok) return;
      const manifest = (await resp.json()) as { treeSha256?: string; version?: string };
      if (manifest.treeSha256 && manifest.version) {
        await api.resReportBundled(manifest.treeSha256, manifest.version);
      }
    } catch {
      // Bundled manifest unavailable — the shell keeps cache-only
      // semantics; the panel shows the bundle without a version.
    }
  }

  /** Refresh the cheap LOCAL state (no network). */
  async function refreshStatus() {
    await reportBundledBaseline();
    try {
      status.value = await api.getResStatus();
    } catch {
      // older shell / mock — keep whatever we had
    }
    try {
      auxCaches.value = await api.auxCacheOverview();
    } catch {
      auxCaches.value = [];
    }
  }

  /** Refresh the REMOTE manifest (GitHub / mirror reachability required). */
  async function refreshUpdates() {
    updatesLoading.value = true;
    try {
      update.value = await api.checkResUpdate();
      updatesCheckedAt.value = Date.now();
    } catch {
      // offline / older shell — keep previous snapshot
    } finally {
      updatesLoading.value = false;
    }
  }

  /** Load the mirror preference from the network config (idempotent). */
  async function loadMirror() {
    try {
      const cfg = await api.getNetworkConfig();
      githubMirror.value = cfg.githubMirror ?? null;
    } catch {
      githubMirror.value = null;
    }
  }

  /** Persist the mirror preference, spreading the rest of the config back
   *  so unrelated fields (proxy, resource CDN) survive the round-trip. */
  async function saveMirror(value: string | null) {
    const current = await api.getNetworkConfig();
    const next: NetworkConfig = {
      ...current,
      githubMirror: value?.trim() || null,
    };
    // Adopt the sanitized response — the shell may correct the value; a
    // backend without the response (mock / older shell) keeps what we sent.
    const saved = await api.setNetworkConfig(next);
    githubMirror.value = saved?.githubMirror ?? next.githubMirror ?? null;
  }

  /** Explicit pack pass (initial / migration / update — the Rust side
   *  picks chain patches when possible). Progress arrives through the
   *  event stream; the panel derives its buttons from `progress`. */
  async function download() {
    wireProgressStream();
    resetSpeedSampler();
    progress.value = { phase: "download", received: 0, total: 0, segment: 1, segments: 1 };
    try {
      await api.resDownload();
    } catch (e) {
      // Early rejections (busy guard, network-stack failure) never reach
      // the install pass, so no error EVENT arrives — surface the
      // rejection here or the panel would sit on a dead progress bar.
      progress.value = {
        phase: "error",
        received: 0,
        total: 0,
        segment: 0,
        segments: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    await refreshStatus();
    await refreshUpdates();
  }

  async function cancel() {
    try {
      await api.resCancel();
    } catch {
      /* best-effort */
    }
  }

  /** Session-scoped guard: one pack-update prompt on screen at a time. */
  let promptPending = false;

  /**
   * Blocking prompt for an available pack update — the post-restart
   * catch-up the startup policy defers to (AppShell calls this on the
   * first boot of a NEW build when the manifest reports an outdated
   * pack). Same grammar as the updater's idle prompt: a hikari
   * blocking toast with 立即更新 / 稍后. 立即更新 opens Settings →
   * updates (where the live progress bar lives) and starts the pass;
   * 稍后 just dismisses — the panel banner remains, and the next
   * post-update restart asks again.
   */
  async function offerUpdatePrompt() {
    const upd = update.value;
    if (!upd?.updateAvailable || promptPending) return;
    const prog = progress.value;
    if (prog && (prog.phase === "download" || prog.phase === "apply")) return;
    promptPending = true;
    const answered = await showBlockingToast(
      t("settings.resUpdatePrompt", {
        version: upd.latestTreeSha256
          ? upd.latestTreeSha256.slice(-6).toUpperCase()
          : t("settings.resVersionUnknown"),
      }),
      {
        confirmLabel: t("settings.resUpdateNow"),
        cancelLabel: t("settings.resUpdateLater"),
        variant: "info",
      },
    );
    promptPending = false;
    if (answered) {
      useSettingsUiStore().show("updates");
      void download();
    }
  }

  async function clearRes() {
    try {
      await api.clearRes();
    } catch {
      /* refused while downloading etc. */
    }
    await refreshStatus();
    await refreshUpdates();
  }

  async function clearAuxCache(scope: string) {
    try {
      await api.clearAuxCache(scope);
    } catch {
      /* best-effort */
    }
    try {
      auxCaches.value = await api.auxCacheOverview();
    } catch {
      /* keep previous */
    }
  }

  function init() {
    wireProgressStream();
    void refreshStatus();
    void loadMirror();
  }

  return {
    status,
    update,
    auxCaches,
    progress,
    speedBps,
    updatesLoading,
    updatesCheckedAt,
    githubMirror,
    anyUpdateAvailable,
    bundledServing,
    deltaStepCount,
    reportBundledBaseline,
    refreshStatus,
    refreshUpdates,
    loadMirror,
    saveMirror,
    download,
    cancel,
    offerUpdatePrompt,
    clearRes,
    clearAuxCache,
    init,
  };
});
