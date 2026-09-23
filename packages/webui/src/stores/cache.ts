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
 * of silently re-pulling.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { api, type NetworkConfig, type ResProgress, type ResStatus, type ResUpdate } from "@/api";
import { isMobileApp } from "@/utils/platform";

export const useCacheStore = defineStore("resourceCache", () => {
  const status = ref<ResStatus | null>(null);
  const update = ref<ResUpdate | null>(null);
  const auxCaches = ref<{ scope: string; sizeBytes: number }[]>([]);
  /** Live pass progress from the event stream; a terminal phase
   *  ("done"/"error") stays until the next refresh so the panel can show
   *  the outcome briefly. */
  const progress = ref<ResProgress | null>(null);
  const updatesLoading = ref(false);
  const updatesCheckedAt = ref(0);
  /** ghproxy-style mirror prefix; saved through setNetworkConfig so the
   *  rest of the network config round-trips untouched. */
  const githubMirror = ref<string | null>(null);
  let progressWired = false;
  /** Whether the APK-bundled baseline was already handed to the shell
   *  (mobile; idempotence guard for the fetch + report pass). */
  let baselineReported = false;

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

  function wireProgressStream() {
    if (progressWired) return;
    progressWired = true;
    // Outside the Tauri shell (browser dev) there is no event source; the
    // optional listener simply stays unset there. The store lives for the
    // app's lifetime, so the returned unlisten is intentionally dropped.
    const un = api.listenResProgress?.((p) => {
      progress.value = p;
    });
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
    clearRes,
    clearAuxCache,
    init,
  };
});
