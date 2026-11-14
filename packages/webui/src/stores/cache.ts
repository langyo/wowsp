/**
 * Resource-pack + auxiliary-cache state for the Settings → resources panel.
 * Owns the single pack's status/update snapshots and the GitHub mirror list
 * (persisted through network-config.toml, same file the network section
 * edits).
 *
 * Pass progress is NOT tracked here: the pack is a `card` context of the
 * unified download context (stores/downloads), which owns the one top-right
 * pass card every resource download shares. This store keeps only the pack's
 * own persistent state (presence, hash stamps, update availability) and the
 * management verbs; `download()` hands the command to `downloads.track`, so
 * a pack pass looks identical wherever it was started from.
 *
 * The pack is content-addressed: `checkResUpdate` compares the local tree
 * hash against the `res-latest` manifest and reports the chain-patch path
 * (`deltaSteps`) when one exists — the update flavour ("incremental, N
 * patches" / "full download required") is announced as a transient toast
 * instead of promising a ~1.2 GB re-download in the card itself.
 * `download` runs the pass on the Rust side (which itself picks patches
 * over the full archive); `verifyIntegrity` re-hashes a current pack on
 * demand and re-downloads automatically when the tree drifted.
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

import { showBlockingToast, useToast } from "@celestia-island/hikari";

import { api, type NetworkConfig, type ResStatus, type ResUpdate } from "@/api";
import { t } from "@/i18n";
import { useDownloadsStore } from "@/stores/downloads";
import { isMobileApp } from "@/utils/platform";

export const useCacheStore = defineStore("resourceCache", () => {
  const downloads = useDownloadsStore();
  const status = ref<ResStatus | null>(null);
  const update = ref<ResUpdate | null>(null);
  const auxCaches = ref<{ scope: string; sizeBytes: number }[]>([]);
  const updatesLoading = ref(false);
  const updatesCheckedAt = ref(0);
  /** Whether the on-demand integrity check is running (the panel's
   *  check-integrity button spins while it does). */
  const integrityChecking = ref(false);
  /** User-saved ghproxy-style mirror prefixes (the ladder's user rows);
   *  saved through setNetworkConfig so the rest of the network config
   *  round-trips untouched. */
  const githubMirrors = ref<string[]>([]);
  /** Whether the APK-bundled baseline was already handed to the shell
   *  (mobile; idempotence guard for the fetch + report pass). */
  let baselineReported = false;

  /** True when the manifest is known and the local hash differs — drives
   *  the update banner in the resources section. */
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

  /** Refresh the REMOTE manifest (GitHub / mirror reachability required).
   *  Silent: the persistent banner covers plain availability — the update
   *  flavour is only announced by the explicit `checkUpdates`. */
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

  /** The user-initiated 检查更新 pass: refresh the manifest AND announce
   *  the update flavour as a transient toast (chain-patch count / full
   *  download / plain availability). The passive refreshes (boot,
   *  section-open, post-pass) must stay silent — a toast on every boot
   *  with the panel closed would be spam; the banner suffices there. */
  async function checkUpdates() {
    await refreshUpdates();
    announceUpdateKind();
  }

  /** Announce the flavour of an available update as a transient toast —
   *  the chain-patch count (or "full download required") is momentary
   *  information, not card layout. */
  function announceUpdateKind() {
    const upd = update.value;
    if (!upd?.updateAvailable) return;
    const steps = upd.deltaSteps;
    const toast = useToast();
    if (steps == null) toast.info(t("settings.cacheUpdateAvailable"));
    else if (steps.length > 0)
      toast.info(t("settings.resDeltaAvailable", { n: steps.length }));
    else toast.info(t("settings.resFullDownload"));
  }

  /**
   * On-demand integrity check for a pack that is already current:
   * recompute the on-disk tree hash and compare with the install-time
   * stamp. Intact → a success toast; NOT intact → a warning toast and an
   * automatic re-download (the pass re-applies the pack, repairing the
   * tree). Rejections (unstamped cache, refused while a pass runs)
   * surface as error toasts — the button only shows for hash-stamped,
   * idle packs, so they indicate genuine surprise.
   */
  async function verifyIntegrity() {
    if (integrityChecking.value) return;
    integrityChecking.value = true;
    const toast = useToast();
    try {
      const report = await api.resVerifyIntegrity();
      if (report.intact) {
        toast.success(t("settings.resIntegrityOk"));
      } else {
        toast.warning(t("settings.resIntegrityBroken"));
        // Release BEFORE the repair pass takes over — download()'s
        // busy-guard would otherwise swallow the auto-repair (the
        // shell-side VERIFY_ACTIVE flag is already cleared by then:
        // the walk finished before this command resolved).
        integrityChecking.value = false;
        void download(true);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      integrityChecking.value = false;
    }
  }

  /** Load the mirror list from the network config (idempotent). The
   *  legacy single `githubMirror` slot folds in as the only user row
   *  when the shell has not migrated the list yet. */
  async function loadMirror() {
    try {
      const cfg = await api.getNetworkConfig();
      githubMirrors.value = cfg.githubMirrors ?? (cfg.githubMirror ? [cfg.githubMirror] : []);
    } catch {
      githubMirrors.value = [];
    }
  }

  /** Persist the mirror list, spreading the rest of the config back so
   *  unrelated fields (proxy, resource CDN) survive the round-trip. */
  async function saveMirrors(list: string[]) {
    const current = await api.getNetworkConfig();
    const next: NetworkConfig = {
      ...current,
      githubMirrors: list,
    };
    // Adopt the sanitized response — the shell may correct the list; a
    // backend without the response (mock / older shell) keeps what we sent,
    // folding its legacy single-prefix echo back in when present.
    const saved = await api.setNetworkConfig(next);
    githubMirrors.value =
      saved?.githubMirrors ??
      (saved?.githubMirror ? [saved.githubMirror] : (next.githubMirrors ?? []));
  }

  /** Explicit pack pass (initial / migration / update — the Rust side
   *  picks chain patches when possible). The command runs inside the
   *  unified download context, so its progress renders on the shared
   *  top-right pass card instead of inside the settings pane; the panel
   *  only gates its buttons on `downloads.busyFor("res-pack")`. The
   *  integrity repair passes `force`: a corrupt tree carries a correct
   *  stamp, so the shell's already-current fast path must not swallow
   *  the reinstall. */
  async function download(force = false) {
    // An integrity walk owns the tree right now — a pass started under it
    // would both race the hash and refuse itself backend-side. (The
    // repair caller releases the flag before handing off, so `force`
    // never needs to bypass this.)
    if (integrityChecking.value) return;
    // An early rejection (busy guard, network-stack failure) never reaches
    // the install pass, so no progress tick would follow; `track` records
    // the failure on the pass and raises the error toast itself.
    await downloads.track("res-pack", () => api.resDownload(force));
    await refreshStatus();
    await refreshUpdates();
  }

  /** In-flight ensure pass — the shell's two loaders (dogtags + models) both
   *  ask for the pack at boot, and the ledger holds ONE pass per kind. Sharing
   *  the promise keeps them on the same pass instead of clobbering it. */
  let ensurePass: Promise<string> | null = null;

  /** Boot-time ensure pass: hand the shared context a pass so the top-right
   *  card can show it (the shell calls this while wiring the model pack). The
   *  value (the cache root) is handed back and a rejection rethrown: the
   *  caller's own fallback chain decides what to do, exactly as before this
   *  store grew a progress surface — the difference is only that the bytes
   *  now render on the shared card instead of nowhere. */
  function ensure(): Promise<string> {
    if (ensurePass) return ensurePass;
    ensurePass = (async () => {
      try {
        const outcome = await downloads.track("res-pack", () => api.ensureResPack(), {
          quiet: true,
        });
        if (!outcome.ok) throw new Error(outcome.error ?? "resource pack ensure failed");
        return outcome.value as string;
      } finally {
        ensurePass = null;
      }
    })();
    return ensurePass;
  }

  /** Session-scoped guard: one pack-update prompt on screen at a time. */
  let promptPending = false;

  /**
   * Blocking prompt for an available pack update — the post-restart
   * catch-up the startup policy defers to (AppShell calls this on the
   * first boot of a NEW build when the manifest reports an outdated
   * pack). Same grammar as the updater's idle prompt: a hikari
   * blocking toast with 立即更新 / 稍后. 立即更新 starts the pass right
   * here — the progress renders on the shared top-right card, so the
   * prompt never has to navigate; 稍后 just dismisses — the status card
   * in Settings → resources keeps saying "updates available", and the
   * next post-update restart asks again.
   */
  async function offerUpdatePrompt() {
    const upd = update.value;
    if (!upd?.updateAvailable || promptPending) return;
    // A pass already under way needs no second consent — the shared card is
    // on screen with the live progress (and its cancel verb).
    if (downloads.busyFor("res-pack")) return;
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
    if (answered) void download();
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

  /** The status card's ONE cleanup verb: clear every auxiliary cache by
   *  running the same per-scope command in sequence, so the family row and
   *  the details panel's per-cache rows can never diverge on the wire (a new
   *  backend command would have to be mirrored into both). Sequential on
   *  purpose — each scope is a blocking-pool removal that finishes in
   *  milliseconds at these sizes, and a parallel burst buys nothing while
   *  making partial failures harder to attribute. */
  const auxClearing = ref(false);
  async function clearAllAuxCaches() {
    if (auxClearing.value) return;
    auxClearing.value = true;
    try {
      for (const cache of auxCaches.value) {
        if (cache.sizeBytes <= 0) continue;
        try {
          await api.clearAuxCache(cache.scope);
        } catch {
          /* best-effort: one wedged scope must not strand the rest */
        }
      }
    } finally {
      try {
        auxCaches.value = await api.auxCacheOverview();
      } catch {
        /* keep previous */
      }
      auxClearing.value = false;
    }
  }

  function init() {
    // Bring the unified download bus up once for the whole app (idempotent):
    // every context's ticks land in the shared ledger, and the top-right pass
    // card is already mounted by the shell.
    downloads.ensureWired();
    void refreshStatus();
    void loadMirror();
  }

  return {
    status,
    update,
    auxCaches,
    updatesLoading,
    updatesCheckedAt,
    integrityChecking,
    githubMirrors,
    anyUpdateAvailable,
    bundledServing,
    deltaStepCount,
    reportBundledBaseline,
    refreshStatus,
    refreshUpdates,
    checkUpdates,
    verifyIntegrity,
    loadMirror,
    saveMirrors,
    download,
    ensure,
    offerUpdatePrompt,
    clearRes,
    clearAuxCache,
    auxClearing,
    clearAllAuxCaches,
    init,
  };
});