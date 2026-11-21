/**
 * Environment parsing for the Vercel edge adapter.
 *
 * Single source of truth for behavior: docs/en/designs/cache-mesh.md
 * (merged as PR #2063). Every knob this adapter exposes maps to a
 * contract section; anything not in the contract is documented here as
 * an adapter-specific extension.
 *
 * On Vercel edge functions `process.env` carries the project's
 * environment variables; handlers call {@link readConfig} once per
 * request (cheap) so tests can flip env vars between calls.
 */

/** Upstream host -> base URL overrides (`UPSTREAM_OVERRIDE`). */
export type UpstreamOverride = Map<string, string>;

export interface RuntimeConfig {
  /**
   * Upstash REST base URL (`KV_REST_URL`). `null` when unset, which
   * selects the in-memory fallback store -- see src/kv.ts for the loud
   * warning about per-instance semantics.
   */
  readonly kvRestUrl: string | null;
  /** Upstash REST token (`KV_REST_TOKEN`). */
  readonly kvRestToken: string | null;
  /**
   * Per-IP lookup budget per hour (contract §3.5, default 240).
   * `LOOKUP_RATE_PER_HOUR` overrides for operators and tests.
   */
  readonly lookupRatePerHour: number;
  /**
   * Whether this registry accepts announces (contract §5.2.5, default
   * true). `PEERS_ACCEPT_ANNOUNCES=false` closes it; off answers 403.
   */
  readonly peersAcceptAnnounces: boolean;
  /**
   * Where this node subscribes the broadcast server list from (contract
   * §2 `node.peersUpstream`, §5.1). Default is the official node;
   * an empty value disables upstream subscription (own table only).
   */
  readonly peersUpstream: string | null;
  /**
   * Pull-through sync on local miss (contract §5.4, default true).
   * `PEERS_SYNC=false` turns this node into a plain cache proxy.
   */
  readonly peersSync: boolean;
  /** Peers asked per miss (contract §5.4, default 3). */
  readonly syncPeersMax: number;
  /** `node.role` (contract §2): official | community. Default community. */
  readonly nodeRole: "official" | "community";
  /**
   * `node.id` (contract §2): 32 lowercase hex, stable per deployment.
   * `NODE_ID` pins it; otherwise a PER-INSTANCE random id is generated
   * -- on Vercel that is per-isolate, so production deployments should
   * set NODE_ID (see README).
   */
  readonly nodeId: string;
  /** Optional operator notice surfaced in the health manifest. */
  readonly notice: string | null;
  /**
   * `UPSTREAM_OVERRIDE`: JSON object mapping an allowlisted host to a
   * replacement base URL, e.g. `{"vortex.wowsgame.cn":"http://127.0.0.1:8800"}`.
   * TEST-ONLY and air-gapped deployments; the allowlist gate still
   * applies to the ORIGINAL host. Never set in production.
   */
  readonly upstreamOverride: UpstreamOverride;
}

/** Official broadcast list everyone subscribes by default (contract §5.1). */
export const DEFAULT_PEERS_UPSTREAM = "https://wowsp.langyo.xyz";

const OFF_VALUES = new Set(["false", "0", "off", "no"]);

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  return !OFF_VALUES.has(normalized);
}

function intEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const NODE_ID_RE = /^[0-9a-f]{32}$/;

function randomNodeId(): string {
  // 16 random bytes as 32 lowercase hex -- the contract §2 shape.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function parseUpstreamOverride(raw: string | undefined): UpstreamOverride {
  const map: UpstreamOverride = new Map();
  if (!raw || raw.trim() === "") return map;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return map;
    for (const [host, base] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof base !== "string" || base.trim() === "") continue;
      map.set(host.toLowerCase(), base.trim());
    }
  } catch {
    // Malformed override env is ignored loudly-by-documentation: the
    // README warns that a bad UPSTREAM_OVERRIDE silently no-ops.
  }
  return map;
}

/**
 * Parse the runtime config from an env bag (defaults: `process.env`).
 * Never throws: bad values fall back to defaults so a typo'd env var
 * degrades instead of taking the endpoint down.
 */
export function readConfig(env: Record<string, string | undefined> = process.env): RuntimeConfig {
  const nodeRole = (env.NODE_ROLE ?? "").trim().toLowerCase() === "official" ? "official" : "community";
  const pinnedNodeId = (env.NODE_ID ?? "").trim().toLowerCase();
  const notice = (env.NOTICE ?? "").trim();
  // undefined -> official default; an explicitly EMPTY value disables
  // upstream subscription (own table only -- useful for tests and for
  // fully standalone deployments).
  const peersUpstream =
    env.PEERS_UPSTREAM === undefined ? DEFAULT_PEERS_UPSTREAM : env.PEERS_UPSTREAM.trim() || null;
  return {
    kvRestUrl: (env.KV_REST_URL ?? "").trim() || null,
    kvRestToken: (env.KV_REST_TOKEN ?? "").trim() || null,
    lookupRatePerHour: intEnv(env.LOOKUP_RATE_PER_HOUR, 240, 1, 1_000_000),
    peersAcceptAnnounces: boolEnv(env.PEERS_ACCEPT_ANNOUNCES, true),
    peersUpstream,
    peersSync: boolEnv(env.PEERS_SYNC, true),
    syncPeersMax: intEnv(env.SYNC_PEERS_MAX, 3, 0, 8),
    nodeRole,
    nodeId: NODE_ID_RE.test(pinnedNodeId) ? pinnedNodeId : randomNodeId(),
    notice: notice || null,
    upstreamOverride: parseUpstreamOverride(env.UPSTREAM_OVERRIDE),
  };
}
