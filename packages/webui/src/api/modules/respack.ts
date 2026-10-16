/** Resource-pack / download domain of the WoWSP API client: the single
 *  resource pack, the unified download-progress bus and the clearable
 *  auxiliary caches (composed into `api` by client.ts). */
import { transport } from "@/transport";
import { RPC } from "@/rpc";

// ── Resource pack (mirrors `wowsp_tauri_shared`, see commands/model_pack.rs)

/** The single resource pack's LOCAL state (Settings → updates panel). */
export interface ResStatus {
  present: boolean;
  /** Content tree hash the cache was installed from (last 6 chars shown). */
  treeSha256?: string | null;
  /** Published-at timestamp that shipped with that tree hash (ISO-8601). */
  version?: string | null;
  /** True when only a legacy `.version` stamp exists — hash unknowable,
   *  the panel offers a one-time full re-download. */
  legacyStamp: boolean;
  /** Recursive on-disk size in bytes. */
  sizeBytes: number;
  downloading: boolean;
  /** Mobile only: the APK-bundled pack is the one serving (no cache pack,
   *  or one older than the bundled baseline). Always false on desktop. */
  bundled?: boolean;
}

/** One link of the chain-patch path (`res-delta-<from>-<to>` release). */
export interface ResDeltaStep {
  from: string;
  to: string;
  url: string;
  size: number;
}

/** Remote resource-pack state after a `res-latest` manifest lookup. */
export interface ResUpdate {
  latestTreeSha256?: string | null;
  latestVersion?: string | null;
  /** Manifest known AND the local hash differs (or is unknown/legacy). */
  updateAvailable: boolean;
  /** Chain-patch path: `Some([])` = full download required, `Some(steps)`
   *  = apply the patches in order, `null` = delta lookup failed. */
  deltaSteps?: ResDeltaStep[] | null;
}

/** One tick of the unified resource-download stream
 *  (`wowsp://download-progress`) — every context (app update, resource
 *  pack, data pack, mod-hub packages) rides this one event; see
 *  `wowsp_tauri_shared::download` and `commands/download_hub.rs`.
 *  Hub phases: `queued | race | download`; context continuations:
 *  `apply | installing | install | done | error` (a user cancel surfaces
 *  through the context's error phase / the rejected command). */
export interface DownloadProgress {
  /** Job identity — what a store filters on ("update", "res-pack",
   *  "data-pack", or the mod-hub entry id). */
  id: string;
  /** Owning context: "update" | "res-pack" | "data-pack" | "mod-package". */
  kind: string;
  phase: string;
  received: number;
  /** Total bytes when known, else 0 (indeterminate). */
  total: number;
  /** Smoothed transfer rate (bytes/sec) while streaming, else 0. */
  speedBps: number;
  /** Context extras: `{segment, segments}` for chain patches,
   *  `{package, packages}` for mod installs. */
  detail?: Record<string, number> | null;
  error?: string | null;
}

/** A clearable auxiliary cache directory. */
export interface AuxCacheStatus {
  /** "image-cache" | "gameparams" | "encyclopedia" | "community". */
  scope: string;
  sizeBytes: number;
}

// ── Unified download-progress bus ─────────────────────────────────────────
// One transport listener for `wowsp://download-progress`, fanned out to
// every subscriber: stores each register a filter, and no context ever
// listens on a second channel. In browser dev mode (no transport.listen)
// the handlers simply never fire.

type DownloadProgressHandler = (p: DownloadProgress) => void;

const downloadProgressHandlers = new Set<DownloadProgressHandler>();
let downloadProgressWired = false;

function wireDownloadProgressBus(handler: DownloadProgressHandler): () => void {
  downloadProgressHandlers.add(handler);
  if (!downloadProgressWired) {
    downloadProgressWired = true;
    const un = transport.listen?.<DownloadProgress>(
      "wowsp://download-progress",
      (p) => {
        for (const h of downloadProgressHandlers) h(p);
      },
    );
    if (un instanceof Promise) void un.catch(() => {});
  }
  return () => {
    downloadProgressHandlers.delete(handler);
  };
}

export const resPackApi = {
  /** Ensure the single resource pack is present (models + dogtags).
   *  Returns the cache directory path so the frontend can construct file
   *  URLs; never silently re-pulls a present-but-outdated pack. */
  ensureResPack: () => transport.invoke<string>(RPC.ensure_res_pack),
  /** Cache root once the pack is on disk (`models/` populated), null
   *  otherwise — local-only, so present packs wire the model asset URLs
   *  without the manifest fetch `ensureResPack` performs. On mobile this
   *  answers null when the APK bundle serves (no downloaded update). */
  resCacheRoot: () => transport.invoke<string | null>(RPC.res_cache_root),
  /** Mobile: hand the APK-bundled baseline (from the same-origin
   *  `/wowsp-res.json` the webui fetched) to the shell so its res status
   *  / update checks compare against the pack actually serving. Desktop
   *  never calls it (pure bookkeeping there). */
  resReportBundled: (treeSha256: string, version: string) =>
    transport.invoke<null>(RPC.res_report_bundled, { treeSha256, version }),
  // ── Resource pack: updates panel ──
  /** Local state (presence, hash stamp, size, in-flight). */
  getResStatus: () => transport.invoke<ResStatus>(RPC.get_res_status),
  /** Remote manifest hash/timestamp + chain-patch path, if any. */
  checkResUpdate: () => transport.invoke<ResUpdate>(RPC.check_res_update),
  /** Explicit (initial/migration/update) pass with progress events;
   *  prefers chain patches, falls back to the hash-verified full pack. */
  resDownload: () => transport.invoke<null>(RPC.res_download),
  /** Cancel the in-flight resource-pack pass. */
  resCancel: () => transport.invoke<null>(RPC.res_cancel),
  /** Delete the pack's cache sub-directories + version stamp. */
  clearRes: () => transport.invoke<null>(RPC.clear_res),
  /** Sizes of the clearable auxiliary cache directories. */
  auxCacheOverview: () => transport.invoke<AuxCacheStatus[]>(RPC.aux_cache_overview),
  /** Wipe one auxiliary cache directory's contents. */
  clearAuxCache: (scope: string) => transport.invoke<null>(RPC.clear_aux_cache, { scope }),
  /** The ONE resource-download progress stream
   *  (`wowsp://download-progress`). Registers exactly one transport
   *  listener process-wide and fans every tick out to the subscribers —
   *  many readers, one writer: stores filter by `kind`/`id` and own
   *  their state slices. The returned unlisten only detaches the
   *  handler (the shared listener stays). */
  listenDownloadProgress: (handler: (p: DownloadProgress) => void) =>
    wireDownloadProgressBus(handler),
};
