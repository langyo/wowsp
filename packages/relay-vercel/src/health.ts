/**
 * `GET /api/health` -- the capability manifest (contract §2).
 *
 * The Vercel adapter implements the HTTP-only subset: `gateway:false`
 * (no WebSocket namespace on edge functions), lookup/peers/blocks on.
 * Old clients ignore the new keys; new clients probe before use; the
 * absence of the whole `capabilities` object means "gateway only".
 */

import { readConfig, type RuntimeConfig } from "./config";

export const MANIFEST_VERSION = "0.0.0-dev";

/**
 * Build the manifest. The version is deliberately NOT the app release
 * version: this package is deployed standalone (fork -> import ->
 * deploy) and does not participate in the seven-slot release versioning
 * (scripts/sync_versions.py knows nothing of it).
 */
export function manifest(cfg: RuntimeConfig): {
  ok: boolean;
  provider: string;
  name: string;
  version: string;
  notice: string | null;
  capabilities: { gateway: boolean; lookup: boolean; peers: boolean; blocks: boolean };
  node: { id: string; role: string; sync: boolean; peersUpstream: string | null };
} {
  return {
    ok: true,
    provider: "wowsp-gateway",
    name: "WoWSP Gateway (Vercel)",
    version: MANIFEST_VERSION,
    notice: cfg.notice,
    capabilities: {
      gateway: false, // no WebSocket on edge (§2 table, Vercel column)
      lookup: true,
      peers: true,
      blocks: true,
    },
    node: {
      id: cfg.nodeId,
      role: cfg.nodeRole,
      sync: cfg.peersSync,
      peersUpstream: cfg.peersUpstream,
    },
  };
}

/** The /api/health handler body (route file adds the edge runtime pin). */
export function healthResponse(cfg?: RuntimeConfig): Response {
  const body = manifest(cfg ?? readConfig());
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}
