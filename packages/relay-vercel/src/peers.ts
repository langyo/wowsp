/**
 * `/api/peers` and `/api/peers/announce` -- the peer registry
 * (contract §5): the broadcast server list and the liveness-checked
 * announce handshake.
 */

import { readConfig, type RuntimeConfig } from "./config";
import { epochSeconds } from "./envelope";
import { clientIp, errorResponse, guarded, methodNotAllowed, preflight, readJsonBody, BodyTooLargeError } from "./http";
import type { Kv } from "./kv";
import { openKv } from "./kv";
import { rateLimit } from "./ratelimit";
import { sha256Hex } from "./policy";

/** Registry row TTL: 48 h (§5.2.3). */
const PEER_ROW_TTL = 172_800;
/** Registry cap: 128 peers, oldest lastSeenAt evicted (§5.2.3). */
const PEER_CAP = 128;
/** Announce budget: 10/hour/IP (§5.2.4). */
const ANNOUNCE_RATE_PER_HOUR = 10;
/** Liveness callback budget (§5.2.2). */
const ANNOUNCE_CALLBACK_MS = 10_000;
/** Announce request body cap. */
const ANNOUNCE_BODY_CAP = 8 * 1024;
/** The upstream list is cached this long (§5.1 "cache-control max-age=60"). */
const UPSTREAM_LIST_CACHE_TTL = 60;

/** A stored registry row (§5.1 shape plus bookkeeping fields). */
export interface PeerRow {
  v: 1;
  url: string;
  capabilities: { gateway?: boolean; lookup?: boolean; peers?: boolean; blocks?: boolean };
  role: string;
  nodeId: string;
  addedAt: number;
  lastSeenAt: number;
  notice: string | null;
  /** §5.3: private rows never appear in the published list. */
  private: boolean;
}

/** The published §5.1 row (fixed key order for stable ETags). */
export interface PublishedPeer {
  url: string;
  capabilities: PeerRow["capabilities"];
  role: string;
  nodeId: string;
  addedAt: number;
 lastSeenAt: number;
  notice: string | null;
}

function keyOf(url: string): string {
  return `peer:${url}`;
}

function normalizeUrl(url: string): string {
  // Registry keys are origins without the trailing slash.
  return url.replace(/\/+$/, "");
}

function parseRow(raw: string | null): PeerRow | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (typeof row.url !== "string" || typeof row.nodeId !== "string") return null;
  if (typeof row.lastSeenAt !== "number" || typeof row.addedAt !== "number") return null;
  const capabilities =
    row.capabilities !== null && typeof row.capabilities === "object" && !Array.isArray(row.capabilities)
      ? (row.capabilities as PeerRow["capabilities"])
      : {};
  return {
    v: 1,
    url: row.url,
    capabilities,
    role: typeof row.role === "string" ? row.role : "community",
    nodeId: row.nodeId,
    addedAt: row.addedAt,
    lastSeenAt: row.lastSeenAt,
    notice: typeof row.notice === "string" ? row.notice : null,
    private: row.private === true,
  };
}

/** Load this node's own registry rows (kv `peer:*`). */
async function ownRows(kv: Kv): Promise<PeerRow[]> {
  try {
    const keys = await kv.keys("peer:");
    const rows: PeerRow[] = [];
    for (const key of keys) {
      const row = parseRow(await kv.get(key));
      if (row !== null) rows.push(row);
    }
    return rows;
  } catch {
    return []; // KV hiccup: degrade to "no own rows"
  }
}

interface UpstreamList {
  peers: Array<Record<string, unknown>>;
}

/** Fetch (or read the <= 60 s cached copy of) the upstream list (§5.1). */
async function upstreamRows(kv: Kv, cfg: RuntimeConfig): Promise<PeerRow[]> {
  if (cfg.peersUpstream === null) return [];
  const cacheKey = "peers:upstream:list";
  let parsed: UpstreamList | null = null;
  try {
    const cached = await kv.get(cacheKey);
    if (cached !== null) parsed = JSON.parse(cached) as UpstreamList;
  } catch {
    parsed = null;
  }
  if (parsed === null) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${cfg.peersUpstream.replace(/\/+$/, "")}/api/peers`, { signal: controller.signal });
      if (response.ok) {
        parsed = (await response.json()) as UpstreamList;
        await kv.setTtl(cacheKey, JSON.stringify(parsed), UPSTREAM_LIST_CACHE_TTL).catch(() => undefined);
      }
    } catch {
      // upstream list unreachable -> own rows only (graceful degrade)
    } finally {
      clearTimeout(timer);
    }
  }
  const rows: PeerRow[] = [];
  if (parsed === null || !Array.isArray(parsed.peers)) return rows;
  for (const entry of parsed.peers) {
    const row = parseRow(JSON.stringify(entry));
    if (row !== null) rows.push(row);
  }
  return rows;
}

/**
 * The merged view (§5.1): own registry rows ∪ upstream list, own rows
 * winning by URL, private rows excluded, capped at 128. Own rows come
 * first -- §5.4's "own table first, then upstream's" ordering.
 */
export async function collectPeerRows(kv: Kv, cfg: RuntimeConfig): Promise<PeerRow[]> {
  const own = await ownRows(kv);
  const upstream = await upstreamRows(kv, cfg);
  const byUrl = new Map<string, PeerRow>();
  const order: string[] = [];
  const add = (row: PeerRow): void => {
    if (row.private) return; // §5.3
    const key = normalizeUrl(row.url);
    if (byUrl.has(key)) return; // first writer wins -- own rows are added first
    byUrl.set(key, row);
    order.push(key);
  };
  for (const row of own) add(row);
  for (const row of upstream) add(row);
  let rows = order.map((key) => byUrl.get(key) as PeerRow);
  if (rows.length > PEER_CAP) {
    // §5.2.3: oldest lastSeenAt evicted, own rows kept first.
    const overflow = rows.slice(PEER_CAP);
    rows = rows.slice(0, PEER_CAP);
    for (const row of overflow) {
      if (!own.some((candidate) => candidate.url === row.url)) continue;
      // Own rows beyond the cap still evict by lastSeenAt, matching the
      // native table behavior; find the oldest slot to replace.
      let oldestIndex = 0;
      for (let i = 1; i < rows.length; i += 1) {
        if (rows[i].lastSeenAt < rows[oldestIndex].lastSeenAt) oldestIndex = i;
      }
      rows[oldestIndex] = row;
    }
  }
  return rows;
}

function publish(row: PeerRow): PublishedPeer {
  return {
    url: row.url,
    capabilities: row.capabilities,
    role: row.role,
    nodeId: row.nodeId,
    addedAt: row.addedAt,
    lastSeenAt: row.lastSeenAt,
    notice: row.notice,
  };
}

/** `GET /api/peers` handler body. */
export async function handlePeersList(request: Request): Promise<Response> {
  return guarded(async () => {
    if (request.method === "OPTIONS") return preflight();
    if (request.method !== "GET") return methodNotAllowed("GET, OPTIONS");
    const cfg = readConfig();
    const kv = openKv(cfg.kvRestUrl, cfg.kvRestToken);
    const rows = await collectPeerRows(kv, cfg);
    const peers = rows.map(publish);
    // ETag over the peers array only (generatedAt changes per response);
    // fixed key order everywhere upstream keeps it byte-stable.
    const etagBody = JSON.stringify(peers);
    const etag = `"${(await sha256Hex(new TextEncoder().encode(etagBody))).slice(0, 32)}"`;
    const headers: Record<string, string> = {
      "cache-control": "public, max-age=60",
      etag,
      "access-control-allow-origin": "*",
    };
    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch !== null && ifNoneMatch.replace(/^W\//, "") === etag) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(JSON.stringify({ v: 1, generatedAt: epochSeconds(), peers }), {
      status: 200,
      headers: { ...headers, "content-type": "application/json" },
    });
  });
}

export type AnnounceGate =
  | { ok: true; url: string }
  | { ok: false; status: number; code: string };

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * The §5.2 shape gate: https URL, host not an IP literal, no userinfo,
 * no explicit port, hostname <= 253. The adapter additionally requires
 * a dot in the hostname (public mesh = real names; dotless intranet
 * names stay private per §5.3) and an origin-shaped URL (empty path,
 * no query/fragment) because the callback is `{url}/api/health`.
 */
export function gateAnnounceUrl(raw: string): AnnounceGate {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    return { ok: false, status: 400, code: "invalid_url" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, status: 400, code: "invalid_url" };
  }
  if (url.protocol !== "https:") return { ok: false, status: 400, code: "invalid_url" };
  if (url.username !== "" || url.password !== "") return { ok: false, status: 400, code: "invalid_url" };
  if (url.port !== "") return { ok: false, status: 400, code: "invalid_url" };
  const host = url.hostname.toLowerCase().replace(/\.$/, ""); // one trailing dot allowed
  if (host.length === 0 || host.length > 253) return { ok: false, status: 400, code: "invalid_url" };
  if (!host.includes(".")) return { ok: false, status: 400, code: "invalid_url" }; // names, not LAN labels
  if (IPV4_RE.test(host) || host.includes(":")) return { ok: false, status: 400, code: "invalid_url" }; // IP literal
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    return { ok: false, status: 400, code: "invalid_url" }; // origins only
  }
  return { ok: true, url: `${url.protocol}//${url.host}` };
}

interface HealthAnswer {
  capabilities?: unknown;
  node?: { id?: unknown; role?: unknown };
}

/**
 * The §5.2 liveness callback: GET {url}/api/health with a 10 s budget;
 * a wowsp node answers capabilities + node.id. Anything else is
 * "foreign" and never listed.
 */
async function probePeer(url: string): Promise<PeerRow | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANNOUNCE_CALLBACK_MS);
  try {
    const response = await fetch(`${url}/api/health`, { signal: controller.signal });
    if (!response.ok) return null;
    const answer = (await response.json()) as HealthAnswer;
    if (answer.capabilities === null || typeof answer.capabilities !== "object" || Array.isArray(answer.capabilities)) {
      return null;
    }
    const nodeId = answer.node?.id;
    if (typeof nodeId !== "string" || nodeId.length === 0 || nodeId.length > 64) return null;
    const role = typeof answer.node?.role === "string" && answer.node.role === "official" ? "official" : "community";
    return {
      v: 1,
      url,
      capabilities: answer.capabilities as PeerRow["capabilities"],
      role,
      nodeId,
      addedAt: epochSeconds(),
      lastSeenAt: epochSeconds(),
      notice: null,
      private: false,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Enforce the 128-row cap after a write (§5.2.3, evict oldest lastSeenAt). */
async function capRegistry(kv: Kv): Promise<void> {
  const keys = await kv.keys("peer:");
  if (keys.length <= PEER_CAP) return;
  const entries: Array<{ key: string; lastSeenAt: number }> = [];
  for (const key of keys) {
    const row = parseRow(await kv.get(key));
    if (row !== null) entries.push({ key, lastSeenAt: row.lastSeenAt });
  }
  entries.sort((a, b) => a.lastSeenAt - b.lastSeenAt);
  const excess = entries.length - PEER_CAP;
  for (const entry of entries.slice(0, Math.max(0, excess))) {
    await kv.del(entry.key).catch(() => undefined);
  }
}

/** `POST /api/peers/announce` handler body. */
export async function handleAnnounce(request: Request): Promise<Response> {
  return guarded(async () => {
    if (request.method === "OPTIONS") return preflight();
    if (request.method !== "POST") return methodNotAllowed("POST, OPTIONS");
    const cfg = readConfig();
    if (!cfg.peersAcceptAnnounces) {
      // §5.2.5: operators can close their registry.
      return errorResponse(403, "announces_disabled");
    }
    const kv = openKv(cfg.kvRestUrl, cfg.kvRestToken);
    const budgetGate = await rateLimit(kv, "announce", clientIp(request), ANNOUNCE_RATE_PER_HOUR);
    if (!budgetGate.allowed) {
      return errorResponse(429, "rate_limited", { "retry-after": String(budgetGate.retryAfter) });
    }
    let body: { url?: unknown; contact?: unknown };
    try {
      body = (await readJsonBody(request, ANNOUNCE_BODY_CAP)) as { url?: unknown; contact?: unknown };
    } catch (err) {
      if (err instanceof BodyTooLargeError) return errorResponse(413, "body_too_large");
      return errorResponse(400, "invalid_body");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse(400, "invalid_body");
    }
    const gate = gateAnnounceUrl(typeof body.url === "string" ? body.url : "");
    if (!gate.ok) return errorResponse(gate.status, gate.code);
    const contact = typeof body.contact === "string" ? body.contact.slice(0, 200) : null;

    const probed = await probePeer(gate.url);
    if (probed === null) {
      // §5.2.2: unreachable or foreign -> 200 with listed:false (announce
      // is best-effort, never an error to the caller).
      return jsonResponseOk({ ok: true, listed: false, reason: "unreachable_or_foreign" });
    }
    const previous = parseRow(await kv.get(keyOf(gate.url)));
    const row: PeerRow = {
      ...probed,
      notice: contact ?? previous?.notice ?? null,
      addedAt: previous?.addedAt ?? probed.addedAt, // re-announce refreshes lastSeenAt only
    };
    await kv.setTtl(keyOf(gate.url), JSON.stringify(row), PEER_ROW_TTL);
    await capRegistry(kv).catch(() => undefined);
    return jsonResponseOk({ ok: true, listed: true });
  });
}

function jsonResponseOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}