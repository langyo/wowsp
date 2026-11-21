/** Stats-cache mesh domain of the WoWSP API client: the settings pane
 *  (设置 → 缓存服务器) of docs/en/designs/cache-mesh.md §6.3 — the
 *  per-server reachability probe and the community-node autodiscover.
 *  The mesh's transport hook itself is Rust-side (commands/
 *  upstream_health.rs); the webui never dials a cache server directly.
 *
 *  Every shape below mirrors the pinned wire contract (camelCase serde on
 *  the Rust side, wowsp_tauri_shared/src/cache.rs). */
import { transport } from "@/transport";
import { RPC } from "@/rpc";

/** The official cache-mesh node root — the pinned first row of the
 *  settings list and the default (and fallback) server entry. Same
 *  constant as the Rust side's OFFICIAL_CACHE_SERVER_URL. */
export const OFFICIAL_CACHE_SERVER = "https://wowsp.langyo.xyz";

/** A node's capability block (§2). An alive node that predates the mesh
 *  reports gateway-only here (lookup false) — never a null block. */
export interface CacheCapabilities {
  gateway: boolean;
  /** /api/lookup/* — the capability the client actually keys on. */
  lookup: boolean;
  peers: boolean;
  blocks: boolean;
}

/** One stats_cache_probe row (§6.3) — mirrors
 *  wowsp_tauri_shared::StatsCacheProbeRow. */
export interface StatsCacheProbeRow {
  /** Server root, exactly as probed (the pane folds pills by this key). */
  url: string;
  /** True when /api/health answered 2xx and parsed. */
  ok: boolean;
  latencyMs: number;
  capabilities: CacheCapabilities | null;
  error: string | null;
}

export const statsCacheApi = {
  /** Probe server roots (default: the configured ladder). All rows run
   *  concurrently; the command never fails — failures land in rows. */
  statsCacheProbe: (urls?: string[]) =>
    transport.invoke<StatsCacheProbeRow[]>(RPC.stats_cache_probe, {
      ...(urls?.length ? { urls } : {}),
    }),
  /** Discover community cache nodes now (list-only preview — nothing is
   *  auto-added). Serves a fresh (≤6 h) cache without a network walk. */
  statsCacheAutodiscover: () => transport.invoke<string[]>(RPC.stats_cache_autodiscover),
};
